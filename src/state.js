/**
 * Durable channel state.
 *
 * One JSON document under `$DSH_HOME/webot/state.json`, written atomically and
 * created with mode 0600 because it holds bot tokens. Kept plain: no DSH
 * imports, so the protocol layer and the tests can use it without a running
 * Harness.
 *
 * Windows caveat, measured: `fs` mode bits are not enforced there — a file
 * created `0o600` reports `666` and inherits the parent directory's ACL. In the
 * real location that is `%USERPROFILE%\.dsh\webot`, whose ACL already grants
 * only the user, SYSTEM and Administrators, so the practical protection matches
 * POSIX 0600. Do not move this file somewhere world-readable and assume the
 * mode argument still protects it.
 *
 * `normalizeState` is a whitelist. A field missing from it is written happily
 * and silently dropped on the next boot — the failure mode is "my setting saved
 * and then vanished", which is why every new field must be added here in the
 * same change that starts writing it.
 *
 * @module dsh-webot/state
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const STATE_VERSION = 1
const MAX_ACCOUNTS = 5

/** Accepted values of `approvalMode`. */
const APPROVAL_MODES = new Set(['both', 'phone', 'desktop'])

/** Directory that owns the state file. */
export function stateDirectory() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim()
  return path.join(home || path.join(os.homedir(), '.dsh'), 'webot')
}

/** Absolute path of the state file. */
export function stateFilePath() {
  return path.join(stateDirectory(), 'state.json')
}

function text(value, max = 512) {
  return typeof value === 'string' ? value.slice(0, max) : ''
}

function normalizeAccount(raw) {
  if (!raw || typeof raw !== 'object') return undefined
  const accountId = text(raw.accountId, 128)
  const token = text(raw.token, 4096)
  if (!accountId || !token) return undefined
  return {
    accountId,
    userId: text(raw.userId, 128),
    baseUrl: text(raw.baseUrl, 256) || 'https://ilinkai.weixin.qq.com',
    token,
    boundAt: Number.isFinite(raw.boundAt) ? Number(raw.boundAt) : Date.now(),
  }
}

/** Reduce any stored value to the exact supported shape. */
export function normalizeState(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const accounts = []
  const seen = new Set()
  if (Array.isArray(source.accounts)) {
    for (const entry of source.accounts) {
      const account = normalizeAccount(entry)
      if (!account || seen.has(account.accountId)) continue
      seen.add(account.accountId)
      accounts.push(account)
      if (accounts.length >= MAX_ACCOUNTS) break
    }
  }
  // Long-poll cursors, keyed by account id. Losing one means the gateway replays
  // or skips whatever was sent while it was missing.
  const syncBufs = {}
  if (source.syncBufs && typeof source.syncBufs === 'object') {
    for (const [key, value] of Object.entries(source.syncBufs)) {
      if (!key || typeof value !== 'string' || value.length > 16_384) continue
      syncBufs[text(key, 128)] = value
    }
  }

  // WeChat conversation -> DSH session, keyed by `${accountId}:${userId}`.
  const bindings = {}
  if (source.bindings && typeof source.bindings === 'object') {
    for (const [key, value] of Object.entries(source.bindings)) {
      if (!key || !value || typeof value !== 'object') continue
      const sessionId = text(value.sessionId, 128)
      if (!sessionId) continue
      bindings[text(key, 256)] = {
        sessionId,
        cwd: text(value.cwd, 512),
        createdAt: Number.isFinite(value.createdAt) ? Number(value.createdAt) : Date.now(),
      }
    }
  }

  return {
    version: STATE_VERSION,
    accounts,
    syncBufs,
    bindings,
    // Where a permission prompt is offered. `both` starts the desktop answerer
    // and the phone prompt together and takes whichever answers first; the other
    // two keep one side out of it entirely.
    approvalMode: APPROVAL_MODES.has(source.approvalMode) ? source.approvalMode : 'both',
    lastError:
      source.lastError && typeof source.lastError === 'object'
        ? {
            at: Number.isFinite(source.lastError.at) ? Number(source.lastError.at) : Date.now(),
            message: text(source.lastError.message, 500),
          }
        : null,
  }
}

/** Read the state file, answering a normalized empty document when absent. */
export function readState() {
  try {
    const raw = fs.readFileSync(stateFilePath(), 'utf8')
    return normalizeState(JSON.parse(raw))
  } catch (error) {
    if (error && error.code === 'ENOENT') return normalizeState(undefined)
    // A corrupt file must not brick the channel: start clean, keep the bytes
    // aside so the bad content is still diagnosable.
    try {
      fs.renameSync(stateFilePath(), `${stateFilePath()}.corrupt-${Date.now()}`)
    } catch {
      /* best effort */
    }
    return normalizeState(undefined)
  }
}

/** Absolute path of the channel's append-only event log. */
export function eventLogPath() {
  return path.join(stateDirectory(), 'events.log')
}

/** Size past which the log is started over instead of growing without bound. */
const EVENT_LOG_LIMIT = 512 * 1024

/**
 * Append one diagnostic line.
 *
 * The in-memory ring in `/status` is only readable by an authenticated page, and
 * the failures worth diagnosing here (a listener that never fires, a session id
 * that does not match) happen when nobody is looking at that page. A file on disk
 * is the difference between reporting a cause and guessing at one.
 *
 * Best effort: a failed write must never break message handling.
 */
export function appendEventLog(kind, detail) {
  try {
    const file = eventLogPath()
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    try {
      if (fs.statSync(file).size > EVENT_LOG_LIMIT) fs.writeFileSync(file, '')
    } catch {
      /* absent file is the normal first case */
    }
    const stamp = new Date().toISOString()
    fs.appendFileSync(file, `${stamp} ${kind} ${String(detail === undefined ? '' : detail).slice(0, 500)}\n`)
  } catch {
    /* diagnostics must never be a failure source */
  }
}

/** Merge a patch into the stored state, normalize, and write it atomically. */
export function updateState(patch) {
  const current = readState()
  const next = normalizeState({ ...current, ...patch })
  writeAtomic(stateFilePath(), `${JSON.stringify(next, null, 2)}\n`)
  return next
}

/**
 * Write a file atomically with 0600 permissions.
 *
 * Rename is the atomic step: a reader sees either the old document or the whole
 * new one, never a half-written file, even if the process dies mid-write.
 */
export function writeAtomic(filePath, content) {
  const directory = path.dirname(filePath)
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(temporary, content, { mode: 0o600 })
  try {
    fs.renameSync(temporary, filePath)
  } catch (error) {
    try {
      fs.unlinkSync(temporary)
    } catch {
      /* best effort */
    }
    throw error
  }
}
