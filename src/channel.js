/**
 * The channel proper: long poll in, agent turn in the middle, WeChat reply out.
 *
 * One poll loop per bound account, one DSH session per WeChat conversation, and a
 * reply aggregator that turns `agent/assistant-stream` text deltas into one WeChat
 * message per answer.
 *
 * ## When the reply is sent
 *
 * Nothing is forwarded automatically. The agent composes each message through
 * `send_to_wechat`, so it owns what is said, how many messages there are, and
 * whether this turn answers at all — the decision the previous auto-forward could
 * not make, and the reason one answer used to arrive as two mismatched messages.
 *
 * The stream is still accumulated, but only as evidence: when the turn's driver
 * goes `idle`, `retireTurnText` records how much the model drafted and how many
 * sends it actually made. `tool-sends=0` next to a non-empty draft is a reply that
 * went nowhere, and that is the one failure this design can produce.
 *
 * @module dsh-webot/channel
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { MESSAGE_TYPE_USER, getUpdates, sendText } from './protocol/messages.js'
import { downloadMedia, extensionForName } from './protocol/media.js'
import { sendMediaToWeChat } from './protocol/outbound-media.js'
import { ANCHOR_REMINDER, composeTail } from './persona.js'
import { PRESENCE_SUPPORTED, atTheDesk, watchDesk } from './presence.js'
import { activeScenario, appendEventLog, readState, updateState } from './state.js'

/** Longest slice of one answer sent as a single WeChat message. */
const MAX_REPLY_CHARS = 1200

/** The full session listing is reused for this long; a finished task is not urgent. */
const SESSION_CACHE_MS = 60_000

/** Pause after a poll or send failure before trying again. */
const RETRY_MS = 1500

/** How many inbound message ids to remember for duplicate suppression. */
const SEEN_LIMIT = 500

/**
 * How many message bodies to keep for resolving quotes.
 *
 * The current WeChat client sends a quote as an id with no content, so this cache is
 * the only source of the quoted text. Sized for a long conversation on one phone.
 */
const QUOTE_CACHE_LIMIT = 1000

/**
 * How long a message body is kept so it can be quoted.
 *
 * Seven days, then it is gone — not marked expired, deleted, from memory and from the
 * state file both. A quote that lands after that resolves to nothing and is reported
 * to the agent as cleared.
 */
const QUOTE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

/** How often the retention sweep runs while the channel is up. */
const QUOTE_PRUNE_INTERVAL_MS = 60 * 60 * 1000

/** Abortable sleep. */
function sleep(ms, signal) {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
  })
}

/** Text carried by one item: plain text, or a voice note's transcription. */
function textOfItem(item) {
  if (!item || typeof item !== 'object') return ''
  if (item.type === 1 && item.text_item && typeof item.text_item.text === 'string') {
    return item.text_item.text
  }
  // A voice note usually arrives with the service's own transcription; using it
  // means voice works without any codec, just without word-level fidelity.
  if (item.type === 3 && item.voice_item && typeof item.voice_item.text === 'string') {
    return item.voice_item.text
  }
  return ''
}

/** Extract the text of one inbound item list, ignoring anything unsupported yet. */
function textOf(message) {
  const items = Array.isArray(message.item_list) ? message.item_list : []
  for (const item of items) {
    const text = textOfItem(item)
    if (text) return text
  }
  return ''
}

/** A quoted message that was itself a picture or a file has no text to quote. */
function labelOfItem(item) {
  if (!item || typeof item !== 'object') return ''
  const label = MEDIA_ITEM_LABELS.get(item.type)
  return label ? `[${label}]` : ''
}

/** Index of the `occurrence`-th match of `value` in `text`, or -1. */
function nthIndexOf(text, value, occurrence, fromIndex = 0) {
  if (!value || !Number.isInteger(occurrence) || occurrence < 0) return -1
  let position = fromIndex
  for (let current = 0; current <= occurrence; current += 1) {
    position = text.indexOf(value, position)
    if (position < 0) return -1
    if (current < occurrence) position += value.length
  }
  return position
}

/**
 * The selected part of a quoted message, when the user quoted only a fragment.
 *
 * `startindex` / `endindex` are **occurrence numbers, not character offsets**. Reading
 * them as offsets is what made the first version of this function return the whole
 * message while looking like it worked. Both readings the client has been observed to
 * use are tried, and a candidate is verified against `quotemd5` when the payload
 * carries one — the same approach the upstream client uses (MIT, Tencent).
 */
function resolvePartial(fullText, partial) {
  if (!fullText || !partial || typeof partial !== 'object') return ''
  const startText = typeof partial.start === 'string' ? partial.start : ''
  const endText = typeof partial.end === 'string' ? partial.end : ''
  if (!startText || !endText) return ''

  const build = (relative) => {
    const start = nthIndexOf(fullText, startText, Number(partial.startindex))
    if (start < 0) return ''
    const end = nthIndexOf(
      fullText,
      endText,
      Number(partial.endindex),
      relative ? start + startText.length : 0,
    )
    if (end < start) return ''
    return fullText.slice(start, end + endText.length)
  }

  const candidates = [build(false), build(true)].filter(
    (value, index, all) => value && all.indexOf(value) === index,
  )
  if (candidates.length === 0) return ''

  const expected = typeof partial.quotemd5 === 'string' ? partial.quotemd5.trim().toLowerCase() : ''
  if (!expected) return candidates[0]
  return (
    candidates.find(
      (value) => crypto.createHash('md5').update(value, 'utf8').digest('hex') === expected,
    ) || ''
  )
}

/**
 * The id a quote reply points at, when the client sent no content of its own.
 *
 * `ref.svr_id` is the server id of the quoted message; older clients also inline the
 * message itself, in which case the id is on `ref.message_item.msg_id`.
 */
function quoteRefId(message) {
  const items = Array.isArray(message.item_list) ? message.item_list : []
  const holder = items.find((item) => item && typeof item === 'object' && item.ref_msg)
  const ref = holder && holder.ref_msg
  if (!ref || typeof ref !== 'object') return ''
  const svr = typeof ref.svr_id === 'string' ? ref.svr_id.trim() : ''
  if (svr) return svr
  return ref.message_item && typeof ref.message_item.msg_id === 'string'
    ? ref.message_item.msg_id.trim()
    : ''
}

/**
 * The message being replied to, rendered as a prefix for the prompt.
 *
 * WeChat sends a quote reply as an extra item carrying `ref_msg`, not as text inside
 * the reply. Reading only the text item is why a quoted message looked invisible:
 * the agent received "这个改成红色" with no idea what 这个 was.
 *
 * The quoted body can come from four places, in order of usefulness:
 *   ref.message_item — the whole quoted message, when the client sends it;
 *   ref.partial_text — the fragment the user selected, when they quoted only part;
 *   ref.title        — a short summary, which is all some clients send;
 *   lookup(svr_id)   — the message cache, because the current WeChat client sends only
 *                      an id, and the body has to be one that went past before.
 *
 * Nothing is invented when the id resolves to nothing. The agent is told the quoted
 * content has been cleared, which is true whether it aged out or was never kept, and
 * is the one thing it needs to know in order to ask instead of guessing.
 */
export function quotedOf(message, lookup) {
  const items = Array.isArray(message.item_list) ? message.item_list : []
  const holder = items.find((item) => item && typeof item === 'object' && item.ref_msg)
  const ref = holder && holder.ref_msg
  if (!ref || typeof ref !== 'object') return ''

  const quotedItem =
    ref.message_item && typeof ref.message_item === 'object' ? ref.message_item : null
  const body = quotedItem ? textOfItem(quotedItem) || labelOfItem(quotedItem) : ''
  const summary = typeof ref.title === 'string' ? ref.title.trim() : ''

  const selected = resolvePartial(body, ref.partial_text).trim()

  const id = quoteRefId(message)
  let cached = ''
  let cachedMedia = null
  if (typeof lookup === 'function' && id) {
    try {
      const hit = lookup(id)
      if (hit && typeof hit === 'object') {
        cached = String(hit.body || '').trim()
        cachedMedia = hit.media || null
      } else {
        cached = String(hit || '').trim()
      }
    } catch {
      cached = ''
    }
  }

  // A quoted picture or file is only useful if the agent is told where it is: the point
  // of quoting a screenshot is to have it looked at, and "[图片]" alone gives it nothing
  // to open.
  let mediaLine = ''
  if (cachedMedia && cachedMedia.path) {
    mediaLine = cachedMedia.transcript
      ? `[微信语音] 转写：${cachedMedia.transcript}`
      : `[微信${cachedMedia.label}] ${cachedMedia.path}（${cachedMedia.bytes} 字节）`
  }

  // The media line wins over the cached body when both exist: the body for a file is
  // often just the label ("[图片]"), while the line carries the path the agent needs —
  // and for a voice note it carries the transcript instead of the word "语音".
  const content = selected || body || summary || mediaLine || cached
  if (!content) {
    // The id stays out of the prompt: it means nothing to the agent, and the point of
    // the message is only that this content is gone.
    return '[引用消息] （这条被引用的内容已被清除）'
  }
  return `[引用消息] ${content}`
}

/** Item types carried into a session, with the label used in the attached note. */
const MEDIA_ITEM_LABELS = new Map([
  [2, '图片'],
  [3, '语音'],
  [4, '文件'],
  [5, '视频'],
])

/** The same labels for the outbound sender, which reports a kind rather than a type. */
const MEDIA_KIND_LABELS = new Map([
  ['image', '图片'],
  ['video', '视频'],
  ['file', '文件'],
])

/** How many media items one message may carry in. */
const MAX_MEDIA_PER_MESSAGE = 3

/**
 * Default and bounds for how long an inbound file waits for its follow-up text.
 *
 * Zero is allowed and means "do not wait": the file is delivered at once, with any
 * text it arrived with. That is the off switch for the whole merge window.
 */
const DEFAULT_MEDIA_MERGE_SEC = 20
const MAX_MEDIA_MERGE_SEC = 300

/** Media items of one inbound message, in arrival order. */
function mediaItemsOf(message) {
  const items = Array.isArray(message.item_list) ? message.item_list : []
  return items.filter((item) => item && MEDIA_ITEM_LABELS.has(item.type))
}

/** The per-type payload object of one media item. */
function mediaPayload(item) {
  switch (item.type) {
    case 2:
      return item.image_item
    case 3:
      return item.voice_item
    case 4:
      return item.file_item
    case 5:
      return item.video_item
    default:
      return undefined
  }
}

/** Split one answer into WeChat-sized pieces, preferring newline boundaries. */
function splitReply(text, limit = MAX_REPLY_CHARS) {
  const max = Number(limit) > 0 ? Number(limit) : MAX_REPLY_CHARS
  if (text.length <= max) return [text]
  const parts = []
  let rest = text
  while (rest.length > max) {
    const window = rest.slice(0, max)
    const cut = Math.max(window.lastIndexOf('\n'), window.lastIndexOf('。'), window.lastIndexOf('. '))
    const end = cut > max * 0.4 ? cut + 1 : max
    parts.push(rest.slice(0, end))
    rest = rest.slice(end)
  }
  if (rest) parts.push(rest)
  return parts
}

/**
 * Bubble splitting — idle while replies are tool-only.
 *
 * Nothing calls this any more: the agent composes each message through
 * `send_to_wechat`, so segmentation is its decision and this splitter would only
 * second-guess it. It stays because it is the piece a future "auto-forward unless
 * the agent already sent" mode needs, and it is tested.
 *
 * Characters that end a bubble when the answer is prose.
 *
 * Closing Chinese quotes are included on purpose: a quoted phrase is where a
 * person stops and starts a new message ("…别是"在吗"" / "之后接一句广告"), and the
 * ASCII quote is deliberately absent — it shows up inside code and English, where
 * a split would be wrong.
 */
const BUBBLE_ENDERS = new Set(['。', '！', '？', '!', '?', '…', '\n', '」', '”', '』'])

/**
 * Punctuation that cannot open a sentence.
 *
 * A closing quote followed by one of these is mid-sentence ("他说"在吗"，然后…"), so
 * the boundary is not a boundary. Without this, the comma is left dangling at the
 * start of the next bubble — which is exactly how a bubble came out reading "，在吗".
 */
const CONTINUATION = new Set(['，', ',', '、', '；', ';', '：', ':'])

/** True when the next non-space character continues the same sentence. */
function continuesSentence(text, from) {
  let index = from
  while (index < text.length && /\s/.test(text[index])) index += 1
  return index < text.length && CONTINUATION.has(text[index])
}

/** More bubbles than this reads as spam; the tail is merged back instead. */
const MAX_BUBBLES = 4

/**
 * A reply shorter than this stays one message.
 *
 * Measured from real traffic: a 73-character answer was being cut into four
 * messages of 10/45/4/12 characters. Splitting is supposed to make a long answer
 * look like texting, not to shred a short one.
 */
const MIN_SPLIT_CHARS = 40

/**
 * A bubble shorter than this is a fragment, not a message.
 *
 * "还在转。" as its own WeChat message is noise; it belongs on the end of whatever
 * it follows.
 */
const MIN_BUBBLE_CHARS = 12

/**
 * A structured answer must never be chopped into bubbles.
 *
 * Code fences, list markers and tables carry meaning across their line breaks, and
 * splitting them turns one readable answer into several broken fragments.
 */
const STRUCTURED = /```|^\s*[-*]\s|^\s*\d+\.\s|^\s*\|/m

/**
 * Split one agent answer into separate WeChat messages, one per sentence.
 *
 * This is what makes a reply read like texting instead of a wall: "你要说的事最好
 * 别是在吗" and "之后接一句广告" arrive as two bubbles. Only prose is split — a
 * structured answer, or anything past {@link MAX_BUBBLES}, falls back to the plain
 * size-based chunking.
 */
function splitBubbles(text, limit = MAX_REPLY_CHARS) {
  const trimmed = String(text || '').trim()
  if (!trimmed) return []
  if (STRUCTURED.test(trimmed)) return splitReply(trimmed)
  // Short answers are already the thing splitting is trying to produce.
  if (trimmed.length <= MIN_SPLIT_CHARS) return splitReply(trimmed)

  const sentences = []
  let buffer = ''
  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index]
    buffer += char
    if (!BUBBLE_ENDERS.has(char)) continue
    // A boundary only counts when what follows starts a new thought.
    if (continuesSentence(trimmed, index + 1)) continue
    const sentence = buffer.trim()
    if (sentence) sentences.push(sentence)
    buffer = ''
  }
  if (buffer.trim()) sentences.push(buffer.trim())

  // Belt and braces: a fragment that still opens with punctuation belongs to the
  // bubble before it, and a fragment that is *only* punctuation is the tail of the
  // previous one — "“在吗？”" must not produce a bubble containing just a quote.
  // No message a person sends starts with a comma or is a lone bracket.
  for (let index = sentences.length - 1; index > 0; index -= 1) {
    const current = sentences[index]
    if (/^[\p{P}\p{S}\s]+$/u.test(current)) {
      sentences[index - 1] += current
      sentences.splice(index, 1)
      continue
    }
    const match = /^[，,、；;：:]+/.exec(current)
    if (!match) continue
    sentences[index - 1] += match[0]
    const rest = current.slice(match[0].length).trim()
    if (rest) sentences[index] = rest
    else sentences.splice(index, 1)
  }

  // Merge fragments: a piece too short to stand alone, or one that would follow a
  // piece too short to stand alone, joins its neighbour. Both sides are checked so
  // a short opening sentence does not leave a two-character tail behind it.
  const merged = []
  for (const sentence of sentences) {
    const previous = merged[merged.length - 1]
    if (previous !== undefined && (sentence.length < MIN_BUBBLE_CHARS || previous.length < MIN_BUBBLE_CHARS)) {
      merged[merged.length - 1] = previous + sentence
      continue
    }
    merged.push(sentence)
  }

  if (merged.length <= 1) return splitReply(trimmed)

  if (merged.length > MAX_BUBBLES) {
    const head = merged.slice(0, MAX_BUBBLES - 1)
    // Joined without a separator: the pieces are already trimmed fragments of the
    // same sentence run, and a space would show up in the bubble.
    head.push(merged.slice(MAX_BUBBLES - 1).join(''))
    return head.flatMap((part) => splitReply(part))
  }

  return merged.flatMap((part) => splitReply(part))
}

/** Commands handled by the channel itself; anything else reaches the agent. */
const KNOWN_COMMANDS = new Set(['help', 'list', 'switch', 'new', 'current', 'cancel'])

/** Rows one `/list` screen shows. */
const MAX_LIST_ROWS = 10

/** Last six characters of a session id — the part that fits on a phone. */
function shortId(sessionId) {
  return String(sessionId).slice(-6)
}

/** Last segment of a workspace path, for a readable name in a notification. */
function baseName(directory) {
  const trimmed = String(directory || '').replace(/[\\/]+$/, '')
  const parts = trimmed.split(/[\\/]/).filter(Boolean)
  return parts.length ? parts[parts.length - 1] : trimmed
}

/** Best-effort title: `SessionSummary` has none, projections may. */
function readTitle(item) {
  const values = item && item.projections && item.projections.values
  if (!values || typeof values !== 'object') return ''
  for (const key of ['title', 'sessionTitle', 'name', 'label']) {
    const value = values[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

/**
 * What a reply to a permission prompt means.
 *
 * Numbers first because a phone is a bad keyboard, words second because `1` on
 * a keyboard is fine but `1` as a *message* invites typos.
 */
const APPROVAL_ANSWERS = new Map([
  ['1', 'allowed-once'],
  ['允许', 'allowed-once'],
  ['同意', 'allowed-once'],
  ['好', 'allowed-once'],
  ['y', 'allowed-once'],
  ['yes', 'allowed-once'],
  ['2', 'rejected'],
  ['拒绝', 'rejected'],
  ['不', 'rejected'],
  ['n', 'rejected'],
  ['no', 'rejected'],
  ['3', 'cancelled'],
  ['取消', 'cancelled'],
])

/** Map one phone reply to an approval outcome, or '' when it is not an answer. */
function parseApprovalAnswer(text) {
  return APPROVAL_ANSWERS.get(String(text || '').trim().toLowerCase()) || ''
}

/**
 * Split `/name rest` into a command. Returns null for anything that is not one,
 * so ordinary text that happens to start with a slash still reaches the agent.
 */
function parseCommand(text) {
  const match = /^\/([A-Za-z]+)\s*([\s\S]*)$/.exec(String(text || '').trim())
  if (!match) return null
  return { name: match[1].toLowerCase(), argument: match[2].trim() }
}

const HELP_TEXT = [
  '可用命令：',
  '/list — 列出会话（带序号和短 id）',
  '/switch 3 — 按序号切换；也可 /switch a1b2c3 按短 id',
  '/new 标题 — 新建会话并切过去',
  '/current — 当前会话',
  '/cancel — 停止正在跑的任务',
  '/help — 这份说明',
  '',
  '其它任何内容都会直接发给当前会话的 agent。',
].join('\n')

/** Read the session a stream payload belongs to, tolerating host shape changes. */
function sessionIdOf(payload) {
  const direct = payload && payload.agent && payload.agent.session && payload.agent.session.id
  if (typeof direct === 'string') return direct
  const fallback = payload && payload.agent && payload.agent.id
  return typeof fallback === 'string' ? fallback : ''
}

/**
 * Build the channel.
 *
 * @param options.sessionController - Host session service (`create`, `prompt`).
 * @param options.workspaceDirectory - Fixed `cwd` for WeChat-created sessions.
 * @param options.onBoundAccount - called with an account id whose loop started.
 * @returns the channel handle.
 */
export function createChannel(options) {
  const { sessionController, workspaceDirectory } = options

  /** accountId -> AbortController for its poll loop. */
  const loops = new Map()
  /** Inbound message ids already dispatched. */
  const seen = new Set()
  /** sessionId -> where its answer goes. */
  const replyTargets = new Map()
  /** sessionId -> text accumulated for the answer in flight. */
  const pendingText = new Map()
  /** sessionId -> settle timer. */
  const settleTimers = new Map()
  /** accountId -> last error text, for the panel. */
  const accountErrors = new Map()
  /**
   * conversationKey -> session ids of the last `/list` screen, in display order.
   *
   * `/switch 3` must mean "row 3 of the screen you are looking at". Sessions run
   * while the list is on screen, so resolving against a freshly fetched list at
   * switch time can pick a different session than the one numbered. Memory only:
   * after a restart the user re-runs `/list`.
   */
  const lastList = new Map()
  /**
   * conversationKey -> the one pending permission decision.
   *
   * The agent turn is blocked while this exists, so at most one per conversation:
   * a second request delegates instead of stacking, which is what keeps a bare
   * "1" unambiguous.
   */
  const pendingApprovals = new Map()
  /**
   * conversationKey -> the one pending structured question.
   *
   * Same one-at-a-time rule as approvals, for the same reason: a bare "2" has to
   * mean one thing.
   */
  const pendingQuestions = new Map()
  /**
   * conversationKey -> when the full prompt last went out.
   *
   * In memory on purpose: a restart should re-send the note once, which is what an
   * empty map does. Persisting it would suppress the reminder exactly when the
   * process — and its context — just came back.
   */
  /**
   * sessionId -> how many turns ago the full prompt last went out.
   *
   * Persisted, so a restart no longer re-sends the note. It used to be in-memory on the
   * theory that a returning process needs its context back, but the conversation keeps
   * its own history across a restart: the note is still there, and re-sending it every
   * boot only adds tokens alongside the anchor line that already went out.
   *
   * Keyed by session, not by conversation: `/new` starts a session whose context really
   * is empty, and that one does need the note.
   */
  const promptMarks = new Map()

  /** Every mark is written through: one state write per turn is already the norm here. */
  function savePromptMark(sessionId, mark) {
    promptMarks.set(sessionId, mark)
    try {
      updateState({
        promptMarks: Object.fromEntries(promptMarks),
      })
    } catch {
      /* a failed write costs one extra reminder, never a lost message */
    }
  }

  // Hydrate before the first message can be handled, so a restart resumes the schedule
  // instead of restarting it.
  {
    const stored = readState().promptMarks || {}
    for (const [sessionId, mark] of Object.entries(stored)) {
      if (!sessionId || !mark || typeof mark !== 'object') continue
      promptMarks.set(sessionId, {
        turns: Number(mark.turns) || 0,
        text: String(mark.text || ''),
      })
    }
  }
  /**
   * sessionId -> generation of the newest "task finished elsewhere" watch.
   *
   * A session that finishes twice supersedes its own earlier watch. The older
   * sampler keeps running until its window closes and is then ignored by comparing
   * generations, which is simpler than killing a child process mid-sleep.
   */
  const doneNotices = new Map()
  /** One log line per process when the presence probe is unsupported, not one per task. */
  let presenceWarned = false
  /** One listing of every session on the machine, refreshed at most this often. */
  let sessionCache = { at: 0, items: [] }
  /**
   * sessionId -> sends made through `send_to_wechat` during the current turn.
   *
   * Reset when a turn is submitted and read when it goes idle: zero sends plus a
   * non-empty draft is the silent-drop case, and it is the only thing standing
   * between this design and an invisible failure.
   */
  const toolSends = new Map()
  /**
   * conversationKey -> files held for their follow-up text.
   *
   * In memory only: a restart inside the window loses the file, which is the same
   * outcome as the process being killed before the agent ran.
   */
  const contentBuffers = new Map()

  /**
   * Ring buffer of what this channel actually did.
   *
   * The whole path — poll, dispatch, prompt, stream, send — crosses three
   * processes and two protocols, and every stage fails silently by design: a
   * dropped stream frame and an unsent message look identical from outside. This
   * is the only way to tell which stage ran, and it is cheap.
   */
  const events = []

  function note(kind, detail) {
    const text = String(detail === undefined ? '' : detail).slice(0, 300)
    events.push({ at: Date.now(), kind, detail: text })
    if (events.length > 80) events.shift()
    appendEventLog(kind, text)
  }

  function recordError(accountId, error) {
    const message = String((error && error.message) || error)
    accountErrors.set(accountId, message)
    try {
      updateState({ lastError: { at: Date.now(), message: message.slice(0, 500) } })
    } catch {
      /* the state file is best effort here; never fail a message over it */
    }
  }

  function clearError(accountId) {
    if (accountErrors.delete(accountId)) {
      try {
        updateState({ lastError: null })
      } catch {
        /* ignore */
      }
    }
  }

  function remember(messageId) {
    if (!messageId) return false
    if (seen.has(messageId)) return true
    seen.add(messageId)
    if (seen.size > SEEN_LIMIT) {
      const oldest = seen.values().next().value
      seen.delete(oldest)
    }
    return false
  }

  /**
   * Release a message id so it may be processed again.
   *
   * Used only when processing threw: the duplicate guard exists to stop the gateway
   * replaying a message, not to make a failed one permanent.
   */
  function forget(messageId) {
    const key = String(messageId || '')
    if (key) seen.delete(key)
  }

  /** How many replays a failed message gets before it is abandoned. */
  const MAX_PENDING_ATTEMPTS = 3

  /**
   * Keep a message that failed twice, so the next start can try it again.
   *
   * The poll cursor has already moved past it, so the gateway will never resend it.
   * Replay is at-least-once: a message that threw after delivery may be delivered
   * again, which is the trade taken over losing it silently.
   */
  function queuePendingInbound(accountId, userId, message) {
    const id = String((message && message.message_id) || '')
    if (!id) return
    const state = readState()
    const list = Array.isArray(state.pendingInbound) ? [...state.pendingInbound] : []
    const index = list.findIndex((entry) => String(entry.message?.message_id || '') === id)
    const previous = index >= 0 ? Number(list[index].attempts) || 0 : 0
    const record = { accountId, userId, message, at: Date.now(), attempts: previous + 1 }
    if (index >= 0) list[index] = record
    else list.push(record)
    // Oldest first out, so a burst of failures cannot grow without bound.
    while (list.length > 20) list.shift()
    try {
      updateState({ pendingInbound: list })
    } catch {
      /* a failed write must not cascade into another failure */
    }
  }

  function dropPendingInbound(messageId) {
    const id = String(messageId || '')
    if (!id) return
    const state = readState()
    const list = Array.isArray(state.pendingInbound) ? state.pendingInbound : []
    const next = list.filter((entry) => String(entry.message?.message_id || '') !== id)
    if (next.length === list.length) return
    try {
      updateState({ pendingInbound: next })
    } catch {
      /* ignore */
    }
  }

  /**
   * Try the messages that failed last time.
   *
   * Runs once at start, before polling resumes. Ids are released from the duplicate
   * guard first, because they were registered before the failure.
   */
  async function replayPendingInbound() {
    const entries = readState().pendingInbound
    if (!Array.isArray(entries) || entries.length === 0) return
    const accounts = new Map(readState().accounts.map((account) => [account.accountId, account]))
    let delivered = 0
    for (const entry of entries) {
      const account = accounts.get(entry.accountId)
      if (!account) {
        // The account was removed; the message has nowhere to go.
        dropPendingInbound(entry.message?.message_id)
        continue
      }
      forget(entry.message?.message_id)
      try {
        await handleInbound(account, entry.message, new AbortController().signal)
        dropPendingInbound(entry.message?.message_id)
        delivered += 1
      } catch (error) {
        const attempts = (Number(entry.attempts) || 0) + 1
        if (attempts >= MAX_PENDING_ATTEMPTS) {
          note(
            'inbound',
            `dropped after ${attempts} attempts | ${String(entry.message?.message_id || '').slice(-12)} | ${String(
              (error && error.message) || error,
            ).slice(0, 120)}`,
          )
          dropPendingInbound(entry.message?.message_id)
        } else {
          queuePendingInbound(entry.accountId, entry.userId, entry.message)
        }
      }
    }
    if (delivered > 0) note('inbound', `replayed ${delivered} pending`)
  }

  /** A media-only message has no text, but it is still quotable as "[图片]". */
  function labelOfMessage(message) {
    const items = mediaItemsOf(message)
    if (items.length === 0) return ''
    return labelOfItem(items[0])
  }

  /**
   * Recent message bodies, keyed by exact message id.
   *
   * A quote reply names the quoted message and sends no body of its own, so the only
   * way to show what was quoted is to have seen that message earlier. Entries hold a
   * body and, for a picture or a file, where it was saved — a quote of a screenshot is
   * meant to be looked at, which the path is what makes possible.
   *
   * Written to the state file and dropped after the retention window.
   */
  const quoteCache = new Map()

  /** Whether the one-shot "did the gateway return an id?" note has been written. */
  let outboundAckLogged = false

  /** Pending timer for the coalesced cache write, and whether one is owed. */
  let quoteFlushTimer = null
  let quoteDirty = false
  let quotePruneTimer = null

  // Hydrate from disk, dropping anything past its retention on the way in. A message
  // older than the window is not kept anywhere: no body, no tombstone, no "was here"
  // marker — a quote of it simply finds nothing.
  {
    let dropped = 0
    for (const entry of readState().quoteCache || []) {
      if (!Array.isArray(entry) || entry.length < 2) continue
      const id = String(entry[0] ?? '').trim()
      const body = String(entry[1] ?? '')
      const at = Number(entry[2]) || 0
      if (!id || !body) continue
      if (at && Date.now() - at > QUOTE_RETENTION_MS) {
        dropped += 1
        continue
      }
      const media = entry[3] && typeof entry[3] === 'object' ? entry[3] : null
      quoteCache.set(id, media ? { body, at: at || Date.now(), media } : { body, at: at || Date.now() })
    }
    if (dropped > 0) {
      quoteDirty = true
      scheduleQuoteFlush()
      note('quote', `dropped ${dropped} expired on load`)
    }
  }

  /** Coalesced write of the cache; per-message writes would rewrite the file constantly. */
  function scheduleQuoteFlush() {
    if (quoteFlushTimer) return
    quoteFlushTimer = setTimeout(() => {
      quoteFlushTimer = null
      flushQuoteCache()
    }, 2000)
    if (typeof quoteFlushTimer.unref === 'function') quoteFlushTimer.unref()
  }

  function flushQuoteCache() {
    if (quoteFlushTimer) {
      clearTimeout(quoteFlushTimer)
      quoteFlushTimer = null
    }
    if (!quoteDirty) return
    quoteDirty = false
    try {
      // The whole file is rewritten, so an expired body is not left behind in it.
      updateState({
        quoteCache: [...quoteCache.entries()].map(([id, entry]) =>
          entry.media
            ? [id, entry.body, entry.at, entry.media]
            : [id, entry.body, entry.at],
        ),
      })
    } catch {
      /* the cache is an optimisation; a failed write must not break delivery */
    }
  }

  /**
   * Forget everything past its retention.
   *
   * Called hourly and on every read, because a long-running process would otherwise
   * hold a message for as long as it stays up, whatever the window says.
   */
  function pruneQuoteCache(now = Date.now()) {
    const cutoff = now - QUOTE_RETENTION_MS
    let removed = 0
    for (const [id, entry] of quoteCache) {
      if (entry.at <= cutoff) {
        quoteCache.delete(id)
        removed += 1
      }
    }
    if (removed > 0) {
      quoteDirty = true
      scheduleQuoteFlush()
      note('quote', `pruned ${removed} expired`)
    }
    return removed
  }

  /**
   * The entry behind a quoted id, or null when it was never seen or is past retention.
   *
   * Returns `{ body, media }` so a quoted file can carry its path through to the prompt.
   */
  function lookupQuote(id) {
    const key = String(id || '').trim()
    if (!key) return null

    let entry = quoteCache.get(key)
    let matched = key
    if (!entry) {
      // Entries cached before 1.0.6 hold the rounded form of a 64-bit id
      // (…597000 instead of …597128), because JSON.parse turned it into a double.
      // Accepting the rounded form lets those still resolve while they age out; the
      // ids are exact from 1.0.6 on.
      const rounded = String(Number(key))
      if (rounded !== key) {
        const legacy = quoteCache.get(rounded)
        if (legacy) {
          entry = legacy
          matched = rounded
        }
      }
    }
    if (!entry) return null

    if (Date.now() - entry.at > QUOTE_RETENTION_MS) {
      quoteCache.delete(matched)
      quoteDirty = true
      scheduleQuoteFlush()
      return null
    }
    return { body: entry.body, media: entry.media || null }
  }

  function rememberQuote(id, body, media) {
    const key = String(id || '').trim()
    if (!key || !body) return
    const existing = quoteCache.get(key)
    if (existing && existing.body === body) {
      // Refresh the timestamp: the same message seen again restarts its window.
      existing.at = Date.now()
      // A file is cached before it is downloaded and again once its path is known.
      if (media) existing.media = media
      quoteDirty = true
      scheduleQuoteFlush()
      return
    }
    quoteCache.set(key, { body, at: Date.now(), ...(media ? { media } : {}) })
    if (quoteCache.size > QUOTE_CACHE_LIMIT) {
      const oldest = quoteCache.keys().next().value
      quoteCache.delete(oldest)
    }
    quoteDirty = true
    scheduleQuoteFlush()
  }

  /** Remember an outbound message under whatever id the gateway returned for it. */
  function cacheOutbound(result, body) {
    if (!result || typeof result !== 'object') return
    const id =
      result.message_id || result.msg_id || result.msgid || result.svr_id || result.server_id || ''
    if (id) {
      rememberQuote(id, body)
    }
    // Once is enough to learn what this gateway hands back; the keys are not content.
    if (!outboundAckLogged) {
      outboundAckLogged = true
      note(
        'send-ack',
        `${id ? `id=${String(id)}` : 'no id'} | keys=${Object.keys(result).join(',') || '(none)'}`,
      )
    }
  }

  function persistCursor(accountId, cursor) {
    const state = readState()
    if (state.syncBufs[accountId] === cursor) return
    updateState({ syncBufs: { ...state.syncBufs, [accountId]: cursor } })
  }

  /** Create a session in the channel workspace and bind this conversation to it. */
  async function createBoundSession(account, userId) {
    const key = `${account.accountId}:${userId}`
    fs.mkdirSync(workspaceDirectory, { recursive: true })

    // Prefer a real Workspace. A session created with only a `cwd` lands in the
    // built-in "Ungrouped" bucket, which the desktop sidebar does not render —
    // the session exists on disk and answers messages, yet is invisible in the
    // app. Naming the workspace puts it in the sidebar where the user expects it.
    let workspace
    try {
      workspace = options.resolveWorkspace ? await options.resolveWorkspace() : undefined
    } catch {
      workspace = undefined
    }

    const created = workspace
      ? await sessionController.create({ workspaceId: workspace.id })
      : await sessionController.create({ cwd: workspaceDirectory })

    updateState({
      bindings: {
        ...readState().bindings,
        [key]: {
          sessionId: created.sessionId,
          cwd: workspace ? workspace.path : workspaceDirectory,
          createdAt: Date.now(),
        },
      },
    })
    return created.sessionId
  }

  /** Find or create the DSH session bound to one WeChat conversation. */
  async function ensureSession(account, userId) {
    const key = `${account.accountId}:${userId}`
    const state = readState()
    const existing = state.bindings[key]
    if (existing) {
      // The `cwd` is part of the session's identity on the Host: adopting an
      // existing session with a different one throws and the session can never
      // be reached again. Recreate the directory rather than move the session.
      try {
        fs.mkdirSync(existing.cwd || workspaceDirectory, { recursive: true })
      } catch {
        /* the agent will surface a missing directory itself */
      }
      return existing.sessionId
    }
    return createBoundSession(account, userId)
  }

  /** Send one reply to a conversation, splitting it to WeChat-sized pieces. */
  async function sendReply(accountId, toUserId, contextToken, text, options = {}) {
    const account = readState().accounts.find((entry) => entry.accountId === accountId)
    if (!account) {
      note('send', 'no account')
      return
    }

    // Only agent answers are bubbled. Command receipts (help, listings) must stay
    // one message — splitting `/help` into ten bubbles is worse than a wall of
    // text.
    const bubble = options.bubbles === true
    const limit = readState().maxReplyChars || MAX_REPLY_CHARS
    const parts = bubble ? splitBubbles(text, limit) : splitReply(text, limit)
    const list = parts.length > 0 ? parts : [String(text || '')]

    for (let index = 0; index < list.length; index += 1) {
      const part = list[index]
      try {
        const result = await sendText({
          baseUrl: account.baseUrl,
          token: account.token,
          toUserId,
          text: part,
          contextToken,
        })
        // If the gateway hands back an id for our own message, remember it: the user
        // quoting the bot's reply is the other half of quote replies.
        cacheOutbound(result, part)
        note('send', `ok · ${part.length} chars${list.length > 1 ? ` (${index + 1}/${list.length})` : ''}`)
        clearError(account.accountId)
      } catch (error) {
        note('send', `failed · ${String((error && error.message) || error)}`)
        recordError(account.accountId, error)
        // Reported to the caller, not just logged: a notification that claims it was
        // sent when the send failed is worse than no notification at all.
        return false
      }
      // A short gap keeps a burst from looking like a machine gun, without
      // pretending to type.
      if (index < list.length - 1) await new Promise((resolve) => setTimeout(resolve, 250))
    }
    return true
  }

  /**
   * Save one inbound media item into the session's workspace.
   *
   * The file lands under `media/inbound/` inside the session `cwd`, which is the
   * agent's working directory — so it can open it with its own tools. The prompt
   * carries the relative path; the bytes are not embedded as an attachment
   * block, which would need the Host attachment service and is a separate step.
   *
   * Returns `{ note, media }`: the note is what goes into the prompt, and `media` is
   * what the quote cache keeps, so a later quote of this message can hand the agent
   * the same file again instead of a bare "[图片]".
   */
  async function saveInboundMedia(item, cwd) {
    const payload = mediaPayload(item)
    const media = payload && payload.media
    if (!media || (!media.encrypt_query_param && !media.full_url)) return null

    const label = MEDIA_ITEM_LABELS.get(item.type) || '附件'
    // An image's `aeskey` is the raw key in hex; `media.aes_key` is base64 of the
    // hex text. Normalising to the first shape lets one parser handle both.
    const aesKeyBase64 = payload.aeskey
      ? Buffer.from(String(payload.aeskey), 'hex').toString('base64')
      : media.aes_key

    const buffer = await downloadMedia({
      encryptQueryParam: media.encrypt_query_param,
      aesKeyBase64,
      fullUrl: media.full_url,
      label,
    })

    const original = typeof payload.file_name === 'string' ? payload.file_name : ''
    const extension = extensionForName(
      original,
      item.type === 2 ? 'jpg' : item.type === 5 ? 'mp4' : item.type === 3 ? 'silk' : 'bin',
    )
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const safeOriginal = original.replace(/[\\/:*?"<>|]/g, '_').slice(-60)
    const fileName = safeOriginal ? `${stamp}-${safeOriginal}` : `${stamp}.${extension}`

    const directory = path.join(cwd, 'media', 'inbound')
    fs.mkdirSync(directory, { recursive: true })
    const target = path.join(directory, fileName)
    fs.writeFileSync(target, buffer)

    const relative = path.relative(cwd, target).split(path.sep).join('/')
    note('media', `${label} | ${buffer.length} bytes | ${relative}`)
    const descriptor = { label, path: relative, bytes: buffer.length }

    // A voice note is the one media type with two independent paths to meaning:
    // the service's transcription, and the SILK payload. SILK needs a decoder
    // nothing here has, so the transcript is what actually gets heard — and when
    // it is missing, saying "saved to <path>" alone is a lie the agent cannot
    // recover from: it will try to open a .silk file and fail.
    if (item.type === 3) {
      const transcript =
        payload && typeof payload.text === 'string' ? payload.text.trim() : ''
      if (transcript) {
        note('voice', `transcript ${transcript.length} chars | ${transcript.slice(0, 40)}`)
        return { note: '', media: { ...descriptor, transcript } }
      }
      note('voice', 'no transcript in payload')
      return {
        note: `[微信语音] 已保存到 ${relative}（${buffer.length} 字节），但这条语音没有附带转写文字，内容无法识别。`,
        media: descriptor,
      }
    }

    return { note: `[微信${label}] 已保存到 ${relative}（${buffer.length} 字节）`, media: descriptor }
  }

  /**
   * The phone this machine is bound to.
   *
   * Used only for outbound sends. Approvals and questions stay strictly
   * session-scoped: claiming a desk session's prompt because it happens to run on
   * the same machine would send a dialog to a phone nobody is looking at, which is
   * the opposite of what that rule protects.
   *
   * The account is chosen by evidence, not by list order. Scanning twice leaves two
   * bot accounts bound to the same user, and picking `accounts[0]` sends from a bot
   * that user has never messaged — which the gateway answers with
   * `ret=-2 prepare failed`. An account holding a context token is one that user
   * has actually talked to, so it is preferred; a token is also what a proactive
   * send needs at all.
   */
  function boundConversationTarget() {
    const state = readState()
    const bound = state.accounts.filter(
      (account) => state.bindings[`${account.accountId}:${account.userId}`],
    )
    if (bound.length === 0) return undefined
    const account =
      bound.find((entry) => state.contextTokens[`${entry.accountId}:${entry.userId}`]) || bound[0]
    const key = `${account.accountId}:${account.userId}`
    return {
      accountId: account.accountId,
      toUserId: account.userId,
      contextToken: state.contextTokens[key] || '',
    }
  }

  /** A session's `cwd`, for resolving a relative path the way that session means it. */
  async function workingDirectoryOf(sessionId) {
    try {
      const value = await sessionController.list({}, AbortSignal.timeout(5000))
      const items = Array.isArray(value && value.items) ? value.items : []
      const found = items.find((item) => String(item.sessionId) === sessionId)
      if (found && found.cwd) return String(found.cwd)
    } catch {
      /* fall through to the conversation workspace */
    }
    return ''
  }

  /**
   * Send a local file to the phone.
   *
   * The session that owns the conversation wins; any other session on this machine
   * falls back to the bound conversation. Without that fallback the tool is only
   * usable from inside a WeChat-started session, which is not where the user is
   * when they ask the desk to "send me that picture".
   *
   * Relative paths resolve against the calling session's `cwd` — that is what the
   * path means to the agent that produced it — and against the conversation
   * workspace only when the session cannot be found.
   */
  async function sendFileToConversation(sessionId, filePath, caption) {
    const target = resolveOutboundTarget(sessionId)
    const direct = !target.crossSession
    // Counted before the attempt so a turn that sent a file is never reported as
    // one that stayed silent.
    toolSends.set(sessionId, (toolSends.get(sessionId) || 0) + 1)

    const account = readState().accounts.find((entry) => entry.accountId === target.accountId)
    if (!account) throw new Error('找不到可用的微信账号')

    const conversationCwd = readState().bindings[`${target.accountId}:${target.toUserId}`]?.cwd
    const base = (direct ? '' : await workingDirectoryOf(sessionId)) || conversationCwd || workspaceDirectory
    const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(base, filePath)

    // Logged before the attempt, not only on success: the failure path used to be
    // silent, which made "发不出去" impossible to diagnose from the log.
    note(
      'send-media',
      `target=${target.accountId}${direct ? '' : ' cross-session'} token=${target.contextToken ? 'yes' : 'none'} path=${resolved}`,
    )

    // No token means this conversation has not been touched since the channel
    // started (or since the feature shipped). The gateway answers such a send with
    // `ret=-2 prepare failed`, so say what will actually fix it instead of
    // forwarding that.
    if (!target.contextToken) {
      note('send-media', 'no-token | waiting for one inbound message')
      throw new Error(
        '微信会话令牌还没拿到，现在发不出去。先在微信里给机器人随便发一句话，再让我发——之后就正常了。',
      )
    }

    let result
    try {
      result = await sendMediaToWeChat({
        baseUrl: account.baseUrl,
        token: account.token,
        toUserId: target.toUserId,
        contextToken: target.contextToken,
        filePath: resolved,
        caption: caption || '',
      })
    } catch (error) {
      note('send-media', `failed | ${String((error && error.message) || error)}`)
      throw error
    }

    note(
      'send-media',
      `sent ${result.kind} | ${result.fileName} | ${result.bytes} bytes${direct ? '' : ' | cross-session'}`,
    )
    // Remember the file under the id the gateway gave it, so quoting it later hands the
    // agent the path instead of a bare "[文件]". The path is the one on disk here, which
    // is what makes the file openable at all.
    if (result.messageId) {
      const label = MEDIA_KIND_LABELS.get(result.kind) || '文件'
      rememberQuote(
        result.messageId,
        `[微信${label}] ${result.filePath}（${result.bytes} 字节）`,
        { label, path: result.filePath, bytes: result.bytes },
      )
    }
    return { sent: true, kind: result.kind, fileName: result.fileName, bytes: result.bytes }
  }

  async function handleInbound(account, message, signal) {
    if (!message || typeof message !== 'object') return

    // Our own sends come back through the same long poll. They are not delivered, but
    // they are worth keeping: a user quoting the bot's reply carries only that id.
    if (message.message_type !== MESSAGE_TYPE_USER) {
      rememberQuote(message.message_id, textOf(message).trim() || labelOfMessage(message))
      note('ids', `bot mid=${String(message.message_id || '')} seq=${String(message.seq ?? '')}`)
      return
    }

    const userId = String(message.from_user_id || '')
    if (!userId) return

    const text = textOf(message).trim()
    const mediaItems = mediaItemsOf(message)
    // A message may be media only, so text alone no longer decides whether there
    // is anything to deliver.
    if (!text && mediaItems.length === 0) return

    // Which ids a quote names, and what this message carries. Kept until the fix is
    // confirmed: the quoted id and the cached key have to be compared, not guessed at.
    {
      const holder = (Array.isArray(message.item_list) ? message.item_list : []).find(
        (item) => item && typeof item === 'object' && item.ref_msg,
      )
      if (holder) {
        note(
          'ids',
          `mid=${String(message.message_id || '')} seq=${String(message.seq ?? '')} cid=${String(message.client_id || '')}`,
        )
        note('ref', JSON.stringify(holder.ref_msg).slice(0, 400))
      }
    }

    // Every message the bot has seen becomes quotable context: the current WeChat
    // client sends a quote as an id with no content, so the body has to come from here.
    const messageId = String(message.message_id || '')
    rememberQuote(messageId, text || labelOfMessage(message))
    // `svr_id` may also be the sequence number, so both are kept as keys.
    if (message.seq !== undefined && message.seq !== null) {
      rememberQuote(message.seq, text || labelOfMessage(message))
    }
    // The WeChat client generates `client_id` for messages it sends; a quote may name
    // the message by that rather than by the gateway's id.
    if (message.client_id) {
      rememberQuote(message.client_id, text || labelOfMessage(message))
    }

    // A quote reply puts the quoted message in a separate item. Keeping it out of
    // `text` means commands and approval answers still parse on the raw words, while
    // the prompt gets the context: "这个改成红色" alone tells the agent nothing.
    const quoted = quotedOf(message, lookupQuote)
    const promptText = quoted ? (text ? `${quoted}\n\n${text}` : quoted) : text

    const quoteId = quoteRefId(message)
    if (quoteId) {
      if (lookupQuote(quoteId)) {
        note('quote', `hit | ${quoteId.slice(-12)} | cached=${quoteCache.size}`)
      } else {
        // An id with nothing behind it is either a message past its retention or one
        // that never went past. Either way the agent was told it was cleared; logging
        // the id here is what made this diagnosable, and it is the id, not the content.
        note('quote', `cleared | ${quoteId.slice(-12)} | cached=${quoteCache.size}`)
      }
    }

    if (remember(messageId)) return
    note(
      'inbound',
      `${userId} · ${text.length} chars · ${mediaItems.length} media${quoted ? ' · quote' : ''}`,
    )

    // Every inbound message carries a fresh context token. Keeping the newest one
    // on disk is what makes an outbound send possible from a session that never
    // received a message, and after a restart drops the in-memory copy.
    const conversationKey = `${account.accountId}:${userId}`
    const incomingToken = String(message.context_token || '')
    if (incomingToken) {
      const state = readState()
      if (state.contextTokens[conversationKey] !== incomingToken) {
        updateState({
          contextTokens: { ...state.contextTokens, [conversationKey]: incomingToken },
        })
      }
    }

    // A reply to a permission prompt is consumed here. The agent turn is blocked
    // waiting for exactly this decision, so forwarding the text would queue it
    // behind the very answer it is supposed to supply.
    const pendingApproval = pendingApprovals.get(`${account.accountId}:${userId}`)
    if (pendingApproval) {
      const outcome = parseApprovalAnswer(text)
      if (outcome) {
        pendingApproval.finish(outcome)
        note('approval-reply', outcome)
        return
      }
      await sendReply(
        account.accountId,
        userId,
        String(message.context_token || ''),
        '先回答上面的权限请求：1 允许 · 2 拒绝 · 3 取消',
      )
      return
    }

    // A reply to a structured question is consumed the same way: the tool call is
    // blocked on it, so the text must not be queued behind it.
    const pendingQuestion = pendingQuestions.get(`${account.accountId}:${userId}`)
    if (pendingQuestion) {
      const answer = buildQuestionAnswer(pendingQuestion.item, text)
      const first = answer.answers[0]
      const chosen = Array.isArray(first.selected) ? first.selected.length : 0
      note('question-reply', `${chosen} selected${first.custom ? ' + custom' : ''}`)
      pendingQuestion.finish(answer)
      await sendReply(
        account.accountId,
        userId,
        String(message.context_token || ''),
        '已记录你的回答',
      )
      return
    }

    // A known command is answered by the channel itself and never reaches the
    // agent. Unknown slash text falls through, so ordinary prose that starts
    // with a slash still works.
    const command = parseCommand(text)
    if (command && KNOWN_COMMANDS.has(command.name)) {
      // A held file must not sit behind a command the user is waiting on.
      await deliverBuffered(`${account.accountId}:${userId}`, '')
      note('command', `/${command.name} ${command.argument}`.trim())
      await handleCommand(
        account,
        {
          accountId: account.accountId,
          toUserId: userId,
          contextToken: String(message.context_token || ''),
        },
        command,
      )
      return
    }

    const sessionKey = `${account.accountId}:${userId}`
    const contextToken = String(message.context_token || '')

    // A file waits for the words that go with it.
    //
    // People send the picture, then type the request — three seconds later, five
    // seconds later. Delivering on arrival makes the agent answer the picture
    // instead of the request, and the request then arrives at a turn that has
    // already spoken. A text inside the window is appended and the pair is
    // delivered at once; silence means the window expires and the file goes alone.
    if (mediaItems.length > 0) {
      const mergeMs = (readState().mediaMergeSec ?? 20) * 1000
      if (mergeMs > 0) {
        queueContent(sessionKey, {
          account,
          userId,
          contextToken,
          text: promptText,
          mediaItems,
          signal,
          mergeMs,
          messageId,
        })
        return
      }
      // Window set to zero: the setting's off switch, delivered with any text it
      // arrived with so a caption still travels with its picture.
      await deliverToSession({
        account,
        userId,
        contextToken,
        texts: [promptText],
        mediaItems,
        signal,
        messageId,
      })
      return
    }

    const held = contentBuffers.get(sessionKey)
    if (held) {
      // Text inside the window: the file and the request become one turn.
      await deliverBuffered(sessionKey, promptText)
      return
    }

    await deliverToSession({
      account,
      userId,
      contextToken,
      texts: [promptText],
      mediaItems: [],
      signal,
      messageId,
    })
  }

  /**
   * Submit one turn: session, media, prompt layers.
   *
   * Extracted so the immediate path and the merged path cannot drift apart — the
   * buffered version is the same delivery, one step later.
   */
  async function deliverToSession({
    account,
    userId,
    contextToken,
    texts,
    mediaItems,
    mediaOwnerIds,
    signal,
    messageId,
  }) {
    const sessionId = await ensureSession(account, userId)
    replyTargets.set(sessionId, { accountId: account.accountId, toUserId: userId, contextToken })
    note('session', sessionId)

    const bindingCwd =
      readState().bindings[`${account.accountId}:${userId}`]?.cwd || workspaceDirectory
    const mediaNotes = []
    const mediaLimit = readState().mediaMaxPerMessage || MAX_MEDIA_PER_MESSAGE
    for (const [index, item] of mediaItems.slice(0, mediaLimit).entries()) {
      try {
        const saved = await saveInboundMedia(item, bindingCwd)
        if (!saved) continue
        if (saved.note) mediaNotes.push(saved.note)
        // The file is on disk now, so the quote cache can remember where it is. Without
        // this a quoted picture resolves to the word "[图片]" and the agent has nothing
        // to open.
        const ownerId = (mediaOwnerIds && mediaOwnerIds[index]) || messageId
        if (ownerId && saved.media) {
          rememberQuote(ownerId, saved.note || `[微信${saved.media.label}]`, saved.media)
        }
      } catch (error) {
        note('media', `failed | ${String((error && error.message) || error)}`)
      }
    }

    const content = [...texts, ...mediaNotes].filter((part) => part).join('\n\n')
    if (!content) {
      await sendReply(account.accountId, userId, contextToken, '媒体下载失败，这次没送进会话。')
      return
    }

    // The prompt goes after this turn's content, not before it: a leading block
    // reads as user background, while trailing text sits closest to the point where
    // the model starts writing.
    //
    // Two layers. The full note is ~1.5k characters and is re-sent only when it is
    // likely to be needed; the anchor line goes out every turn regardless, because
    // the rule it carries is the one failure with no recovery.
    const state = readState()
    // The switch in the panel governs the long note only. '' here makes
    // takePromptFor fall straight through to the anchor, which has no switch on
    // purpose: it is the one line whose absence silences the reply path.
    // The note itself is whichever named scenario is active.
    const promptText =
      state.channelPromptEnabled === false
        ? ''
        : composeTail({ channelPrompt: activeScenario(state).content })
    const tail = takePromptFor(sessionId, promptText, state)
    const body = tail ? `${content}\n\n${tail}` : content

    // Steer first: a message sent while the agent is working is an interruption,
    // not a queued item. Waiting for the turn to end means the user answers the
    // previous answer, and by then the agent has moved on — which is what made a
    // working session feel like it was ignoring the phone.
    //
    // A refused steer is a real outcome, not an error: the turn it targeted can
    // end between the decision and the submit. The queue is then the fallback,
    // because losing the message is the one failure nothing can repair.
    const request = {
      requestId: `webot-${crypto.randomUUID()}`,
      sessionId,
      content: [{ type: 'text', text: body }],
    }
    // The turn's accounting starts here: no sends yet, no draft yet.
    toolSends.delete(sessionId)
    pendingText.delete(sessionId)
    const promptSignal = signal || new AbortController().signal
    try {
      await sessionController.prompt({ ...request, mode: 'steer' }, promptSignal)
      note('prompt', 'steered')
    } catch (error) {
      note('prompt', `steer refused | ${String((error && error.message) || error)} → queue`)
      await sessionController.prompt({ ...request, mode: 'queue' }, promptSignal)
      note('prompt', 'queued')
    }
    clearError(account.accountId)
  }

  /**
   * Decide whether this turn carries the full note or only the anchor line.
   *
   * Three triggers: the first message of a session (its context is empty), the turn
   * count (a long session, where the note drifts far back), and an edit (the user just
   * changed it and expects it applied now).
   *
   * A restart is deliberately *not* a trigger. The schedule lives in the state file, so
   * a restarted process resumes where it left off; the conversation's own transcript
   * still contains the note, and re-sending it on every boot only spends tokens.
   *
   * There is deliberately no idle-time trigger. A chat resumed hours later still has
   * the note earlier in its own transcript, so nothing is lost by counting turns only —
   * and a clock trigger would re-send on the one occasion the context is least likely
   * to have dropped it (a short conversation after a pause).
   */
  function takePromptFor(sessionId, promptText, state) {
    const key = sessionId
    const mark = promptMarks.get(key)
    const turns = state.promptRefreshTurns || 20
    // Editable, and empty means "off": that is the user's call to make, but the hint
    // in the panel says what turning it off costs.
    const anchor = state.anchorPrompt === undefined ? ANCHOR_REMINDER : state.anchorPrompt

    if (!promptText) {
      savePromptMark(key, { turns: 0, text: '' })
      return anchor
    }

    const due = !mark || mark.text !== promptText || mark.turns >= turns

    if (due) {
      savePromptMark(key, { turns: 0, text: promptText })
      // Not the anchor as well: the note states the rule in its first section, and
      // saying one thing twice is how prompts become noise.
      note('prompt', `full | ${promptText.length} chars | next in ${turns} turns`)
      return promptText
    }

    savePromptMark(key, { turns: mark.turns + 1, text: mark.text })
    note('prompt', `anchor | ${anchor.length} chars | ${mark.turns + 1}/${turns} turns`)
    return anchor
  }

  /** Hold a file (and any text that came with it) until the window closes. */
  function queueContent(
    key,
    { account, userId, contextToken, text, mediaItems, signal, mergeMs, messageId },
  ) {
    let held = contentBuffers.get(key)
    if (!held) {
      held = {
        account,
        userId,
        contextToken,
        texts: [],
        mediaItems: [],
        // One id per held item, so each saved file is quoted under its own message.
        mediaOwnerIds: [],
        signal: signal || new AbortController().signal,
        timer: null,
      }
      contentBuffers.set(key, held)
    }
    if (text) held.texts.push(text)
    held.mediaItems.push(...mediaItems)
    if (messageId) held.mediaOwnerIds.push(...mediaItems.map(() => messageId))
    if (signal) held.signal = signal
    if (held.timer) clearTimeout(held.timer)
    held.timer = setTimeout(() => {
      void deliverBuffered(key, '')
    }, mergeMs)
    note('merge', `hold | ${held.mediaItems.length} media | ${held.texts.length} text | ${mergeMs}ms`)
  }

  /** Deliver whatever is held, optionally with one more piece of text. */
  async function deliverBuffered(key, extraText) {
    const held = contentBuffers.get(key)
    if (!held) return
    contentBuffers.delete(key)
    if (held.timer) clearTimeout(held.timer)

    const texts = [...held.texts]
    if (extraText) texts.push(extraText)
    note(
      'merge',
      `flush | ${held.mediaItems.length} media | ${texts.length} text${extraText ? ' (follow-up)' : ' (window expired)'}`,
    )

    await deliverToSession({
      account: held.account,
      userId: held.userId,
      contextToken: held.contextToken,
      texts,
      mediaItems: held.mediaItems,
      mediaOwnerIds: held.mediaOwnerIds,
      signal: held.signal,
    })
  }

  /** Where a given session's answers go, when this channel owns that session. */
  function targetForSession(sessionId) {
    const direct = replyTargets.get(sessionId)
    if (direct) return direct
    const state = readState()
    const account = state.accounts[0]
    if (!account) return undefined
    const key = `${account.accountId}:${account.userId}`
    const binding = state.bindings[key]
    if (binding && binding.sessionId === sessionId) {
      return {
        accountId: account.accountId,
        toUserId: account.userId,
        contextToken: state.contextTokens[key] || '',
      }
    }
    return undefined
  }

  /**
   * Resolve when the phone answers a prompt, or when the request goes away.
   *
   * Generic over the pending registry so permission prompts and structured
   * questions share one implementation instead of drifting apart. `abortValue` is
   * what the caller wants back when the request is cancelled, because the two
   * answer types have nothing in common.
   */
  function beginWait(registry, key, signal, abortValue, extra) {
    const entry = {}
    if (extra) Object.assign(entry, extra)
    const promise = new Promise((resolve) => {
      entry.resolve = resolve
    })
    const onAbort = () => entry.finish(abortValue)
    entry.finish = (value) => {
      if (registry.get(key) === entry) registry.delete(key)
      if (signal) signal.removeEventListener('abort', onAbort)
      entry.resolve(value)
    }
    registry.set(key, entry)
    if (signal) {
      if (signal.aborted) entry.finish(abortValue)
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    return { promise, finish: entry.finish }
  }

  /**
   * Claim one permission request for the phone, or delegate.
   *
   * `next()` is the default for anything this channel does not own. A session the
   * user is driving at the desk must keep its desktop prompt: silently answering
   * it from a phone nobody is looking at would be worse than making the desk wait.
   *
   * Wrapped so a throw here cannot surface as an unhandled rejection inside the
   * waterfall, which would leave the agent waiting with no prompt anywhere.
   */
  async function handleApproval(request, next) {
    try {
      return await claimApproval(request, next)
    } catch (error) {
      note('approval', `error | ${String((error && error.message) || error)}`)
      return next()
    }
  }

  async function claimApproval(request, next) {
    const sessionId = request && request.agent && request.agent.id ? String(request.agent.id) : ''
    const toolName = String((request && request.toolName) || 'tool')
    // Logged before any decision: "the prompt never reached WeChat" and "the
    // prompt never reached this listener" look identical from the phone.
    note('approval', `seen ${toolName} | ${sessionId || 'no-session'}`)
    if (!sessionId) return next()

    // Where the prompt is offered. There is no "both": once this listener claims
    // the request the desktop answerer never runs, and once it delegates the
    // phone never sees it. `desktop` is the way to keep the desk's own prompt.
    const mode = readState().approvalMode === 'desktop' ? 'desktop' : 'phone'
    if (mode === 'desktop') {
      note('approval', 'delegated | mode=desktop')
      return next()
    }

    const target = targetForSession(sessionId)
    if (!target) {
      note('approval', `delegated | no target for ${sessionId.slice(-8)}`)
      return next()
    }

    const key = `${target.accountId}:${target.toUserId}`
    if (pendingApprovals.has(key)) {
      note('approval', 'delegated | another prompt is already open')
      return next()
    }

    const reason =
      (request.displayReason && (request.displayReason.zh || request.displayReason.en)) ||
      request.reason ||
      ''

    const lines = [`agent 需要你的许可（会话 ${shortId(sessionId)}）`, `工具：${toolName}`]
    if (reason) lines.push(`原因：${String(reason).slice(0, 300)}`)
    lines.push('', '回复 1 允许一次 · 2 拒绝 · 3 取消')

    const wait = beginWait(pendingApprovals, key, request.signal, 'cancelled')
    let delivered = false
    try {
      delivered = await sendReply(
        target.accountId,
        target.toUserId,
        target.contextToken,
        lines.join('\n'),
      )
    } catch (error) {
      // The prompt never reached the phone. Finish the wait before letting the error
      // through: the entry is registered in `pendingApprovals` from the moment it is
      // created, and an entry nobody can answer blocks this conversation — every later
      // approval is delegated with "another prompt is already open".
      wait.finish('cancelled')
      throw error
    }
    if (!delivered) {
      // sendReply reports a failed send by returning false, not by throwing. Waiting
      // anyway would block the agent turn for the whole timeout on a prompt that is not
      // on any phone, and then auto-reject it: the worst of both. Delegate instead, so
      // the desk still gets a prompt and the turn is not held hostage.
      wait.finish('cancelled')
      note('approval', 'not delivered, delegated | send failed')
      return next()
    }

    // Claimed outright, so the desktop answerer is never started. Racing it and
    // losing would leave the browser holding a dialog that only that answerer
    // can close, and the host has no withdraw call: the prompt stays on screen
    // after the turn has already moved on.
    //
    // An unanswered prompt blocks the agent turn, so it expires instead of
    // waiting forever. Rejecting is the safe side — the ask can be repeated.
    const timeoutSec = readState().approvalTimeoutSec
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      note('approval', `timeout | ${timeoutSec}s, auto-reject`)
      wait.finish('rejected')
    }, timeoutSec * 1000)

    const outcome = await wait.promise
    clearTimeout(timer)
    note('approval', `answered ${outcome} | phone`)

    if (timedOut) {
      await sendReply(
        target.accountId,
        target.toUserId,
        target.contextToken,
        `${timeoutSec} 秒内没有回复，已自动拒绝。需要的话重新让 agent 执行一次。`,
      )
    }
    return outcome
  }

  /** An empty answer that still names the question, for the cancelled case. */
  function emptyQuestionAnswer(item) {
    return { answers: [{ id: String((item && item.id) || ''), selected: [] }] }
  }

  /** Parse `1,3` / `1 3` / `1、3` into zero-based indexes; null when not a selection. */
  function parseSelection(text, count) {
    const parts = String(text || '')
      .split(/[\s,，、]+/)
      .filter(Boolean)
    if (parts.length === 0) return null
    const indexes = []
    for (const part of parts) {
      if (!/^\d+$/.test(part)) return null
      const value = Number(part)
      if (!Number.isFinite(value) || value < 1 || value > count) return null
      indexes.push(value - 1)
    }
    return [...new Set(indexes)]
  }

  /** Turn one phone reply into the answer shape the tool expects. */
  function buildQuestionAnswer(item, text) {
    const options = Array.isArray(item && item.options) ? item.options : []
    const trimmed = String(text || '').trim()
    const selection = options.length ? parseSelection(trimmed, options.length) : null
    if (selection) {
      const chosen = item.multiSelect ? selection : selection.slice(0, 1)
      return {
        answers: [
          { id: String(item.id), selected: chosen.map((index) => String(options[index].label)) },
        ],
      }
    }
    // Anything that is not a valid selection is a typed answer, which the tool
    // accepts through `custom`.
    return { answers: [{ id: String(item.id), selected: [], custom: trimmed }] }
  }

  /** Claim one structured question for the phone, or delegate. */
  async function handleQuestion(request, next) {
    try {
      return await claimQuestion(request, next)
    } catch (error) {
      note('question', `error | ${String((error && error.message) || error)}`)
      return next()
    }
  }

  async function claimQuestion(request, next) {
    const items = request && Array.isArray(request.questions) ? request.questions : []
    const sessionId = request && request.agent && request.agent.id ? String(request.agent.id) : ''
    note('question', `seen ${items.length} | ${sessionId ? sessionId.slice(-8) : 'no-session'}`)

    // Questions ride the same switch as permissions: one place decides whether
    // interactive prompts belong to the phone or the desk.
    if (readState().approvalMode === 'desktop') {
      note('question', 'delegated | mode=desktop')
      return next()
    }
    if (!sessionId) return next()

    const target = targetForSession(sessionId)
    if (!target) {
      note('question', `delegated | no target for ${sessionId.slice(-8)}`)
      return next()
    }

    const key = `${target.accountId}:${target.toUserId}`
    if (pendingQuestions.has(key)) {
      note('question', 'delegated | another question is already open')
      return next()
    }

    // Only single-question requests are handled here. Answering several at once
    // from a phone needs numbering that spans questions, and getting it wrong
    // produces a confidently wrong answer — delegating is the honest option.
    if (items.length !== 1) {
      note('question', `delegated | ${items.length} questions, phone handles one`)
      return next()
    }

    const item = items[0]
    const options = Array.isArray(item.options) ? item.options : []
    const lines = [`agent 想问你（会话 ${shortId(sessionId)}）`]
    if (item.header) lines.push(`【${item.header}】`)
    lines.push(String(item.question || ''))
    if (item.detail) lines.push(String(item.detail).slice(0, 300))
    options.forEach((option, index) => {
      const description = option.description ? ` — ${String(option.description).slice(0, 120)}` : ''
      lines.push(`${index + 1}. ${String(option.label)}${description}`)
    })
    lines.push('')
    lines.push(
      options.length
        ? item.multiSelect
          ? '回复序号，可多选（如 1,3），也可以直接输入你的答案'
          : '回复序号，也可以直接输入你的答案'
        : '直接回复你的答案',
    )

    const wait = beginWait(pendingQuestions, key, request.signal, emptyQuestionAnswer(item), { item })
    let delivered = false
    try {
      delivered = await sendReply(
        target.accountId,
        target.toUserId,
        target.contextToken,
        lines.join('\n'),
      )
    } catch (error) {
      // Same reasoning as approvals: a registered wait that never reached the phone
      // would make this conversation look busy to every later question.
      wait.finish(emptyQuestionAnswer(item))
      throw error
    }
    if (!delivered) {
      // The question never reached the phone; asking the desk instead of waiting for an
      // answer that cannot arrive.
      wait.finish(emptyQuestionAnswer(item))
      note('question', 'not delivered, delegated | send failed')
      return next()
    }

    const answer = await wait.promise
    const first = answer.answers && answer.answers[0]
    const chosen = first && Array.isArray(first.selected) ? first.selected.length : 0
    note('question', `answered | ${chosen} selected${first && first.custom ? ' + custom' : ''}`)
    return answer
  }

  async function listSessions() {
    const value = await sessionController.list({}, AbortSignal.timeout(8000))
    return Array.isArray(value && value.items) ? [...value.items] : []
  }

  /** Handle one channel command. A command never reaches the agent. */
  async function handleCommand(account, target, command) {
    const key = `${account.accountId}:${target.toUserId}`
    const binding = readState().bindings[key]
    const reply = (text) => sendReply(account.accountId, target.toUserId, target.contextToken, text)

    if (command.name === 'help') return reply(HELP_TEXT)

    if (command.name === 'current') {
      if (!binding) return reply('当前没有绑定会话。发任意消息会自动新建一个。')
      return reply(`当前会话：${shortId(binding.sessionId)}\n目录：${binding.cwd || workspaceDirectory}`)
    }

    if (command.name === 'new') {
      const sessionId = await createBoundSession(account, target.toUserId)
      const title = command.argument.slice(0, 60)
      if (title) {
        try {
          await sessionController.rename({ sessionId, title })
        } catch {
          /* the session exists either way; a failed rename must not fail the command */
        }
      }
      return reply(`已新建会话 ${shortId(sessionId)}${title ? '：' + title : ''}`)
    }

    if (command.name === 'cancel') {
      if (!binding) return reply('当前没有绑定会话。')
      try {
        sessionController.cancel({ sessionId: binding.sessionId })
      } catch {
        /* nothing running or the session is cold; both answer the same way */
      }
      return reply('已请求停止当前任务。')
    }

    if (command.name === 'list') {
      const items = await listSessions()
      if (items.length === 0) return reply('还没有会话。发任意消息会新建一个。')
      const page = items.slice(0, readState().maxListRows || MAX_LIST_ROWS)
      // Freeze this screen's numbering so `/switch 3` means row 3 of what the
      // user is reading, not row 3 of whatever the list looks like later.
      lastList.set(key, page.map((item) => item.sessionId))
      const lines = page.map((item, index) => {
        const title = readTitle(item)
        const current = binding && binding.sessionId === item.sessionId ? ' ← 当前' : ''
        const running = item.running ? ' · 运行中' : ''
        return `${index + 1}. ${title ? title + ' · ' : ''}${shortId(item.sessionId)}${running}${current}`
      })
      return reply(
        `会话（${items.length} 个，显示前 ${page.length} 个）\n${lines.join('\n')}\n\n/switch 序号 或 /switch 短id`,
      )
    }

    if (command.name === 'switch') {
      const want = command.argument
      if (!want) return reply('用法：/switch 3 或 /switch a1b2c3')
      const items = await listSessions()
      let sessionId = ''
      if (/^\d+$/.test(want)) {
        const numbered = lastList.get(key) || []
        sessionId = numbered[Number(want) - 1] || ''
        if (!sessionId) return reply('这个序号没有对应的会话。先发 /list 再选。')
      } else {
        const matches = items.filter((item) => String(item.sessionId).includes(want))
        if (matches.length === 0) return reply('找不到这个会话。发 /list 看看。')
        if (matches.length > 1) return reply('短 id 有歧义，请多给几位。')
        sessionId = matches[0].sessionId
      }
      const found = items.find((item) => item.sessionId === sessionId)
      updateState({
        bindings: {
          ...readState().bindings,
          [key]: {
            sessionId,
            // Store the cwd the Host reports: a mismatch makes the adopted
            // session permanently unreachable.
            cwd: (found && found.cwd) || workspaceDirectory,
            createdAt: Date.now(),
          },
        },
      })
      const title = found ? readTitle(found) : ''
      return reply(`已切换到 ${shortId(sessionId)}${title ? '：' + title : ''}`)
    }

    return reply(HELP_TEXT)
  }

  /**
   * Retire the turn's accumulated text without sending it.
   *
   * Tool-only mode: the agent owns delivery, so this text is a draft it chose not
   * to send (or already paraphrased into `send_to_wechat` calls). It is dropped
   * rather than forwarded, and the count of tool sends in this turn decides which
   * of the two happened — which is the difference between normal operation and a
   * reply that silently went nowhere.
   */
  function retireTurnText(sessionId, reason) {
    settleTimers.delete(sessionId)
    const text = (pendingText.get(sessionId) || '').trim()
    pendingText.delete(sessionId)
    const sent = toolSends.get(sessionId) || 0
    toolSends.delete(sessionId)
    note(
      'turn',
      `${shortId(sessionId)} | ${reason} | tool-sends=${sent} | draft=${text.length} chars${sent === 0 && text ? ' | NO REPLY SENT' : ''}`,
    )
  }

  /**
   * Is this session one this channel owns, and therefore already talking to the
   * phone?
   *
   * `replyTargets` alone is not enough: it is filled while a conversation is live,
   * and a bound session that has not spoken since the process started is still the
   * user's WeChat session — notifying about it would be the channel telling the
   * phone about itself.
   */
  function isOwnedSession(sessionId) {
    if (replyTargets.has(sessionId)) return true
    const bindings = readState().bindings
    for (const value of Object.values(bindings)) {
      if (value && value.sessionId === sessionId) return true
    }
    return false
  }

  /** The turn's driver went idle: whatever it drafted is no longer live. */
  function handleAgentStatus(payload) {
    if (!payload || payload.status !== 'idle') return
    const sessionId = sessionIdOf(payload)
    if (!sessionId) return
    if (!replyTargets.has(sessionId)) {
      if (isOwnedSession(sessionId)) return
      // A session this channel does not own just finished. Whether the phone should
      // hear about it depends on something only the desktop can answer: is anybody
      // sitting there?
      scheduleDoneNotice(sessionId)
      return
    }
    retireTurnText(sessionId, 'idle')
  }

  /**
   * Watch the desk for a while after a task finishes elsewhere.
   *
   * The rule is the user's: sample the pointer for `doneNotifyDelaySec` after the
   * turn ended, and if it never travels far enough, nobody is watching — a message
   * is worth sending. A bumped desk moves the pointer a few pixels; a person
   * reaching for it moves it much further, which is what the threshold separates.
   */
  function scheduleDoneNotice(sessionId) {
    const state = readState()
    if (!state.doneNotifyEnabled) return
    // A reminder that fires on every finished task is worse than none. Only Windows
    // can answer "is somebody here", so elsewhere the feature stays off and says so
    // once rather than notifying every time.
    if (!PRESENCE_SUPPORTED) {
      if (!presenceWarned) {
        presenceWarned = true
        note('done', `disabled | presence probe needs Windows (this is ${process.platform})`)
      }
      return
    }
    // Nothing bound means nowhere to send; not an error, just off.
    if (!boundConversationTarget()) return

    const delayMs = (state.doneNotifyDelaySec || 30) * 1000
    const thresholdPx = state.presenceTravelPx || 120
    const generation = (doneNotices.get(sessionId) || 0) + 1
    doneNotices.set(sessionId, generation)
    note('done', `watch ${shortId(sessionId)} | ${Math.round(delayMs / 1000)}s | need ${thresholdPx}px`)

    void (async () => {
      // The sampler owns the clock: it resolves when the window closes, so there is
      // no timer to keep in step with it.
      const report = await watchDesk(delayMs, thresholdPx)
      if (doneNotices.get(sessionId) !== generation) return
      doneNotices.delete(sessionId)
      await fireDoneNotice(sessionId, report)
    })()
  }

  /** The window closed: notify unless the pointer proved somebody is at the desk. */
  async function fireDoneNotice(sessionId, report) {
    if (atTheDesk(report)) {
      note(
        'done',
        `skip ${shortId(sessionId)} | moved ${Math.round(report.travelPx)}px (need ${report.thresholdPx}) | keys ${report.keyboardSamples}`,
      )
      return
    }
    // `null` means the probe could not run. Notifying is the lesser evil: the whole
    // point is to reach the phone, and silence would look exactly like a task that
    // never finished.
    const presence = report
      ? `moved ${Math.round(report.travelPx)}px of ${report.thresholdPx}`
      : 'unknown (probe failed)'

    const target = boundConversationTarget()
    if (!target || !target.contextToken) {
      note('done', `skip ${shortId(sessionId)} | no bound conversation`)
      return
    }

    const { workspace, title } = await describeSession(sessionId)
    const text = `[系统提示] ${workspace} · ${title} · DSH 已跑完`
    const ok = await sendReply(target.accountId, target.toUserId, target.contextToken, text)
    note('done', ok ? `sent | ${presence} | ${workspace} | ${title}` : `failed | ${workspace} | ${title}`)
  }

  /** Workspace folder and title for a session, from one cached listing. */
  async function describeSession(sessionId) {
    let items = sessionCache.items
    if (Date.now() - sessionCache.at > SESSION_CACHE_MS) {
      try {
        const value = await sessionController.list({}, AbortSignal.timeout(8000))
        if (Array.isArray(value && value.items)) {
          items = value.items
          sessionCache = { at: Date.now(), items }
        }
      } catch {
        /* keep the previous listing; the message still goes out with what we have */
      }
    }
    const found = items.find((item) => String(item.sessionId) === sessionId)
    const cwd = found && found.cwd ? String(found.cwd) : ''
    const workspace = cwd ? baseName(cwd) : '未知工作区'
    const title = (found && readTitle(found)) || shortId(sessionId)
    return { workspace, title }
  }

  /**
   * Send one composed message to the conversation that owns `sessionId`.
   *
   * The agent calls this instead of having its text forwarded, so the message is
   * sent as written: no bubble splitting, only the size cap a single WeChat message
   * requires. Segmentation is the caller's decision now.
   */
  async function sendTextToConversation(sessionId, text) {
    const body = String(text || '').trim()
    if (!body) throw new Error('text 是空的，没东西可发')

    const target = resolveOutboundTarget(sessionId)
    toolSends.set(sessionId, (toolSends.get(sessionId) || 0) + 1)
    await sendReply(target.accountId, target.toUserId, target.contextToken, body)
    return { sent: true, chars: body.length }
  }
  /** Where an outbound send goes: this session's conversation, else the bound one. */
  function resolveOutboundTarget(sessionId) {    const direct = targetForSession(sessionId)
    const target = direct || boundConversationTarget()
    if (!target) throw new Error('这台机器还没绑定微信，发不出去')
    return { ...target, crossSession: !direct }
  }

  /** Feed one `agent/assistant-stream` payload. Sessions this channel does not own are ignored. */
  function handleAssistantStream(payload) {
    const sessionId = sessionIdOf(payload)
    if (!sessionId || !replyTargets.has(sessionId)) return
    const frame = payload.frame
    if (!frame || typeof frame !== 'object') return
    if (frame.type !== 'chunk') return
    const chunk = frame.chunk
    if (!chunk || chunk.type !== 'text-delta' || typeof chunk.text !== 'string') return
    pendingText.set(sessionId, (pendingText.get(sessionId) || '') + chunk.text)
  }

  async function loop(account, signal) {
    let syncBuffer = readState().syncBufs[account.accountId] || ''

    while (!signal.aborted) {
      let response
      try {
        response = await getUpdates({
          baseUrl: account.baseUrl,
          token: account.token,
          syncBuffer,
          signal,
        })
      } catch (error) {
        if (signal.aborted) break
        // A client-side long-poll timeout is the normal exit; only a real error
        // is worth reporting and backing off from.
        if (!/timeout|aborted/i.test(String((error && error.message) || ''))) {
          recordError(account.accountId, error)
          note('poll-error', String((error && error.message) || error))
        }
        await sleep(RETRY_MS, signal)
        continue
      }
      if (signal.aborted) break

      if (response && typeof response.get_updates_buf === 'string' && response.get_updates_buf !== syncBuffer) {
        syncBuffer = response.get_updates_buf
        persistCursor(account.accountId, syncBuffer)
      }

      // -14: the server dropped this bot session; the token is no longer usable.
      if (response && response.errcode === -14) {
        recordError(account.accountId, new Error('登录已失效，请在 weBot 设置里重新绑定。'))
        return
      }
      if (response && response.ret && response.ret !== 0) {
        recordError(
          account.accountId,
          new Error(`getupdates ret=${response.ret} errcode=${response.errcode} ${response.errmsg || ''}`),
        )
      }

      const messages = response && Array.isArray(response.msgs) ? response.msgs : []
      for (const message of messages) {
        if (signal.aborted) break
        try {
          await handleInbound(account, message, signal)
        } catch (error) {
          if (signal.aborted) break
          // The cursor for this batch was already persisted, so a message that fails
          // here would otherwise never be fetched again. One retry, with the duplicate
          // guard released, covers the common transient cause (a CDN fetch, a state
          // write). A failure that survives it is logged with the message id, because a
          // silently dropped message is the one outcome nobody can notice.
          const shortId = String((message && message.message_id) || '').slice(-12)
          forget(message && message.message_id)
          try {
            await sleep(500, signal)
            await handleInbound(account, message, signal)
            note('inbound', `retry ok | ${shortId}`)
          } catch (retryError) {
            if (signal.aborted) break
            note(
              'inbound',
              `failed after retry | ${shortId} | ${String(
                (retryError && retryError.message) || retryError,
              ).slice(0, 200)}`,
            )
            // Kept on disk so the next start can try again: the cursor has moved past
            // this message and the gateway will not resend it.
            queuePendingInbound(account.accountId, String(message?.from_user_id || ''), message)
            recordError(account.accountId, retryError)
          }
        }
      }
    }
  }

  function startAccount(account) {
    if (!account || !account.accountId || !account.token) return
    const existing = loops.get(account.accountId)
    if (existing) return
    const controller = new AbortController()
    loops.set(account.accountId, controller)
    note('poll', `start · ${account.accountId}`)
    void loop(account, controller.signal).finally(() => {
      if (loops.get(account.accountId) === controller) loops.delete(account.accountId)
    })
  }

  function startAll() {
    for (const account of readState().accounts) startAccount(account)
    // Retention has to run while the process is up: a message that ages out during a
    // long session must be deleted then, not at the next restart.
    pruneQuoteCache()
    if (!quotePruneTimer) {
      quotePruneTimer = setInterval(() => pruneQuoteCache(), QUOTE_PRUNE_INTERVAL_MS)
      if (typeof quotePruneTimer.unref === 'function') quotePruneTimer.unref()
    }
    // Messages that failed twice last time get one more chance, once, at start.
    void replayPendingInbound().catch((error) => {
      note('inbound', `replay failed | ${String((error && error.message) || error).slice(0, 200)}`)
    })
  }

  function stopAccount(accountId) {
    const controller = loops.get(accountId)
    if (!controller) return
    loops.delete(accountId)
    controller.abort()
  }

  function stopAll() {
    // The quote cache is written on a timer; unloading must not drop the last batch.
    if (quotePruneTimer) {
      clearInterval(quotePruneTimer)
      quotePruneTimer = null
    }
    flushQuoteCache()
    for (const accountId of [...loops.keys()]) stopAccount(accountId)
    for (const timer of settleTimers.values()) clearTimeout(timer)
    settleTimers.clear()
    // An unanswered permission request would otherwise leave the agent turn
    // blocked for the rest of the process's life.
    for (const entry of [...pendingApprovals.values()]) entry.finish('cancelled')
    pendingApprovals.clear()
    for (const entry of [...pendingQuestions.values()]) entry.finish({ answers: [] })
    pendingQuestions.clear()
    // The schedule is persisted, so unloading just drops the in-memory copy; the next
    // start hydrates it back and resumes counting instead of starting over.
    promptMarks.clear()
    // Clearing the generations makes in-flight samplers ignore their own results.
    doneNotices.clear()
    // A held file would otherwise be dropped in silence when the row unloads. It is
    // delivered now, without waiting for a window that will never expire.
    for (const key of [...contentBuffers.keys()]) void deliverBuffered(key, '')
  }

  function snapshot() {
    return {
      polling: loops.size,
      accounts: [...loops.keys()].map((accountId) => ({
        accountId,
        polling: true,
        error: accountErrors.get(accountId) || null,
      })),
      errors: [...accountErrors.values()],
      activeSessions: replyTargets.size,
      pendingApprovals: pendingApprovals.size,
      pendingQuestions: pendingQuestions.size,
      pendingInbound: (readState().pendingInbound || []).length,
      pendingMerges: contentBuffers.size,
      events: events.slice(-24),
    }
  }

  return {
    handleAgentStatus,
    handleAssistantStream,
    handleApproval,
    handleQuestion,
    replayPendingInbound,
    sendFileToConversation,
    sendTextToConversation,
    startAccount,
    startAll,
    stopAccount,
    stopAll,
    snapshot,
    log: note,
  }
}
