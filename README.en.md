# dsh-webot

[中文](README.md) · **English**

A WeChat channel plugin for DeepSeek Harness. It adds a 「weBot设置」 button to the
top-right of the settings page: scan the QR code once, and from then on the phone is
another way to drive the agent on this machine.

- Send a message in WeChat → the agent works in DSH → the answer arrives on the phone
- The agent writes its own replies through the `send_to_wechat` tool, in as many
  messages as it wants
- Send it a picture or a file: it lands in the session workspace and the agent can
  read it. It can send pictures and files back
- Permission prompts arrive on the phone: `1` allow once / `2` reject / `3` cancel
- A message sent mid-task interrupts the running turn instead of queueing behind it
- Sessions can be managed from WeChat: `/list`, `/switch`, `/new`, `/current`, `/cancel`
- Scenarios: keep several prompt-and-persona sets and switch between them
- When another session finishes and you are not at the desk, the phone is told
  (Windows only)

---

## Install

### Requirements

| Item | Requirement |
| --- | --- |
| DeepSeek Harness | Desktop build with plugin management (`plugin_manager`) |
| OS | **Windows 10/11** for everything; macOS / Linux for everything except the completion reminder (see Compatibility) |
| Network | Reachability of `ilinkai.weixin.qq.com` (Tencent's iLink gateway) |
| WeChat | A phone with WeChat. No official account, no WeCom account needed |

### Three steps

**1. Put the repository somewhere permanent**

```bash
git clone https://github.com/fanwejie/dsh-webot.git
```

Anywhere is fine, but **not a temporary directory** — DSH links this directory, and
deleting it removes the plugin.

**2. Let DSH install it**

Turn on **Full access** in DSH (installing a plugin writes to the profile, which is
refused without it), then tell the agent:

> 用 plugin_manager 把 `<the absolute path you cloned into>` 装成 bundle

It runs `install_bundle` and installs the one runtime dependency (`qrcode`) with it.
`application: applied` means it is live; `restart-required` means step 3 is next.

> If the QR step ever reports `二维码依赖未安装（qrcode）`, run `npm install` once inside
> the plugin directory. DSH loads this plugin from the directory directly, so a
> missing `node_modules` there is the only thing to fix.

**3. Restart DSH**

The Host half only loads on restart. The Client half (the button and panel) follows a
page refresh.

### Bind

1. DSH → Settings → **「weBot设置」** at the top right
2. The panel fetches a QR code; scan it with WeChat
3. The panel shows 「已连接 · 微信消息会送到这里」, and the binding is written to
   `%USERPROFILE%\.dsh\webot\state.json`

After that, any WeChat message to the bot starts a session in DSH.

### What you should see

```
WeChat: 在吗
→ a new session appears in DSH, working in %USERPROFILE%\.dsh\dsh_webot
→ an answer arrives in WeChat a few seconds later
```

The log is `%USERPROFILE%\.dsh\webot\events.log`. Every line is one real action
(`inbound`, `prompt full`, `send ok`, `done sent`, …). **Read it first when something
looks wrong.**

---

## Compatibility

| Feature | Windows | macOS / Linux |
| --- | --- | --- |
| QR binding, text both ways | ✅ | ✅ |
| Sending and receiving images / files / video | ✅ | ✅ |
| Permission prompts and questions on the phone | ✅ | ✅ |
| Session commands (`/list` …) | ✅ | ✅ |
| Completion reminder (is anyone at the desk?) | ✅ | ❌ switched off |

**Why the completion reminder is Windows-only.** It decides whether a human is
present by sampling how far the pointer travels, which needs `GetCursorPos` /
`GetLastInputInfo`; the plugin reaches them through PowerShell. macOS and Linux have
no equivalent without a native module, and this plugin deliberately carries no native
dependency — otherwise every user would need a compiler toolchain.

On other platforms the switch is ignored and one log line says so
(`done disabled | presence probe needs Windows`). It never degrades into "send a
WeChat message after every finished task".

### What it relies on in DSH

- Services: `connection` (HTTP routes), `sessionController` (create, prompt, cancel),
  `tools` (registers `send_to_wechat`)
- Events: `agent/assistant-stream`, `agent/status`, `approval/request` (waterfall),
  `user-questions/request` (waterfall)
- Slots: `settings.action` (the button), `shell.overlay`

If any of these changes, the plugin says so in the startup log
(`tool registry unavailable`, `status listener: rejected`, …) instead of failing
silently.

---

## Layout

| Path | Role |
| --- | --- |
| `index.js` | Host half: routes, the one live login attempt, session delivery, tool registration |
| `client.js` | Browser half: the header button and the whole panel (plain JS, no build) |
| `src/protocol/` | iLink: HTTP, login, messages, media download and upload |
| `src/channel.js` | Channel core: long poll, dispatch, replies, approvals, notifications |
| `src/state.js` | State file: atomic write, whitelist, migration of old fields |
| `src/persona.js` | Shipped prompt defaults |
| `src/presence.js` | "Is anyone at the desk?", Windows only |
| `cordis.patch.yml` | One Host row |
| `locale/` | Plugin title and description shown in plugin management |
| `tools/` | Dev-only readers for the installed DSH packages (not shipped) |

---

---

*What follows is the reasoning and the mistakes, kept for whoever changes this
plugin. For using it, the sections above are enough.*

## How one message travels

```
WeChat ──► iLink getupdates (long poll, 35s)
             │  message_type 1 only; duplicate message ids dropped
             ▼
        conversation key = accountId:userId
             │  first message creates the DSH session, later ones reuse it
             ▼
        sessionController.prompt({ sessionId, content:[{type:'text'}] })
             │
             ▼
        agent runs tools ──► send_to_wechat(text|path) ──► iLink ──► the phone
             │
             └─► agent/assistant-stream is accumulated as *evidence only*
```

**Nothing is forwarded automatically.** The agent composes every message through
`send_to_wechat`, so it decides what is said, how many messages there are, and
whether this turn answers at all.

That decision is why this mode replaced auto-forwarding: one answer used to arrive as
two mismatched messages, because a quiet-period timer fired in the pause a tool call
creates between model steps, sent the text so far, and the rest followed afterwards.

The stream is still accumulated, but only to answer one question at `agent/status`
`idle`: **did this turn actually reply?** The log records it as
`turn <id> | idle | tool-sends=N | draft=M chars`, and appends `NO REPLY SENT` when
the model drafted text and sent nothing. That case is the only failure this design
can produce, and it is the reason the counter exists.

Because delivery is a decision, the channel prompt states it first and without
hedging: *每轮结束前必须调用 send_to_wechat 的 text 参数……不调用，他就什么都收不到，
而且不会有任何报错。*

### Telling the phone when a desk task finishes

The channel also watches sessions it does **not** own. When one of them goes idle
(the `agent/status` listener is global), it samples the pointer for
`doneNotifyDelaySec` and then answers one question: *is anybody at this computer?*

- total pointer travel under **120 px** (about four pointer widths) → nobody is
  sitting there → **send one line**, composed by the channel, not the model:

```
[系统提示] weBot · 修一下发送 · DSH 已跑完
```

- more travel than that, or steady typing → you are at the desk → **stay quiet**.

**Why a distance and not "any input".** The first version asked `GetLastInputInfo`
whether *anything* had happened, and a bumped desk cancels that — a reminder you
never saw. Measuring how far the pointer travelled separates a nudge from a person
reaching for the mouse. Typing counts too, as a sample count rather than a distance:
someone in an editor has not moved the pointer but is plainly present.

**One process, not 120.** Sampling from Node would mean a process launch every
250 ms. A single PowerShell process is started once and loops internally, returning
one line — `travel keys` — when the window closes.

Verified against real movement: dragging the pointer 200 px makes the sampler report
`travelPx: 200`, and the thresholds behave (`119 → away`, `120 → present`).

If the probe cannot run on Windows, the message is sent and the log says so: the
purpose is to reach the phone, and silence would be indistinguishable from a task
that never finished. On platforms where it can never run, the feature is off
entirely. Off by default everywhere — it is the one setting that produces messages
nobody typed.

### Interrupting a running turn

A message sent while the agent is working is submitted as `steer`, not `queue`.
Queueing it means the user is answering an answer that is already stale, and the
agent finishes work nobody asked for any more — which is what makes a busy session
feel like it is ignoring the phone.

A refused `steer` is a real outcome, not an error: the turn it targeted can end
between the decision and the submit. The message is then submitted as `queue`,
because losing it is the one failure nothing can repair. The log records which
happened (`prompt steered` / `prompt queued`), so a session that never interrupts is
diagnosable rather than mysterious.

`cwd` for every session this channel creates is fixed at `$DSH_HOME/dsh_webot`. It
must never vary per conversation: the Host matches an adopted session by `cwd`, and a
mismatch makes that session permanently unreachable.

## Settings

Everything tunable lives in the panel, with the range enforced on both sides: the
input clamps, and `/api/webot/settings` rejects an out-of-range value rather than
storing it. Every field's `?` explains it; this table is the summary.

| Setting | Default | Range | What it does |
| --- | --- | --- | --- |
| 权限请求在哪回答 | phone | phone / desktop | Who claims a permission prompt |
| 等多久算放弃 | 30 s | 5–300 | An unanswered prompt is rejected after this |
| 文件合并 | 20 s | 0–300 | An inbound file waits this long for its follow-up text; 0 = never wait |
| 单次附件数 | 3 | 1–10 | Attachments handled per inbound message |
| 提示词重发 | 20 turns | 1–200 | Turns between full-prompt resends (1 = every turn) |
| 单条消息上限 | 1200 chars | 200–4000 | Longest single WeChat message before splitting |
| /list 行数 | 10 | 3–30 | Rows `/list` prints |
| 任务完成提醒 | off | on/off | Notify the phone when another session finishes |
| 等待秒数 | 30 s | 5–600 | How long to watch the desk before deciding |
| 鼠标阈值 | 120 px | 20–1000 | Pointer travel that counts as "somebody is here" |
| 提示词 | shipped text | 0–8000 chars | The note appended to each turn |

Deliberately **not** in the panel: the poll retry interval, the duplicate-id cache
size, the session-listing cache and the bubble-splitter thresholds. Those are
engineering constants — exposing them would let a user make the channel silently
slower or lossier with no way to tell.

## Seeing the session in DSH

A session created with only a `cwd` lands in the built-in "Ungrouped" bucket, and the
desktop sidebar does not render that bucket — the session exists on disk, answers
WeChat messages, and is invisible in the app. That was the state after the first
text-only milestone, confirmed by a session directory on disk with no sidebar row.

It is fixed in two ways:

- channel-created sessions are created inside a **named workspace** at
  `$DSH_HOME/dsh_webot`, so they appear in the sidebar like any other;
- the panel's 「会话绑定」 section lists the Host's sessions and binds the
  conversation to any of them — including one you already had — or detaches it, so
  the next message starts a fresh session inside the workspace.

## The prompt

**Named scenarios, plus one anchor.** The long note is not a single string: it is a
list of scenarios you can add, edit, switch and delete, because the voice you want for
work is not the one you want at 11pm.

```
场景提示词  [ 工作 ▾ ]  [调整] [删除]
           点击添加场景提示词
```

| Layer | When | Size |
| --- | --- | --- |
| Anchor | **every turn, no switch** | 48 chars |
| Scenario (the active one) | every N turns, or when the text changes — **switchable** | up to 8,000 chars |

`发送场合提示词` turns the scenario note off entirely; the anchor has no such control on
purpose. Turning the note off costs nothing but the persona; turning the anchor off
would silence every reply path at once, and silently.

Adding and editing happen in their own dialog — name, content, save, cancel — because
a full prompt does not belong in a row of a settings list. Both fields commit on
their own: there is no save button to forget.

**Deleting is staged.** 删除 greys the option and turns into 撤销删除; nothing is
written until the panel closes. That way one misplaced click cannot destroy a prompt
that took ten minutes to write, and the undo is in the same place as the mistake. The
last scenario cannot be deleted: the channel would have nothing to send.

`channelPrompt` from an earlier version is migrated into the first scenario on read,
so an upgrade never drops text somebody wrote.

The anchor carries exactly one rule: *这轮回复要用 send_to_wechat 的 text 发出去，否则他
收不到任何消息*. It is exempt from the schedule because in tool-only mode a turn that
misses it reaches nobody and reports no error — the one failure here with no
recovery. Saving those 48 characters would trade a rounding error of tokens for
silent lost messages.

**Both strings are editable**, in the panel's 提示词 group: 每轮都追发的提醒 is the
anchor (capped at 300 characters, because it is paid on every message) and 场合提示词
is the scenario above. Clearing the anchor turns it off — the field says so, because
that is the one edit here that can quietly reintroduce silent non-replies.

The full note is re-sent on two triggers: the turn count (a long working session,
where the note drifts far back in the context) and an edit (the user just changed it
and expects it applied now).

**A restart is not a trigger.** The counter lives in `state.json`, so a restarted process
resumes counting where it stopped instead of sending the note again — the conversation's
own transcript still contains it, and re-sending it only spends tokens. Only the first
message of a **new session** carries the full note, because that session's context really
is empty.

**No idle-time trigger, on purpose.** A chat resumed hours later still has the note
earlier in its own transcript, so counting turns loses nothing — and a clock trigger
would fire on the one occasion the context is least likely to have dropped it.

`提示词重发` in the panel sets N (default 20, 1–200; `1` restores the old every-turn
behaviour). The log says which layer went out:

```
prompt full | 1509 chars | next in 20 turns
prompt anchor | 3/20 turns
```

The shipped default is the authored "微信聊天助手" prompt in seven sections. The order
is the priority order:

| Section | Purpose |
| --- | --- |
| 一、基本规则 | Nothing is auto-sent, the phone-only setting, how to hand over a file, message length, and the ban on pretending a task succeeded |
| 二、人格设定 | Who is speaking: gentle, 细腻, a little shy, a little sisterly |
| 三、聊天风格 | Voice, with the phrases it may use sparingly |
| 四、关心与情绪回应 | When to comfort — and that comfort must not become the default answer |
| 五、任务处理原则 | Task first, comfort afterwards; never trade accuracy for the persona |
| 六、禁止事项 | Pet names, manufactured intimacy, restating the user, summaries, support-desk phrasing, over-acting cute |
| 七、表情与长度 | Emoji only, at most two per message; length by situation |

### Why the persona can exist here at all

In tool-only mode **the reply is a tool argument**, so the tone can be attached to the
argument instead of to the turn. The agent still plans, calls tools and reports
failures as an engineer; only the sentence it hands the phone sounds like a person.

That is the difference from an earlier version, where a global "you are X" coloured
the work too — the agent became chatty about its own tool calls. The same is why
section 四 says 优先完成任务，不要先进行无关的情绪安慰 and section 五 forbids
「任务已完成」-style reports while requiring failures to be stated: **the persona may
change the tone of the report, never its content.**

Length is a number, not an adjective — 三行以内, 0–2 表情, 一至三句话 — because
"别太长" leaves the model judging its own length, and it always judges itself short.

The cap is 8000 characters (`MAX_PROMPT_CHARS`). It rides on most turns, so it is the
one thing here with a running cost; truncating it would be worse, because the model
cannot tell that the rule it needed was cut off.

There is no `/role`, no chat/work switch, and no `personas/` directory: one list of
scenarios, editable in the panel, is the whole surface.

### Why it is shaped this way

This follows `presenceNote` in
[`dsh-wechat`](https://github.com/xcisxc29/dsh-wechat) (`packages/core/src/state.ts`,
`packages/bundle/src/host.ts`):

- **A situation note, not a role-play card.** Its default text exists because
  "without it the agent answers as if its user sits at the desktop console" — the job
  is to say where the conversation is happening, which is exactly what a
  location-agnostic agent cannot know.
- **Appended, not prepended.** Its prompt is built as
  `[user text, quoted, attachments, note]`. Trailing text sits closest to the point
  where generation starts; a leading block reads as user background. Our first
  version put an 1100-character persona in front of every message, and it was mostly
  ignored — this is the fix that mattered most.
- **`undefined` means default, `''` means off.** A cleared field stays cleared
  instead of silently snapping back.

### Reply bubbles

**Idle in this mode.** The splitter is still in `src/channel.js` and still tested — a
future "auto-forward unless the agent already sent" mode needs exactly it — but
nothing calls it now: the agent composes each message through `send_to_wechat`, so how
many messages there are is its decision, and splitting its text would second-guess it.

What the splitter did, and the rules it learned from real traffic, for when it comes
back: an answer was cut at sentence boundaries — `。！？!?…`, newlines, and closing
Chinese quotes (`」”』`) — because that is where a person stops and starts a new
bubble.

**Only long answers are split.** Measured from real traffic, a 73-character reply came
out as four messages of 10/45/4/12 characters — the report was "乱七八糟", and it was
right: that is shredding, not texting.

```
reply 82 chars -> 3 bubbles: 21 / 49 / 12
reply 21 chars -> 1 bubble
```

Guards, each for a specific failure:

- **Short replies stay whole** (`MIN_SPLIT_CHARS = 40`). Splitting is meant to make a
  long answer look like texting, not to cut a short one in half. The quoted-phrase
  example above no longer splits for this reason: both halves are short enough that
  two messages read worse than one.
- **A bubble shorter than 12 characters merges into its neighbour**
  (`MIN_BUBBLE_CHARS`), on either side of the join, so a short opening sentence does
  not strand a two-character tail behind it. `还在转。` as its own message is noise.
- **A boundary only counts when a new thought follows.** Closing quotes end a bubble,
  but not when the next non-space character is `，、；：` — that is mid-sentence, and
  splitting there left a bubble opening with a comma (`他说“在吗”，然后…`). Reported
  from a real reply reading "，在吗".
- **A fragment that is only punctuation rejoins the previous bubble.** Splitting at
  `？` inside quotes otherwise produced a bubble containing nothing but `”`.
- **At most 4 bubbles.** The tail merges back into the last one; more reads as spam
  rather than as texting.
- **Structured answers never split** — a code fence, a list marker or a table carries
  meaning across its line breaks, and chopping it turns one readable answer into
  several broken fragments.
- **Command receipts never bubble.** `/help` and `/list` are one message; splitting
  them into ten would be worse than a wall of text.
- The ASCII `"` is deliberately *not* a boundary: it appears inside code and English,
  where a split would be wrong.
- 250 ms between bubbles, so a burst does not look like a machine gun.

## Commands from WeChat

Handled by the channel itself; they never reach the agent. Anything else is a normal
prompt.

| Command | What it does |
| --- | --- |
| `/list` | This machine's sessions, numbered, each with its short id |
| `/switch 3` | Move to row 3 of the screen **you are reading** |
| `/switch a1b2c3` | Move by short id — independent of numbering, never stale |
| `/new 修复登录` | Create a session (titled if given) and move to it |
| `/current` | Which session this conversation is on |
| `/cancel` | Stop the running turn |
| `/help` | The list above |

`/switch 3` resolves against the ids captured when that `/list` was sent, not against
a fresh fetch: sessions run while the list sits on a phone, so row 3 may point at a
different session by the time the reply arrives. Numbers therefore go stale across
*different* listings, which is exactly why every row also carries a short id.

The command name runs up to the first non-letter, so `/switch3` is accepted as
`/switch 3`; `/switch:3` is not, because the colon lands in the argument and is then
treated as a short id.

## Permission prompts on the phone

`approval/request` is a waterfall: return an outcome to claim the request, call
`next()` to leave it to the other answerers. The channel claims a prompt only when
the requesting session is one it owns; everything else delegates.

**Which side sees the prompt is a setting**, `approvalMode` in the panel:

| Mode | Behaviour |
| --- | --- |
| `phone` (default) | The channel claims the request; the desk never shows it |
| `desktop` | The channel delegates; the phone never shows it |

There is deliberately **no "both"**, and this was learned the expensive way: it
shipped, and it left a permission dialog stuck on the desktop after the turn had
already finished. Calling `next()` opens a dialog in the browser that closes only when
*that* answerer resolves; letting the phone win instead abandons it, and the host
exposes no withdraw call. A request has exactly one owner, so the choice is made up
front instead of raced.

While a prompt is open the agent turn is blocked on it, so the phone reply is consumed
before commands and before the agent.

**An unanswered prompt expires.** After `approvalTimeoutSec` (default 30, 5–300) the
channel answers `rejected` on your behalf and says so on the phone. Waiting forever is
the one outcome that is always wrong: the agent turn is blocked, the machine sits
idle, and nobody learns why. Refusing is safe — the ask can simply be repeated.

| Reply | Outcome |
| --- | --- |
| `1`, `允许`, `同意`, `好`, `y`, `yes` | `allowed-once` |
| `2`, `拒绝`, `不`, `n`, `no` | `rejected` |
| `3`, `取消` | `cancelled` |

Anything else while a prompt is open gets a short reminder instead of being
forwarded — the turn is waiting on the decision, so queueing text behind it would only
look like the agent ignored you. `req.signal` aborts the wait (the request went away),
and unloading the plugin resolves every open prompt as `cancelled` so no turn stays
blocked for the life of the process.

One prompt per conversation: a second simultaneous request delegates instead of
stacking, which is what keeps a bare `1` unambiguous.

## Structured questions

`ask_user_question` — the agent asking you to pick from options — is a waterfall like
approvals, gets the same `prepend`, and follows the same `approvalMode` switch (a
deployment that keeps prompts at the desk keeps questions there too).

On the phone it renders as a numbered list:

```
agent 想问你（会话 b64751）
【部署方式】
要部署到哪台机器上？
1. 本机 — 直接在这台电脑上跑
2. 服务器 — 推到我那台常开的机器
回复序号，也可以直接输入你的答案
```

A reply of `1` selects that option; `1,3` selects both when the question is
multi-select; anything that is not a valid selection is taken as a typed answer and
arrives as `custom`. Options are matched by **label**, which is what the answer type
carries.

**One question per request.** A request with several questions delegates to the desk
instead of guessing: answering them from a phone needs numbering that spans questions,
and a wrong guess would come back as a confidently wrong answer rather than a
failure.

There is no timeout here, unlike approvals. A question has no safe default — the tool
call's own `signal` decides when to give up, and an aborted wait answers with empty
selections.

## Quote replies

Long-press a message in WeChat, choose 引用, and type. On the wire that reply is **two
items**: the new text, and a second item carrying `ref_msg`. Reading only the text item
is why a quoted message looked invisible — the agent received "这个改成红色" with no idea
what 这个 referred to.

The quote is now prefixed to the prompt:

```
[引用消息] 把标题字体改成蓝色，顺便把字号调大一点

这个改成红色
```

The quoted body comes from, in order:

| Source | When it exists |
|---|---|
| `ref.message_item` | The client sent the whole quoted message — the common case |
| `partial_text` | The user selected a fragment: located by **nth occurrence** of the boundary strings, verified against `quotemd5` |
| `ref.title` | The client only sent a summary |
| the local message cache | When there is only `svr_id` — **which is what the current client sends** |

⚠️ The trap: `startindex` / `endindex` in `partial_text` are **occurrence numbers, not
character offsets**. Treating them as offsets returns the whole message — it looks like
it works, but the selection is wrong.

### The message cache keeps seven days

### Quoting a picture or a file

Quoting an image is only useful if the agent knows **where the file is**; the word
"[图片]" gives it nothing to open. The cache therefore keeps where the bytes landed, not
just the text:

```
[引用消息] [微信图片] media/inbound/2026-11-02T04-30-11-001Z.jpg（184320 字节）
[引用消息] [微信语音] 转写：明天下午三点开会
[引用消息] [微信文件] C:/Users/…/手册.pdf（1113063 字节）
```

The shape is the same as a normal inbound note, so the agent knows to open it with
`read_image` or a file tool.

**Files the bot sent** are quotable too: the send acknowledgement carries their id, and
the path is the one on disk. Note that the gateway never echoes our own sends back
through `getupdates`, so for a bot-sent message the `sendmessage` acknowledgement is the
only id there is.

When only an id arrives, the body can come from nowhere but a local cache. Each message
is kept for **seven days**, then deleted:

- swept at startup, hourly while running, and on read when an entry has aged out;
- deleted for real: gone from memory, and gone from `state.json` because the whole file
  is rewritten — no "expired" marker, no placeholder row. The log records ids and
  counts, never content;
- capped at 1000 entries as a backstop; retention, not the cap, is the real limit.

A quote of something cleared reaches the agent as one line:

```
[引用消息] （这条被引用的内容已被清除）
```

No id, no guess — all it needs to know is that this text is not available, so it should
ask rather than invent.

**What this does not reach**, stated plainly: if the quoted message was ever delivered to
the agent as part of a prompt, it lives in that session's transcript, which belongs to
DSH's session management and is outside this plugin's cleanup. Deleting a session is the
way to remove that.

**Commands are unaffected**: `/list`, `/switch` and friends still parse from what you
typed, because the quote only enters the prompt.

Field names and parsing rules come from `@tencent-weixin/openclaw-weixin` (MIT, Tencent),
including both index readings of `partial_text` and the `quotemd5` check.

## Media

### A file waits for the sentence that explains it

People send the picture, then type the request — three seconds later, five seconds
later. Delivering on arrival makes the agent answer the picture instead of the
request, and the request then lands in a turn that has already spoken.

So an inbound file is **held for `mediaMergeSec` seconds** (default 20, 0–300,
editable in the panel):

- text arriving inside the window is appended and the pair is delivered at once;
- more files inside the window join the same hold, and each one restarts it;
- silence means the window expires and the file goes on its own;
- `0` disables the wait entirely — the file is delivered immediately, still together
  with any text that arrived with it.

The hold is in memory. A restart inside the window loses the file, which is the same
outcome as the process dying before the agent ever ran.

Commands flush the hold first, so `/list` right after a screenshot is not stuck behind
it. A held file is also delivered on unload rather than dropped.

Inbound works: an image, file, video or voice note is downloaded from the CDN,
AES-128-ECB decrypted, and saved under `media/inbound/` inside the session's
workspace. The prompt then carries the relative path:

```
[微信图片] 已保存到 media/inbound/2026-11-01T09-12-33-123Z.jpg（184320 字节）
```

Because the file lands inside the agent's `cwd`, it can open it with its own tools —
`read_image` for pictures, the ordinary file tools for documents — so no attachment
plumbing is needed. What it does *not* do is embed the bytes as an image block in the
prompt; that needs the Host attachment service and is a separate step.

The AES key has **two encodings**, and this is the part that is easy to get wrong:
`media.aes_key` for files, voice and video is `base64(hex text)`, while an image's
`image_item.aeskey` is the raw key in hex. Base64-decoding and using the result
directly yields a 32-byte key for the first shape — garbage rather than an error.
`parseAesKey` decides by decoded length, not by which field it came from.

Voice notes use the service's own transcription when the item carries one, so voice
works without a codec (word-level fidelity is whatever Tencent provides).

### Outbound

The agent can send a file back with the `send_to_wechat` tool:

```json
{ "path": "report.pdf", "caption": "做好了" }
```

Relative paths resolve against the session's workspace (its `cwd`), which is where the
agent wrote them. Images, videos and ordinary files are dispatched by extension. Three
details decide whether the phone shows a picture or a grey box:

- the download reference is the **`x-encrypted-param` response header** of the upload
  POST — `upload_full_url` from `getuploadurl` is upload authorization, and putting it
  in the item gets a 403 on read;
- `media.aes_key` is base64 of the **hex text** of the key, not base64 of the raw
  bytes; the wrong shape is accepted by the server and renders broken;
- each item carries only its own fields (`image` gets `mid_size`, `file` gets
  `file_name` + `len`, `video` gets `video_size`) — extra fields corrupt the frame.

Uploads retry three times on 5xx and abort immediately on 4xx, because a refusal is
not a flake.

## Sending from any session

`send_to_wechat` resolves its target as: **the session's own conversation, else the one
this machine is bound to**. Without the fallback the tool only worked from inside a
WeChat-started session — which is not where you are when you ask the desk to "send me
that picture", and the tool failed with "这个会话没有绑定微信对话".

Approvals and structured questions deliberately do **not** get this fallback: they
stay strictly session-scoped. Sending a dialog to a phone nobody is looking at is the
opposite of what that rule protects.

Relative paths resolve against the calling session's `cwd` (what the path means to the
agent that produced it), and against the conversation workspace only when the session
cannot be looked up.

**The context token is what makes it actually deliver.** The gateway issues a token
with every inbound message and expects it echoed on the reply; a send from a desk
session has never seen one. Without a token the gateway answers `ret=-2 prepare
failed` rather than delivering, so the newest token per conversation is persisted in
`state.json` (`contextTokens`) and used by both send paths. A `ret=-2` on a
token-bearing send is retried once **without** the token — the stale-token case.

**The account is chosen by evidence, not list order.** Scanning the QR code twice
leaves two bot accounts bound to the same user, and picking `accounts[0]` sends from a
bot that user has never messaged — which the gateway also answers with `prepare
failed`. The bound account holding a context token is one the user has actually talked
to, so it wins.

With no token at all, the send is refused before it is attempted and says what fixes
it: send one message from WeChat first. That state is real — it is what the channel
looks like right after a restart, before the first inbound message arrives.

The send path logs before it attempts, not only on success:

```
send-media target=…@im.bot cross-session token=yes path=…
send-media failed | <reason>
send-media sent image | shot.png | 118473 bytes | cross-session
```

Without that first line a failed send left no trace at all, which is exactly why
"发不出去" could not be diagnosed from the log.

Package name, patch row id and the `client.js` module id must stay equal
(`dsh-webot`); the plugin manager and the client module loader both key on it.

## What a download and a send are allowed to do

**A download URL passes four checks.** The media address comes from `full_url` in the
gateway response and used to be fetched verbatim.

1. **https** is required;
2. **loopback, private and link-local addresses are refused** — IPv4 and IPv6 both,
   including IPv4 wrapped inside IPv6 (`::ffff:127.0.0.1`, which the URL parser
   normalises to `::ffff:7f00:1` — the shape the first attempt missed);
3. **only WeChat's media domains are allowed**: `*.weixin.qq.com` and `*.qpic.cn`,
   everything else is refused;
4. **what the name resolves to is checked too**: a public name pointing at `10.x` is
   refused as well;
5. **redirects are followed by hand**, and every hop is re-checked the same way — letting
   `fetch` follow them means the final address never passes a check at all.

**Why an allowlist, and not just "check where it resolves".** The check and the connection
are two separate lookups and `fetch` offers no way to pin the address, so the answer can
change (DNS rebinding). Checking the answer catches a name that points inside from the
start; **restricting which names may be reached** closes the window — bypassing it would
mean controlling `weixin.qq.com`'s own DNS.

If the CDN ever lives elsewhere, extend the list:

```bash
WEBOT_MEDIA_HOSTS=cdn.example.com,media.example.org
```

(suffix match only, and the resolution check still applies).

**An abnormal resolver answer refuses the download; it never passes.** Empty array, a
non-array, an entry that is not an address, a timeout — all are failures. This is worth
stating: `.find()` over an empty array returns `undefined`, which means the check did not
happen, and a check that did not happen must not be read as a pass. The resolution timeout
is five seconds by default and can be changed with `WEBOT_DNS_TIMEOUT_MS`.

⚠️ **Not solved: DNS rebinding.** The resolution check and the connection are two
separate lookups, and `fetch` offers no way to pin the address, so the second answer could
differ. Exploiting that requires controlling the media URL Tencent's gateway hands out —
a high bar, but this is not claimed to be closed.

**The size ceiling is a real ceiling.** The old order read `content-length`, pulled the
whole body in with `arrayBuffer()`, then compared against 30 MB — with an absent or lying
header the memory was already spent. The body is now read in chunks and the stream
cancelled the moment the running total passes the limit; **error bodies are capped at
4 KB**; and each download has a 60 s timeout that also works on Node 20.0–20.2, where
`AbortSignal.any` does not exist (the signals are combined by hand).

**Sending a file allows an absolute path, on purpose.** The agent may send any file on
this machine to the bound WeChat account — that is what makes "send me that PDF on the
desktop" work. It grants no privilege the agent does not already have through its file
tools; the real boundary is DSH's tool permissions and sandbox policy. Every send logs
`send-media target=… path=…`, and **that line contains a local absolute path**, so the log
file's own permissions are yours to manage.

## A message is not lost to one failure

The poll cursor is persisted **before** the batch is handled: that keeps the gateway from
replaying a message, but it also means a message whose handling throws is never fetched
again.

So a failing message is retried once in place (with its duplicate guard released); if that
fails it is written to `pendingInbound` in `state.json` (max 20, adjustable with
`WEBOT_PENDING_LIMIT`) and replayed at the next start, and three consecutive failures
abandon it with a `dropped after N attempts` line.

**The queue never loses a message quietly.** All three ways it could are logged and
counted:

| Case | Behaviour |
|---|---|
| Queue full | drops the oldest, logs `pending queue full (20) \| dropped <id>`, counted in `snapshot().pendingDropped` |
| State file holds more than the cap | trimmed on load, logs `pending queue over limit … on load` |
| The state write fails | the message stays in memory, logs `pending write failed … will retry`, retries in 2 s |

**Replays do not run a turn twice.** A delivered message id is recorded in
`deliveredInbound` (max 200); a replay that finds it drops it with a
`replay skipped, already delivered` line. The check sits at the top of `handleInbound`, so
the in-place retry cannot run the same turn again either. A failed write of that set logs
`delivered marker not persisted … will retry` and tries again two seconds later — it is the
only thing standing between a restart and a second run.

⚠️ **Remaining boundary**: if the process is killed between submitting the prompt and
writing `deliveredInbound`, that message is delivered once more after a restart. The write
retry narrows the window to milliseconds, but removing it entirely needs a transaction
across two systems.


## Tests

```bash
npm test
```

41 cases: quote resolution (full / partial / picture / voice / cleared), 64-bit id
precision, the download guard (IPv6, mapped addresses, DNS, redirects), the streaming
size cap, the error-body limit, the approval regression, and the durable replay of failed
messages.

## The protocol layer

Written against `@tencent-weixin/openclaw-weixin@2.4.10` (MIT, published by Tencent),
which is the only authority for this protocol — every field name here was read from
`src/api/api.ts`, `src/api/types.ts` and `src/auth/login-qr.ts`, none of it guessed.

The handshake is not one request:

```
POST ilink/bot/get_bot_qrcode?bot_type=3   -> { qrcode, qrcode_img_content }
GET  ilink/bot/get_qrcode_status?qrcode=…  -> long poll, up to 35s
       wait | scaned | need_verifycode | scaned_but_redirect
       expired | verify_code_blocked | binded_redirect | confirmed
```

Three details are load-bearing:

- **A long-poll timeout or network error is not a failure.** The upstream client turns
  both into `wait` and keeps polling; treating them as errors aborts every login
  roughly 35 seconds in.
- **`scaned_but_redirect` moves polling to `https://<redirect_host>`** and the QR stays
  the same. It is a host change, not progress.
- **`X-WECHAT-UIN` is base64 of the decimal text** of a random uint32, not base64 of
  the four bytes. GET and POST build their headers from different helpers.

## Dependency: `qrcode`

The panel shows a QR image, so the Host encodes one. The import in
`src/protocol/login.js` is **dynamic and lazy** on purpose: a profile can install this
bundle as `link:<directory>` and pnpm does not install dependencies for a linked
package, so a static import would take the whole Host row down with
`ERR_MODULE_NOT_FOUND` before any route existed. Lazily imported, a missing dependency
becomes one legible line in the panel instead.

```bash
cd <plugin dir> && npm install     # pulls qrcode
```

## State file

`$DSH_HOME/webot/state.json`, written atomically (temp file + rename) so a reader sees
either the old document or the whole new one.

`normalizeState` is a **whitelist**: a field missing from it is written happily and
silently dropped on the next boot. Any change that starts writing a new field must add
it there in the same commit.

Windows caveat, measured: `fs` mode bits are not enforced. A file created `0600`
reports `666` and inherits the parent directory's ACL. In the real location that is
`%USERPROFILE%\.dsh\webot`, already restricted to the user, SYSTEM and Administrators —
but do not move the file somewhere world-readable and assume the mode argument still
protects it.

## Security

- **Tokens never leave the Host process.** `/api/webot/status` reports each account as
  `{ accountId, userId, boundAt, hasToken }`. A merely authenticated page cannot
  exfiltrate the channel's credentials.
- Every route is registered on `ctx.connection.fetch`, not the raw web server, so it
  inherits Harness authentication, Host/Origin admission and middleware.
- The binding is cryptographically tied to the WeChat account that scanned: the token
  embeds `ilink_user_id`, and the gateway only delivers messages from that one account.
- The agent driven from WeChat runs with your file permissions. Nothing here is a
  sandbox: a WeChat turn can read and write what any other DSH session can. Scope it
  with a DSH agent preset or sandbox policy if that matters.

## Why the panel is not in `shell.overlay`

Measured in `@deepseek-ai/dsh-client-ui-settings-general` (0.2.1-rc.5):

- the settings dialog is `createPortal(..., document.body)` with `.overlay{z-index:1000}`;
- `shell.overlay` renders inside the layout frame, i.e. inside `#root`.

A body-level sibling at `z-index:1000` beats any descendant of `#root` regardless of
that descendant's own `z-index`. A panel mounted in `shell.overlay` therefore always
paints behind Settings — the observed symptom was a panel that only appeared after
closing it.

The panel is rendered from the header action's own subtree instead: inside the
dialog's `z-index:1000` stacking context, `position: fixed` reaches the viewport and
paints above the dialog's mask and panel. No portal, no `document.body` append, no
second application root. Closing Settings closes the panel too, which is intended —
the panel's only entry point is that header.

A render error inside the panel is caught by a boundary, which shows a short error card
and keeps the button in place. Without it, one bad read took the whole `settings.action`
entry off screen and the only way back was reloading the page.

## Matching the host look

The button copies `Button variant="outline" size="sm"` from
`dsh-client-ui-primitives` rather than importing it (a plain-JS plugin must not load
other Harness Client packages — a throwing import blanks the slot entry):

```
height 28px, padding 0 10px, font 12/18, radius var(--dsw-radius-sm),
border 1px solid var(--dsw-alias-border-l2), background transparent,
hover var(--dsw-alias-interactive-bg-hover)
```

The panel copies the settings dialog's geometry (`800px`, the same
`--dsh-frame-overlay-top` height clamp, `--dsw-radius-panel`, `--dsw-elevation-prominent`,
`--dsw-alias-bg-mask-1` + `--dsw-mask-blur`) so the two read as one family. Styles use
only `--dsw-*` tokens; literal colours appear in `icon.svg` and in the QR tile, which
must stay light to scan.

One trap worth recording: `--dsw-alias-border-l3` does not exist. The theme defines
only `border-l1` and `border-l2`, and a `border: ... var(--missing)` declaration is
invalid at computed-value time — the whole shorthand is dropped, so those elements had
*no border* rather than a faint one.

## Behaviour notes

- `Escape` is handled in the capture phase, so closing the panel does not also close
  the settings dialog underneath it.
- The action button toggles (`aria-expanded`); a mask click closes.
- Opening the panel while unbound starts the handshake automatically. Starting is
  idempotent on the Host: a live attempt is reused, a settled one replaced.

## Dev tools

`tools/asar-extract.mjs` and `tools/asar-find.mjs` read the installed `app.asar`
directly (`rg`, `glob` and shell commands cannot see inside it, but Node can), which is
how the CSS and stacking facts above were established:

```bash
node tools/asar-find.mjs "<...>/app.asar" ui-settings-general 20
node tools/asar-extract.mjs "<...>/app.asar" \
  dsh/node_modules/@deepseek-ai/dsh-client-ui-settings-general/lib/client.js \
  .scratch/settings-general.client.js
node tools/snippet.mjs .scratch/index.css 'outline' 160 4
```

## Licence

MIT. See [LICENSE](LICENSE).

Protocol reference: `@tencent-weixin/openclaw-weixin` (MIT, Tencent) — the iLink
endpoints, payload fields and the AES-128-ECB media scheme were read from it. No code
from that package is vendored here.
