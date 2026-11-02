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

/** The `base_info` every CGI request carries; exported for the upload path. */
export function requestBaseInfo() {
  return baseInfo()
}

function newClientId() {
  return `webot-${crypto.randomUUID()}`
}

/**
 * Parse a gateway response without rounding its 64-bit ids.
 *
 * `message_id`, `msg_id` and `svr_id` are uint64 on the wire. `JSON.parse` turns a
 * numeric literal into a double, so 7522876884340597128 arrives as 7522876884340597000 —
 * the trailing digits are gone before any code sees them. That is not cosmetic: a quote
 * names the quoted message by the exact id, so a rounded key can never match it, and the
 * lookup fails while looking perfectly reasonable.
 *
 * The raw text is therefore rewritten to quote any long integer under those keys before
 * parsing, which is what "parsed losslessly as a string" means in the protocol notes.
 * Sixteen digits is the threshold: real ids are 19, timestamps are 13.
 */
export function parseGatewayJson(raw) {
  const guarded = String(raw).replace(
    /("(?:message_id|msg_id|svr_id|server_id|msgid)"\s*:\s*)(\d{16,})/g,
    '$1"$2"',
  )
  return JSON.parse(guarded)
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
  return parseGatewayJson(raw)
}

/** Send one `MessageItem` and echo the conversation's context token. */
export async function sendItem({ baseUrl, token, toUserId, item, contextToken, signal }) {
  const submit = async (withContext) => {
    const msg = {
      from_user_id: '',
      to_user_id: toUserId,
      client_id: newClientId(),
      message_type: MESSAGE_TYPE_BOT,
      message_state: MESSAGE_STATE_FINISH,
      item_list: [item],
    }
    if (withContext && contextToken) msg.context_token = contextToken

    const raw = await ilinkPost({
      baseUrl,
      endpoint: 'ilink/bot/sendmessage',
      payload: { msg, base_info: baseInfo() },
      token,
      timeoutMs: 20_000,
      signal,
      label: 'sendmessage',
    })
    // Parsed the same way as getupdates: the id this returns is what a later quote of
    // our own message will name, so it has to be exact too.
    const parsed = parseGatewayJson(raw)
    if (parsed.ret && parsed.ret !== 0) {
      throw new Error(`sendmessage ret=${parsed.ret} errmsg=${parsed.errmsg || '(none)'}`)
    }
    return parsed
  }

  try {
    return await submit(true)
  } catch (error) {
    // `ret=-2 prepare failed` is what a token the gateway will not accept looks
    // like — a stale one, or one whose conversation has moved on. A proactive
    // message with no token at all is accepted, so retry once bare rather than
    // losing the message over the token.
    if (contextToken && /ret=-2\b/.test(String((error && error.message) || ''))) {
      return submit(false)
    }
    throw error
  }
}

/** Send one plain-text message to `toUserId`, echoing the conversation's context token. */
export async function sendText({ baseUrl, token, toUserId, text, contextToken, signal }) {
  return sendItem({
    baseUrl,
    token,
    toUserId,
    item: { type: MESSAGE_ITEM_TEXT, text_item: { text } },
    contextToken,
    signal,
  })
}
