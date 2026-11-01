/**
 * Two prompt layers appended to the end of every WeChat message.
 *
 * Modelled on `presenceNote` in `dsh-wechat` (packages/core/src/state.ts), which
 * taught two things worth copying and one worth changing:
 *
 * - it is a **situation note**, not a role-play card: it says where the model is
 *   talking (a phone, no screen), what it may not assume, and how to hand a file
 *   over. That is what stops an agent answering as if its user sits at the desk.
 * - it is **appended, not prepended** (`host.ts` builds `[prompt, quoted,
 *   attachments, presenceNote]`). Trailing text sits closest to generation, and a
 *   leading block reads as user background instead of as instruction.
 * - what it does not have is a persona layer. Splitting the two here is the
 *   difference between "how to behave on this channel" and "who is speaking", and
 *   keeping them separate is what lets the agent hold a tone *and* get work done —
 *   a card that says "don't be an assistant" fights the tools it must call.
 *
 * @module dsh-webot/persona
 */

/** Cap per layer: these are repeated on every turn. */
export const MAX_PROMPT_CHARS = 3000

/**
 * Always appended, in both registers.
 *
 * Kept short on purpose. The model already knows how to be an agent; what it
 * cannot know is that its user is on a phone.
 */
export const DEFAULT_CHANNEL_PROMPT = [
  '[渠道：微信] 你在和微信上的用户对话，对方在手机上，看不到这台电脑的屏幕，也没法自己打开文件。',
  '不要让他去"打开某个路径"或"看某个文件"。要给他看东西时，用 send_to_wechat 直接发：',
  '图片和视频会显示成照片/视频，其他文件作为附件发过去。',
  // A number, not an adjective: "别太长" left the model judging its own length.
  '一条回复别超过三行，手机上超过三行就没法读了。',
].join('')

function clamp(value) {
  const text = String(value === undefined || value === null ? '' : value).trim()
  return text ? text.slice(0, MAX_PROMPT_CHARS) : ''
}

/**
 * The text to append after this turn's content.
 *
 * One layer only. A persona layer used to sit behind this one, and it was removed
 * on request: two boxes that both describe "how to behave" invite the user to tune
 * the same behaviour in two places, and the persona text kept fighting the agent's
 * own job. One editable note is the whole surface.
 *
 * @returns '' when the layer is empty, so the caller can skip the join.
 */
export function composeTail({ channelPrompt }) {
  return clamp(channelPrompt)
}
