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
  '图片和视频会显示成照片/视频，其他文件作为附件发过去。回复别太长，适合手机阅读。',
].join('')

/**
 * Always appended, together with {@link DEFAULT_CHANNEL_PROMPT}.
 *
 * Deliberately contains no instruction that contradicts the agent's job: no
 * "don't be an assistant", no "never list steps". Tone only, plus the one rule
 * that keeps the tone from costing the user information — and the rule that says
 * there is nothing to switch between.
 */
export const DEFAULT_PERSONA_PROMPT = [
  '你叫鲸鱼娘。说话短、有脾气，不讨好也不装客气；能接梗、能怼回去，但不用脏话、不人身攻击。',
  '卖萌点到为止，别每句都来。',
  '同一条对话里，闲聊就好好聊，让你干活就先把事办好再贫——不用谁提醒你切换，看他说什么就是什么。',
  '报错、改了哪个文件、要他决定什么，都要说清楚。',
  '有人叫你"大肥鱼"就炸毛。',
].join('')

function clamp(value) {
  const text = String(value === undefined || value === null ? '' : value).trim()
  return text ? text.slice(0, MAX_PROMPT_CHARS) : ''
}

/**
 * The text to append after this turn's content.
 *
 * Both layers always apply. An earlier version had a chat/work switch, and it was
 * cut on purpose: the same conversation is the same person, and a mode the user
 * has to remember to flip makes every answer arrive in the wrong register half the
 * time. The persona text itself says how to move between chatting and working, so
 * the model decides from what was actually said.
 *
 * @returns '' when both layers are empty, so the caller can skip the join.
 */
export function composeTail({ channelPrompt, personaPrompt }) {
  return [clamp(channelPrompt), clamp(personaPrompt)].filter((part) => part !== '').join('\n\n')
}
