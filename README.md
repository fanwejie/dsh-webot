# dsh-webot

WeChat channel for DeepSeek Harness — bind WeChat, then drive the agent on this machine from your phone.

**Status: M3 (text both ways).** What works today:

- a 「weBot设置」 action in the settings header, right of the shipped
  「打开配置文件」 (`open-document`, order 0) and left of Close;
- the full-screen panel that action opens;
- the real Tencent iLink QR handshake: fetch QR, long-poll its status, pairing
  code, IDC redirect, automatic refresh on expiry, and the resulting binding
  persisted to disk;
- the long poll that receives WeChat messages, one DSH session per WeChat
  conversation, and the agent's answer sent back to the phone;
- `GET /api/webot/status` reporting the bound account and its live state (never
  its token), plus a ring buffer of what the channel recently did.

Not built yet: session commands (M4), approvals from the phone (M5), media (M6).

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
        agent/assistant-stream ──► text-delta accumulated per session
             │  flush only after the stream is quiet for 700ms
             ▼
        iLink sendmessage ──► the phone
```

Why the settle timer and not "send on `end`": an assistant turn is not one
stream. Every model step opens its own attempt and emits its own `end` frame, so
a turn that calls a tool produces several. Flushing on each `end` splits one
answer into several WeChat messages; flushing on the `finish` chunk is worse,
because that fires once per step too. A `start` arriving inside the quiet window
cancels the flush — which is exactly the tool-call case.

### Interrupting a running turn

A message sent while the agent is working is submitted as `steer`, not `queue`.
Queueing it means the user is answering an answer that is already stale, and the
agent finishes work nobody asked for any more — which is what makes a busy session
feel like it is ignoring the phone.

A refused `steer` is a real outcome, not an error: the turn it targeted can end
between the decision and the submit. The message is then submitted as `queue`,
because losing it is the one failure nothing can repair. The log records which
happened (`prompt steered` / `prompt queued`), so a session that never interrupts
is diagnosable rather than mysterious.

`cwd` for every session this channel creates is fixed at `$DSH_HOME/dsh_webot`.
It must never vary per conversation: the Host matches an adopted session by
`cwd`, and a mismatch makes that session permanently unreachable.


## Seeing the session in DSH

A session created with only a `cwd` lands in the built-in "Ungrouped" bucket,
and the desktop sidebar does not render that bucket — the session exists on
disk, answers WeChat messages, and is invisible in the app. That was the state
after M3, confirmed by a session directory on disk with no sidebar row.

M4 fixes it in two ways:

- channel-created sessions are created inside a **named workspace** at
  `$DSH_HOME/dsh_webot`, so they appear in the sidebar like any other;
- the panel's 「会话绑定」 section lists the Host's sessions and binds the
  conversation to any of them — including one you already had — or detaches it,
  so the next message starts a fresh session inside the workspace.

## The prompt

One editable note, **appended after the user's message, on every turn**:

| Field | Purpose |
| --- | --- |
| 场合提示词 `channelPrompt` | Where the model is talking: a phone, no screen, no file access, send files with `send_to_wechat`, keep it under three lines |

That is the whole surface. A persona layer used to sit beside it and was removed on
request: two boxes describing "how to behave" invite the same behaviour to be tuned
in two places, and the persona text kept fighting the agent's own job. Anything you
want said about tone now goes in this one box, and it is the same box that already
knows you are on a phone.

There is no `/role`, no chat/work switch, and no `personas/` directory any more.

### Why it is shaped this way

This follows `presenceNote` in
[`dsh-wechat`](https://github.com/xcisxc29/dsh-wechat) (`packages/core/src/state.ts`,
`packages/bundle/src/host.ts`):

- **A situation note, not a role-play card.** Its default text exists because
  "without it the agent answers as if its user sits at the desktop console" — the
  job is to say where the conversation is happening, which is exactly what a
  location-agnostic agent cannot know.
- **Appended, not prepended.** Its prompt is built as
  `[user text, quoted, attachments, note]`. Trailing text sits closest to the point
  where generation starts; a leading block reads as user background. Our first
  version put an 1100-character persona in front of every message, and it was
  mostly ignored — this is the fix that mattered most.
- **`undefined` means default, `''` means off.** A cleared field stays cleared
  instead of silently snapping back.

The note is capped at 3000 characters: it rides on every turn. Length is stated as a
rule rather than a preference — `一条回复别超过三行` — because "别太长" alone left the
model judging its own length.

The panel's 「恢复默认」 fills the textarea with the current shipped text. Without it,
an earlier save would keep overriding every later improvement to the default, and
getting the new wording back would mean retyping it by hand.

### Reply bubbles

An agent answer is split into separate WeChat messages at sentence boundaries —
`。！？!?…`, newlines, and closing Chinese quotes (`」”』`), because that is where a
person stops and starts a new bubble.

**Only long answers are split.** Measured from real traffic, a 73-character reply
came out as four messages of 10/45/4/12 characters — the report was "乱七八糟",
and it was right: that is shredding, not texting.

```
reply 82 chars -> 3 bubbles: 21 / 49 / 12
reply 21 chars -> 1 bubble
```

Guards, each for a specific failure:

- **Short replies stay whole** (`MIN_SPLIT_CHARS = 40`). Splitting is meant to make
  a long answer look like texting, not to cut a short one in half. The
  quoted-phrase example above no longer splits for this reason: both halves are
  short enough that two messages read worse than one.
- **A bubble shorter than 12 characters merges into its neighbour**
  (`MIN_BUBBLE_CHARS`), on either side of the join, so a short opening sentence does
  not strand a two-character tail behind it. `还在转。` as its own message is noise.
- **A boundary only counts when a new thought follows.** Closing quotes end a
  bubble, but not when the next non-space character is `，、；：` — that is
  mid-sentence, and splitting there left a bubble opening with a comma
  (`他说“在吗”，然后…`). Reported from a real reply reading "，在吗".
- **A fragment that is only punctuation rejoins the previous bubble.** Splitting at
  `？` inside quotes otherwise produced a bubble containing nothing but `”`.
- **At most 4 bubbles.** The tail merges back into the last one; more reads as
  spam rather than as texting.
- **Structured answers never split** — a code fence, a list marker or a table
  carries meaning across its line breaks, and chopping it turns one readable answer
  into several broken fragments.
- **Command receipts never bubble.** `/help` and `/list` are one message; splitting
  them into ten would be worse than a wall of text.
- The ASCII `"` is deliberately *not* a boundary: it appears inside code and
  English, where a split would be wrong.
- 250 ms between bubbles, so a burst does not look like a machine gun.

**Why the card is prepended rather than registered as a prompt section.** The
correct home is a section on the *agent's* context so it is scoped to WeChat
sessions, but `systemPrompt.section()` registers globally for the calling context,
and this plugin's context is the root — the persona would then appear in every
session in DSH, including the ones driven at the desk. Scoping needs the agent
context from `agent/created`, which is a bigger change than this feature needs
yet. Prepending is isolated by construction, and an identical prefix still hits the
prompt cache.

## Commands from WeChat

Handled by the channel itself; they never reach the agent. Anything else is a
normal prompt.

| Command | What it does |
| --- | --- |
| `/list` | This Machine's sessions, numbered, each with its short id |
| `/switch 3` | Move to row 3 of the screen **you are reading** |
| `/switch a1b2c3` | Move by short id — independent of numbering, never stale |
| `/new 修复登录` | Create a session (titled if given) and move to it |
| `/current` | Which session this conversation is on |
| `/cancel` | Stop the running turn |
| `/help` | The list above |

`/switch 3` resolves against the ids captured when that `/list` was sent, not
against a fresh fetch: sessions run while the list sits on a phone, so row 3 may
point at a different session by the time the reply arrives. Numbers therefore go
stale across *different* listings, which is exactly why every row also carries a
short id.

The command name runs up to the first non-letter, so `/switch3` is accepted as
`/switch 3`; `/switch:3` is not, because the colon lands in the argument and is
then treated as a short id.

## Permission prompts on the phone

`approval/request` is a waterfall: return an outcome to claim the request, call
`next()` to leave it to the other answerers. The channel claims a prompt only
when the requesting session is one it owns; everything else delegates.

**Which side sees the prompt is a setting**, `approvalMode` in the panel:

| Mode | Behaviour |
| --- | --- |
| `phone` (default) | The channel claims the request; the desk never shows it |
| `desktop` | The channel delegates; the phone never shows it |

There is deliberately **no "both"**, and this was learned the expensive way: it
shipped, and it left a permission dialog stuck on the desktop after the turn had
already finished. Calling `next()` opens a dialog in the browser that closes only
when *that* answerer resolves; letting the phone win instead abandons it, and the
host exposes no withdraw call. A request has exactly one owner, so the choice is
made up front instead of raced.

While a prompt is open the agent turn is blocked on it, so the phone reply is
consumed before commands and before the agent.

**An unanswered prompt expires.** After `approvalTimeoutSec` (default 30,
5–300) the channel answers `rejected` on your behalf and says so on the phone.
Waiting forever is the one outcome that is always wrong: the agent turn is
blocked, the machine sits idle, and nobody learns why. Refusing is safe — the ask
can simply be repeated.

| Reply | Outcome |
| --- | --- |
| `1`, `允许`, `同意`, `好`, `y`, `yes` | `allowed-once` |
| `2`, `拒绝`, `不`, `n`, `no` | `rejected` |
| `3`, `取消` | `cancelled` |

Anything else while a prompt is open gets a short reminder instead of being
forwarded — the turn is waiting on the decision, so queueing text behind it
would only look like the agent ignored you. `req.signal` aborts the wait (the
request went away), and unloading the plugin resolves every open prompt as
`cancelled` so no turn stays blocked for the life of the process.

One prompt per conversation: a second simultaneous request delegates instead of
stacking, which is what keeps a bare `1` unambiguous.

**Which side sees the prompt is a setting**, `approvalMode` in the panel:

| Mode | Behaviour |
| --- | --- |
| `both` (default) | The desktop answerer starts and the WeChat message is sent; the first answer wins |
| `phone` | Only WeChat; the desk never sees the request |
| `desktop` | Only the desk; the channel delegates and sends nothing |

There is deliberately **no "both"**, and this was learned the expensive way: it
shipped, and it left a permission dialog stuck on the desktop after the turn had
already finished. Calling `next()` opens a dialog in the browser that closes only
when *that* answerer resolves; letting the phone win instead abandons it, and the
host exposes no withdraw call. A request has exactly one owner, so the choice is
made up front instead of raced.

## Structured questions

`ask_user_question` — the agent asking you to pick from options — is a waterfall
like approvals, gets the same `prepend`, and follows the same `approvalMode`
switch (a deployment that keeps prompts at the desk keeps questions there too).

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
multi-select; anything that is not a valid selection is taken as a typed answer
and arrives as `custom`. Options are matched by **label**, which is what the
answer type carries.

**One question per request.** A request with several questions delegates to the
desk instead of guessing: answering them from a phone needs numbering that spans
questions, and a wrong guess would come back as a confidently wrong answer rather
than a failure.

There is no timeout here, unlike approvals. A question has no safe default — the
tool call's own `signal` decides when to give up, and an aborted wait answers with
empty selections.

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
- `0` disables the wait entirely — the file is delivered immediately, still
  together with any text that arrived with it.

The hold is in memory. A restart inside the window loses the file, which is the
same outcome as the process dying before the agent ever ran.

Commands flush the hold first, so `/list` right after a screenshot is not stuck
behind it. A held file is also delivered on unload rather than dropped.

Inbound works: an image, file, video or voice note is downloaded from the CDN,
AES-128-ECB decrypted, and saved under `media/inbound/` inside the session's
workspace. The prompt then carries the relative path:

```
[微信图片] 已保存到 media/inbound/2026-11-01T09-12-33-123Z.jpg（184320 字节）
```

Because the file lands inside the agent's `cwd`, it can open it with its own tools
— `read_image` for pictures, the ordinary file tools for documents — so no
attachment plumbing is needed. What it does *not* do is embed the bytes as an
image block in the prompt; that needs the Host attachment service and is a
separate step.

The AES key has **two encodings**, and this is the part that is easy to get wrong:
`media.aes_key` for files, voice and video is `base64(hex text)`, while an image's
`image_item.aeskey` is the raw key in hex. Base64-decoding and using the result
directly yields a 32-byte key for the first shape — garbage rather than an error.
`parseAesKey` decides by decoded length, not by which field it came from.

Voice notes use the service's own transcription when the item carries one, so
voice works without a codec (word-level fidelity is whatever Tencent provides).

### Outbound

The agent can send a file back with the `send_to_wechat` tool:

```json
{ "path": "report.pdf", "caption": "做好了" }
```

Relative paths resolve against the session's workspace (its `cwd`), which is where
the agent wrote them. Images, videos and ordinary files are dispatched by
extension. Three details decide whether the phone shows a picture or a grey box:

- the download reference is the **`x-encrypted-param` response header** of the
  upload POST — `upload_full_url` from `getuploadurl` is upload authorization, and
  putting it in the item gets a 403 on read;
- `media.aes_key` is base64 of the **hex text** of the key, not base64 of the raw
  bytes; the wrong shape is accepted by the server and renders broken;
- each item carries only its own fields (`image` gets `mid_size`, `file` gets
  `file_name` + `len`, `video` gets `video_size`) — extra fields corrupt the frame.

Uploads retry three times on 5xx and abort immediately on 4xx, because a refusal
is not a flake.

## Layout

| File | Role |
| --- | --- |
| `index.js` | Host half: routes, the one live login attempt, status document. |
| `src/protocol/http.js` | iLink transport: headers, verbs, timeouts, error shape. |
| `src/protocol/login.js` | QR login state machine. |
| `src/state.js` | Durable state: atomic write, whitelist normalization. |
| `client.js` | Browser half: the header button and the panel. Plain JS, no build. |
| `cordis.patch.yml` | One Host row, id `dsh-webot`. |
| `tools/` | Dev-only readers for the installed DSH bundles. |

### Sending from any session

`send_to_wechat` resolves its target as: **the session's own conversation, else the
one this machine is bound to**. Without the fallback the tool only worked from
inside a WeChat-started session — which is not where you are when you ask the desk
to "send me that picture", and the tool failed with "这个会话没有绑定微信对话".

Approvals and structured questions deliberately do **not** get this fallback: they
stay strictly session-scoped. Sending a dialog to a phone nobody is looking at is
the opposite of what that rule protects.

Relative paths resolve against the calling session's `cwd` (what the path means to
the agent that produced it), and against the conversation workspace only when the
session cannot be looked up.

**The context token is what makes it actually deliver.** The gateway issues a token
with every inbound message and expects it echoed on the reply; a send from a desk
session has never seen one. Without a token the gateway answers
`ret=-2 prepare failed` rather than delivering, so the newest token per conversation
is persisted in `state.json` (`contextTokens`) and used by both send paths. A
`ret=-2` on a token-bearing send is retried once **without** the token — the
stale-token case.

**The account is chosen by evidence, not list order.** Scanning the QR code twice
leaves two bot accounts bound to the same user, and picking `accounts[0]` sends from
a bot that user has never messaged — which the gateway also answers with
`prepare failed`. The bound account holding a context token is one the user has
actually talked to, so it wins.

With no token at all, the send is refused before it is attempted and says what
fixes it: send one message from WeChat first. That state is real — it is what the
channel looks like right after a restart, before the first inbound message arrives.

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

## The protocol layer

Written against `@tencent-weixin/openclaw-weixin@2.4.10` (MIT, published by
Tencent), which is the only authority for this protocol — every field name here
was read from `src/api/api.ts`, `src/api/types.ts` and `src/auth/login-qr.ts`,
none of it guessed.

The handshake is not one request:

```
POST ilink/bot/get_bot_qrcode?bot_type=3   -> { qrcode, qrcode_img_content }
GET  ilink/bot/get_qrcode_status?qrcode=…  -> long poll, up to 35s
       wait | scaned | need_verifycode | scaned_but_redirect
       expired | verify_code_blocked | binded_redirect | confirmed
```

Three details are load-bearing:

- **A long-poll timeout or network error is not a failure.** The upstream client
  turns both into `wait` and keeps polling; treating them as errors aborts every
  login roughly 35 seconds in.
- **`scaned_but_redirect` moves polling to `https://<redirect_host>`** and the QR
  stays the same. It is a host change, not progress.
- **`X-WECHAT-UIN` is base64 of the decimal text** of a random uint32, not base64
  of the four bytes. GET and POST build their headers from different helpers.

## Dependency: `qrcode`

The panel shows a QR image, so the Host encodes one. The import in
`src/protocol/login.js` is **dynamic and lazy** on purpose: a profile installs
this bundle as `link:<workspace>` and pnpm does not install dependencies for a
linked package, so a static import would take the whole Host row down with
`ERR_MODULE_NOT_FOUND` before any route existed. Lazily imported, a missing
dependency becomes one legible line in the panel instead.

```bash
cd <plugin dir> && npm install     # pulls qrcode
```

## State file

`$DSH_HOME/webot/state.json`, written atomically (temp file + rename) so a reader
sees either the old document or the whole new one.

`normalizeState` is a **whitelist**: a field missing from it is written happily
and silently dropped on the next boot. Any change that starts writing a new field
must add it there in the same commit.

Windows caveat, measured: `fs` mode bits are not enforced. A file created `0600`
reports `666` and inherits the parent directory's ACL. In the real location that
is `%USERPROFILE%\.dsh\webot`, already restricted to the user, SYSTEM and
Administrators — but do not move the file somewhere world-readable and assume the
mode argument still protects it.

## Security

- **Tokens never leave the Host process.** `/api/webot/status` reports each
  account as `{ accountId, userId, boundAt, hasToken }`. A merely authenticated
  page cannot exfiltrate the channel's credentials.
- Every route is registered on `ctx.connection.fetch`, not the raw web server, so
  it inherits Harness authentication, Host/Origin admission and middleware.
- The binding is cryptographically tied to the WeChat account that scanned: the
  token embeds `ilink_user_id`, and the gateway only delivers messages from that
  one account.

## Why the panel is not in `shell.overlay`

Measured in `@deepseek-ai/dsh-client-ui-settings-general` (0.2.1-rc.5):

- the settings dialog is `createPortal(..., document.body)` with `.overlay{z-index:1000}`;
- `shell.overlay` renders inside the layout frame, i.e. inside `#root`.

A body-level sibling at `z-index:1000` beats any descendant of `#root` regardless
of that descendant's own `z-index`. A panel mounted in `shell.overlay` therefore
always paints behind Settings — the observed symptom was a panel that only
appeared after closing it.

The panel is rendered from the header action's own subtree instead: inside the
dialog's `z-index:1000` stacking context, `position: fixed` reaches the viewport
and paints above the dialog's mask and panel. No portal, no `document.body`
append, no second application root. Closing Settings closes the panel too, which
is intended — the panel's only entry point is that header.

## Matching the host look

The button copies `Button variant="outline" size="sm"` from
`dsh-client-ui-primitives` rather than importing it (a plain-JS plugin must not
load other Harness Client packages — a throwing import blanks the slot entry):

```
height 28px, padding 0 10px, font 12/18, radius var(--dsw-radius-sm),
border .5px solid var(--dsw-alias-border-l3), background transparent,
hover var(--dsw-alias-interactive-bg-hover)
```

The panel copies the settings dialog's geometry (`800px`, the same
`--dsh-frame-overlay-top` height clamp, `--dsw-radius-panel`,
`--dsw-elevation-prominent`, `--dsw-alias-bg-mask-1` + `--dsw-mask-blur`) so the
two read as one family. Styles use only `--dsw-*` tokens; literal colours appear
in `icon.svg` and in the QR tile, which must stay light to scan.

## Behaviour notes

- `Escape` is handled in the capture phase, so closing the panel does not also
  close the settings dialog underneath it.
- The action button toggles (`aria-expanded`); a mask click closes.
- Opening the panel while unbound starts the handshake automatically. Starting is
  idempotent on the Host: a live attempt is reused, a settled one replaced.

## Dev tools

`tools/asar-extract.mjs` and `tools/asar-find.mjs` read the installed `app.asar`
directly (`rg`, `glob` and shell commands cannot see inside it, but Node can),
which is how the CSS and stacking facts above were established:

```bash
node tools/asar-find.mjs "<...>/app.asar" ui-settings-general 20
node tools/asar-extract.mjs "<...>/app.asar" \
  dsh/node_modules/@deepseek-ai/dsh-client-ui-settings-general/lib/client.js \
  .scratch/settings-general.client.js
node tools/snippet.mjs .scratch/index.css 'outline' 160 4
```

## Install

1. `npm install` in this directory (the `qrcode` dependency).
2. `plugin_manager` → `install_bundle`, target this directory, profile `desktop`.
3. Restart DSH for the Host half. The Client half follows the page.

## Licence

MIT. Protocol reference: `@tencent-weixin/openclaw-weixin` (MIT, Tencent).
