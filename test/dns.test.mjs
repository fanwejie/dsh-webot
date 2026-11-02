import { test } from 'node:test'
import assert from 'node:assert/strict'

/**
 * Every abnormal resolver answer must refuse the download.
 *
 * The previous version failed open on two of these: an empty array slipped past
 * `.find(...) === undefined`, and so did an answer that was not an address at all. A check
 * that silently does not happen is worse than a download that fails.
 *
 * The timeout is driven down through `WEBOT_DNS_TIMEOUT_MS`, which is read when the module
 * loads — hence the dynamic import after setting it. The production default is five
 * seconds, so this file would otherwise take that long to prove one case.
 */
process.env.WEBOT_DNS_TIMEOUT_MS = '150'
const { assertPublicMediaUrl, setMediaHostResolver } = await import('../src/protocol/media.js')

const HOST = 'https://novac2c.cdn.weixin.qq.com/c2c/download'

const answers = [
  ['an empty answer', []],
  ['a null answer', null],
  ['an undefined answer', undefined],
  ['a non-array answer', '93.184.216.34'],
  ['an answer that is not an address', ['not-an-ip']],
  ['an answer with a numeric entry', [12345]],
  ['an answer mixing a valid and an invalid entry', ['93.184.216.34', 'garbage']],
]

for (const [name, answer] of answers) {
  test(`refuses ${name}`, async () => {
    setMediaHostResolver(async () => answer)
    try {
      await assert.rejects(() => assertPublicMediaUrl(HOST), /已拒绝|无法解析/)
    } finally {
      setMediaHostResolver(async () => ['93.184.216.34'])
    }
  })
}

test('refuses an answer that is entirely private', async () => {
  setMediaHostResolver(async () => ['10.1.2.3'])
  try {
    await assert.rejects(() => assertPublicMediaUrl(HOST), /解析到内网地址/)
  } finally {
    setMediaHostResolver(async () => ['93.184.216.34'])
  }
})

test('refuses an answer that mixes a public and a private address', async () => {
  setMediaHostResolver(async () => ['93.184.216.34', '127.0.0.1'])
  try {
    await assert.rejects(() => assertPublicMediaUrl(HOST), /解析到内网地址 127\.0\.0\.1/)
  } finally {
    setMediaHostResolver(async () => ['93.184.216.34'])
  }
})

test('refuses when the resolver throws', async () => {
  setMediaHostResolver(async () => {
    throw new Error('ENOTFOUND')
  })
  try {
    await assert.rejects(() => assertPublicMediaUrl(HOST), /无法解析下载主机/)
  } finally {
    setMediaHostResolver(async () => ['93.184.216.34'])
  }
})

test('refuses when the resolver never answers', async () => {
  setMediaHostResolver(() => new Promise(() => {}))
  try {
    await assert.rejects(() => assertPublicMediaUrl(HOST), /解析超时/)
  } finally {
    setMediaHostResolver(async () => ['93.184.216.34'])
  }
})

test('allows a clean public answer', async () => {
  setMediaHostResolver(async () => ['93.184.216.34', '93.184.216.35'])
  try {
    await assert.doesNotReject(() => assertPublicMediaUrl(HOST))
  } finally {
    setMediaHostResolver(async () => ['93.184.216.34'])
  }
})
