import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseGatewayJson } from '../src/protocol/messages.js'

/**
 * The gateway sends `message_id` as a JSON number and the quoted message's `msg_id` as a
 * string. JSON.parse rounds the first and leaves the second exact, so a quote could
 * never be looked up. This is the regression test for that.
 */
const PAYLOAD = `{
  "ret": 0,
  "msgs": [{
    "message_id": 7522876884340597128,
    "seq": 79,
    "item_list": [{
      "type": 1,
      "text_item": { "text": "这个呢" },
      "ref_msg": { "message_item": { "msg_id": "7522876884340597128" } }
    }]
  }]
}`

test('JSON.parse loses precision on a 64-bit id — the bug this guards against', () => {
  const naive = JSON.parse(PAYLOAD)
  assert.equal(String(naive.msgs[0].message_id), '7522876884340597000')
  assert.notEqual(String(naive.msgs[0].message_id), '7522876884340597128')
})

test('parseGatewayJson keeps both ids exact and equal', () => {
  const parsed = parseGatewayJson(PAYLOAD)
  const id = parsed.msgs[0].message_id
  const ref = parsed.msgs[0].item_list[0].ref_msg.message_item.msg_id
  assert.equal(id, '7522876884340597128')
  assert.equal(ref, '7522876884340597128')
  assert.equal(typeof id, 'string')
})

test('ordinary fields are untouched', () => {
  const parsed = parseGatewayJson(
    '{"a":1,"b":1793593615000,"c":"x","d":true,"e":{"f":[1,2]},"ret":0}',
  )
  assert.deepEqual(parsed, { a: 1, b: 1793593615000, c: 'x', d: true, e: { f: [1, 2] }, ret: 0 })
  assert.equal(typeof parsed.b, 'number', 'a 13-digit timestamp stays a number')
})
