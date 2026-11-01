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

/**
 * Download one media reference and answer its plaintext bytes.
 *
 * Without a key the bytes are fetched as-is, which is what an image without
 * `aeskey`/`aes_key` needs.
 */
export async function downloadMedia({ encryptQueryParam, aesKeyBase64, fullUrl, cdnBaseUrl, signal, label }) {
  const url = buildDownloadUrl({ encryptQueryParam, fullUrl, cdnBaseUrl })

  const response = await fetch(url, signal ? { signal } : undefined)
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`${label}: CDN 下载失败 HTTP ${response.status} ${body.slice(0, 200)}`)
  }

  const declared = Number(response.headers.get('content-length') || 0)
  if (declared > MAX_MEDIA_BYTES) {
    throw new Error(`${label}: 文件过大（${declared} 字节），已跳过`)
  }
  const encrypted = Buffer.from(await response.arrayBuffer())
  if (encrypted.length > MAX_MEDIA_BYTES) {
    throw new Error(`${label}: 文件过大（${encrypted.length} 字节），已跳过`)
  }

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
