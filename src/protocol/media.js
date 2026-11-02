/**
 * iLink media transport: CDN URL construction, key parsing, download + decrypt.
 *
 * Mirrors `src/cdn/cdn-url.ts`, `src/cdn/pic-decrypt.ts` and the image branch of
 * `src/media/media-download.ts` in `@tencent-weixin/openclaw-weixin@2.4.10`
 * (MIT, Tencent).
 *
 * The AES key has **two encodings in the wild**, and this is the trap the
 * upstream comments call out explicitly:
 *
 *   base64(16 raw bytes)          — what an image's `image_item.aeskey` becomes
 *                                   after hex-decoding and re-encoding
 *   base64(32 hex characters)     — what `media.aes_key` carries for files,
 *                                   voice and video
 *
 * Base64-decoding and using the result directly works for the first and produces
 * a 32-byte key for the second, which yields garbage rather than an error. So the
 * decoded length decides, not the field it came from.
 *
 * @module dsh-webot/protocol/media
 */

import crypto from 'node:crypto'
import dns from 'node:dns/promises'

/** CDN host for every media download. */
export const CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c'

/** Refuse anything larger than this before decrypting it in memory. */
export const MAX_MEDIA_BYTES = 30 * 1024 * 1024

/** Build the fallback download URL from the encrypted query parameter. */
export function buildDownloadUrl({ encryptQueryParam, fullUrl, cdnBaseUrl }) {
  // `full_url` is what the server actually returned; prefer it and only fall
  // back to the client-side shape when it is absent.
  if (fullUrl) return fullUrl
  const base = cdnBaseUrl || CDN_BASE_URL
  return `${base}/download?encrypted_query_param=${encodeURIComponent(encryptQueryParam || '')}`
}

/**
 * Parse a textual IP into its bytes, or return null when it is not an IP at all.
 *
 * Brackets are stripped first: `new URL()` keeps them on an IPv6 hostname, which is why
 * a plain `/^fc/` test never matched `[fc00::1]` and let unique-local addresses through.
 */
function ipBytes(text) {
  const raw = String(text || '').replace(/^\[|\]$/g, '')
  if (!raw) return null

  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(raw)) {
    const parts = raw.split('.').map(Number)
    if (parts.some((n) => n > 255)) return null
    return Buffer.from(parts)
  }
  if (!/^[0-9a-f:.]+$/i.test(raw) || !raw.includes(':')) return null

  // An IPv6 address may end in a dotted IPv4 tail (`::ffff:127.0.0.1`); turn that into
  // two hex groups so one parser handles every shape.
  let text6 = raw
  const tail = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text6)
  if (tail) {
    const v4 = tail[1].split('.').map(Number)
    if (v4.some((n) => n > 255)) return null
    const hi = ((v4[0] << 8) | v4[1]).toString(16)
    const lo = ((v4[2] << 8) | v4[3]).toString(16)
    text6 = `${text6.slice(0, tail.index)}${hi}:${lo}`
  }

  const halves = text6.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const missing = 8 - head.length - rest.length
  if (halves.length === 2 ? missing < 0 : missing !== 0) return null
  const groups = halves.length === 2 ? [...head, ...Array(missing).fill('0'), ...rest] : head
  if (groups.length !== 8) return null

  const buffer = Buffer.alloc(16)
  for (const [index, group] of groups.entries()) {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return null
    buffer.writeUInt16BE(parseInt(group, 16), index * 2)
  }
  return buffer
}

/** Ranges that must never be fetched, by the bytes of the address. */
function isPrivateV4([a, b]) {
  return (
    a === 0 || // 0.0.0.0/8
    a === 10 || // 10/8
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // 100.64/10 carrier NAT
    (a === 169 && b === 254) || // link local
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) || // 192.0.0/24, 192.0.2/24 test nets
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    a >= 224 // multicast, reserved, broadcast
  )
}

/**
 * Whether an address literal points somewhere this plugin must not reach.
 *
 * Covers IPv4, IPv6, and IPv4-mapped IPv6 (`::ffff:127.0.0.1`, which the URL parser
 * normalises to `::ffff:7f00:1` — the shape that slipped through the first attempt).
 */
export function isPrivateAddress(text) {
  const bytes = ipBytes(text)
  if (!bytes) return false
  if (bytes.length === 4) return isPrivateV4(bytes)

  // IPv4-mapped and NAT64 addresses carry an IPv4 address in the last four bytes; they
  // reach the same host, so they get the same verdict.
  const isMapped =
    (bytes.subarray(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff) ||
    (bytes[0] === 0x00 &&
      bytes[1] === 0x64 &&
      bytes[2] === 0xff &&
      bytes[3] === 0x9b &&
      bytes.subarray(4, 12).every((byte) => byte === 0))
  if (isMapped) return isPrivateV4(bytes.subarray(12))

  const unspecified = bytes.every((byte) => byte === 0)
  if (unspecified) return true
  const loopback = bytes.subarray(0, 15).every((byte) => byte === 0) && bytes[15] === 1
  if (loopback) return true
  const linkLocal = bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80 // fe80::/10
  if (linkLocal) return true
  const uniqueLocal = (bytes[0] & 0xfe) === 0xfc // fc00::/7
  if (uniqueLocal) return true
  return false
}

/**
 * Refuse a download URL that does not point at a public HTTPS host.
 *
 * `full_url` comes from the gateway response and is used verbatim, so without this the
 * plugin will fetch whatever address an upstream payload names — including
 * `http://127.0.0.1:…` or a private-range IP, which is the shape of an SSRF. Tencent's
 * CDN is always HTTPS, so requiring HTTPS costs nothing.
 *
 * Literal private addresses are refused here; a *name* that resolves to one is refused
 * by `assertPublicMediaUrl`, which also resolves it. Neither of these stops a DNS
 * rebinding attack on its own — see the note there.
 *
 * @throws when the URL is not something this plugin should be fetching.
 */
export function assertSafeMediaUrl(rawUrl, label = 'CDN') {
  let url
  try {
    url = new URL(String(rawUrl || ''))
  } catch {
    throw new Error(`${label}: 下载地址不是合法 URL`)
  }
  if (url.protocol !== 'https:') {
    throw new Error(`${label}: 下载地址必须是 https，收到 ${url.protocol}//${url.host}`)
  }
  const host = url.hostname.toLowerCase()
  if (ipBytes(host) && isPrivateAddress(host)) {
    throw new Error(`${label}: 下载地址指向内网/本机地址 ${host}，已拒绝`)
  }
  return url.toString()
}

/** Resolver used for the host check; injectable so tests do not need DNS. */
let resolveHost = async (host) => (await dns.lookup(host, { all: true })).map((e) => e.address)

/** Replace the resolver. Tests only. */
export function setMediaHostResolver(fn) {
  resolveHost = fn
}

/**
 * Hosts a media download is allowed to reach.
 *
 * Tencent serves media from `*.weixin.qq.com`. An allowlist is the only thing that
 * actually closes DNS rebinding here: `fetch` resolves again at connect time and offers
 * no way to pin the address, so a name whose answer changes between the check and the
 * connection would still slip through. Restricting *which* names may be reached removes
 * that window for anything an attacker can control — rebinding `weixin.qq.com` itself
 * would require controlling Tencent's DNS.
 *
 * `WEBOT_MEDIA_HOSTS` adds suffixes (comma separated) for a deployment whose CDN lives
 * elsewhere; the same resolution check still applies to those.
 */
const DEFAULT_MEDIA_HOST_SUFFIXES = ['weixin.qq.com', 'qpic.cn']

let allowedHostSuffixes = DEFAULT_MEDIA_HOST_SUFFIXES.concat(
  String(process.env.WEBOT_MEDIA_HOSTS || '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean),
)

/** Replace the allowed suffixes. Tests only — production reads the env var once. */
export function setAllowedMediaHostSuffixes(list) {
  allowedHostSuffixes = list.map((entry) => String(entry).toLowerCase())
}

/** Whether a hostname ends with one of the allowed suffixes, on a label boundary. */
export function isAllowedMediaHost(host) {
  const name = String(host || '').toLowerCase().replace(/^\[|\]$/g, '')
  return allowedHostSuffixes.some((suffix) => name === suffix || name.endsWith(`.${suffix}`))
}

/** How long a media host may take to resolve before the download is refused. */
const DNS_TIMEOUT_MS = (() => {
  const raw = Number(process.env.WEBOT_DNS_TIMEOUT_MS)
  if (Number.isFinite(raw) && raw >= 50) return Math.min(Math.floor(raw), 30_000)
  return 5000
})()

/**
 * Resolve a hostname and refuse anything that is not a clean list of public addresses.
 *
 * Fails closed on every abnormal shape, because the alternative is fail-open: an empty
 * answer used to pass straight through `.find(...) === undefined`, and so did an answer
 * that was not an address at all. Both mean the check did not happen, which is worse than
 * a failed download.
 */
async function resolvePublicAddresses(host, label) {
  let timer
  let addresses
  try {
    addresses = await Promise.race([
      resolveHost(host),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('解析超时')), DNS_TIMEOUT_MS)
        if (typeof timer.unref === 'function') timer.unref()
      }),
    ])
  } catch (error) {
    throw new Error(`${label}: 无法解析下载主机 ${host}（${String((error && error.message) || error)}）`)
  } finally {
    clearTimeout(timer)
  }

  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw new Error(`${label}: 下载主机 ${host} 没有解析到任何地址，已拒绝`)
  }
  for (const address of addresses) {
    if (typeof address !== 'string' || ipBytes(address) === null) {
      throw new Error(`${label}: 下载主机 ${host} 返回了无法识别的地址 ${String(address)}，已拒绝`)
    }
    if (isPrivateAddress(address)) {
      throw new Error(`${label}: 下载主机 ${host} 解析到内网地址 ${address}，已拒绝`)
    }
  }
  return addresses
}

/**
 * `assertSafeMediaUrl`, plus the host allowlist and a check of what it resolves to.
 *
 * A public-looking name can point at 127.0.0.1, so every answer is checked. Combined with
 * the allowlist above, that covers both halves of an SSRF: which names may be reached,
 * and where they point.
 *
 * What is still not closed: the resolver is consulted here and again by `fetch` at
 * connect time (`fetch` has no hook to pin an address). A rebinding answer would need a
 * name under an allowlisted suffix, i.e. control of Tencent's DNS.
 */
export async function assertPublicMediaUrl(rawUrl, label = 'CDN') {
  const safe = assertSafeMediaUrl(rawUrl, label)
  const host = new URL(safe).hostname.replace(/^\[|\]$/g, '')
  if (ipBytes(host)) return safe // literal, already checked

  if (!isAllowedMediaHost(host)) {
    throw new Error(
      `${label}: 下载主机 ${host} 不在允许列表内（${allowedHostSuffixes.join(', ')}），已拒绝`,
    )
  }

  await resolvePublicAddresses(host, label)
  return safe
}

/** How long one media download may take, independent of the surrounding turn. */
const MEDIA_FETCH_TIMEOUT_MS = 60_000

/**
 * Read a response body with a hard byte ceiling, without materialising a huge buffer
 * first.
 *
 * `content-length` is advisory: a server may omit it or lie, and `arrayBuffer()` reads
 * whatever arrives. A 30 MB ceiling checked after the read is therefore not a ceiling at
 * all — the memory is already spent. This reads in chunks and aborts the moment the
 * running total passes the limit.
 */
async function readWithLimit(response, limitBytes, label) {
  const declared = Number(response.headers.get('content-length') || 0)
  if (declared > limitBytes) {
    throw new Error(`${label}: 文件过大（${declared} 字节），已跳过`)
  }
  if (!response.body || typeof response.body.getReader !== 'function') {
    // Older runtimes and some test doubles have no stream; fall back to the whole-body
    // read, still checking the size afterwards.
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length > limitBytes) {
      throw new Error(`${label}: 文件过大（${buffer.length} 字节），已跳过`)
    }
    return buffer
  }
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.length
      if (total > limitBytes) {
        await reader.cancel().catch(() => {})
        throw new Error(`${label}: 文件过大（超过 ${limitBytes} 字节），已中断下载`)
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks, total)
}

/**
 * Turn one `aes_key` value into the raw 16-byte key.
 *
 * @throws when the value is neither shape, rather than silently using a bad key.
 */
export function parseAesKey(aesKeyBase64) {
  const decoded = Buffer.from(String(aesKeyBase64 || ''), 'base64')
  if (decoded.length === 16) return decoded
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString('ascii'))) {
    return Buffer.from(decoded.toString('ascii'), 'hex')
  }
  throw new Error(
    `aes_key 必须是 16 字节原始密钥或 32 位十六进制字符串，实际解出 ${decoded.length} 字节`,
  )
}

/** AES-128-ECB decrypt. Matches the upstream helper's default PKCS#7 padding. */
function decryptEcb(ciphertext, key) {
  const decipher = crypto.createDecipheriv('aes-128-ecb', key, null)
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()])
  } catch (error) {
    // Some payloads are padded differently; retry unpadded and trim the tail
    // rather than failing a download over a padding byte.
    const raw = crypto.createDecipheriv('aes-128-ecb', key, null)
    raw.setAutoPadding(false)
    const plain = Buffer.concat([raw.update(ciphertext), raw.final()])
    let end = plain.length
    while (end > 0 && plain[end - 1] === 0) end -= 1
    if (end === 0) throw error
    return plain.subarray(0, end)
  }
}

/** How many redirects a media download may follow before it is treated as a loop. */
const MAX_MEDIA_REDIRECTS = 3

/** How much of an error response body is read, so a huge page cannot be buffered. */
const MAX_ERROR_BODY_BYTES = 4 * 1024

/**
 * Combine two abort signals without requiring `AbortSignal.any`.
 *
 * `AbortSignal.any` arrived in Node 20.3, while this plugin declares engines `>=20`: on
 * 20.0–20.2 the old code silently dropped the download timeout whenever the caller
 * passed its own signal, which is the only path that matters here.
 */
function combineSignals(first, second) {
  if (!first) return second
  if (!second) return first
  if (AbortSignal.any) return AbortSignal.any([first, second])
  const controller = new AbortController()
  const forward = (signal) => {
    if (signal.aborted) controller.abort(signal.reason)
    else signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true })
  }
  forward(first)
  forward(second)
  return controller.signal
}

/** Read at most `limitBytes` of a body, for error messages. */
async function readErrorBody(response, limitBytes) {
  try {
    if (!response.body || typeof response.body.getReader !== 'function') {
      const text = await response.text()
      return text.slice(0, 200)
    }
    const reader = response.body.getReader()
    const chunks = []
    let total = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        total += value.length
        chunks.push(Buffer.from(value))
        if (total >= limitBytes) {
          await reader.cancel().catch(() => {})
          break
        }
      }
    } finally {
      reader.releaseLock()
    }
    return Buffer.concat(chunks, Math.min(total, limitBytes)).toString('utf8').slice(0, 200)
  } catch {
    return ''
  }
}

/** A status that carries a `location` to follow. */
function isRedirectStatus(status) {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

/**
 * Download one media reference and answer its plaintext bytes.
 *
 * Without a key the bytes are fetched as-is, which is what an image without
 * `aeskey`/`aes_key` needs.
 */
export async function downloadMedia({ encryptQueryParam, aesKeyBase64, fullUrl, cdnBaseUrl, signal, label }) {
  const name = label || 'CDN'
  let url = await assertPublicMediaUrl(
    buildDownloadUrl({ encryptQueryParam, fullUrl, cdnBaseUrl }),
    name,
  )

  const timeout = AbortSignal.timeout ? AbortSignal.timeout(MEDIA_FETCH_TIMEOUT_MS) : undefined
  const combined = combineSignals(signal, timeout)

  // Redirects are followed by hand: `fetch` follows them internally, which means the
  // final address never passes the checks above. Each hop is validated the same way as
  // the first, so a redirect cannot walk the request into a private network.
  let response
  for (let hop = 0; ; hop += 1) {
    response = await fetch(url, { signal: combined, redirect: 'manual' })
    if (!isRedirectStatus(response.status)) break
    const location = response.headers.get('location')
    if (!location) {
      throw new Error(`${name}: HTTP ${response.status} 重定向缺少 location`)
    }
    if (hop >= MAX_MEDIA_REDIRECTS) {
      throw new Error(`${name}: 重定向超过 ${MAX_MEDIA_REDIRECTS} 次，已放弃`)
    }
    const next = new URL(location, url).toString()
    url = await assertPublicMediaUrl(next, name)
  }

  if (!response.ok) {
    const body = await readErrorBody(response, MAX_ERROR_BODY_BYTES)
    throw new Error(`${name}: CDN 下载失败 HTTP ${response.status} ${body}`)
  }

  const encrypted = await readWithLimit(response, MAX_MEDIA_BYTES, name)

  if (!aesKeyBase64) return encrypted
  return decryptEcb(encrypted, parseAesKey(aesKeyBase64))
}

/** Minimal extension -> MIME map, enough to name a saved file sensibly. */
const MIME_BY_EXT = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  json: 'application/json',
  csv: 'text/csv',
  zip: 'application/zip',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  mp4: 'video/mp4',
  silk: 'audio/silk',
}

/** MIME for a filename, defaulting to octet-stream. */
export function mimeForName(name) {
  const ext = String(name || '').split('.').pop().toLowerCase()
  return MIME_BY_EXT[ext] || 'application/octet-stream'
}

/** Pick a safe extension for a saved inbound file. */
export function extensionForName(name, fallback) {
  const ext = String(name || '').split('.').pop().toLowerCase()
  if (ext && /^[a-z0-9]{1,8}$/.test(ext)) return ext
  return fallback
}
