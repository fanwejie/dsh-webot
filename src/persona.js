/**
 * Persona cards: one markdown file per role, injected ahead of the user message.
 *
 * A card is a normal file under `personas/`, so editing it needs no code change —
 * the next message picks it up. Cards are capped: a persona is repeated on every
 * turn, and an unbounded file would quietly become the largest thing in the
 * context window.
 *
 * ## Why the card rides the prompt instead of the system prompt
 *
 * The right home for this is a prompt section registered on the *agent's* own
 * context, so it is scoped to WeChat sessions and costs nothing to repeat.
 * `systemPrompt.section()` is global to the calling context, and this plugin's
 * context is the root — registering there would put the persona in front of
 * every session in DSH, including the ones you drive at the desk. Scoping it
 * needs the agent context handed out by `agent/created`, which is a larger change
 * than the first version of this feature needs. Prepending is isolated to this
 * channel by construction, and an identical prefix still hits the cache.
 *
 * @module dsh-webot/persona
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Default role when none is configured. */
export const DEFAULT_ROLE = 'dafeiyu'

/** Hard cap on one card, in characters. */
const MAX_ROLE_CHARS = 8000

/**
 * What replaces the card in work mode.
 *
 * Not an empty string: silence would leave whatever the previous turns set up,
 * and the point of the switch is a deliberate change of register.
 */
export const WORK_PREFIX = [
  '【干活模式】这一轮按工具型助手来：简洁、准确，先给结论和要做的步骤，',
  '不用人设语气、不用颜文字。需要确认的地方直接问，不要猜。',
].join('')

function roleDirectory() {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'personas')
}

/** Role names available on disk, without the extension. */
export function roleNames() {
  try {
    return fs
      .readdirSync(roleDirectory())
      .filter((name) => name.toLowerCase().endsWith('.md'))
      .map((name) => name.slice(0, -3))
      .sort()
  } catch {
    return []
  }
}

/** One role card, or '' when the file is missing or unreadable. */
export function readRole(name) {
  const safe = String(name || '')
    .replace(/[^\w\u4e00-\u9fa5-]/g, '')
    .slice(0, 64)
  if (!safe) return ''
  try {
    const raw = fs.readFileSync(path.join(roleDirectory(), `${safe}.md`), 'utf8')
    // A card may open with an HTML comment carrying its source, licence and what
    // was changed. That belongs to the reader of the file, not to the model.
    const body = raw.replace(/^\s*<!--[\s\S]*?-->\s*/, '')
    return body.trim().slice(0, MAX_ROLE_CHARS)
  } catch {
    return ''
  }
}

/**
 * Text to place ahead of one inbound message.
 *
 * @returns '' when there is nothing to say, so callers can skip the join.
 */
export function personaPrefix({ mode, role }) {
  if (mode === 'work') return WORK_PREFIX
  return readRole(role || DEFAULT_ROLE)
}
