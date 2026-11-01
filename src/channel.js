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

import { MESSAGE_TYPE_USER, getUpdates, sendText } from './protocol/messages.js'
import { readState, updateState } from './state.js'

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
  }
  return ''
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
   * Ring buffer of what this channel actually did.
   *
   * The whole path — poll, dispatch, prompt, stream, send — crosses three
   * processes and two protocols, and every stage fails silently by design: a
   * dropped stream frame and an unsent message look identical from outside. This
   * is the only way to tell which stage ran, and it is cheap.
   */
  const events = []

  function note(kind, detail) {
    events.push({ at: Date.now(), kind, detail: String(detail === undefined ? '' : detail).slice(0, 300) })
    if (events.length > 80) events.shift()
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

    fs.mkdirSync(workspaceDirectory, { recursive: true })
    const created = await sessionController.create({ cwd: workspaceDirectory })
    updateState({
      bindings: {
        ...readState().bindings,
        [key]: { sessionId: created.sessionId, cwd: workspaceDirectory, createdAt: Date.now() },
      },
    })
    return created.sessionId
  }

  async function handleInbound(account, message, signal) {
    if (!message || typeof message !== 'object') return
    // BOT-typed entries are our own sends echoed back by the gateway.
    if (message.message_type !== MESSAGE_TYPE_USER) return

    const userId = String(message.from_user_id || '')
    if (!userId) return

    const text = textOf(message).trim()
    if (!text) return

    const messageId = String(message.message_id || '')
    if (remember(messageId)) return
    note('inbound', `${userId} · ${text.length} chars`)

    const sessionId = await ensureSession(account, userId)
    replyTargets.set(sessionId, {
      accountId: account.accountId,
      toUserId: userId,
      contextToken: String(message.context_token || ''),
    })
    note('session', sessionId)

    await sessionController.prompt(
      {
        requestId: `webot-${crypto.randomUUID()}`,
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text }],
      },
      signal,
    )
    note('prompt', 'accepted')
    clearError(account.accountId)
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
    const account = readState().accounts.find((entry) => entry.accountId === target.accountId)
    if (!account) {
      note('flush', `${sessionId} · account gone`)
      return
    }

    const parts = splitReply(text)
    note('flush', `${sessionId} · ${text.length} chars in ${parts.length} part(s)`)
    for (const part of parts) {
      try {
        await sendText({
          baseUrl: account.baseUrl,
          token: account.token,
          toUserId: target.toUserId,
          text: part,
          contextToken: target.contextToken,
        })
        note('send', `ok · ${part.length} chars`)
        clearError(account.accountId)
      } catch (error) {
        note('send', `failed · ${String((error && error.message) || error)}`)
        recordError(account.accountId, error)
        return
      }
    }
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
      events: events.slice(-24),
    }
  }

  return { handleAssistantStream, startAccount, startAll, stopAccount, stopAll, snapshot }
}
