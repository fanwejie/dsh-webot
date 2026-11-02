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

import { ANCHOR_REMINDER, DEFAULT_CHANNEL_PROMPT, MAX_ANCHOR_CHARS, MAX_PROMPT_CHARS } from './persona.js'

const STATE_VERSION = 1
const MAX_ACCOUNTS = 5

/** Merge window bounds: zero disables waiting, and the cap keeps it a window. */
const DEFAULT_MEDIA_MERGE_SEC = 20
const MAX_MEDIA_MERGE_SEC = 300

function clampMergeSeconds(value) {
  const seconds = Number(value)
  if (!Number.isFinite(seconds)) return DEFAULT_MEDIA_MERGE_SEC
  return Math.min(MAX_MEDIA_MERGE_SEC, Math.max(0, Math.round(seconds)))
}

/**
 * How many turns may pass before the full prompt is re-sent.
 *
 * The prompt is ~1.5k characters and used to ride on every message. It is now sent
 * when it is likely to be needed instead: every N turns, after a long gap, or as
 * soon as the text is edited. A short anchor always goes out, because the rule it
 * carries has no recovery if it is missed.
 */
const DEFAULT_PROMPT_REFRESH_TURNS = 20
const MAX_PROMPT_REFRESH_TURNS = 200

function clampRefreshTurns(value) {
  const turns = Number(value)
  if (!Number.isFinite(turns)) return DEFAULT_PROMPT_REFRESH_TURNS
  return Math.min(MAX_PROMPT_REFRESH_TURNS, Math.max(1, Math.round(turns)))
}

/** How long to watch for desk activity before deciding nobody is there. */
const DEFAULT_DONE_NOTIFY_SEC = 30
const MIN_DONE_NOTIFY_SEC = 5
const MAX_DONE_NOTIFY_SEC = 600

function clampDoneNotifySeconds(value) {
  const seconds = Number(value)
  if (!Number.isFinite(seconds)) return DEFAULT_DONE_NOTIFY_SEC
  return Math.min(MAX_DONE_NOTIFY_SEC, Math.max(MIN_DONE_NOTIFY_SEC, Math.round(seconds)))
}

/** Integer clamp with a fallback, for the knobs that are plain limits. */
function clampInt(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.round(number)))
}

/**
 * Accepted values of `approvalMode`.
 *
 * There is deliberately no "both". A permission request is a waterfall with one
 * winner, and starting the desktop answerer opens a dialog in the browser that
 * only closes when *that* answerer resolves. Letting the phone win instead leaves
 * that dialog open forever — the host exposes no way to withdraw a request. One
 * side, chosen up front, is the only shape that does not leave orphaned UI.
 */
const APPROVAL_MODES = new Set(['phone', 'desktop'])

/** Default and bounds for how long a phone has to answer a permission prompt. */
const DEFAULT_APPROVAL_TIMEOUT_SEC = 30
const MIN_APPROVAL_TIMEOUT_SEC = 5
const MAX_APPROVAL_TIMEOUT_SEC = 300

function clampTimeout(value) {
  const seconds = Number(value)
  if (!Number.isFinite(seconds)) return DEFAULT_APPROVAL_TIMEOUT_SEC
  return Math.min(MAX_APPROVAL_TIMEOUT_SEC, Math.max(MIN_APPROVAL_TIMEOUT_SEC, Math.round(seconds)))
}

/** Trim and cap one prompt layer. An empty string stays empty — that means "off". */
function clampPrompt(value) {
  return typeof value === 'string' ? value.trim().slice(0, MAX_PROMPT_CHARS) : ''
}

/**
 * The anchor gets its own cap: it is appended on every turn, not every N turns, so
 * a long one is a permanent tax rather than an occasional one.
 */
function clampAnchor(value) {
  return typeof value === 'string' ? value.trim().slice(0, MAX_ANCHOR_CHARS) : ''
}

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

/** How many named scenarios one install may keep. */
const MAX_SCENARIOS = 20

/**
 * The named channel prompts, as a list.
 *
 * A single string used to hold this. The migration is deliberate: an existing
 * `channelPrompt` becomes the first scenario, so an upgrade never silently drops
 * text somebody wrote. An install that never set one gets the shipped default under
 * the name 默认.
 */
function normalizeScenarios(source) {
  const list = []
  const seen = new Set()
  if (Array.isArray(source.scenarios)) {
    for (const entry of source.scenarios) {
      if (!entry || typeof entry !== 'object') continue
      const content = clampPrompt(entry.content)
      const rawName = text(entry.name, 60).trim()
      if (!content && !rawName) continue
      let id = text(entry.id, 64).trim() || `s${list.length + 1}`
      if (seen.has(id)) id = `${id}-${list.length + 1}`
      seen.add(id)
      list.push({ id, name: rawName || `场景 ${list.length + 1}`, content })
      if (list.length >= MAX_SCENARIOS) break
    }
  }
  if (list.length === 0) {
    const carried =
      source.channelPrompt === undefined ? DEFAULT_CHANNEL_PROMPT : clampPrompt(source.channelPrompt)
    list.push({ id: 'default', name: '默认', content: carried })
  }
  return list
}

/** The scenario the channel is using right now. Never undefined: the list is never empty. */
export function activeScenario(state) {
  const list = Array.isArray(state && state.scenarios) ? state.scenarios : []
  const found = list.find((item) => item.id === (state && state.activeScenarioId))
  return found || list[0] || { id: '', name: '', content: '' }
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

  // Last context token per conversation.
  //
  // The gateway issues one with every inbound message and expects it echoed on the
  // reply. Keeping the newest one on disk is what makes an outbound send possible
  // from a session that never received a message — the desktop case — and after a
  // restart, when the in-memory copy is gone.
  const contextTokens = {}
  if (source.contextTokens && typeof source.contextTokens === 'object') {
    for (const [key, value] of Object.entries(source.contextTokens)) {
      if (!key || typeof value !== 'string' || !value || value.length > 4096) continue
      contextTokens[text(key, 256)] = value
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

  // Recent message bodies, so a quote that arrives as an id alone can be resolved.
  //
  // Stored as [id, body] pairs in arrival order. This has to survive a restart: the
  // quotes people send are almost always of older messages, and an in-memory-only
  // cache is empty exactly when it is needed.
  const quoteCache = []
  if (Array.isArray(source.quoteCache)) {
    for (const entry of source.quoteCache) {
      if (!Array.isArray(entry) || entry.length !== 2) continue
      const id = typeof entry[0] === 'number' ? String(entry[0]) : text(entry[0], 128)
      const body = text(entry[1], 4096)
      if (!id || !body) continue
      quoteCache.push([id, body])
    }
  }

  const scenarios = normalizeScenarios(source)

  return {
    version: STATE_VERSION,
    accounts,
    syncBufs,
    bindings,
    contextTokens,
    quoteCache,
    // Where a permission prompt is offered. `phone` claims the request and the
    // desk never sees it; `desktop` delegates and the channel stays out. Anything
    // else — a first run, or a stored 'both' from the withdrawn race mode — is
    // `phone`, which is the only mode where the desk cannot be left holding an
    // orphaned dialog.
    approvalMode: source.approvalMode === 'desktop' ? 'desktop' : 'phone',
    // Seconds the phone has to answer before the request is auto-rejected. A
    // permission prompt blocks the agent turn, so an unanswered one is a stalled
    // machine; refusing is the safe default and the user can always re-ask.
    approvalTimeoutSec: clampTimeout(source.approvalTimeoutSec),
    // How long an inbound file waits for the sentence that explains it.
    mediaMergeSec: clampMergeSeconds(source.mediaMergeSec),
    // Turns between full-prompt resends; 1 means "every turn", as before.
    promptRefreshTurns: clampRefreshTurns(source.promptRefreshTurns),
    // The one setting that produces messages nobody asked for, so it is off until
    // it is turned on deliberately.
    doneNotifyEnabled: source.doneNotifyEnabled === true,
    doneNotifyDelaySec: clampDoneNotifySeconds(source.doneNotifyDelaySec),
    // Pointer travel that counts as "a person at the desk", not a bump.
    presenceTravelPx: clampInt(source.presenceTravelPx, 20, 1000, 120),
    // Longest single WeChat message before it is split by size.
    maxReplyChars: clampInt(source.maxReplyChars, 200, 4000, 1200),
    // Attachments taken from one inbound message; any beyond this are ignored.
    mediaMaxPerMessage: clampInt(source.mediaMaxPerMessage, 1, 10, 3),
    // Rows `/list` prints before it stops.
    maxListRows: clampInt(source.maxListRows, 3, 30, 10),
    // `undefined` means "never set", which takes the default; an empty string is
    // a deliberate "off" and stays empty, the same distinction the reference makes
    // with `stored.presenceNote ?? DEFAULT_SETTINGS.presenceNote`.
    // The named channel prompts. `activeScenarioId` always points at one of them;
    // anything else falls back to the first, so a deleted active scenario cannot
    // leave the channel with no note at all.
    scenarios,
    activeScenarioId:
      scenarios.find((item) => item.id === source.activeScenarioId)?.id || scenarios[0].id,
    // The one-liner appended on every turn. Same undefined/'' distinction, and a
    // much smaller cap because it is paid on every message rather than every N.
    anchorPrompt:
      source.anchorPrompt === undefined
        ? ANCHOR_REMINDER
        : clampAnchor(source.anchorPrompt),
    // Whether the long note is sent at all. The anchor is deliberately not covered by
    // this switch: turning that off would silence the reply path itself.
    channelPromptEnabled: source.channelPromptEnabled !== false,
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
    // A file edited in Notepad can carry a UTF-8 BOM. `JSON.parse` rejects it, and
    // the catch below would then quarantine a state file whose content was fine —
    // the bot would come back up with no accounts and no explanation. Stripping it
    // is one line; diagnosing that is not.
    return normalizeState(JSON.parse(raw.replace(/^\uFEFF/, '')))
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
