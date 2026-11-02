import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assertSafeMediaUrl, downloadMedia, MAX_MEDIA_BYTES } from '../src/protocol/media.js'

test('a normal WeChat CDN URL is allowed', () => {
  const url = 'https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=x'
  assert.equal(assertSafeMediaUrl(url), url)
})

test('plain http is refused', () => {
  assert.throws(() => assertSafeMediaUrl('http://novac2c.cdn.weixin.qq.com/x'), /必须是 https/)
})

for (const host of [
  '127.0.0.1',
  '10.0.0.1',
  '192.168.1.5',
  '172.16.0.9',
  '169.254.169.254',
  '0.0.0.0',
]) {
  test(`an internal address is refused: ${host}`, () => {
    assert.throws(() => assertSafeMediaUrl(`https://${host}/x`), /内网|本机/)
  })
}

test('ipv6 loopback is refused', () => {
  assert.throws(() => assertSafeMediaUrl('https://[::1]/x'), /内网|本机/)
})

test('a malformed url is refused', () => {
  assert.throws(() => assertSafeMediaUrl('not a url'), /不是合法 URL/)
  assert.throws(() => assertSafeMediaUrl(''), /不是合法 URL/)
})

/** A streaming response whose body is `chunks` of `size` bytes. */
function streamResponse(chunks, size) {
  let sent = 0
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    body: {
      getReader() {
        return {
          async read() {
            if (sent >= chunks) return { done: true, value: undefined }
            sent += 1
            return { done: false, value: new Uint8Array(size) }
          },
          async cancel() {},
          releaseLock() {},
        }
      },
    },
  }
}

test('a download that exceeds the cap aborts instead of buffering it all', async () => {
  const original = globalThis.fetch
  // 4 chunks of 10 MB against a 30 MB ceiling: the fourth must stop the read.
  globalThis.fetch = async () => streamResponse(4, 10 * 1024 * 1024)
  try {
    await assert.rejects(
      () => downloadMedia({ fullUrl: 'https://example.com/f', label: 'CDN' }),
      /文件过大/,
    )
  } finally {
    globalThis.fetch = original
  }
})

test('a download inside the cap is returned whole', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => streamResponse(3, 1024)
  try {
    const buffer = await downloadMedia({ fullUrl: 'https://example.com/f', label: 'CDN' })
    assert.equal(buffer.length, 3 * 1024)
  } finally {
    globalThis.fetch = original
  }
})

test('the cap is 30 MB', () => {
  assert.equal(MAX_MEDIA_BYTES, 30 * 1024 * 1024)
})
