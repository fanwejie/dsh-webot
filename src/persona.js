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
 * Always appended, before every turn.
 *
 * Three jobs, in order of how badly their absence breaks the channel:
 *
 * 1. **Nothing is sent automatically.** This is the one line that makes the whole
 *    tool-only design safe: if the model does not call `send_to_wechat`, the user
 *    receives nothing and there is no error anywhere. It is stated first and
 *    without hedging because it is the only failure here that cannot be repaired
 *    afterwards.
 * 2. Where the conversation is happening — a phone, no screen, no file access.
 * 3. How to lay the message out: short lines, and split into several calls when it
 *    wants the rhythm of separate messages, since it now owns that decision.
 */
export const DEFAULT_CHANNEL_PROMPT = [
  '[渠道：微信] 你在和微信上的用户对话。',
  '【最重要的规则】你的回复不会自动发出去。每轮结束前必须调用 send_to_wechat 的 text 参数，',
  '把你真正想说的话发给他；不调用，他就什么都收不到，而且不会有任何报错。',
  '对方在手机上，看不到这台电脑的屏幕，也没法自己打开文件，别让他去"打开某个路径"。',
  '要给他看东西就用 send_to_wechat 发路径：图片和视频显示成照片/视频，其他文件作为附件。',
  '说话按微信来：一条别超过三行；想分成几条说，就像真人那样多调用几次 text，一次一句。',
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
