/**
 * iLink message verbs.
 *
 * Mirrors `getUpdates` / `sendMessage` from `src/api/api.ts` and the text entry
 * built by `buildTextMessageReq` in `src/messaging/send.ts`
 * (`@tencent-weixin/openclaw-weixin@2.4.10`, MIT, Tencent).
 *
 * The outbound entry carries exactly the fields the official client sets and no
 * others. The upstream documentation is explicit that extra item fields make the
 * server accept a message the phone then renders as a broken frame, so this
 * function is deliberately narrow rather than "whatever looks reasonable".
 *
 * @module dsh-webot/protocol/messages
 */

import crypto from 'node:crypto'

import { ilinkPost } from './http.js'

/** `MessageType.BOT` — the only sender type this plugin writes. */
const MESSAGE_TYPE_BOT = 2

/** `MessageState.FINISH` — a complete, non-streaming item. */
const MESSAGE_STATE_FINISH = 2

/** `MessageItemType.TEXT`. */
const MESSAGE_ITEM_TEXT = 1

/** `MessageType.USER` — the only sender type this plugin reads. */
export const MESSAGE_TYPE_USER = 1

/** Bot identity reported to the gateway on every request. */
const CHANNEL_VERSION = '0.3.0'

function baseInfo() {
  return { channel_version: CHANNEL_VERSION, bot_agent: `weBot/${CHANNEL_VERSION}` }
}

function newClientId() {
  return `webot-${crypto.randomUUID()}`
}

/**
 * Long-poll for new messages.
 *
 * `get_updates_buf` is a server-issued cursor. Sending the previous value is what
 * makes the poll incremental; sending `''` re-requests from the server's current
 * position. It must be persisted across restarts or messages between shutdown and
 * startup are lost.
 *
 * A client-side timeout surfaces as a thrown error and is normal: the server holds
 * the request until there is something to say.
 */
export async function getUpdates({ baseUrl, token, syncBuffer, timeoutMs = 35_000, signal }) {
  const raw = await ilinkPost({
    baseUrl,
    endpoint: 'ilink/bot/getupdates',
    payload: { get_updates_buf: syncBuffer || '', base_info: baseInfo() },
    token,
    timeoutMs,
    signal,
    label: 'getupdates',
  })
  return JSON.parse(raw)
}

/** Send one plain-text message to `toUserId`, echoing the conversation's context token. */
export async function sendText({ baseUrl, token, toUserId, text, contextToken, signal }) {
  const msg = {
    from_user_id: '',
    to_user_id: toUserId,
    client_id: newClientId(),
    message_type: MESSAGE_TYPE_BOT,
    message_state: MESSAGE_STATE_FINISH,
    item_list: [{ type: MESSAGE_ITEM_TEXT, text_item: { text } }],
  }
  if (contextToken) msg.context_token = contextToken

  const raw = await ilinkPost({
    baseUrl,
    endpoint: 'ilink/bot/sendmessage',
    payload: { msg, base_info: baseInfo() },
    token,
    timeoutMs: 20_000,
    signal,
    label: 'sendmessage',
  })
  const parsed = JSON.parse(raw)
  if (parsed.ret && parsed.ret !== 0) {
    throw new Error(`sendmessage ret=${parsed.ret} errmsg=${parsed.errmsg || '(none)'}`)
  }
  return parsed
}
