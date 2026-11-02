/**
 * dsh-webot — Host half (M3).
 *
 * Owns three things: the settings panel's routes, the one QR login attempt at a
 * time, and the channel that carries WeChat messages into agent turns and the
 * answers back out.
 *
 * Routes are registered on the shared browser connection channel
 * (`ctx.connection.fetch`) rather than the raw web server, so they inherit
 * Harness authentication. That matters here: these routes return account
 * identities and start a handshake that ends in a bot token.
 *
 * Tokens never leave the Host. `/api/webot/status` reports each account with
 * `hasToken: true` instead of the token itself, so a page that is merely
 * authenticated cannot exfiltrate the channel's credentials.
 *
 * @module dsh-webot
 */

import path from 'node:path'

import { createChannel } from './src/channel.js'
import {
  ANCHOR_REMINDER,
  DEFAULT_CHANNEL_PROMPT,
  MAX_ANCHOR_CHARS,
  MAX_PROMPT_CHARS,
} from './src/persona.js'
import { createLoginTask } from './src/protocol/login.js'
import { readState, stateDirectory, stateFilePath, updateState } from './src/state.js'

/**
 * Services this row cannot work without. `connection` serves the panel;
 * `sessionController` owns the sessions a WeChat conversation is mapped onto.
 * Declaring both means the row stays inactive rather than half-working in a
 * composition that lacks them.
 */
export const inject = ['connection', 'sessionController']

const VERSION = '1.0.8'

/**
 * Fixed `cwd` for every session this channel creates.
 *
 * It must never vary per conversation: the Host matches an adopted session by
 * `cwd`, and a mismatch makes that session permanently unreachable. Same rule,
 * same reason, as `$DSH_HOME/dsh_orb`.
 */
const WORKSPACE_DIRECTORY = path.join(path.dirname(stateDirectory()), 'dsh_webot')

/** Phases after which a login attempt will never change again. */
const TERMINAL_PHASES = new Set(['confirmed', 'failed', 'cancelled', 'already-bound'])

/** The one live login attempt, or null between attempts. */
let loginTask = null

/** The live channel, set for the lifetime of the row. */
let channel = null

/** `accountId:userId` of the bound conversation — the key every binding uses. */
function conversationKeyFor(state) {
  const account = state.accounts[0]
  return account ? `${account.accountId}:${account.userId}` : ''
}

/** The session this WeChat conversation currently talks to, if any. */
function readBinding(state) {
  const key = conversationKeyFor(state)
  const entry = key ? state.bindings[key] : undefined
  if (!entry) return null
  return {
    sessionId: entry.sessionId,
    shortId: entry.sessionId.slice(-6),
    cwd: entry.cwd,
    createdAt: entry.createdAt,
  }
}

/**
 * Best-effort title for a session row.
 *
 * `SessionSummary` carries no title field; a title reaches the client through the
 * session's projections, whose key set belongs to whichever package provides it.
 * Several plausible names are tried instead of betting on one.
 */
function readTitle(item) {
  const values = item && item.projections && item.projections.values
  if (!values || typeof values !== 'object') return ''
  for (const key of ['title', 'sessionTitle', 'name', 'label']) {
    const value = values[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

/** The status document the panel renders. Never includes a token. */
function readStatus() {
  const state = readState()
  const live = channel ? channel.snapshot() : { polling: 0, accounts: [], errors: [] }
  const pollingByAccount = new Map(live.accounts.map((entry) => [entry.accountId, entry]))
  const bound = state.accounts.length > 0
  const polling = live.polling > 0

  return {
    ok: true,
    plugin: 'dsh-webot',
    version: VERSION,
    milestone: 'M6',
    bound,
    connected: bound && polling,
    polling,
    phase: bound ? (polling ? 'connected' : 'bound') : 'idle',
    accounts: state.accounts.map((account) => {
      const entry = pollingByAccount.get(account.accountId)
      return {
        accountId: account.accountId,
        userId: account.userId,
        baseUrl: account.baseUrl,
        boundAt: account.boundAt,
        hasToken: Boolean(account.token),
        polling: Boolean(entry),
        error: entry ? entry.error : null,
      }
    }),
    errors: [...live.errors, ...(state.lastError ? [state.lastError.message] : [])],
    conversationKey: conversationKeyFor(state),
    binding: readBinding(state),
    approvalMode: state.approvalMode || 'phone',
    approvalTimeoutSec: state.approvalTimeoutSec || 30,
    mediaMergeSec: state.mediaMergeSec,
    promptRefreshTurns: state.promptRefreshTurns,
    doneNotifyEnabled: state.doneNotifyEnabled,
    doneNotifyDelaySec: state.doneNotifyDelaySec,
    presenceTravelPx: state.presenceTravelPx,
    maxReplyChars: state.maxReplyChars,
    mediaMaxPerMessage: state.mediaMaxPerMessage,
    maxListRows: state.maxListRows,
    scenarios: state.scenarios,
    activeScenarioId: state.activeScenarioId,
    channelPromptEnabled: state.channelPromptEnabled,
    anchorPrompt: state.anchorPrompt,
    // Shipped default, so the panel can offer "restore" without a second route.
    // Without this, a saved prompt would keep overriding an improved default
    // forever, and the only way back would be retyping it by hand.
    defaultChannelPrompt: DEFAULT_CHANNEL_PROMPT,
    defaultAnchorPrompt: ANCHOR_REMINDER,
    diagnostics: {
      statePath: stateFilePath(),
      workspace: WORKSPACE_DIRECTORY,
      sessions: live.activeSessions,
      pendingApprovals: live.pendingApprovals || 0,
      pendingQuestions: live.pendingQuestions || 0,
      events: live.events || [],
    },
    checkedAt: new Date().toISOString(),
  }
}

function createTask(getChannel) {
  return createLoginTask({
    onBound: async (account) => {
      const current = readState()
      const others = current.accounts.filter((entry) => entry.accountId !== account.accountId)
      updateState({ accounts: [account, ...others], lastError: null })
      // Binding is only half the job: start listening immediately so the very
      // first WeChat message after scanning is answered without a restart.
      getChannel().startAccount(account)
    },
  })
}

/** Reuse a live attempt; replace one that already settled. */
function taskForStart(getChannel) {
  if (loginTask && !TERMINAL_PHASES.has(loginTask.snapshot().phase)) return loginTask
  loginTask = createTask(getChannel)
  return loginTask
}

function json(body, status = 200) {
  return Response.json(body, { status })
}

function failure(error) {
  return json({ ok: false, error: String((error && error.message) || error) }, 500)
}

async function readCode(request) {
  try {
    const payload = await request.json()
    return typeof payload?.code === 'string' ? payload.code : ''
  } catch {
    return ''
  }
}

/**
 * Register every route and start the channel for the plugin's lifetime.
 *
 * @param ctx - the plugin context.
 */
export function apply(ctx) {
  const liveChannel = createChannel({
    sessionController: ctx.sessionController,
    workspaceDirectory: WORKSPACE_DIRECTORY,
    resolveWorkspace: resolveWorkspace,
  })
  channel = liveChannel

  /**
   * The named Workspace the channel's sessions live in.
   *
   * Without one, a session created with a bare `cwd` falls into the built-in
   * "Ungrouped" bucket, which the desktop sidebar does not render: the session
   * exists, answers messages, and is invisible in the app. `workspaceRegistry`
   * is read optionally so a composition without the Workspace feature still runs
   * the channel, just without the sidebar entry.
   */
  async function resolveWorkspace() {
    const registry = ctx.get('workspaceRegistry')
    if (!registry) return undefined
    const existing = await registry.resolveByPath(WORKSPACE_DIRECTORY)
    if (existing) return { id: existing.id, path: existing.path }
    const created = await registry.create(WORKSPACE_DIRECTORY)
    return { id: created.id, path: created.path }
  }

  // Create the workspace eagerly rather than only on the first inbound message.
  // If the sidebar groups sessions by `cwd`, this is also what makes a session
  // created *before* this change show up, instead of only new ones.
  void resolveWorkspace().catch(() => undefined)

  const getChannel = () => liveChannel

  // The turn's real end. Without this the answer is flushed by a quiet-period
  // timer, which fires in the pause a tool call creates — sending half the answer,
  // then the other half as a second message.
  const onAgentStatus = (payload) => liveChannel.handleAgentStatus(payload)
  try {
    ctx.on('agent/status', onAgentStatus, { global: true })
    liveChannel.log('boot', 'status listener: global')
  } catch {
    liveChannel.log('boot', 'status listener: rejected')
  }

  // Assistant text for every session in this Host. Sessions this channel did not
  // start are ignored inside the handler, which matches them by session id.
  //
  // `{ global: true }` is what lifts a host-scope listener onto an agent-scoped
  // event; without it these frames are dispatched on the agent's own scope and
  // never reach this context. The fallback keeps the row alive if a Cordis build
  // rejects the options bag outright — the feature would then go quiet rather
  // than take the whole plugin down.
  const onStream = (payload) => liveChannel.handleAssistantStream(payload)
  try {
    ctx.on('agent/assistant-stream', onStream, { global: true })
  } catch {
    ctx.on('agent/assistant-stream', onStream)
  }

  // Permission prompts are a waterfall: returning an outcome claims the request,
  // calling `next()` leaves it to the other answerers (the desktop pane). The
  // channel only claims prompts for sessions it owns.
  //
  // `prepend: true` is the load-bearing part. The desktop answerer is registered
  // before this row, and a waterfall stops at whoever claims the request; without
  // prepending, the prompt is answered at the desk and never reaches the phone.
  const onApproval = (request, next) => liveChannel.handleApproval(request, next)
  try {
    ctx.on('approval/request', onApproval, { global: true, prepend: true })
    liveChannel.log('boot', 'approval listener: global+prepend')
  } catch {
    try {
      ctx.on('approval/request', onApproval)
      liveChannel.log('boot', 'approval listener: local only - options rejected')
    } catch (error) {
      liveChannel.log('boot', `approval listener failed: ${String((error && error.message) || error)}`)
    }
  }

  // Structured questions are the same shape of waterfall as permissions, and get
  // the same treatment: prepend so the desk cannot claim a prompt the phone is
  // supposed to answer.
  const onQuestion = (request, next) => liveChannel.handleQuestion(request, next)
  try {
    ctx.on('user-questions/request', onQuestion, { global: true, prepend: true })
    liveChannel.log('boot', 'question listener: global+prepend')
  } catch {
    try {
      ctx.on('user-questions/request', onQuestion)
      liveChannel.log('boot', 'question listener: local only - options rejected')
    } catch (error) {
      liveChannel.log('boot', `question listener failed: ${String((error && error.message) || error)}`)
    }
  }

  // The one tool this plugin adds, and in tool-only mode the *only* way a reply
  // reaches the phone. Read optionally so a composition without the tool registry
  // still runs the channel; there the agent simply cannot answer.
  const tools = ctx.get('tools')
  if (tools && typeof tools.register === 'function') {
    ctx.effect(
      () =>
        tools.register({
          name: 'send_to_wechat',
          description:
            '把消息发到微信。**每轮回复都必须调用它，否则用户什么都收不到**——你的正文不会被自动转发。' +
            '用 text 发文字（一次一句，想分几条就调用几次）；用 path 发图片/视频/文件（jpg/png/gif/webp、mp4/mov 或普通文件）。' +
            '也可以同时给 text 和 path：先发文字再发文件。',
          parameters: {
            type: 'object',
            properties: {
              text: {
                type: 'string',
                description:
                  '要发的文字。写成真人说话：短句、直接、有脾气，别客套，别写"已完成/已发送"这种汇报腔。' +
                  '一条一句话；想分成几条微信消息，就像真人那样多调用几次，每次一句。',
              },
              path: {
                type: 'string',
                description: '要发送的文件路径；相对路径按当前会话的工作目录解析',
              },
              caption: { type: 'string', description: '可选，随文件一起发的一句说明' },
            },
            required: [],
            additionalProperties: false,
          },
          output: {
            schema: {
              type: 'object',
              properties: {
                sent: { type: 'boolean' },
                kind: { type: 'string' },
                fileName: { type: 'string' },
                chars: { type: 'number' },
                bytes: { type: 'number' },
              },
              required: ['sent'],
              additionalProperties: false,
            },
            render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
          },
          execute: async (args, exec) => {
            const sessionId =
              exec && exec.agent && exec.agent.id ? String(exec.agent.id) : ''
            if (!sessionId) throw new Error('拿不到当前会话，无法确定发往哪个微信对话')

            const text = args && typeof args.text === 'string' ? args.text.trim() : ''
            const filePath = args && typeof args.path === 'string' ? args.path.trim() : ''
            if (!text && !filePath) throw new Error('text 和 path 至少给一个，否则没有东西可发')

            // Text first: a caption describes the file that follows it.
            let result
            if (text) result = await liveChannel.sendTextToConversation(sessionId, text)
            if (filePath) {
              const sentFile = await liveChannel.sendFileToConversation(
                sessionId,
                filePath,
                args && args.caption ? String(args.caption) : '',
              )
              result = { ...sentFile, ...(result || {}) , sent: true }
            }
            return result
          },
        }),
      'dsh-webot: send_to_wechat tool',
    )
    liveChannel.log('boot', 'send_to_wechat tool registered')
  } else {
    // Silent absence is the worst outcome: the agent would simply never have the
    // tool and nothing would say why.
    liveChannel.log('boot', 'tool registry unavailable - send_to_wechat disabled')
  }

  ctx.effect(() => {
    liveChannel.startAll()
    return () => liveChannel.stopAll()
  }, 'dsh-webot: wechat poll loops')

  ctx.effect(
    () => () => {
      if (loginTask) loginTask.cancel()
      loginTask = null
      channel = null
    },
    'dsh-webot: stop everything on unload',
  )

  const register = (routePath, methods, fetch) =>
    ctx.effect(
      () => ctx.connection.fetch.register({ path: routePath, methods, requestBody: 'buffered', fetch }),
      `dsh-webot: ${routePath}`,
    )

  register('/api/webot/status', ['GET'], () => {
    try {
      return json(readStatus())
    } catch (error) {
      return failure(error)
    }
  })

  register('/api/webot/login/start', ['POST'], async () => {
    try {
      const task = taskForStart(getChannel)
      const login = await task.start()
      return json({ ok: true, login })
    } catch (error) {
      return failure(error)
    }
  })

  register('/api/webot/login', ['GET'], () => {
    try {
      return json({ ok: true, login: loginTask ? loginTask.snapshot() : { phase: 'idle' } })
    } catch (error) {
      return failure(error)
    }
  })

  register('/api/webot/login/verify', ['POST'], async (request) => {
    try {
      const code = await readCode(request)
      if (!code) return json({ ok: false, error: '缺少 code' }, 400)
      const accepted = loginTask ? loginTask.verify(code) : false
      if (!accepted) return json({ ok: false, error: '当前没有等待配对码的登录' }, 409)
      return json({ ok: true })
    } catch (error) {
      return failure(error)
    }
  })

  register('/api/webot/login/cancel', ['POST'], () => {
    try {
      if (loginTask) loginTask.cancel()
      loginTask = null
      return json({ ok: true })
    } catch (error) {
      return failure(error)
    }
  })

  register('/api/webot/sessions', ['GET'], async () => {
    try {
      const value = await ctx.sessionController.list({}, AbortSignal.timeout(8000))
      const items = Array.isArray(value && value.items) ? value.items : []
      return json({
        ok: true,
        current: readBinding(readState()),
        items: items.slice(0, 40).map((item) => ({
          sessionId: item.sessionId,
          shortId: String(item.sessionId).slice(-6),
          title: readTitle(item),
          cwd: item.cwd || '',
          updatedAt: item.updatedAt || 0,
          running: Boolean(item.running),
          blank: Boolean(item.blank),
        })),
      })
    } catch (error) {
      return failure(error)
    }
  })

  register('/api/webot/bind', ['POST'], async (request) => {
    try {
      const payload = await request.json().catch(() => ({}))
      const state = readState()
      const key = conversationKeyFor(state)
      if (!key) return json({ ok: false, error: '还没有绑定微信' }, 409)

      const bindings = { ...state.bindings }
      const requested = typeof payload?.sessionId === 'string' ? payload.sessionId.trim() : ''

      // No session id means "detach": the next inbound message creates a fresh
      // session inside the named workspace.
      if (!requested) {
        delete bindings[key]
        updateState({ bindings })
        return json({ ok: true, binding: null })
      }

      const value = await ctx.sessionController.list({}, AbortSignal.timeout(8000))
      const items = Array.isArray(value && value.items) ? value.items : []
      const found = items.find((item) => item.sessionId === requested)
      if (!found) return json({ ok: false, error: '找不到该会话，请刷新列表后重试' }, 404)

      // The Host adopts an existing session by `cwd`; store the one it reports
      // rather than assuming it, or the session becomes unreachable later.
      bindings[key] = {
        sessionId: requested,
        cwd: found.cwd || WORKSPACE_DIRECTORY,
        createdAt: Date.now(),
      }
      updateState({ bindings })
      return json({ ok: true, binding: readBinding(readState()) })
    } catch (error) {
      return failure(error)
    }
  })

  register('/api/webot/settings', ['POST'], async (request) => {
    try {
      const payload = await request.json().catch(() => ({}))
      const patch = {}

      if (payload && typeof payload.approvalMode === 'string') {
        if (!['phone', 'desktop'].includes(payload.approvalMode)) {
          return json({ ok: false, error: 'approvalMode 只能是 phone / desktop' }, 400)
        }
        patch.approvalMode = payload.approvalMode
      }

      if (payload && payload.approvalTimeoutSec !== undefined) {
        const seconds = Number(payload.approvalTimeoutSec)
        if (!Number.isFinite(seconds) || seconds < 5 || seconds > 300) {
          return json({ ok: false, error: 'approvalTimeoutSec 需在 5–300 秒之间' }, 400)
        }
        patch.approvalTimeoutSec = Math.round(seconds)
      }

      if (payload && payload.doneNotifyEnabled !== undefined) {
        patch.doneNotifyEnabled = payload.doneNotifyEnabled === true
      }

      if (payload && payload.doneNotifyDelaySec !== undefined) {
        const seconds = Number(payload.doneNotifyDelaySec)
        if (!Number.isFinite(seconds) || seconds < 5 || seconds > 600) {
          return json({ ok: false, error: 'doneNotifyDelaySec 需在 5–600 秒之间' }, 400)
        }
        patch.doneNotifyDelaySec = Math.round(seconds)
      }

      // The limit-style knobs share one shape: an integer inside a fixed range.
      for (const [key, min, max] of [
        ['presenceTravelPx', 20, 1000],
        ['maxReplyChars', 200, 4000],
        ['mediaMaxPerMessage', 1, 10],
        ['maxListRows', 3, 30],
      ]) {
        if (!payload || payload[key] === undefined) continue
        const value = Number(payload[key])
        if (!Number.isFinite(value) || value < min || value > max) {
          return json({ ok: false, error: `${key} 需在 ${min}–${max} 之间` }, 400)
        }
        patch[key] = Math.round(value)
      }

      if (payload && payload.promptRefreshTurns !== undefined) {
        const turns = Number(payload.promptRefreshTurns)
        if (!Number.isFinite(turns) || turns < 1 || turns > 200) {
          return json({ ok: false, error: 'promptRefreshTurns 需在 1–200 之间' }, 400)
        }
        patch.promptRefreshTurns = Math.round(turns)
      }

      if (payload && payload.mediaMergeSec !== undefined) {
        const seconds = Number(payload.mediaMergeSec)
        if (!Number.isFinite(seconds) || seconds < 0 || seconds > 300) {
          return json({ ok: false, error: 'mediaMergeSec 需在 0–300 秒之间' }, 400)
        }
        patch.mediaMergeSec = Math.round(seconds)
      }

      if (payload && payload.channelPromptEnabled !== undefined) {
        patch.channelPromptEnabled = payload.channelPromptEnabled === true
      }

      if (payload && typeof payload.anchorPrompt === 'string') {
        if (payload.anchorPrompt.length > MAX_ANCHOR_CHARS) {
          return json({ ok: false, error: `anchorPrompt 超过 ${MAX_ANCHOR_CHARS} 字` }, 400)
        }
        patch.anchorPrompt = payload.anchorPrompt
      }

      // The named scenarios. Shape and lengths are enforced here so a bad payload
      // cannot reach the state file; normalizeState clamps again on read.
      if (payload && payload.scenarios !== undefined) {
        if (!Array.isArray(payload.scenarios)) {
          return json({ ok: false, error: 'scenarios 必须是数组' }, 400)
        }
        if (payload.scenarios.length === 0) {
          return json({ ok: false, error: '至少要保留一个场景' }, 400)
        }
        if (payload.scenarios.length > 20) {
          return json({ ok: false, error: '场景最多 20 个' }, 400)
        }
        const cleaned = []
        for (const entry of payload.scenarios) {
          if (!entry || typeof entry !== 'object') {
            return json({ ok: false, error: '场景格式不对' }, 400)
          }
          const name = typeof entry.name === 'string' ? entry.name.trim() : ''
          const content = typeof entry.content === 'string' ? entry.content : ''
          if (!name) return json({ ok: false, error: '场景名称不能为空' }, 400)
          if (name.length > 60) return json({ ok: false, error: '场景名称最多 60 字' }, 400)
          if (content.length > MAX_PROMPT_CHARS) {
            return json({ ok: false, error: `场景内容超过 ${MAX_PROMPT_CHARS} 字` }, 400)
          }
          const id = typeof entry.id === 'string' && entry.id.trim() ? entry.id.trim().slice(0, 64) : ''
          cleaned.push({ id, name, content })
        }
        patch.scenarios = cleaned
      }

      if (payload && typeof payload.activeScenarioId === 'string') {
        patch.activeScenarioId = payload.activeScenarioId
      }

      if (Object.keys(patch).length === 0) {
        return json({ ok: false, error: '没有可更新的字段' }, 400)
      }

      const next = updateState(patch)
      return json({
        ok: true,
        approvalMode: next.approvalMode,
        approvalTimeoutSec: next.approvalTimeoutSec,
        mediaMergeSec: next.mediaMergeSec,
        promptRefreshTurns: next.promptRefreshTurns,
        doneNotifyEnabled: next.doneNotifyEnabled,
        doneNotifyDelaySec: next.doneNotifyDelaySec,
        presenceTravelPx: next.presenceTravelPx,
        maxReplyChars: next.maxReplyChars,
        mediaMaxPerMessage: next.mediaMaxPerMessage,
        maxListRows: next.maxListRows,
        scenarios: next.scenarios,
        activeScenarioId: next.activeScenarioId,
        channelPromptEnabled: next.channelPromptEnabled,
        anchorPrompt: next.anchorPrompt,
      })
    } catch (error) {
      return failure(error)
    }
  })
}
