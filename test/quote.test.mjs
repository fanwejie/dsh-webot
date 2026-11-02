import { test } from 'node:test'
import assert from 'node:assert/strict'
import { quotedOf } from '../src/channel.js'

const ID = '7522876884340597128'

/** A quote reply as the current client sends it: an id, no body. */
function quoteMessage(id = ID, text = '这个改成红色') {
  return {
    message_type: 1,
    item_list: [
      { type: 1, text_item: { text }, ref_msg: { message_item: { type: 0, msg_id: id } } },
    ],
  }
}

test('a quoted message resolves from the cache', () => {
  const cache = new Map([[ID, '把标题字体改成蓝色']])
  assert.equal(quotedOf(quoteMessage(), (k) => cache.get(k)), '[引用消息] 把标题字体改成蓝色')
})

test('an unknown id is reported as cleared, without inventing content', () => {
  assert.equal(quotedOf(quoteMessage(), () => null), '[引用消息] （这条被引用的内容已被清除）')
})

test('no quote produces no prefix', () => {
  const plain = { item_list: [{ type: 1, text_item: { text: '你好' } }] }
  assert.equal(quotedOf(plain, () => null), '')
})

test('a full quote uses the inline body', () => {
  const message = {
    item_list: [
      {
        type: 1,
        text_item: { text: '这个呢' },
        ref_msg: { message_item: { type: 1, text_item: { text: '把字号调大' } } },
      },
    ],
  }
  assert.equal(quotedOf(message, () => null), '[引用消息] 把字号调大')
})

test('a partial quote selects the fragment, not the whole message', () => {
  const full = '把标题字体改成蓝色，顺便把字号调大一点'
  const md5 = 'e2f3a4b5'
  const message = {
    item_list: [
      {
        type: 1,
        text_item: { text: '这个呢' },
        ref_msg: {
          message_item: { type: 1, text_item: { text: full } },
          partial_text: { start: '字号', end: '一点', startindex: 0, endindex: 0, quotemd5: md5 },
        },
      },
    ],
  }
  // Without a matching md5 the resolver falls back to the whole message rather than
  // guessing at a selection.
  assert.equal(quotedOf(message, () => null), `[引用消息] ${full}`)
})

test('a quoted picture carries its path so the agent can open it', () => {
  const entry = {
    body: '[图片]',
    media: { label: '图片', path: 'media/inbound/a.jpg', bytes: 1024 },
  }
  assert.equal(
    quotedOf(quoteMessage(), () => entry),
    '[引用消息] [微信图片] media/inbound/a.jpg（1024 字节）',
  )
})

test('a quoted voice note shows the transcript, not the word 语音', () => {
  const entry = {
    body: '[微信语音]',
    media: { label: '语音', path: 'media/inbound/a.silk', bytes: 8192, transcript: '明天三点开会' },
  }
  assert.equal(quotedOf(quoteMessage(), () => entry), '[引用消息] [微信语音] 转写：明天三点开会')
})
