import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  assertSafeMediaUrl,
  assertPublicMediaUrl,
  downloadMedia,
  isPrivateAddress,
  setMediaHostResolver,
  MAX_MEDIA_BYTES,
} from '../src/protocol/media.js'

/** No test may depend on real DNS. */
setMediaHostResolver(async () => ['93.184.216.34'])

test('a normal WeChat CDN URL is allowed', () => {
  const url = 'https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=x'
  assert.equal(assertSafeMediaUrl(url), url)
})

test('plain http is refused', () => {
  assert.throws(() => assertSafeMediaUrl('http://novac2c.cdn.weixin.qq.com/x'), /必须是 https/)
})

// The exact shapes that slipped through the first attempt: the URL parser keeps the
// brackets on an IPv6 hostname and normalises `::ffff:127.0.0.1` to `::ffff:7f00:1`.
for (const url of [
  'https://127.0.0.1/x',
  'https://10.0.0.1/x',
  'https://192.168.1.5/x',
  'https://172.16.0.9/x',
  'https://169.254.169.254/latest/meta-data/',
  'https://0.0.0.0/x',
  'https://100.64.0.1/x',
  'https://[::1]/x',
  'https://[::ffff:127.0.0.1]/x',
  'https://[fc00::1]/x',
  'https://[fd00::1]/x',
  'https://[fe80::1]/x',
  'https://[::]/x',
]) {
  test(`an internal address is refused: ${url}`, () => {
    assert.throws(() => assertSafeMediaUrl(url), /内网|本机/)
  })
}

test('a public IPv6 literal is allowed', () => {
  assert.doesNotThrow(() => assertSafeMediaUrl('https://[2001:4860:4860::8888]/x'))
})

test('the address classifier handles every IPv6 form', () => {
  assert.equal(isPrivateAddress('[::ffff:127.0.0.1]'), true)
  assert.equal(isPrivateAddress('::ffff:7f00:1'), true)
  assert.equal(isPrivateAddress('[fc00::1]'), true)
  assert.equal(isPrivateAddress('[fe80::1]'), true)
  assert.equal(isPrivateAddress('[2001:4860:4860::8888]'), false)
  assert.equal(isPrivateAddress('8.8.8.8'), false)
})

test('a malformed url is refused', () => {
  assert.throws(() => assertSafeMediaUrl('not a url'), /不是合法 URL/)
  assert.throws(() => assertSafeMediaUrl(''), /不是合法 URL/)
})

test('a name that resolves to a private address is refused', async () => {
  setMediaHostResolver(async () => ['10.1.2.3'])
  try {
    await assert.rejects(() => assertPublicMediaUrl('https://cdn.example.com/x'), /解析到内网地址/)
  } finally {
    setMediaHostResolver(async () => ['93.184.216.34'])
  }
})

test('one private address among the answers is enough to refuse', async () => {
  setMediaHostResolver(async () => ['93.184.216.34', '127.0.0.1'])
  try {
    await assert.rejects(() => assertPublicMediaUrl('https://cdn.example.com/x'), /内网地址/)
  } finally {
    setMediaHostResolver(async () => ['93.184.216.34'])
  }
})

/** A streaming response whose body is `chunks` reads of `size` bytes. */
function streamResponse(chunks, size, status = 200, headers = {}) {
  let sent = 0
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
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

/** Run `body` with a stubbed global fetch. */
async function withFetch(fake, body) {
  const original = globalThis.fetch
  globalThis.fetch = fake
  try {
    await body()
  } finally {
    globalThis.fetch = original
  }
}

test('a download that exceeds the cap aborts instead of buffering it all', async () => {
  await withFetch(async () => streamResponse(4, 10 * 1024 * 1024), async () => {
    await assert.rejects(
      () => downloadMedia({ fullUrl: 'https://cdn.example.com/f', label: 'CDN' }),
      /文件过大/,
    )
  })
})

test('a download inside the cap is returned whole', async () => {
  await withFetch(async () => streamResponse(3, 1024), async () => {
    const buffer = await downloadMedia({ fullUrl: 'https://cdn.example.com/f', label: 'CDN' })
    assert.equal(buffer.length, 3 * 1024)
  })
})

test('a huge error body is not buffered', async () => {
  await withFetch(async () => streamResponse(50, 1024 * 1024, 500), async () => {
    await assert.rejects(
      () => downloadMedia({ fullUrl: 'https://cdn.example.com/f', label: 'CDN' }),
      /HTTP 500/,
    )
  })
})

test('a redirect is followed when it stays public', async () => {
  const fake = async (url) => {
    if (String(url).includes('/start')) {
      return streamResponse(0, 0, 302, { location: 'https://cdn.example.com/final' })
    }
    return streamResponse(2, 512)
  }
  await withFetch(fake, async () => {
    const buffer = await downloadMedia({ fullUrl: 'https://cdn.example.com/start', label: 'CDN' })
    assert.equal(buffer.length, 1024)
  })
})

test('a redirect into a private address is refused', async () => {
  const fake = async (url) => {
    if (String(url).includes('/start')) {
      return streamResponse(0, 0, 302, { location: 'https://127.0.0.1/secret' })
    }
    throw new Error('the private address must never be fetched')
  }
  await withFetch(fake, async () => {
    await assert.rejects(
      () => downloadMedia({ fullUrl: 'https://cdn.example.com/start', label: 'CDN' }),
      /内网|本机/,
    )
  })
})

test('the cap is 30 MB', () => {
  assert.equal(MAX_MEDIA_BYTES, 30 * 1024 * 1024)
})
