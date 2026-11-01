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

Both exclusive modes were shipped for one round each, and each one made the other
side look broken — from that side the prompt genuinely is missing, because a
waterfall has exactly one winner. `both` is the only mode where neither side can
report a prompt as lost.

One consequence of `both`: if the desk answers first, the WeChat message stays on
the phone unanswered, and a later `1` is no longer a pending decision — it reaches
the agent as ordinary text. That is the price of racing.

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
