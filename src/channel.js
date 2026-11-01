/**
 * The channel proper: long poll in, agent turn in the middle, WeChat reply out.
 *
 * One poll loop per bound account, one DSH session per WeChat conversation, and a
 * reply aggregator that turns `agent/assistant-stream` text deltas into one WeChat
 * message per answer.
 *
 * ## Why the reply waits for a settle timer
 *
 * An assistant turn is not one stream. Every model step opens its own attempt and
 * emits its own `end` frame, so a turn that calls a tool produces several. Sending
 * on each `end` splits one answer into several WeChat messages; sending on the
 * `finish` chunk is worse, because that fires once per step too. The aggregator
 * therefore appends text deltas and flushes only after the stream has been quiet
 * for {@link SETTLE_MS} — a `start` arriving inside that window cancels the flush,
 * which is exactly the tool-call case.
 *
 * @module dsh-webot/channel
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { MESSAGE_TYPE_USER, getUpdates, sendText } from './protocol/messages.js'
import { downloadMedia, extensionForName } from './protocol/media.js'
import { sendMediaToWeChat } from './protocol/outbound-media.js'
import { composeTail } from './persona.js'
import { appendEventLog, readState, updateState } from './state.js'

/** Longest slice of one answer sent as a single WeChat message. */
const MAX_REPLY_CHARS = 1200

/** How long the stream must be quiet before the answer is flushed. */
const SETTLE_MS = 700

/** Pause after a poll or send failure before trying again. */
const RETRY_MS = 1500

/** How many inbound message ids to remember for duplicate suppression. */
const SEEN_LIMIT = 500

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

/** Extract the text of one inbound item list, ignoring anything unsupported yet. */
function textOf(message) {
  const items = Array.isArray(message.item_list) ? message.item_list : []
  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    if (item.type === 1 && item.text_item && typeof item.text_item.text === 'string') {
      return item.text_item.text
    }
    // A voice note usually arrives with the service's own transcription; using it
    // means voice works without any codec, just without word-level fidelity.
    if (item.type === 3 && item.voice_item && typeof item.voice_item.text === 'string') {
      return item.voice_item.text
    }
  }
  return ''
}

/** Item types carried into a session, with the label used in the attached note. */
const MEDIA_ITEM_LABELS = new Map([
  [2, '图片'],
  [3, '语音'],
  [4, '文件'],
  [5, '视频'],
])

/** How many media items one message may carry in. */
const MAX_MEDIA_PER_MESSAGE = 3

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
function splitReply(text) {
  if (text.length <= MAX_REPLY_CHARS) return [text]
  const parts = []
  let rest = text
  while (rest.length > MAX_REPLY_CHARS) {
    const window = rest.slice(0, MAX_REPLY_CHARS)
    const cut = Math.max(window.lastIndexOf('\n'), window.lastIndexOf('。'), window.lastIndexOf('. '))
    const end = cut > MAX_REPLY_CHARS * 0.4 ? cut + 1 : MAX_REPLY_CHARS
    parts.push(rest.slice(0, end))
    rest = rest.slice(end)
  }
  if (rest) parts.push(rest)
  return parts
}

/**
 * Characters that end a bubble when the answer is prose.
 *
 * Closing Chinese quotes are included on purpose: a quoted phrase is where a
 * person stops and starts a new message ("…别是"在吗"" / "之后接一句广告"), and the
 * ASCII quote is deliberately absent — it shows up inside code and English, where
 * a split would be wrong.
 */
const BUBBLE_ENDERS = new Set(['。', '！', '？', '!', '?', '…', '\n', '」', '”', '』'])

/** More bubbles than this reads as spam; the tail is merged back instead. */
const MAX_BUBBLES = 4

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
function splitBubbles(text) {
  const trimmed = String(text || '').trim()
  if (!trimmed) return []
  if (STRUCTURED.test(trimmed)) return splitReply(trimmed)

  const sentences = []
  let buffer = ''
  for (const char of trimmed) {
    buffer += char
    if (BUBBLE_ENDERS.has(char)) {
      const sentence = buffer.trim()
      if (sentence) sentences.push(sentence)
      buffer = ''
    }
  }
  if (buffer.trim()) sentences.push(buffer.trim())

  if (sentences.length <= 1) return splitReply(trimmed)

  if (sentences.length > MAX_BUBBLES) {
    const head = sentences.slice(0, MAX_BUBBLES - 1)
    // Joined without a separator: the pieces are already trimmed fragments of the
    // same sentence run, and a space would show up in the bubble.
    head.push(sentences.slice(MAX_BUBBLES - 1).join(''))
    return head.flatMap((part) => splitReply(part))
  }

  return sentences.flatMap((part) => splitReply(part))
}

/** Commands handled by the channel itself; anything else reaches the agent. */
const KNOWN_COMMANDS = new Set(['help', 'list', 'switch', 'new', 'current', 'cancel', 'chat', 'work'])

/** Rows one `/list` screen shows. */
const MAX_LIST_ROWS = 10

/** Last six characters of a session id — the part that fits on a phone. */
function shortId(sessionId) {
  return String(sessionId).slice(-6)
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
  '',
  '/chat — 聊天模式（带人设，默认）',
  '/work — 干活模式（不套人设）',
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
    // text — and work mode deliberately answers in one piece.
    const bubble = options.bubbles === true && readState().personaMode !== 'work'
    const parts = bubble ? splitBubbles(text) : splitReply(text)
    const list = parts.length > 0 ? parts : [String(text || '')]

    for (let index = 0; index < list.length; index += 1) {
      const part = list[index]
      try {
        await sendText({
          baseUrl: account.baseUrl,
          token: account.token,
          toUserId,
          text: part,
          contextToken,
        })
        note('send', `ok · ${part.length} chars${list.length > 1 ? ` (${index + 1}/${list.length})` : ''}`)
        clearError(account.accountId)
      } catch (error) {
        note('send', `failed · ${String((error && error.message) || error)}`)
        recordError(account.accountId, error)
        return
      }
      // A short gap keeps a burst from looking like a machine gun, without
      // pretending to type.
      if (index < list.length - 1) await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }

  /**
   * Save one inbound media item into the session's workspace.
   *
   * The file lands under `media/inbound/` inside the session `cwd`, which is the
   * agent's working directory — so it can open it with its own tools. The prompt
   * carries the relative path; the bytes are not embedded as an attachment
   * block, which would need the Host attachment service and is a separate step.
   */
  async function saveInboundMedia(item, cwd) {
    const payload = mediaPayload(item)
    const media = payload && payload.media
    if (!media || (!media.encrypt_query_param && !media.full_url)) return ''

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
        return ''
      }
      note('voice', 'no transcript in payload')
      return `[微信语音] 已保存到 ${relative}（${buffer.length} 字节），但这条语音没有附带转写文字，内容无法识别。`
    }

    return `[微信${label}] 已保存到 ${relative}（${buffer.length} 字节）`
  }

  /**
   * Send a local file to the conversation that owns `sessionId`.
   *
   * Relative paths resolve against the session's workspace, not the process
   * directory: the agent produced the file while working in `cwd`, and that is
   * what a relative path means to it.
   */
  async function sendFileToConversation(sessionId, filePath, caption) {
    const target = targetForSession(sessionId)
    if (!target) throw new Error('这个会话没有绑定微信对话，文件发不出去')

    const account = readState().accounts.find((entry) => entry.accountId === target.accountId)
    if (!account) throw new Error('找不到可用的微信账号')

    const binding = readState().bindings[`${target.accountId}:${target.toUserId}`]
    const base = (binding && binding.cwd) || workspaceDirectory
    const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(base, filePath)

    const result = await sendMediaToWeChat({
      baseUrl: account.baseUrl,
      token: account.token,
      toUserId: target.toUserId,
      contextToken: target.contextToken,
      filePath: resolved,
      caption: caption || '',
    })
    note('send-media', `${result.kind} | ${result.fileName} | ${result.bytes} bytes`)
    return { sent: true, kind: result.kind, fileName: result.fileName, bytes: result.bytes }
  }

  async function handleInbound(account, message, signal) {
    if (!message || typeof message !== 'object') return
    // BOT-typed entries are our own sends echoed back by the gateway.
    if (message.message_type !== MESSAGE_TYPE_USER) return

    const userId = String(message.from_user_id || '')
    if (!userId) return

    const text = textOf(message).trim()
    const mediaItems = mediaItemsOf(message)
    // A message may be media only, so text alone no longer decides whether there
    // is anything to deliver.
    if (!text && mediaItems.length === 0) return

    const messageId = String(message.message_id || '')
    if (remember(messageId)) return
    note('inbound', `${userId} · ${text.length} chars · ${mediaItems.length} media`)

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

    const sessionId = await ensureSession(account, userId)
    replyTargets.set(sessionId, {
      accountId: account.accountId,
      toUserId: userId,
      contextToken: String(message.context_token || ''),
    })
    note('session', sessionId)

    const bindingCwd =
      readState().bindings[`${account.accountId}:${userId}`]?.cwd || workspaceDirectory
    const mediaNotes = []
    for (const item of mediaItems.slice(0, MAX_MEDIA_PER_MESSAGE)) {
      try {
        const saved = await saveInboundMedia(item, bindingCwd)
        if (saved) mediaNotes.push(saved)
      } catch (error) {
        note('media', `failed | ${String((error && error.message) || error)}`)
      }
    }

    const content = [text, ...mediaNotes].filter((part) => part).join('\n\n')
    if (!content) {
      await sendReply(
        account.accountId,
        userId,
        String(message.context_token || ''),
        '媒体下载失败，这次没送进会话。',
      )
      return
    }

    // The prompt layers go after this turn's content, not before it: a leading
    // block reads as user background, while trailing text sits closest to the
    // point where the model starts writing.
    const state = readState()
    const tail = composeTail({
      mode: state.personaMode,
      channelPrompt: state.channelPrompt,
      personaPrompt: state.personaPrompt,
    })
    const body = tail ? `${content}\n\n${tail}` : content

    await sessionController.prompt(
      {
        requestId: `webot-${crypto.randomUUID()}`,
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: body }],
      },
      signal,
    )
    note('prompt', 'accepted')
    clearError(account.accountId)
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
      return { accountId: account.accountId, toUserId: account.userId, contextToken: '' }
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
    await sendReply(target.accountId, target.toUserId, target.contextToken, lines.join('\n'))

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
    await sendReply(target.accountId, target.toUserId, target.contextToken, lines.join('\n'))

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
      const page = items.slice(0, MAX_LIST_ROWS)
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

    if (command.name === 'chat') {
      updateState({ personaMode: 'chat' })
      return reply('切回聊天模式了。')
    }

    if (command.name === 'work') {
      updateState({ personaMode: 'work' })
      return reply('切到干活模式：不套人设，直接说事。要聊天就发 /chat。')
    }

    return reply(HELP_TEXT)
  }

  async function flush(sessionId) {
    settleTimers.delete(sessionId)
    const text = (pendingText.get(sessionId) || '').trim()
    pendingText.delete(sessionId)
    if (!text) {
      note('flush', `${sessionId} · empty`)
      return
    }

    const target = replyTargets.get(sessionId)
    if (!target) {
      note('flush', `${sessionId} · no target`)
      return
    }

    note('flush', `${sessionId} · ${text.length} chars`)
    // This is the one path that carries an agent answer, so it is the one that
    // asks for bubble splitting.
    await sendReply(target.accountId, target.toUserId, target.contextToken, text, { bubbles: true })
  }

  function scheduleFlush(sessionId) {
    const existing = settleTimers.get(sessionId)
    if (existing) clearTimeout(existing)
    settleTimers.set(
      sessionId,
      setTimeout(() => {
        void flush(sessionId)
      }, SETTLE_MS),
    )
  }

  /** Feed one `agent/assistant-stream` payload. Sessions this channel does not own are ignored. */
  function handleAssistantStream(payload) {
    const sessionId = sessionIdOf(payload)
    if (!sessionId || !replyTargets.has(sessionId)) return
    const frame = payload.frame
    if (!frame || typeof frame !== 'object') return

    if (frame.type === 'start') {
      // A new model step: any pending flush belongs before this step, not inside it.
      const timer = settleTimers.get(sessionId)
      if (timer) {
        clearTimeout(timer)
        settleTimers.delete(sessionId)
      }
      return
    }

    if (frame.type === 'end') {
      scheduleFlush(sessionId)
      return
    }

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
          recordError(account.accountId, error)
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
  }

  function stopAccount(accountId) {
    const controller = loops.get(accountId)
    if (!controller) return
    loops.delete(accountId)
    controller.abort()
  }

  function stopAll() {
    for (const accountId of [...loops.keys()]) stopAccount(accountId)
    for (const timer of settleTimers.values()) clearTimeout(timer)
    settleTimers.clear()
    // An unanswered permission request would otherwise leave the agent turn
    // blocked for the rest of the process's life.
    for (const entry of [...pendingApprovals.values()]) entry.finish('cancelled')
    pendingApprovals.clear()
    for (const entry of [...pendingQuestions.values()]) entry.finish({ answers: [] })
    pendingQuestions.clear()
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
      events: events.slice(-24),
    }
  }

  return {
    handleAssistantStream,
    handleApproval,
    handleQuestion,
    sendFileToConversation,
    startAccount,
    startAll,
    stopAccount,
    stopAll,
    snapshot,
    log: note,
  }
}
