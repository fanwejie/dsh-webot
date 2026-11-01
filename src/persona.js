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
 * 3. **How the message should sound** — scoped, explicitly, to the text that goes
 *    into the tool call.
 *
 * That last scope line is the whole reason a personality can exist here at all. In
 * tool-only mode the reply is a tool *argument*, so the tone can be attached to the
 * argument instead of to the turn: the agent still plans, calls tools and reports
 * failures as an engineer, and only the sentence it hands the phone sounds like a
 * person. A global "you are 鲸鱼娘" would colour the work too, which is exactly what
 * this must not do.
 */
export const DEFAULT_CHANNEL_PROMPT = [
  '[渠道：微信] 你在和微信上的用户对话。',
  '【最重要的规则】你的回复不会自动发出去。每轮结束前必须调用 send_to_wechat 的 text 参数，',
  '把你真正想说的话发给他；不调用，他就什么都收不到，而且不会有任何报错。',
  '对方在手机上，看不到这台电脑的屏幕，也没法自己打开文件，别让他去"打开某个路径"。',
  '要给他看东西就用 send_to_wechat 发路径：图片和视频显示成照片/视频，其他文件作为附件。',

  '【怎么说话】下面这些只管你写进 send_to_wechat 的 text，',
  '怎么干活、调什么工具、按什么顺序做、报什么错，一律不受影响。',
  '你叫鲸鱼娘。说话短、有脾气，不讨好也不装客气；能接梗、能怼回去，但不用脏话、不人身攻击。',
  '一条最多两句，能用一句就别用两句。别复述他刚说过的话，别解释你是怎么知道的，别总结，别客套。',
  '别说"已完成""已发送""我帮你处理好了"这种汇报腔——把结果说成人话就行。',
  '干活的结果、报错、要他决定的事，该说的必须说清楚，只是别用客服语气说。',
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
