# dsh-webot

WeChat channel for DeepSeek Harness — bind WeChat, then drive the agent on this machine from your phone.

**Status: M1 (skeleton).** This milestone proves the plumbing, not the feature:

- a 「weBot设置」 action in the settings header, immediately right of the shipped
  「打开配置文件」 (`open-document`, order 0) and left of Close;
- the full-screen panel that action opens;
- the Host endpoint `GET /api/webot/status` behind it, registered on the shared
  browser connection channel so it inherits Harness authentication.

No WeChat protocol code exists yet. QR binding (M2), text both ways (M3), session
commands (M4), approvals from the phone (M5) and media (M6) come later.

## Layout

| File | Role |
| --- | --- |
| `index.js` | Host half: the status route. |
| `client.js` | Browser half: the header button and the panel. Plain JS, no build step. |
| `cordis.patch.yml` | One Host row, id `dsh-webot`. |
| `locale/{zh,en}.json` | Plugin Manager / inventory display metadata. |
| `tools/` | Dev-only readers for the installed DSH bundles (see below). |

Package name, patch row id and the `client.js` module id must stay equal
(`dsh-webot`); the plugin manager and the client module loader both key on it.

## Why the panel is not in `shell.overlay`

Measured in `@deepseek-ai/dsh-client-ui-settings-general` (0.2.1-rc.5):

- the settings dialog is `createPortal(..., document.body)` with `.overlay{z-index:1000}`;
- `shell.overlay` renders inside the layout frame, i.e. inside `#root`.

A body-level sibling at `z-index:1000` beats any descendant of `#root` regardless
of the descendant's own `z-index`, because that descendant is confined to `#root`'s
stacking level. A panel mounted in `shell.overlay` therefore always paints behind
Settings — the observed symptom was a panel that only appeared after closing it.

The panel is rendered from the header action's own subtree instead: inside the
dialog's `z-index:1000` stacking context, `position: fixed` reaches the viewport
(no transformed ancestor in between) and paints above the dialog's mask and panel.
No portal, no `document.body` append, no second application root.

Consequence: closing Settings closes the panel too. That is the intended
behaviour, since the panel's only entry point is that header.

## Matching the host look

The button copies `Button variant="outline" size="sm"` from
`dsh-client-ui-primitives` instead of importing it (a plain-JS plugin must not
load other Harness Client packages — a throwing import blanks the slot entry):

```
height 28px, padding 0 10px, font 12/18, radius var(--dsw-radius-sm),
border .5px solid var(--dsw-alias-border-l3), background transparent,
hover var(--dsw-alias-interactive-bg-hover)
```

The panel copies the settings dialog's geometry (`800px`, the same
`--dsh-frame-overlay-top` height clamp, `--dsw-radius-panel`,
`--dsw-elevation-prominent`, `--dsw-alias-bg-mask-1` + `--dsw-mask-blur`) so the
two read as one family.

Styles reference only `--dsw-alias-*` / `--dsw-*` tokens; literal colours appear
in `icon.svg` artwork only.

## Behaviour notes

- `Escape` is handled in the capture phase, so closing this panel does not also
  close the settings dialog underneath it.
- The action button toggles (`aria-expanded`), and the mask click closes.
- Focus moves to the close button on open and is restored on close.

## Dev tools

`tools/asar-extract.mjs` and `tools/asar-find.mjs` read the installed
`app.asar` directly (`rg`, `glob` and shell commands cannot see inside it, but
Node can), which is how the CSS and stacking facts above were established:

```bash
node tools/asar-find.mjs "<...>/app.asar" ui-settings-general 20
node tools/asar-extract.mjs "<...>/app.asar" \
  dsh/node_modules/@deepseek-ai/dsh-client-ui-settings-general/lib/client.js \
  .scratch/settings-general.client.js
node tools/snippet.mjs .scratch/index.css 'outline' 160 4
```

`tools/snippet.mjs` prints context around regex matches, which is the only
practical way to read minified CSS where every rule sits on one line.

## Install

`plugin_manager` → `install_bundle` with this directory as the target, into the
`desktop` profile. The Host half needs a DSH restart; the Client half reloads
with a page refresh because the installed package is a link to this directory.

## Licence

MIT.
