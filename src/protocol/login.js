/**
 * QR login state machine.
 *
 * Implements the flow from `src/auth/login-qr.ts` in
 * `@tencent-weixin/openclaw-weixin@2.4.10` (MIT, Tencent) against a Host-owned
 * task, instead of blocking on stdin the way the upstream CLI does.
 *
 * The handshake is not one request. It is:
 *
 *   get_bot_qrcode  -> a QR payload plus the URL it encodes
 *   get_qrcode_status (long poll, up to 35s) -> wait | scaned | need_verifycode |
 *       scaned_but_redirect | expired | verify_code_blocked | binded_redirect |
 *       confirmed
 *
 * Two details are load-bearing:
 *
 * - `scaned_but_redirect` moves polling to `https://<redirect_host>` and must
 *   not be treated as progress; the QR stays the same.
 * - A network error or a client-side long-poll timeout is *not* a failure. The
 *   upstream client turns both into `wait` and keeps polling, because the server
 *   holding the request is the normal case.
 *
 * @module dsh-webot/protocol/login
 */

import { DEFAULT_BOT_TYPE, ILINK_BASE_URL, ilinkGet, ilinkPost } from './http.js'

/**
 * `qrcode` is loaded lazily on purpose.
 *
 * A profile installs this bundle with `link:<workspace>`, and pnpm does not
 * install dependencies for a linked package. A static import would therefore
 * take the whole Host row down with ERR_MODULE_NOT_FOUND before any route
 * exists — a failure with no visible cause. Imported here, a missing dependency
 * becomes one legible message in the panel instead.
 */
let qrcodeModule

async function loadQrCode() {
  if (qrcodeModule) return qrcodeModule
  try {
    qrcodeModule = await import('qrcode')
  } catch (error) {
    throw new Error(
      '二维码依赖未安装（qrcode）。请在插件目录运行 npm install 后重启 DSH。原始错误：' +
        String(error && error.message).split('\n')[0],
    )
  }
  return qrcodeModule
}

/** How long one QR payload is usable before the server calls it expired. */
const LONG_POLL_TIMEOUT_MS = 35_000

/** How many times one login may replace an expired QR before giving up. */
const MAX_QR_REFRESH = 3

/** Upper bound for one whole login attempt, matching the upstream 8 minutes. */
const OVERALL_TIMEOUT_MS = 8 * 60_000

/** Pause between two completed polls. */
const POLL_INTERVAL_MS = 1_000

/** Abortable sleep; resolves on timeout or immediately on abort. */
function delay(ms, signal) {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
  })
}

/**
 * Create one login attempt.
 *
 * @param options.onBound - called with the bound account before the task reports
 *   `confirmed`; a throw here turns into a failed login rather than a silent one.
 * @returns the task handle: `start`, `snapshot`, `verify`, `cancel`, `dispose`.
 */
export function createLoginTask(options = {}) {
  const baseUrl = options.baseUrl || ILINK_BASE_URL
  const botType = options.botType || DEFAULT_BOT_TYPE

  const controller = new AbortController()
  const signal = controller.signal

  let phase = 'idle'
  let qrDataUrl = ''
  let qrUrl = ''
  let message = ''
  let error = ''
  let refreshed = 0
  let accountId = ''
  let awaitingVerifyCode = false
  let pendingVerifyCode = ''
  let pollingBaseUrl = baseUrl
  let qrcode = ''
  let codeWaiter = null
  let settled = false

  function snapshot() {
    return {
      phase,
      qrDataUrl,
      qrUrl,
      message,
      error,
      refreshed,
      accountId: accountId || undefined,
      awaitingVerifyCode,
      at: Date.now(),
    }
  }

  function settle(nextPhase, nextMessage) {
    if (settled) return
    settled = true
    phase = nextPhase
    message = nextMessage || ''
    awaitingVerifyCode = false
    if (codeWaiter) {
      const waiter = codeWaiter
      codeWaiter = null
      waiter.reject(new Error('cancelled'))
    }
  }

  function fail(reason) {
    error = reason
    settle('failed', reason)
  }

  function waitForCode(abortSignal) {
    return new Promise((resolve, reject) => {
      codeWaiter = { resolve, reject }
      abortSignal.addEventListener(
        'abort',
        () => {
          if (codeWaiter) {
            codeWaiter = null
            reject(new Error('cancelled'))
          }
        },
        { once: true },
      )
    })
  }

  async function fetchQr() {
    const raw = await ilinkPost({
      baseUrl: pollingBaseUrl,
      endpoint: `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`,
      payload: { local_token_list: [] },
      timeoutMs: 15_000,
      signal,
      label: 'get_bot_qrcode',
    })
    const parsed = JSON.parse(raw)
    const nextQrcode = String(parsed.qrcode || '')
    const nextUrl = String(parsed.qrcode_img_content || '')
    if (!nextQrcode || !nextUrl) throw new Error('二维码响应缺少 qrcode 或扫码链接')
    qrcode = nextQrcode
    qrUrl = nextUrl
    const QRCode = await loadQrCode()
    const encoder = QRCode.default || QRCode
    qrDataUrl = await encoder.toDataURL(nextUrl, {
      margin: 1,
      width: 320,
      errorCorrectionLevel: 'M',
    })
  }

  async function pollOnce() {
    let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`
    if (pendingVerifyCode) endpoint += `&verify_code=${encodeURIComponent(pendingVerifyCode)}`
    const raw = await ilinkGet({
      baseUrl: pollingBaseUrl,
      endpoint,
      timeoutMs: LONG_POLL_TIMEOUT_MS,
      signal,
      label: 'get_qrcode_status',
    })
    return JSON.parse(raw)
  }

  async function onConfirmed(status) {
    const id = String(status.ilink_bot_id || '')
    if (!id) {
      fail('登录失败：服务器未返回 ilink_bot_id。')
      return
    }
    accountId = id
    const account = {
      accountId: id,
      userId: String(status.ilink_user_id || ''),
      token: String(status.bot_token || ''),
      baseUrl: String(status.baseurl || ILINK_BASE_URL),
      boundAt: Date.now(),
    }
    try {
      if (options.onBound) await options.onBound(account)
    } catch (writeError) {
      fail(`绑定成功但保存失败：${String(writeError && writeError.message)}`)
      return
    }
    settle('confirmed', '已绑定微信')
  }

  async function refreshOrFail() {
    refreshed += 1
    if (refreshed > MAX_QR_REFRESH) {
      fail('二维码多次失效，连接流程已停止，请重试。')
      return 'stop'
    }
    phase = 'refreshing'
    message = '二维码已过期，正在刷新'
    pendingVerifyCode = ''
    try {
      await fetchQr()
    } catch (refreshError) {
      fail(`刷新二维码失败：${String(refreshError && refreshError.message)}`)
      return 'stop'
    }
    phase = 'waiting'
    message = '二维码已更新，请重新扫码'
    return 'tick'
  }

  async function applyStatus(status) {
    const kind = String((status && status.status) || '')
    switch (kind) {
      case 'wait':
        return 'tick'

      case 'scaned':
        if (pendingVerifyCode) pendingVerifyCode = ''
        if (phase !== 'scanned') {
          phase = 'scanned'
          message = '已扫码，正在确认'
        }
        return 'tick'

      case 'scaned_but_redirect': {
        const host = status.redirect_host
        if (host) pollingBaseUrl = `https://${host}`
        return 'tick'
      }

      case 'need_verifycode': {
        // Reaching this twice means the previous code was rejected.
        pendingVerifyCode = ''
        awaitingVerifyCode = true
        phase = 'need_verifycode'
        message = '输入手机微信上显示的数字'
        let code
        try {
          code = await waitForCode(signal)
        } catch {
          return 'stop'
        }
        if (signal.aborted) return 'stop'
        pendingVerifyCode = String(code || '').trim()
        awaitingVerifyCode = false
        phase = 'scanned'
        message = '正在验证配对码'
        return 'continue'
      }

      case 'expired':
      case 'verify_code_blocked':
        return refreshOrFail()

      case 'binded_redirect':
        settle('already-bound', '这个微信已经绑定过，无需重复扫码。')
        return 'stop'

      case 'confirmed':
        await onConfirmed(status)
        return 'stop'

      default:
        return 'tick'
    }
  }

  async function run() {
    const deadline = Date.now() + OVERALL_TIMEOUT_MS
    try {
      while (!signal.aborted && !settled && Date.now() < deadline) {
        let status
        try {
          status = await pollOnce()
        } catch (pollError) {
          if (signal.aborted || settled) return
          // Server-side hold, gateway 5xx, or a client-side long-poll timeout:
          // all normal, all mean "keep waiting".
          await delay(POLL_INTERVAL_MS, signal)
          continue
        }
        const outcome = await applyStatus(status)
        if (outcome === 'stop' || settled) return
        if (outcome === 'continue') continue
        await delay(POLL_INTERVAL_MS, signal)
      }
      if (!settled && !signal.aborted) fail('登录超时，请重试。')
    } catch (runError) {
      if (!signal.aborted) fail(`登录失败：${String(runError && runError.message)}`)
    }
  }

  async function start() {
    if (settled) return snapshot()
    phase = 'starting'
    message = '正在获取二维码'
    error = ''
    try {
      await fetchQr()
    } catch (fetchError) {
      fail(`获取二维码失败：${String(fetchError && fetchError.message)}`)
      return snapshot()
    }
    if (!settled) {
      phase = 'waiting'
      message = '用手机微信扫描二维码'
      void run()
    }
    return snapshot()
  }

  /** Supply the pairing code the phone displayed. Answers false when nobody asked. */
  function verify(code) {
    const trimmed = String(code || '').trim()
    if (!trimmed || !codeWaiter) return false
    const waiter = codeWaiter
    codeWaiter = null
    waiter.resolve(trimmed)
    return true
  }

  function cancel() {
    if (settled) return
    settle('cancelled', '已取消登录')
    controller.abort()
  }

  return { start, snapshot, verify, cancel, dispose: cancel }
}
