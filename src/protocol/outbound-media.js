/**
 * Outbound media: upload a local file to the Weixin CDN and send it as an item.
 *
 * Mirrors `src/cdn/upload.ts`, `src/cdn/cdn-upload.ts` and
 * `src/cdn/aes-ecb.ts` plus `sendImageMessageWeixin` / `sendFileMessageWeixin`
 * from `@tencent-weixin/openclaw-weixin@2.4.10` (MIT, Tencent).
 *
 * The two details that decide whether the phone shows a picture or a grey box:
 *
 * - the download reference is the **`x-encrypted-param` response header** of the
 *   upload POST. `upload_full_url` from `getuploadurl` is upload authorization;
 *   putting it in the item gets a 403 on read.
 * - `media.aes_key` is `base64` of the **hex text** of the key, not base64 of the
 *   raw 16 bytes. The wrong shape is accepted by the server and renders broken.
 *
 * @module dsh-webot/protocol/outbound-media
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { ilinkPost } from './http.js'
import { CDN_BASE_URL } from './media.js'
import { requestBaseInfo, sendItem } from './messages.js'

/** `UploadMediaType` values. */
const MEDIA_TYPE = { image: 1, video: 2, file: 3 }

/** Item types. */
const ITEM = { text: 1, image: 2, file: 4, video: 5 }

const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp'])
const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'm4v'])

/** Refuse to upload anything larger than this. */
const MAX_UPLOAD_BYTES = 30 * 1024 * 1024

/** AES-128-ECB ciphertext size with PKCS#7 padding. */
function paddedSize(size) {
  return Math.ceil((size + 1) / 16) * 16
}

function encryptEcb(plaintext, key) {
  const cipher = crypto.createCipheriv('aes-128-ecb', key, null)
  return Buffer.concat([cipher.update(plaintext), cipher.final()])
}

/** Which iLink media type a path should be sent as. */
function kindFor(filePath) {
  const extension = path.extname(filePath).slice(1).toLowerCase()
  if (IMAGE_EXTENSIONS.has(extension)) return 'image'
  if (VIDEO_EXTENSIONS.has(extension)) return 'video'
  return 'file'
}

/**
 * Upload one file and send it to `toUserId`.
 *
 * @returns `{ kind, fileName, bytes }` on success; throws with a readable reason
 *   otherwise, which the tool surfaces to the agent.
 */
export async function sendMediaToWeChat({
  baseUrl,
  token,
  toUserId,
  contextToken,
  filePath,
  caption,
  signal,
}) {
  let stat
  try {
    stat = fs.statSync(filePath)
  } catch {
    throw new Error(`找不到文件：${filePath}`)
  }
  if (!stat.isFile()) throw new Error(`不是文件：${filePath}`)
  if (stat.size === 0) throw new Error(`文件是空的：${filePath}`)
  if (stat.size > MAX_UPLOAD_BYTES) {
    throw new Error(`文件太大（${stat.size} 字节），上限 ${MAX_UPLOAD_BYTES}`)
  }

  const plaintext = fs.readFileSync(filePath)
  const rawsize = plaintext.length
  const rawfilemd5 = crypto.createHash('md5').update(plaintext).digest('hex')
  const filesize = paddedSize(rawsize)
  const filekey = crypto.randomBytes(16).toString('hex')
  const aeskey = crypto.randomBytes(16)
  const kind = kindFor(filePath)

  const uploadRaw = await ilinkPost({
    baseUrl,
    endpoint: 'ilink/bot/getuploadurl',
    payload: {
      filekey,
      media_type: MEDIA_TYPE[kind],
      to_user_id: toUserId,
      rawsize,
      rawfilemd5,
      filesize,
      no_need_thumb: true,
      aeskey: aeskey.toString('hex'),
      base_info: requestBaseInfo(),
    },
    token,
    timeoutMs: 20_000,
    signal,
    label: 'getuploadurl',
  })

  const upload = JSON.parse(uploadRaw)
  const fullUrl = typeof upload.upload_full_url === 'string' ? upload.upload_full_url.trim() : ''
  const uploadParam = typeof upload.upload_param === 'string' ? upload.upload_param : ''
  const url =
    fullUrl ||
    (uploadParam
      ? `${CDN_BASE_URL}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`
      : '')
  if (!url) throw new Error('getuploadurl 没有返回上传地址')

  const ciphertext = encryptEcb(plaintext, aeskey)
  let downloadParam = ''
  let lastError
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: new Uint8Array(ciphertext),
        ...(signal ? { signal } : {}),
      })
      if (response.status >= 400 && response.status < 500) {
        const detail = response.headers.get('x-error-message') || ''
        throw new Error(`CDN 拒绝上传（HTTP ${response.status}）${detail}`)
      }
      if (response.status !== 200) throw new Error(`CDN 上传失败（HTTP ${response.status}）`)
      downloadParam = response.headers.get('x-encrypted-param') || ''
      if (!downloadParam) throw new Error('CDN 响应缺少 x-encrypted-param 头')
      break
    } catch (error) {
      lastError = error
      // A 4xx is a refusal, not a flake; retrying it just wastes the file.
      if (String((error && error.message) || '').includes('拒绝上传')) throw error
    }
  }
  if (!downloadParam) throw lastError || new Error('CDN 上传失败')

  const media = {
    encrypt_query_param: downloadParam,
    // base64 of the hex TEXT — see the module note above.
    aes_key: Buffer.from(aeskey.toString('hex'), 'utf8').toString('base64'),
    encrypt_type: 1,
  }

  let item
  if (kind === 'image') {
    item = { type: ITEM.image, image_item: { media, mid_size: filesize } }
  } else if (kind === 'video') {
    item = { type: ITEM.video, video_item: { media, video_size: filesize } }
  } else {
    item = {
      type: ITEM.file,
      file_item: { media, file_name: path.basename(filePath), len: String(rawsize) },
    }
  }

  if (caption) {
    await sendItem({
      baseUrl,
      token,
      toUserId,
      item: { type: ITEM.text, text_item: { text: caption } },
      contextToken,
      signal,
    })
  }
  await sendItem({ baseUrl, token, toUserId, item, contextToken, signal })

  return { kind, fileName: path.basename(filePath), bytes: rawsize }
}
