/**
 * dsh-webot — Host half (M2).
 *
 * Serves the settings panel and owns the one QR login attempt at a time.
 *
 * Routes are registered on the shared browser connection channel
 * (`ctx.connection.fetch`) rather than the raw web server, so they inherit
 * Harness authentication. That matters here more than in M1: these routes return
 * account identities and start a handshake that ends in a bot token.
 *
 * Tokens never leave the Host. `/api/webot/status` reports each account with
 * `hasToken: true` instead of the token itself, so a page that is merely
 * authenticated cannot exfiltrate the channel's credentials.
 *
 * @module dsh-webot
 */

import { createLoginTask } from './src/protocol/login.js'
import { readState, stateFilePath, updateState } from './src/state.js'

/** The row needs the browser connection channel to serve the panel. */
export const inject = ['connection']

const VERSION = '0.2.0'

/** Phases after which a login attempt will never change again. */
const TERMINAL_PHASES = new Set(['confirmed', 'failed', 'cancelled', 'already-bound'])

/** The one live login attempt, or null between attempts. */
let loginTask = null

/** The status document the panel renders. Never includes a token. */
function readStatus() {
  const state = readState()
  const bound = state.accounts.length > 0
  return {
    ok: true,
    plugin: 'dsh-webot',
    version: VERSION,
    milestone: 'M2',
    bound,
    // No long poll exists until M3, so `connected` stays false and the panel
    // reports "bound" instead of claiming a live link it does not have.
    connected: false,
    polling: false,
    phase: bound ? 'bound' : 'idle',
    accounts: state.accounts.map((account) => ({
      accountId: account.accountId,
      userId: account.userId,
      baseUrl: account.baseUrl,
      boundAt: account.boundAt,
      hasToken: Boolean(account.token),
    })),
    errors: state.lastError ? [state.lastError.message] : [],
    diagnostics: { statePath: stateFilePath() },
    checkedAt: new Date().toISOString(),
  }
}

function createTask() {
  return createLoginTask({
    onBound: async (account) => {
      const current = readState()
      const others = current.accounts.filter((entry) => entry.accountId !== account.accountId)
      updateState({ accounts: [account, ...others], lastError: null })
    },
  })
}

/** Reuse a live attempt; replace one that already settled. */
function taskForStart() {
  if (loginTask && !TERMINAL_PHASES.has(loginTask.snapshot().phase)) return loginTask
  loginTask = createTask()
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
 * Register every route for the plugin's lifetime.
 *
 * @param ctx - the plugin context.
 */
export function apply(ctx) {
  const register = (path, methods, fetch) =>
    ctx.effect(
      () => ctx.connection.fetch.register({ path, methods, requestBody: 'buffered', fetch }),
      `dsh-webot: ${path}`,
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
      const task = taskForStart()
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

  ctx.effect(
    () => () => {
      if (loginTask) loginTask.cancel()
      loginTask = null
    },
    'dsh-webot: stop the login attempt on unload',
  )
}
