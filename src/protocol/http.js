/**
 * iLink HTTP transport.
 *
 * Mirrors `src/api/api.ts` in `@tencent-weixin/openclaw-weixin@2.4.10` (MIT,
 * Tencent). Only the parts M2 needs are here: the QR login pair and the shared
 * header recipe. Nothing in this file knows about DSH.
 *
 * Two shapes matter and are easy to get wrong:
 *
 * - POST carries `AuthorizationType`, `X-WECHAT-UIN` and `Content-Type`;
 *   GET carries only the `iLink-App-*` pair. The official client builds them
 *   from two different helpers and this keeps that split.
 * - `X-WECHAT-UIN` is base64 of the *decimal text* of a random uint32, not
 *   base64 of the four bytes.
 *
 * @module dsh-webot/protocol/http
 */

import crypto from 'node:crypto'

/** Host every QR login request goes to before any IDC redirect. */
export const ILINK_BASE_URL = 'https://ilinkai.weixin.qq.com'

/** `ilink_appid` of the upstream channel this transport mirrors. */
const APP_ID = 'bot'

/**
 * Value of `iLink-App-ClientVersion`, encoded as 0x00MMNNPP.
 *
 * This mirrors the upstream client whose request shapes this module implements
 * (2.4.10). It is an observability field, not an authentication one, but sending
 * the version of a client that is known to be accepted is cheaper than finding
 * out how the server reacts to an unknown one.
 */
const CLIENT_VERSION = buildClientVersion('2.4.10')

/** Bot type the desktop channel build uses for `get_bot_qrcode`. */
export const DEFAULT_BOT_TYPE = '3'

function buildClientVersion(version) {
  const parts = version.split('.').map((part) => parseInt(part, 10) || 0)
  const major = parts[0] ?? 0
  const minor = parts[1] ?? 0
  const patch = parts[2] ?? 0
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff)
}

/** `X-WECHAT-UIN`: random uint32 -> decimal string -> base64 of that string. */
function randomWechatUin() {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0)
  return Buffer.from(String(uint32), 'utf-8').toString('base64')
}

/** Headers shared by both verbs. */
function commonHeaders() {
  return {
    'iLink-App-Id': APP_ID,
    'iLink-App-ClientVersion': String(CLIENT_VERSION),
  }
}

function postHeaders(token) {
  const headers = {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': randomWechatUin(),
    ...commonHeaders(),
  }
  const trimmed = typeof token === 'string' ? token.trim() : ''
  if (trimmed) headers.Authorization = `Bearer ${trimmed}`
  return headers
}

function joinUrl(baseUrl, endpoint) {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
  return new URL(endpoint, base).toString()
}

/** One failed iLink call, with the pieces worth logging. */
export class IlinkError extends Error {
  constructor(message, options = {}) {
    super(message)
    this.name = 'IlinkError'
    this.status = options.status
    this.endpoint = options.endpoint
    this.body = options.body
  }
}

async function request({ method, baseUrl, endpoint, body, token, timeoutMs, signal, label }) {
  const url = joinUrl(baseUrl, endpoint)
  const headers = method === 'POST' ? postHeaders(token) : commonHeaders()

  // A per-request timeout is the long-poll exit; an external signal is the user
  // cancelling. Neither may mask the other, so they are combined rather than
  // chosen between.
  const timeoutSignal = timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined
  const combined =
    signal && timeoutSignal ? AbortSignal.any([signal, timeoutSignal]) : (signal ?? timeoutSignal)

  let response
  try {
    response = await fetch(url, {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
      ...(combined ? { signal: combined } : {}),
    })
  } catch (error) {
    throw new IlinkError(`${label}: request failed (${describeFetchError(error)})`, {
      endpoint,
      body: String(error && error.cause ? error.cause : error),
    })
  }

  const text = await response.text()
  if (!response.ok) {
    throw new IlinkError(`${label}: HTTP ${response.status}`, {
      status: response.status,
      endpoint,
      body: text.slice(0, 500),
    })
  }
  return text
}

function describeFetchError(error) {
  if (error && error.name === 'TimeoutError') return 'timeout'
  const cause = error && error.cause
  const code = cause && cause.code ? String(cause.code) : ''
  return code || String(cause || error || 'unknown')
}

/** POST JSON to an iLink endpoint and return the raw response text. */
export async function ilinkPost({ baseUrl, endpoint, payload, token, timeoutMs, signal, label }) {
  return request({
    method: 'POST',
    baseUrl,
    endpoint,
    body: JSON.stringify(payload),
    token,
    timeoutMs,
    signal,
    label,
  })
}

/** GET an iLink endpoint and return the raw response text. */
export async function ilinkGet({ baseUrl, endpoint, timeoutMs, signal, label }) {
  return request({ method: 'GET', baseUrl, endpoint, timeoutMs, signal, label })
}
