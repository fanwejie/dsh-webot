/**
 * dsh-webot — Client half (M2).
 *
 * One registration: the 「weBot设置」 action in `settings.action`, ordered right
 * after the shipped 「打开配置文件」 (id `open-document`, order 0), before Close.
 * It renders both the button and — while open — the panel it opens.
 *
 * ## Why the panel is NOT in `shell.overlay`
 *
 * `shell.overlay` renders inside the layout frame, and therefore inside `#root`.
 * The settings dialog is a `createPortal(..., document.body)` with `z-index:1000`
 * (see `dsh-client-ui-settings-general`), so it is a body-level sibling that wins
 * the stacking comparison no matter how large a z-index an `#root` descendant
 * declares — the descendant is confined to `#root`'s own level. A panel mounted
 * there is *always* painted behind the settings dialog.
 *
 * Rendering the panel from the header action's own subtree puts it inside the
 * dialog's `z-index:1000` stacking context, so `position: fixed` reaches the
 * viewport (no transformed ancestor between) and paints above the dialog's mask
 * and panel. No portal, no `document.body` append, no second application root.
 *
 * ## Styling
 *
 * The button copies the host's `Button variant="outline" size="sm"` recipe from
 * `dsh-client-ui-primitives` because the primitive itself must not be imported.
 * The panel copies the settings dialog's own geometry so it reads as a sibling
 * surface rather than a bolted-on window.
 */
window.__ModuleLoader__.load({
  id: 'dsh-webot',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const NS = 'dsh-webot'

    const STATUS_URL = '/api/webot/status'
    const LOGIN_URL = '/api/webot/login'
    const LOGIN_START_URL = '/api/webot/login/start'
    const LOGIN_VERIFY_URL = '/api/webot/login/verify'
    const LOGIN_CANCEL_URL = '/api/webot/login/cancel'
    const SESSIONS_URL = '/api/webot/sessions'
    const BIND_URL = '/api/webot/bind'
    const SETTINGS_URL = '/api/webot/settings'
    const TITLE_ID = 'webot-panel-title'

    /* ------------------------------------------------------------------ *
     * Shared visibility. Plain module state: no DOM, no timers, no listeners,
     * so it keeps the lazy factory side-effect free.
     * ------------------------------------------------------------------ */
    let panelVisible = false
    const subscribers = new Set()

    function setPanelVisible(next) {
      if (panelVisible === next) return
      panelVisible = next
      for (const notify of subscribers) notify()
    }

    function usePanelVisible() {
      const [value, setValue] = React.useState(panelVisible)
      React.useEffect(() => {
        const notify = () => setValue(panelVisible)
        subscribers.add(notify)
        notify()
        return () => {
          subscribers.delete(notify)
        }
      }, [])
      return value
    }

    /* ------------------------------------------------------------------ *
     * Styles. Theme tokens only; literal colours appear in artwork and in the
     * QR tile, which must stay light to stay scannable.
     * ------------------------------------------------------------------ */

    /** Host `Button` base + `size: 'sm'` + `variant: 'outline'`, copied. */
    const ACTION_BUTTON = {
      boxSizing: 'border-box',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: '4px',
      height: '28px',
      padding: '0 10px',
      border: '1px solid var(--dsw-alias-border-l2)',
      borderRadius: 'var(--dsw-radius-sm)',
      background: 'transparent',
      color: 'var(--dsw-alias-label-primary)',
      cursor: 'pointer',
      fontFamily: 'inherit',
      fontSize: '12px',
      lineHeight: '18px',
      whiteSpace: 'nowrap',
    }

    /** Same geometry, `variant: 'primary'`. */
    const PRIMARY_BUTTON = {
      ...ACTION_BUTTON,
      border: 'none',
      background: 'var(--dsw-alias-button-primary-fill)',
      color: 'var(--dsw-alias-label-primary-foreground)',
    }

    /** Full-viewport layer, above the settings dialog that hosts it. */
    const LAYER = {
      position: 'fixed',
      top: 'var(--dsh-frame-chrome-top, 0px)',
      right: '0',
      bottom: '0',
      left: '0',
      zIndex: 2000,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontFamily: 'inherit',
    }

    /** The settings dialog's own mask recipe. */
    const MASK = {
      position: 'absolute',
      inset: '0',
      background: 'var(--dsw-alias-bg-mask-1)',
      backdropFilter: 'var(--dsw-mask-blur)',
    }

    /** The settings dialog's own panel recipe, so both read as one family. */
    const CARD = {
      position: 'relative',
      zIndex: 1,
      display: 'flex',
      flexDirection: 'column',
      width: '800px',
      height: 'min(800px, calc(100vh - 2 * max(24px, var(--dsh-frame-overlay-top, 24px))))',
      maxWidth: 'calc(100vw - 48px)',
      borderRadius: 'var(--dsw-radius-panel)',
      background: 'var(--dsw-alias-bg-layer-2)',
      boxShadow: 'var(--dsw-elevation-prominent)',
      color: 'var(--dsw-alias-label-primary)',
      overflow: 'hidden',
      outline: 'none',
    }

    const HEADER = {
      boxSizing: 'border-box',
      flex: 'none',
      display: 'flex',
      alignItems: 'flex-start',
      justifyContent: 'space-between',
      gap: '8px',
      padding: '20px 14px 8px 20px',
      borderBottom: '0.5px solid var(--dsw-alias-border-l1)',
    }

    const BODY = {
      flex: '1 1 auto',
      minHeight: '0',
      overflowY: 'auto',
      padding: '16px 20px 20px',
    }

    const FOOTER = {
      flex: 'none',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: '12px',
      padding: '10px 20px',
      borderTop: '0.5px solid var(--dsw-alias-border-l1)',
      color: 'var(--dsw-alias-label-secondary)',
      fontSize: '12px',
      lineHeight: '18px',
    }

    /** Host `Button size: 'sm'` + `variant: 'ghost'`, for in-panel controls. */
    const GHOST_BUTTON = {
      ...ACTION_BUTTON,
      border: 'none',
      color: 'var(--dsw-alias-label-primary)',
    }

    const SECTION_TITLE = { margin: 0, fontSize: '13px', lineHeight: '20px', fontWeight: 600 }

    const FIELD_ROW = {
      display: 'flex',
      alignItems: 'baseline',
      gap: '12px',
      padding: '6px 0',
      fontSize: '12px',
      lineHeight: '18px',
    }

    // Wide enough for an eight-character label plus its `?` icon: "在哪回答权限请求"
    // is ~96px, the icon adds ~18, and a fixed column keeps every control aligned.
    const FIELD_NAME = { flex: '0 0 136px', color: 'var(--dsw-alias-label-secondary)' }

    const FIELD_VALUE = {
      flex: '1 1 auto',
      minWidth: '0',
      color: 'var(--dsw-alias-label-primary)',
      fontVariantNumeric: 'tabular-nums',
      wordBreak: 'break-all',
    }

    const PANEL_CARD = {
      padding: '12px 14px',
      borderRadius: 'var(--dsw-radius-md)',
      background: 'var(--dsw-alias-bg-layer-1)',
      border: '0.5px solid var(--dsw-alias-border-l1)',
    }

    /**
     * The commands the channel answers itself, for the usage list.
     *
     * Kept here rather than in the locale so the columns stay aligned across
     * languages: the command text is the same string in both, and only the
     * description is translated.
     */
    const USAGE_COMMANDS = [
      ['/list', 'usage.list'],
      ['/switch 3', 'usage.switchNum'],
      ['/switch a1b2c3', 'usage.switchId'],
      ['/new', 'usage.new'],
      ['/current', 'usage.current'],
      ['/cancel', 'usage.cancel'],
      ['/help', 'usage.help'],
    ]

    const TEXT_INPUT = {
      boxSizing: 'border-box',
      height: '28px',
      width: '140px',
      padding: '0 8px',
      borderRadius: 'var(--dsw-radius-sm)',
      border: '1px solid var(--dsw-alias-border-l2)',
      background: 'var(--dsw-alias-bg-base)',
      color: 'var(--dsw-alias-label-primary)',
      fontFamily: 'inherit',
      fontSize: '12px',
      lineHeight: '18px',
      letterSpacing: '2px',
    }

    /** Native select, sized like the host's small inputs. */
    const SELECT = {
      boxSizing: 'border-box',
      height: '28px',
      maxWidth: '260px',
      padding: '0 8px',
      borderRadius: 'var(--dsw-radius-sm)',
      border: '1px solid var(--dsw-alias-border-l2)',
      background: 'var(--dsw-alias-bg-base)',
      color: 'var(--dsw-alias-label-primary)',
      fontFamily: 'inherit',
      fontSize: '12px',
      lineHeight: '18px',
    }

    /** Multi-line editor for the two prompt layers. */
    const TEXTAREA = {
      boxSizing: 'border-box',
      width: '100%',
      maxWidth: '560px',
      padding: '8px',
      borderRadius: 'var(--dsw-radius-sm)',
      border: '1px solid var(--dsw-alias-border-l2)',
      background: 'var(--dsw-alias-bg-base)',
      color: 'var(--dsw-alias-label-primary)',
      fontFamily: 'inherit',
      fontSize: '12px',
      lineHeight: '18px',
      resize: 'vertical',
    }

    const MUTED = {
      margin: '4px 0 0',
      fontSize: '12px',
      lineHeight: '18px',
      color: 'var(--dsw-alias-label-secondary)',
    }

    /* ------------------------------------------------------------------ *
     * Small shared pieces
     * ------------------------------------------------------------------ */

    /** Read a dictionary entry, answering '' when the key is missing (t echoes the key). */
    function translate(t, key) {
      const value = t(key)
      return value === key ? '' : value
    }

    function field(name, value) {
      return h(
        'div',
        { key: name, style: FIELD_ROW },
        h('span', { style: FIELD_NAME }, name),
        h('span', { style: FIELD_VALUE }, value),
      )
    }

    /** A host-shaped button that knows its hover state. */
    function Btn({ t, label, onClick, variant, disabled }) {
      const [hover, setHover] = React.useState(false)
      const base = variant === 'primary' ? PRIMARY_BUTTON : GHOST_BUTTON
      const hoverBackground =
        variant === 'primary'
          ? 'var(--dsw-alias-button-primary-hover)'
          : 'var(--dsw-alias-interactive-bg-hover)'
      return h(
        'button',
        {
          type: 'button',
          disabled: Boolean(disabled),
          onClick,
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          style: {
            ...base,
            opacity: disabled ? 0.4 : 1,
            cursor: disabled ? 'not-allowed' : 'pointer',
            background: hover && !disabled ? hoverBackground : base.background,
          },
        },
        label,
      )
    }

    function StatusDot({ tone }) {
      return h('span', {
        'aria-hidden': 'true',
        style: { width: '8px', height: '8px', borderRadius: '50%', background: tone, flex: '0 0 auto' },
      })
    }

    /**
     * A `?` that explains its field while the pointer is on it.
     *
     * These explanations used to be paragraphs under the controls, which made the
     * panel read like documentation and pushed every real control apart. Hidden
     * behind a hover, the default view is short and the detail is one gesture away.
     *
     * `position: fixed` with measured coordinates, not `absolute`: the panel body
     * scrolls, and an absolutely positioned tip would be clipped at the scroll
     * container's edge — precisely for the fields near the bottom.
     */
    function Hint({ t, text }) {
      const [anchor, setAnchor] = React.useState(null)
      const ref = React.useRef(null)
      if (!text) return null

      const open = () => {
        const el = ref.current
        if (!el) return
        const rect = el.getBoundingClientRect()
        const width = 264
        const left = Math.min(Math.max(8, rect.left), window.innerWidth - width - 8)
        // Below the icon unless that would run off the bottom, in which case above.
        const below = rect.bottom + 6
        const top = below + 120 > window.innerHeight ? Math.max(8, rect.top - 126) : below
        setAnchor({ left, top })
      }

      return h(
        'span',
        { style: { display: 'inline-flex', alignItems: 'center', marginLeft: '4px' } },
        h(
          'span',
          {
            ref,
            role: 'button',
            tabIndex: 0,
            'aria-label': t('hint.show'),
            onMouseEnter: open,
            onFocus: open,
            onMouseLeave: () => setAnchor(null),
            onBlur: () => setAnchor(null),
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: '14px',
              height: '14px',
              borderRadius: '50%',
              border: '1px solid var(--dsw-alias-border-l2)',
              color: 'var(--dsw-alias-label-secondary)',
              fontSize: '10px',
              lineHeight: '1',
              cursor: 'help',
              flex: '0 0 auto',
              userSelect: 'none',
            },
          },
          '?',
        ),
        anchor
          ? h(
              'span',
              {
                role: 'tooltip',
                style: {
                  position: 'fixed',
                  left: anchor.left + 'px',
                  top: anchor.top + 'px',
                  width: '264px',
                  zIndex: 1200,
                  padding: '8px 10px',
                  borderRadius: 'var(--dsw-radius-md)',
                  background: 'var(--dsw-alias-bg-base)',
                  color: 'var(--dsw-alias-label-primary)',
                  border: '0.5px solid var(--dsw-alias-border-l1)',
                  boxShadow: '0 8px 20px rgba(0, 0, 0, 0.28)',
                  fontSize: '12px',
                  lineHeight: '18px',
                  fontWeight: 400,
                  whiteSpace: 'normal',
                },
              },
              text,
            )
          : null,
      )
    }

    /**
     * One numeric setting: a label with its `?`, the box, and its unit.
     *
     * Every numeric setting used to carry its own draft state and commit function —
     * eight copies of the same four rules (empty reverts, out of range clamps, Enter
     * and blur both commit, a save failure surfaces). One component now owns them.
     */
    function NumberField({ t, label, hint, unit, value, min, max, fallback, disabled, onCommit }) {
      const [draft, setDraft] = React.useState(null)

      const commit = () => {
        if (draft === null) return
        const raw = String(draft).trim()
        if (raw === '') {
          setDraft(null)
          return
        }
        const number = Number(raw)
        if (!Number.isFinite(number)) {
          setDraft(null)
          return
        }
        const clamped = Math.min(max, Math.max(min, Math.round(number)))
        setDraft(String(clamped))
        onCommit(clamped)
      }

      return h(
        'div',
        { style: { ...FIELD_ROW, alignItems: 'center' } },
        h('span', { style: FIELD_NAME }, label, hint ? h(Hint, { t, text: hint }) : null),
        h('input', {
          type: 'number',
          min,
          max,
          disabled: disabled === true,
          value: draft === null ? String(value ?? fallback) : draft,
          onChange: (event) => setDraft(event.target.value),
          onBlur: commit,
          onKeyDown: (event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              event.currentTarget.blur()
            }
          },
          'aria-label': label,
          style: { ...TEXT_INPUT, width: '80px', letterSpacing: 'normal', opacity: disabled ? 0.5 : 1 },
        }),
        unit ? h('span', { style: { ...MUTED, margin: 0 } }, unit) : null,
      )
    }

    /**
     * A settings group: a rounded box whose title sits in a gap cut into the top
     * border.
     *
     * The gap is not a real cut — the title carries the panel's own background and
     * is pulled up over the border, which is what makes the line appear to stop and
     * restart around it. That is why the background colour must match the surface
     * the box sits on (`bg-layer-2`, the panel card) rather than a fixed token.
     */
    const GROUP = {
      position: 'relative',
      marginTop: '22px',
      padding: '16px 14px 8px',
      // Thicker than any control inside it, in the stronger of the two border tokens:
      // a hairline of `l1` is essentially invisible on a dark surface, which is what
      // was reported, and 1px still read as too thin next to it.
      // The box has no fill on purpose — the legend can then mask the border with the
      // panel's own background without leaving a rectangle of the wrong colour.
      border: '2px solid var(--dsw-alias-border-l2)',
      borderRadius: 'var(--dsw-radius-md)',
    }

    function Group({ t, title, hint, children }) {
      return h(
        'div',
        { style: GROUP },
        h(
          'span',
          {
            style: {
              position: 'absolute',
              top: '-9px',
              left: '12px',
              padding: '0 6px',
              background: 'var(--dsw-alias-bg-layer-2)',
              color: 'var(--dsw-alias-label-secondary)',
              fontSize: '12px',
              lineHeight: '18px',
              fontWeight: 600,
              whiteSpace: 'nowrap',
            },
          },
          title,
          hint ? h(Hint, { t, text: hint }) : null,
        ),
        children,
      )
    }

    /**
     * Editor for one named scenario: name, content, save, cancel.
     *
     * Rendered as its own layer above the settings panel rather than inline, because
     * the content field is a full prompt and the list behind it should not scroll
     * while it is being written.
     */
    const SCENARIO_LAYER = {
      position: 'fixed',
      inset: 0,
      zIndex: 1500,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'rgba(0, 0, 0, 0.45)',
    }

    const SCENARIO_CARD = {
      boxSizing: 'border-box',
      width: '560px',
      maxWidth: 'calc(100vw - 48px)',
      maxHeight: 'calc(100vh - 96px)',
      overflowY: 'auto',
      padding: '18px 18px 14px',
      borderRadius: 'var(--dsw-radius-md)',
      border: '1px solid var(--dsw-alias-border-l2)',
      background: 'var(--dsw-alias-bg-layer-2)',
      color: 'var(--dsw-alias-label-primary)',
      boxShadow: 'var(--dsw-elevation-prominent)',
    }

    function ScenarioEditor({ t, initial, onSave, onCancel }) {
      const [name, setName] = React.useState(initial.name || '')
      const [content, setContent] = React.useState(initial.content || '')
      const nameRef = React.useRef(null)
      const canSave = name.trim().length > 0

      React.useEffect(() => {
        const timer = setTimeout(() => {
          if (nameRef.current && typeof nameRef.current.focus === 'function') nameRef.current.focus()
        }, 0)
        return () => clearTimeout(timer)
      }, [])

      return h(
        'div',
        { style: SCENARIO_LAYER, onMouseDown: (event) => { if (event.target === event.currentTarget) onCancel() } },
        h(
          'div',
          { role: 'dialog', 'aria-modal': 'true', style: SCENARIO_CARD },
          h('h3', { style: SECTION_TITLE }, initial.id ? t('scenario.editTitle') : t('scenario.addTitle')),
          h('p', { style: { ...MUTED, marginTop: '10px' } }, t('scenario.nameLabel')),
          h('input', {
            ref: nameRef,
            type: 'text',
            value: name,
            maxLength: 60,
            onChange: (event) => setName(event.target.value),
            'aria-label': t('scenario.nameLabel'),
            style: { ...TEXT_INPUT, width: '100%', letterSpacing: 'normal' },
          }),
          h('p', { style: { ...MUTED, marginTop: '10px' } }, t('scenario.contentLabel')),
          h('textarea', {
            value: content,
            onChange: (event) => setContent(event.target.value),
            rows: 12,
            'aria-label': t('scenario.contentLabel'),
            style: TEXTAREA,
          }),
          h(
            'div',
            { style: { marginTop: '12px', display: 'flex', gap: '8px', justifyContent: 'flex-end' } },
            h(Btn, { label: t('scenario.cancel'), onClick: onCancel }),
            h(Btn, {
              label: t('scenario.save'),
              variant: 'primary',
              disabled: !canSave,
              onClick: () => onSave({ name: name.trim(), content }),
            }),
          ),
        ),
      )
    }

    /**
     * A drawn dropdown, used for both the scenario picker and the approval mode.
     *
     * A native `<select>` popup is painted by the platform: its corners cannot be
     * rounded and its options do not reliably take a background colour. Since the
     * list is exactly what the user reads, it is worth owning.
     *
     * Rows are exactly as tall as the closed control (28px), so the open list reads
     * as one box continuing rather than a differently-proportioned menu. A label too
     * long for one line is allowed to wrap, and the row thickens to fit it instead of
     * truncating the name the user is choosing between.
     */
    function Dropdown({ ariaLabel, items, valueId, disabled, onSelect, basis = '260px', minWidth = '180px' }) {
      const [open, setOpen] = React.useState(false)
      const [box, setBox] = React.useState(null)
      const triggerRef = React.useRef(null)
      const selected = items.find((item) => item.id === valueId) || items[0]

      const close = () => {
        setOpen(false)
        setBox(null)
      }

      /**
       * Measured placement, not `absolute` inside the row: this row sits at the
       * bottom of the panel, and an absolutely positioned list is clipped by the
       * body's scroll container exactly there. Fixed coordinates also let the list
       * flip above the trigger when the window has no room below.
       */
      const toggle = () => {
        if (open) {
          close()
          return
        }
        const el = triggerRef.current
        if (!el) return
        const rect = el.getBoundingClientRect()
        const below = window.innerHeight - rect.bottom - 8
        const above = rect.top - 8
        const flip = below < 160 && above > below
        const available = flip ? above : below
        setBox({
          left: rect.left,
          width: rect.width,
          maxHeight: Math.min(260, Math.max(96, available - 4)),
          top: flip ? undefined : rect.bottom + 4,
          bottom: flip ? window.innerHeight - rect.top + 4 : undefined,
        })
        setOpen(true)
      }

      return h(
        'div',
        { style: { position: 'relative', flex: `0 1 ${basis}`, minWidth, maxWidth: '100%' } },
        h(
          'button',
          {
            ref: triggerRef,
            type: 'button',
            disabled: disabled === true,
            'aria-haspopup': 'listbox',
            'aria-expanded': open ? 'true' : 'false',
            'aria-label': ariaLabel,
            onClick: toggle,
            style: {
              ...SELECT,
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              width: '100%',
              cursor: disabled ? 'default' : 'pointer',
              textAlign: 'left',
              borderRadius: 'var(--dsw-radius-md)',
              opacity: disabled ? 0.5 : 1,
            },
          },
          h(
            'span',
            {
              style: {
                flex: '1 1 auto',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                color: selected && selected.muted ? 'var(--dsw-alias-label-secondary)' : undefined,
              },
            },
            selected ? selected.label : '—',
          ),
          h('span', { style: { flex: '0 0 auto', opacity: 0.6 } }, '▾'),
        ),
        open && box
          ? h('div', {
              // Behind the list, above everything else: clicking anywhere else closes.
              style: { position: 'fixed', inset: 0, zIndex: 1290 },
              onClick: close,
            })
          : null,
        open && box
          ? h(
              'div',
              {
                role: 'listbox',
                style: {
                  position: 'fixed',
                  left: box.left + 'px',
                  width: box.width + 'px',
                  top: box.top === undefined ? undefined : box.top + 'px',
                  bottom: box.bottom === undefined ? undefined : box.bottom + 'px',
                  zIndex: 1300,
                  padding: '4px',
                  maxHeight: box.maxHeight + 'px',
                  overflowY: 'auto',
                  borderRadius: 'var(--dsw-radius-md)',
                  border: '1px solid var(--dsw-alias-border-l2)',
                  background: 'var(--dsw-alias-bg-base)',
                  boxShadow: 'var(--dsw-elevation-prominent)',
                },
              },
              items.map((item) => {
                const isSelected = item.id === valueId
                return h(
                  'div',
                  {
                    key: item.id,
                    role: 'option',
                    'aria-selected': isSelected ? 'true' : 'false',
                    onClick: () => {
                      close()
                      if (!isSelected) onSelect(item.id)
                    },
                    style: {
                      // Same height as the closed control, and free to grow when the
                      // label needs a second line.
                      minHeight: '28px',
                      boxSizing: 'border-box',
                      display: 'flex',
                      alignItems: 'center',
                      padding: '4px 10px',
                      borderRadius: 'var(--dsw-radius-sm)',
                      cursor: 'pointer',
                      fontSize: '12px',
                      lineHeight: '18px',
                      whiteSpace: 'normal',
                      wordBreak: 'break-word',
                      // Selected: the lighter surface. Everything else: the base, which
                      // is black on the dark theme.
                      background: isSelected ? 'var(--dsw-alias-bg-layer-1)' : 'transparent',
                      color: item.muted ? 'var(--dsw-alias-label-secondary)' : 'var(--dsw-alias-label-primary)',
                      fontWeight: isSelected ? 600 : 400,
                      textDecoration: item.muted ? 'line-through' : 'none',
                    },
                  },
                  item.label,
                )
              }),
            )
          : null,
      )
    }

    /* ------------------------------------------------------------------ *
     * The channel body: status, binding, and the QR handshake
     * ------------------------------------------------------------------ */
    function ChannelBody({ t }) {
      const [status, setStatus] = React.useState({ phase: 'loading' })
      const [login, setLogin] = React.useState(null)
      const [code, setCode] = React.useState('')
      const [session, setSession] = React.useState(0)
      const [statusTick, setStatusTick] = React.useState(0)
      // Rebinding on purpose: a bound card would otherwise leave "scan again"
      // with nothing to switch on, because the handshake only runs while unbound.
      const [force, setForce] = React.useState(false)
      const confirmedHandled = React.useRef(false)

      /** POST helper shared by the polling effect and the rebinding controls. */
      const post = React.useCallback(
        (url, body) =>
          fetch(url, {
            method: 'POST',
            credentials: 'same-origin',
            ...(body === undefined
              ? {}
              : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
          }).then((response) => response.json().catch(() => ({}))),
        [],
      )

      // 1. Channel status.
      React.useEffect(() => {
        let cancelled = false
        // Keep the current panel mounted while refreshing.
        //
        // Blanking to `loading` first replaced the whole body with one short line,
        // which collapsed the scroll height and let the browser clamp the position
        // to 0 — so every save jumped the panel back to the top. The data is stale
        // for a moment either way; a stale field is better than a lost scroll
        // position.
        setStatus((previous) => (previous.phase === 'ready' ? previous : { phase: 'loading' }))
        fetch(STATUS_URL, { credentials: 'same-origin' })
          .then((response) =>
            response.ok ? response.json() : Promise.reject(new Error('HTTP ' + response.status)),
          )
          .then((json) => {
            if (!cancelled) setStatus({ phase: 'ready', data: json })
          })
          .catch((error) => {
            if (!cancelled) setStatus({ phase: 'error', reason: (error && error.message) || String(error) })
          })
        return () => {
          cancelled = true
        }
      }, [statusTick])

      const bound = status.phase === 'ready' && status.data && status.data.bound === true

      // 2. Login handshake, only while unbound. Starting is idempotent on the
      //    Host: an attempt that is still alive is reused, not replaced.
      React.useEffect(() => {
        if (status.phase !== 'ready' || (bound && !force)) return undefined
        let cancelled = false
        let timer = null

        async function step() {
          let snapshot = null
          try {
            const response = await fetch(LOGIN_URL, { credentials: 'same-origin' })
            const body = await response.json()
            snapshot = body.login || null
          } catch {
            snapshot = null
          }
          if (cancelled) return

          if (!snapshot || snapshot.phase === 'idle' || snapshot.phase === 'cancelled') {
            try {
              const body = await post(LOGIN_START_URL)
              if (cancelled) return
              setLogin(body.login || { phase: 'failed', error: body.error || 'unavailable' })
            } catch (error) {
              if (!cancelled) setLogin({ phase: 'failed', error: (error && error.message) || String(error) })
              return
            }
          } else {
            setLogin(snapshot)
            if (snapshot.phase === 'confirmed') {
              if (!confirmedHandled.current) {
                confirmedHandled.current = true
                setForce(false)
                setStatusTick((n) => n + 1)
              }
              return
            }
            if (snapshot.phase === 'failed' || snapshot.phase === 'already-bound') return
          }
          if (!cancelled) timer = setTimeout(step, 1200)
        }

        step()
        return () => {
          cancelled = true
          if (timer) clearTimeout(timer)
        }
      }, [status.phase, bound, force, session, post])

      function restart() {
        setLogin(null)
        setCode('')
        confirmedHandled.current = false
        post(LOGIN_CANCEL_URL).finally(() => setSession((n) => n + 1))
      }

      function submitCode(event) {
        event.preventDefault()
        const trimmed = code.trim()
        if (!trimmed) return
        post(LOGIN_VERIFY_URL, { code: trimmed }).catch(() => {})
        setCode('')
      }

      const refreshStatus = () => setStatusTick((n) => n + 1)

      /* --- session binding --- */
      const [picker, setPicker] = React.useState(false)
      const [sessions, setSessions] = React.useState({ phase: 'idle' })
      const [bindError, setBindError] = React.useState('')

      function loadSessions() {
        setSessions({ phase: 'loading' })
        fetch(SESSIONS_URL, { credentials: 'same-origin' })
          .then((response) =>
            response.ok ? response.json() : Promise.reject(new Error('HTTP ' + response.status)),
          )
          .then((json) => setSessions({ phase: 'ready', items: json.items || [] }))
          .catch((error) => setSessions({ phase: 'error', reason: (error && error.message) || String(error) }))
      }

      function togglePicker() {
        const next = !picker
        setPicker(next)
        if (next) loadSessions()
      }

      function bindTo(sessionId) {
        setBindError('')
        post(BIND_URL, { sessionId })
          .then((body) => {
            if (!body || body.ok !== true) {
              setBindError((body && body.error) || t('bind.failed'))
              return
            }
            setPicker(false)
            refreshStatus()
          })
          .catch((error) => setBindError((error && error.message) || String(error)))
      }

      /**
       * Draft for the every-turn reminder: null means "showing the saved value".
       *
       * With no save button, leaving the field is the commit — the same rule the
       * number fields follow. A prompt that loses an unsaved edit because the panel
       * was closed is worse than an extra request on blur.
       */
      const [draftAnchor, setDraftAnchor] = React.useState(null)

      function commitAnchor() {
        if (draftAnchor === null) return
        if (draftAnchor === String((status.data || {}).anchorPrompt || '')) {
          setDraftAnchor(null)
          return
        }
        setBindError('')
        post(SETTINGS_URL, { anchorPrompt: draftAnchor })
          .then((body) => {
            if (!body || body.ok !== true) {
              // Keep the draft: the text the user typed must not vanish because the
              // host rejected it.
              setBindError((body && body.error) || t('bind.failed'))
              return
            }
            setDraftAnchor(null)
            refreshStatus()
          })
          .catch((error) => setBindError((error && error.message) || String(error)))
      }

      /* --- named channel prompts --- */
      // `status.data` does not exist yet on the first render (phase 'loading'), and
      // these lines run before the loading branch returns. Reading it unguarded threw
      // during render, which takes the whole panel - and the header button with it -
      // off screen.
      const data = status.data || {}
      const scenarios = Array.isArray(data.scenarios) ? data.scenarios : []
      const activeId = String(data.activeScenarioId || '')
      const active =
        scenarios.find((item) => item.id === activeId) || scenarios[0] || { id: '', name: '', content: '' }
      // null = no editor open; {id} present = editing that scenario, absent = adding.
      const [editor, setEditor] = React.useState(null)
      // Deletion is staged until the panel closes; see the unmount commit below.
      const [pendingDeleteId, setPendingDeleteId] = React.useState(null)

      function saveScenario(draft) {
        const list = scenarios.map((item) => ({ id: item.id, name: item.name, content: item.content }))
        if (editor && editor.id) {
          const index = list.findIndex((item) => item.id === editor.id)
          if (index >= 0) list[index] = { ...list[index], name: draft.name, content: draft.content }
          setEditor(null)
          postSettings({ scenarios: list })
          return
        }
        // Slug from the clock: ids only have to be unique inside this list.
        const id = `s${Date.now().toString(36)}`
        list.push({ id, name: draft.name, content: draft.content })
        setEditor(null)
        postSettings({ scenarios: list, activeScenarioId: id })
      }

      // The newest list and pending id, readable from the unmount cleanup, which
      // cannot see later renders.
      const pendingRef = React.useRef(null)
      pendingRef.current = pendingDeleteId
        ? { id: pendingDeleteId, list: scenarios.map((item) => ({ id: item.id, name: item.name, content: item.content })) }
        : null

      React.useEffect(
        () => () => {
          const pending = pendingRef.current
          if (!pending) return
          const remaining = pending.list.filter((item) => item.id !== pending.id)
          // The last scenario cannot be deleted: the channel would have no note.
          if (remaining.length === 0) return
          // Fired when the panel unmounts, which is exactly "panel closed".
          void post(SETTINGS_URL, {
            scenarios: remaining,
            activeScenarioId: remaining[0].id,
          })
        },
        [],
      )

      // Without a save button, an edit still in the box when the panel closes must not
      // be thrown away: blur is not guaranteed on unmount, and closing by clicking the
      // mask is the normal way to leave.
      const anchorRef = React.useRef(null)
      anchorRef.current = {
        draft: draftAnchor,
        saved: String((status.data || {}).anchorPrompt || ''),
      }

      React.useEffect(
        () => () => {
          const held = anchorRef.current
          if (!held || held.draft === null) return
          if (held.draft === held.saved) return
          void post(SETTINGS_URL, { anchorPrompt: held.draft })
        },
        [],
      )

      /** Write one settings patch and refresh, surfacing the Host's rejection. */
      function postSettings(patch) {
        setBindError('')
        post(SETTINGS_URL, patch)
          .then((body) => {
            if (!body || body.ok !== true) {
              setBindError((body && body.error) || t('bind.failed'))
              return
            }
            refreshStatus()
          })
          .catch((error) => setBindError((error && error.message) || String(error)))
      }

      function setApprovalMode(mode) {
        setBindError('')
        post(SETTINGS_URL, { approvalMode: mode })
          .then((body) => {
            if (!body || body.ok !== true) {
              setBindError((body && body.error) || t('bind.failed'))
              return
            }
            refreshStatus()
          })
          .catch((error) => setBindError((error && error.message) || String(error)))
      }

      function renderPicker() {
        if (sessions.phase === 'loading') return h('p', { style: MUTED }, t('bind.loading'))
        if (sessions.phase === 'error') {
          return h(
            'div',
            { style: { marginTop: '8px' } },
            h('p', { style: { ...MUTED, color: 'var(--dsw-alias-state-error-primary)' } },
              t('bind.error', { reason: sessions.reason })),
            h(Btn, { label: t('bind.retry'), onClick: loadSessions }),
          )
        }
        const items = sessions.items || []
        return h(
          'div',
          { style: { marginTop: '8px', maxHeight: '220px', overflowY: 'auto' } },
          h(Btn, { label: t('bind.detach'), onClick: () => bindTo('') }),
          items.length === 0
            ? h('p', { style: MUTED }, t('bind.empty'))
            : items.map((item) =>
                h(
                  'button',
                  {
                    key: item.sessionId,
                    type: 'button',
                    onClick: () => bindTo(item.sessionId),
                    style: {
                      display: 'block',
                      width: '100%',
                      textAlign: 'left',
                      marginTop: '4px',
                      padding: '6px 8px',
                      borderRadius: 'var(--dsw-radius-sm)',
                      border: '0.5px solid var(--dsw-alias-border-l1)',
                      background: 'var(--dsw-alias-bg-base)',
                      color: 'var(--dsw-alias-label-primary)',
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                      fontSize: '12px',
                      lineHeight: '18px',
                    },
                  },
                  h('span', null, item.title || t('bind.untitled')),
                  h(
                    'span',
                    { style: { color: 'var(--dsw-alias-label-secondary)' } },
                    ' · ' + item.shortId + (item.running ? ' · ' + t('bind.running') : ''),
                  ),
                ),
              ),
        )
      }

      /* --- status unresolved --- */
      if (status.phase === 'loading') {
        return h('p', { style: MUTED }, t('status.loading'))
      }
      if (status.phase === 'error') {
        return h(
          'div',
          { style: PANEL_CARD },
          h('p', { style: { margin: 0, fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-state-error-primary)' } },
            t('status.error', { reason: status.reason })),
          h('div', { style: { marginTop: '10px' } }, h(Btn, { label: t('status.refresh'), onClick: refreshStatus })),
        )
      }

      /* --- bound --- */
      if (bound && !force) {
        const account = (status.data.accounts && status.data.accounts[0]) || {}
        const boundAt = account.boundAt ? new Date(account.boundAt).toLocaleString() : '—'
        return h(
          'section',
          null,
          h(
            'div',
            { style: { ...PANEL_CARD, display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', rowGap: '6px' } },
            h(StatusDot, {
              tone: status.data.connected
                ? 'var(--dsw-alias-state-success-primary)'
                : 'var(--dsw-alias-state-warn-primary)',
            }),
            h('span', { style: { fontSize: '13px', lineHeight: '20px', fontWeight: 600 } },
              status.data.connected ? t('status.connected') : t('status.bound')),
            h('span', { style: { fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)' } },
              status.data.connected ? t('status.pollingNote') : t('status.boundNote')),
            // Actions belong on the line they act on: "已连接" is what you refresh,
            // and re-binding is the same subject. Pushed right so the state reads
            // first and the buttons stay out of the text's way.
            h('span', { style: { flex: 1 } }),
            h(
              'span',
              { style: { display: 'flex', gap: '8px', flexShrink: 0 } },
              h(Btn, { label: t('status.refresh'), onClick: refreshStatus }),
              h(Btn, {
                label: t('login.rebind'),
                onClick: () => {
                  setForce(true)
                  restart()
                },
              }),
            ),
          ),
          h(
            'div',
            { style: { marginTop: '10px' } },
            field(t('account.id'), String(account.accountId || '—')),
            account.userId ? field(t('account.user'), String(account.userId)) : null,
            field(t('account.boundAt'), boundAt),
            field(t('account.polling'), account.polling ? t('common.yes') : t('common.no')),
            status.data.diagnostics && status.data.diagnostics.workspace
              ? field(t('account.workspace'), String(status.data.diagnostics.workspace))
              : null,
            status.data.diagnostics && status.data.diagnostics.sessions !== undefined
              ? field(t('account.sessions'), String(status.data.diagnostics.sessions))
              : null,
            status.data.diagnostics && status.data.diagnostics.statePath
              ? field(t('status.field.stateFile'), String(status.data.diagnostics.statePath))
              : null,
          ),
          h(
            'div',
            {
              style: {
                marginTop: '16px',
                paddingTop: '12px',
                borderTop: '0.5px solid var(--dsw-alias-border-l1)',
              },
            },
            h(
              'div',
              {
                style: {
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '8px',
                },
              },
              h('h3', { style: SECTION_TITLE }, t('bind.heading')),
              h(Btn, { label: picker ? t('bind.close') : t('bind.change'), onClick: togglePicker }),
            ),
            h('p', { style: MUTED }, t('bind.hint')),
            field(t('bind.current'), status.data.binding ? status.data.binding.shortId : t('bind.auto')),
            status.data.binding && status.data.binding.cwd
              ? field(t('bind.cwd'), String(status.data.binding.cwd))
              : null,
            picker ? renderPicker() : null,
            bindError
              ? h('p', { style: { ...MUTED, color: 'var(--dsw-alias-state-error-primary)' } }, bindError)
              : null,
          ),
          h(
            Group,
            { t, title: t('group.approval') },
            h(
              'div',
              { style: { ...FIELD_ROW, alignItems: 'center' } },
              h('span', { style: FIELD_NAME }, t('approval.mode'), h(Hint, { t, text: t('approval.hint') })),
              h(Dropdown, {
                ariaLabel: t('approval.mode'),
                items: [
                  { id: 'phone', label: t('approval.phone') },
                  { id: 'desktop', label: t('approval.desktop') },
                ],
                valueId: status.data.approvalMode || 'phone',
                onSelect: setApprovalMode,
                basis: '260px',
                minWidth: '220px',
              }),
            ),
            h(NumberField, {
              t,
              label: t('approval.timeout'),
              hint: t('approval.timeoutHint'),
              unit: t('approval.timeoutUnit'),
              value: status.data.approvalTimeoutSec,
              min: 5,
              max: 300,
              fallback: 30,
              onCommit: (value) => postSettings({ approvalTimeoutSec: value }),
            }),
          ),
          h(
            Group,
            { t, title: t('group.media') },
            h(NumberField, {
              t,
              label: t('merge.label'),
              hint: t('merge.hint'),
              unit: t('merge.unit'),
              value: status.data.mediaMergeSec,
              min: 0,
              max: 300,
              fallback: 20,
              onCommit: (value) => postSettings({ mediaMergeSec: value }),
            }),
            h(NumberField, {
              t,
              label: t('merge.maxMedia'),
              hint: t('merge.maxMediaHint'),
              unit: t('merge.maxMediaUnit'),
              value: status.data.mediaMaxPerMessage,
              min: 1,
              max: 10,
              fallback: 3,
              onCommit: (value) => postSettings({ mediaMaxPerMessage: value }),
            }),
          ),
          h(
            Group,
            { t, title: t('group.reply') },
            h(NumberField, {
              t,
              label: t('reply.max.label'),
              hint: t('reply.max.hint'),
              unit: t('reply.max.unit'),
              value: status.data.maxReplyChars,
              min: 200,
              max: 4000,
              fallback: 1200,
              onCommit: (value) => postSettings({ maxReplyChars: value }),
            }),
            h(NumberField, {
              t,
              label: t('list.max.label'),
              hint: t('list.max.hint'),
              unit: t('list.max.unit'),
              value: status.data.maxListRows,
              min: 3,
              max: 30,
              fallback: 10,
              onCommit: (value) => postSettings({ maxListRows: value }),
            }),
          ),
          h(
            Group,
            { t, title: t('group.done'), hint: t('done.hint') },
            h(
              'div',
              { style: { ...FIELD_ROW, alignItems: 'center' } },
              h('span', { style: FIELD_NAME }, t('done.enable')),
              h('input', {
                type: 'checkbox',
                checked: status.data.doneNotifyEnabled === true,
                onChange: (event) => postSettings({ doneNotifyEnabled: Boolean(event.target.checked) }),
                'aria-label': t('done.enable'),
                style: { width: '14px', height: '14px', margin: 0, accentColor: 'var(--dsw-alias-brand-primary)' },
              }),
            ),
            h(NumberField, {
              t,
              label: t('done.delay'),
              hint: t('done.delayHint'),
              value: status.data.doneNotifyDelaySec,
              min: 5,
              max: 600,
              fallback: 30,
              disabled: status.data.doneNotifyEnabled !== true,
              onCommit: (value) => postSettings({ doneNotifyDelaySec: value }),
            }),
            h(NumberField, {
              t,
              label: t('done.travelLabel'),
              hint: t('done.travelHint'),
              unit: t('done.travelUnit'),
              value: status.data.presenceTravelPx,
              min: 20,
              max: 1000,
              fallback: 120,
              disabled: status.data.doneNotifyEnabled !== true,
              onCommit: (value) => postSettings({ presenceTravelPx: value }),
            }),
          ),
          h(
            Group,
            { t, title: t('persona.heading'), hint: t('persona.hint') },
            h(
              'p',
              { style: { ...MUTED } },
              t('persona.anchorLabel'),
              h(Hint, { t, text: t('persona.anchorHint') }),
            ),
            h('textarea', {
              value: draftAnchor === null ? String(status.data.anchorPrompt || '') : draftAnchor,
              onChange: (event) => setDraftAnchor(event.target.value),
              // No save button: leaving the field commits, like the number fields.
              onBlur: commitAnchor,
              // Two rows: this string goes out on every turn, so it is meant to stay
              // short — a tall box would invite it to grow.
              rows: 2,
              'aria-label': t('persona.anchorLabel'),
              style: TEXTAREA,
            }),
            // The switch covers the long note only. The anchor above has none on
            // purpose: it is the line whose absence silences every reply.
            h(
              'div',
              { style: { ...FIELD_ROW, alignItems: 'center', marginTop: '12px' } },
              h('span', { style: FIELD_NAME }, t('prompt.enable'), h(Hint, { t, text: t('prompt.enableHint') })),
              h('input', {
                type: 'checkbox',
                checked: status.data.channelPromptEnabled !== false,
                onChange: (event) => postSettings({ channelPromptEnabled: Boolean(event.target.checked) }),
                'aria-label': t('prompt.enable'),
                style: { width: '14px', height: '14px', margin: 0, accentColor: 'var(--dsw-alias-brand-primary)' },
              }),
              h('span', { style: { ...MUTED, margin: 0 } }, t('prompt.enableState')),
            ),
            h(NumberField, {
              t,
              label: t('promptRefresh.label'),
              hint: t('promptRefresh.hint'),
              unit: t('promptRefresh.unit'),
              value: status.data.promptRefreshTurns,
              min: 1,
              max: 200,
              fallback: 20,
              disabled: status.data.channelPromptEnabled === false,
              onCommit: (value) => postSettings({ promptRefreshTurns: value }),
            }),
            h(
              'div',
              { style: { ...FIELD_ROW, alignItems: 'center', marginTop: '10px' } },
              h('span', { style: FIELD_NAME }, t('scenario.label'), h(Hint, { t, text: t('scenario.hint') })),
              h(Dropdown, {
                ariaLabel: t('scenario.label'),
                items: scenarios.map((item) => ({
                  id: item.id,
                  muted: item.id === pendingDeleteId,
                  label:
                    item.id === pendingDeleteId
                      ? `${item.name} ${t('scenario.pending')}`
                      : item.name,
                })),
                valueId: active.id,
                disabled: status.data.channelPromptEnabled === false,
                onSelect: (id) => postSettings({ activeScenarioId: id }),
                basis: '360px',
                minWidth: '240px',
              }),
              pendingDeleteId
                ? h(Btn, { label: t('scenario.undo'), onClick: () => setPendingDeleteId(null) })
                : h(Btn, {
                    label: t('scenario.edit'),
                    disabled: !active.id,
                    onClick: () => setEditor({ id: active.id, name: active.name, content: active.content }),
                  }),
              pendingDeleteId
                ? null
                : h(Btn, {
                    label: t('scenario.delete'),
                    disabled: scenarios.length <= 1,
                    onClick: () => setPendingDeleteId(active.id),
                  }),
            ),
            h(
              'p',
              { style: { margin: '6px 0 0', fontSize: '12px', lineHeight: '18px' } },
              h(
                'button',
                {
                  type: 'button',
                  disabled: pendingDeleteId !== null,
                  onClick: () => setEditor({ name: '', content: '' }),
                  style: {
                    padding: 0,
                    border: 0,
                    background: 'transparent',
                    color: pendingDeleteId ? 'var(--dsw-alias-label-secondary)' : 'var(--dsw-alias-brand-primary)',
                    cursor: pendingDeleteId ? 'default' : 'pointer',
                    font: 'inherit',
                    textDecoration: pendingDeleteId ? 'none' : 'underline',
                  },
                },
                t('scenario.add'),
              ),
            ),
            pendingDeleteId
              ? h('p', { style: { ...MUTED, marginTop: '6px' } }, t('scenario.pendingHint'))
              : null,
            // Rendered here rather than at the root: it reads this group's state, and
            // `position: fixed` means its DOM parent does not matter.
            editor
              ? h(ScenarioEditor, {
                  t,
                  initial: editor,
                  onSave: saveScenario,
                  onCancel: () => setEditor(null),
                })
              : null,
          ),
          h(
            'section',
            { style: { ...PANEL_CARD, marginTop: '16px' } },
            h('h3', { style: SECTION_TITLE }, t('bind.usageHeading')),
            h('p', { style: { ...MUTED, marginTop: '6px' } }, t('bind.commands')),
            // A two-column list beats one sentence with six commands in it: the
            // command is what you scan for, so it gets its own monospaced column.
            h(
              'div',
              {
                style: {
                  display: 'grid',
                  gridTemplateColumns: 'max-content 1fr',
                  columnGap: '14px',
                  rowGap: '5px',
                  marginTop: '8px',
                  fontSize: '12px',
                  lineHeight: '18px',
                },
              },
              USAGE_COMMANDS.map(([command, key]) => [
                h(
                  'code',
                  {
                    key: `c-${command}`,
                    style: {
                      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                      color: 'var(--dsw-alias-label-primary)',
                      whiteSpace: 'nowrap',
                    },
                  },
                  command,
                ),
                h(
                  'span',
                  { key: `d-${command}`, style: { color: 'var(--dsw-alias-label-secondary)' } },
                  t(key),
                ),
              ]),
            ),
          ),
        )
      }

      /* --- waiting for a scan --- */
      const phase = (login && login.phase) || 'idle'
      const busy = phase === 'starting' || phase === 'refreshing' || phase === 'scanned'
      const terminal = phase === 'failed' || phase === 'already-bound'

      return h(
        'section',
        null,
        h(
          'div',
          { style: { ...PANEL_CARD, display: 'flex', alignItems: 'center', gap: '8px' } },
          h(StatusDot, { tone: busy ? 'var(--dsw-alias-state-warn-primary)' : 'var(--dsw-alias-state-idle-primary)' }),
          h('span', { style: { fontSize: '13px', lineHeight: '20px', fontWeight: 600 } }, t('status.unbound')),
          h('span', { style: { fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)' } },
            translate(t, 'login.phase.' + phase) || phase),
        ),

        login && login.qrDataUrl
          ? h(
              'div',
              { style: { marginTop: '12px', display: 'flex', gap: '16px', alignItems: 'flex-start' } },
              h('img', {
                src: login.qrDataUrl,
                alt: t('login.qrAlt'),
                width: 232,
                height: 232,
                // A QR must stay dark-on-light to scan; this is artwork, not chrome.
                style: { display: 'block', borderRadius: '8px', background: '#ffffff', padding: '8px', flex: '0 0 auto' },
              }),
              h(
                'div',
                { style: { minWidth: '0', flex: '1 1 auto' } },
                h('p', { style: { margin: 0, fontSize: '13px', lineHeight: '20px', fontWeight: 600 } }, t('login.scanTitle')),
                h('p', { style: MUTED }, login.message || t('login.scanHint')),
                login.refreshed
                  ? h('p', { style: MUTED }, t('login.refreshed', { count: String(login.refreshed) }))
                  : null,
                login.qrUrl
                  ? h('p', { style: { ...MUTED, marginTop: '8px', wordBreak: 'break-all' } },
                      t('login.linkHint'), ' ', h('a', {
                        href: login.qrUrl,
                        target: '_blank',
                        rel: 'noreferrer',
                        style: { color: 'var(--dsw-alias-brand-primary)' },
                      }, t('login.openLink')))
                  : null,
              ),
            )
          : h('p', { style: { ...MUTED, marginTop: '12px' } }, login && login.message ? login.message : t('login.preparing')),

        login && login.awaitingVerifyCode
          ? h(
              'form',
              { onSubmit: submitCode, style: { marginTop: '12px', display: 'flex', gap: '8px', alignItems: 'center' } },
              h('input', {
                type: 'text',
                inputMode: 'numeric',
                value: code,
                onChange: (event) => setCode(event.target.value.replace(/[^0-9]/g, '').slice(0, 8)),
                placeholder: t('login.codePlaceholder'),
                'aria-label': t('login.codePlaceholder'),
                style: TEXT_INPUT,
              }),
              h(Btn, { label: t('login.submitCode'), onClick: submitCode, variant: 'primary' }),
            )
          : null,

        login && login.error
          ? h('p', { style: { margin: '10px 0 0', fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-state-error-primary)' } },
              login.error)
          : null,

        terminal
          ? h('div', { style: { marginTop: '12px' } }, h(Btn, { label: t('login.retry'), onClick: restart }))
          : null,

        force
          ? h(
              'div',
              { style: { marginTop: '12px' } },
              h(Btn, {
                label: t('login.cancel'),
                onClick: () => {
                  setForce(false)
                  restart()
                },
              }),
            )
          : null,
      )
    }

    /* ------------------------------------------------------------------ *
     * The header action
     * ------------------------------------------------------------------ */
    function OpenButton({ t, active }) {
      const [hover, setHover] = React.useState(false)
      return h(
        'button',
        {
          type: 'button',
          'aria-label': t('action.label'),
          'aria-expanded': active ? 'true' : 'false',
          title: t('action.hint'),
          onClick: () => setPanelVisible(!panelVisible),
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          style: hover
            ? { ...ACTION_BUTTON, background: 'var(--dsw-alias-interactive-bg-hover)' }
            : ACTION_BUTTON,
        },
        t('action.label'),
      )
    }

    /* ------------------------------------------------------------------ *
     * The panel (mounted only while open)
     * ------------------------------------------------------------------ */
    function PanelView({ t }) {
      const closeRef = React.useRef(null)

      React.useEffect(() => {
        const restore = document.activeElement
        const onKeyDown = (event) => {
          if (event.key !== 'Escape') return
          event.preventDefault()
          event.stopPropagation()
          setPanelVisible(false)
        }
        // Capture phase: our Escape must beat the settings dialog's own handler,
        // otherwise closing this panel would close Settings underneath it too.
        document.addEventListener('keydown', onKeyDown, true)
        const timer = setTimeout(() => {
          const target = closeRef.current
          if (target && typeof target.focus === 'function') target.focus()
        }, 0)
        return () => {
          document.removeEventListener('keydown', onKeyDown, true)
          clearTimeout(timer)
          if (restore && typeof restore.focus === 'function') {
            try {
              restore.focus()
            } catch {
              /* the invoking control may be gone; nothing to restore */
            }
          }
        }
      }, [])

      const [closeHover, setCloseHover] = React.useState(false)

      return h(
        'div',
        { style: LAYER },
        h('div', {
          style: MASK,
          'aria-hidden': 'true',
          onClick: () => setPanelVisible(false),
        }),
        h(
          'div',
          {
            role: 'dialog',
            'aria-modal': 'true',
            'aria-labelledby': TITLE_ID,
            tabIndex: -1,
            style: CARD,
          },
          h(
            'div',
            { style: HEADER },
            h(
              'div',
              { style: { minWidth: '0' } },
              h('h2', { id: TITLE_ID, style: { margin: 0, fontSize: '16px', lineHeight: '24px', fontWeight: 500 } },
                t('panel.title')),
              h('p', { style: { ...MUTED, marginTop: '2px' } }, t('panel.subtitle')),
            ),
            h(
              'button',
              {
                type: 'button',
                ref: closeRef,
                'aria-label': t('panel.close'),
                title: t('panel.close'),
                onClick: () => setPanelVisible(false),
                onMouseEnter: () => setCloseHover(true),
                onMouseLeave: () => setCloseHover(false),
                style: {
                  width: '28px',
                  height: '28px',
                  flex: '0 0 auto',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: 0,
                  border: 'none',
                  borderRadius: 'var(--dsw-radius-sm)',
                  background: closeHover ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent',
                  color: 'var(--dsw-alias-label-primary)',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  fontSize: '16px',
                  lineHeight: '1',
                },
              },
              '×',
            ),
          ),
          h(
            'div',
            { style: BODY },
            h('h3', { style: { ...SECTION_TITLE, marginBottom: '10px' } }, t('status.heading')),
            h(ChannelBody, { t }),
          ),
          h('div', { style: FOOTER }, h('span', null, t('footer.hint')), h('span', null, t('panel.subtitle'))),
        ),
      )
    }

    /**
     * Keeps a render error inside the panel.
     *
     * Without this, an exception while rendering the panel takes down the whole
     * `settings.action` entry — the button disappears and there is no way back except
     * reloading the page. That is exactly what a bad `status.data` read did once. A
     * boundary cannot fix such a bug, but it keeps the door reachable.
     */
    let PanelBoundary = (props) => props.children
    if (typeof React.Component === 'function') {
      PanelBoundary = class PanelBoundary extends React.Component {
        constructor(props) {
          super(props)
          this.state = { error: null }
        }

        static getDerivedStateFromError(error) {
          return { error }
        }

        render() {
          if (this.state.error) {
            return h(
              'div',
              { style: CARD, role: 'alert' },
              h(
                'div',
                { style: { padding: '20px' } },
                h('h3', { style: SECTION_TITLE }, this.props.t('panel.crashed')),
                h(
                  'p',
                  { style: MUTED },
                  String((this.state.error && this.state.error.message) || this.state.error),
                ),
                h(Btn, {
                  label: this.props.t('panel.close'),
                  onClick: () => this.props.onClose(),
                }),
              ),
            )
          }
          return this.props.children
        }
      }
    }

    /** The single `settings.action` entry: the button, plus its panel while open. */
    function WebotEntry({ t }) {
      const visible = usePanelVisible()
      return h(
        React.Fragment,
        null,
        h(OpenButton, { t, active: visible }),
        visible
          ? h(PanelBoundary, { t, onClose: () => setPanelVisible(false) }, h(PanelView, { t }))
          : null,
      )
    }

    /* ------------------------------------------------------------------ *
     * Dictionaries
     * ------------------------------------------------------------------ */
    const ZH = {
      'action.label': 'weBot设置',
      'action.hint': '打开 weBot 设置（微信通道）',
      'panel.title': 'weBot 设置',
      'panel.subtitle': '微信 ↔ DeepSeek Harness',
      'panel.close': '关闭',
      'panel.crashed': '面板出错了',
      'status.heading': '连接状态',
      'status.loading': '正在读取状态…',
      'status.refresh': '刷新',
      'status.error': '读取状态失败：{reason}',
      'status.bound': '已绑定',
      'status.connected': '已连接',
      'status.boundNote': '未在监听',
      'status.pollingNote': '微信消息会送到这里',
      'status.unbound': '未绑定',
      'status.field.stateFile': '状态文件',
      'account.id': '机器人 ID',
      'account.user': '微信用户',
      'account.boundAt': '绑定时间',
      'account.polling': '长连接',
      'account.workspace': '会话目录',
      'account.sessions': '活动会话',
      'common.yes': '在线',
      'common.no': '离线',
      'bind.heading': '会话绑定',
      'bind.hint': '微信消息进这个 DSH 会话；在 DSH 里能看见它，也能接着在这边聊。',
      'bind.current': '当前会话',
      'bind.cwd': '会话目录',
      'bind.auto': '自动新建',
      'bind.change': '选择会话',
      'bind.close': '收起',
      'bind.loading': '正在读取会话…',
      'bind.error': '读取会话失败：{reason}',
      'bind.retry': '重试',
      'bind.empty': '没有可选会话',
      'bind.detach': '解除绑定（下条消息新建）',
      'bind.failed': '绑定失败',
      'bind.untitled': '未命名会话',
      'bind.running': '运行中',
      'bind.commands': '在微信里直接发这些，不会经过 agent：',
      'bind.usageHeading': '怎么用',
      'usage.list': '列出这台机器上的会话（带编号和短 id）',
      'usage.switchNum': '切到第 3 个 — 按你屏幕上看到的编号',
      'usage.switchId': '按短 id 切换 — 编号变了也不会切错',
      'usage.new': '开一个新会话',
      'usage.current': '看现在用的是哪个会话',
      'usage.cancel': '停掉正在跑的这一轮',
      'usage.help': '在微信里显示这份说明',
      'approval.mode': '权限请求在哪回答',
      'approval.phone': '手机上（这个通道接管）',
      'approval.desktop': '电脑上（通道不参与）',
      'approval.hint':
        'agent 要做有风险的操作前，会先停下来等你点头。选"手机上"，请求就发到微信，回 1 允许一次、2 拒绝、3 取消；选"电脑上"，它还是弹在电脑上，这个通道完全不碰。只能二选一：同一个请求只会被一边接住，两边同时开会让另一边留下一个关不掉的弹窗。',
      'approval.timeout': '等多久算放弃',
      'approval.timeoutUnit': '秒后当作拒绝（5–300）',
      'approval.timeoutHint':
        '超过这个时间没人回复，就当作你拒绝，agent 不会自己往下做。被拒绝不等于出错：它会说明没拿到许可，你可以再让它试一次。',
      'merge.label': '文件合并',
      'merge.unit': '秒内追加的文字会跟文件一起发',
      'merge.hint': '发图/文件后等这么多秒：期间你打字就并成一条发给 agent，没打就等到点再发。填 0 = 不等，立刻发。',
      'merge.maxMedia': '单次附件数',
      'merge.maxMediaUnit': '个（超出部分忽略）',
      'merge.maxMediaHint': '一条微信消息里带好几张图时，最多处理几个。多出来的不会下载，也不会进会话。',
      'reply.max.label': '单条消息上限',
      'reply.max.unit': '字（超过就切开分条发）',
      'reply.max.hint': '一条微信消息最多容纳多少字。超长回复会优先在换行和句号处断开，分成几条发出。',
      'list.max.label': '/list 行数',
      'list.max.unit': '行（超出不显示）',
      'list.max.hint': '在微信里发 /list 时最多列几行会话。手机上一屏看不完太长也没用。',
      'promptRefresh.label': '提示词重发',
      'promptRefresh.unit': '轮完整发一次',
      'done.enable': '启用',
      'group.approval': '权限',
      'group.media': '文件与附件',
      'group.reply': '消息与命令',
      'group.done': '任务完成提醒',
      'done.delay': '等待秒数',
      'done.delayHint':
        '任务结束后先盯这么久，再决定要不要提醒你。窗口内鼠标累计移动超过下面的阈值、或者一直在敲键盘，就认为你在电脑前，不发。',
      'done.travelLabel': '鼠标阈值',
      'done.travelUnit': 'px（累计移动超过它就算你在电脑前）',
      'done.travelHint':
        '判定"人在电脑前"需要鼠标累计移动多少像素。默认 120px 约等于 4 个光标的长度：桌子震动、手碰一下鼠标远达不到，所以不会取消提醒；你真的去动鼠标，一下就会超过。',
      'done.hint':
        '打开后：别的会话跑完，如果在"等待秒数"内鼠标没怎么动，就发一条"[系统提示] 工作区 · 会话 · DSH 已跑完"到微信。'
        + '只提醒别的会话（微信自己的会话不提醒，它本来就会回你）。'
        + '这条消息由通道直接发出，不经过 AI。'
        + '需要读 Windows 的鼠标位置，所以每次判定会起一个 PowerShell 进程，跑满整个窗口。',
      'promptRefresh.hint': '完整提示词不再每条都发；平时只带一句"必须调工具"的提醒。改提示词后会自动重发一次。',
      'persona.heading': '提示词',
      'persona.anchorLabel': '每轮都追发的提醒',
      'persona.anchorHint':
        '这条每轮都会追加，不按轮次省。它只干一件事：提醒 agent 必须调用 send_to_wechat，否则你收不到消息。可以改措辞，离开这个框就保存；清空等于关掉——关掉之后它忘调工具时不会有任何提示。',
      'scenario.label': '场景提示词',
      'scenario.hint':
        '一套"怎么说话、在什么场合"的完整说明。可以存多套，随时切换——比如"工作"和"闲聊"两套不同的语气。只有选中的那套会发给 agent。',
      'scenario.add': '点击添加场景提示词',
      'scenario.edit': '调整',
      'scenario.delete': '删除',
      'scenario.undo': '撤销删除',
      'scenario.pending': '（将删除）',
      'scenario.pendingHint': '关闭面板后才会真正删除；现在点「撤销删除」可以反悔。',
      'scenario.addTitle': '添加场景提示词',
      'scenario.editTitle': '调整场景提示词',
      'scenario.nameLabel': '名称',
      'scenario.contentLabel': '内容',
      'scenario.save': '保存',
      'scenario.cancel': '取消',
      'prompt.enable': '发送场合提示词',
      'prompt.enableHint':
        '关掉后不再追加那段长提示词，只发每轮提醒。适合你只想让它干活、不想让它演人格的时候。',
      'prompt.enableState': '下面的场景提示词与重发轮次都受这个开关控制',
      'persona.hint': '追加在消息末尾；改完离开输入框就生效，不用重启。',
      'login.phase.idle': '准备中',
      'login.phase.starting': '正在获取二维码',
      'login.phase.waiting': '等待扫码',
      'login.phase.scanned': '已扫码，确认中',
      'login.phase.need_verifycode': '需要配对码',
      'login.phase.refreshing': '正在刷新二维码',
      'login.phase.confirmed': '已完成',
      'login.phase.failed': '失败',
      'login.phase.cancelled': '已取消',
      'login.phase.already-bound': '已经绑定过',
      'login.preparing': '正在准备扫码…',
      'login.scanTitle': '用手机微信扫描',
      'login.scanHint': '扫描后按手机上的提示操作',
      'login.qrAlt': '微信登录二维码',
      'login.refreshed': '已刷新 {count} 次',
      'login.linkHint': '二维码显示不出来时，可以',
      'login.openLink': '在新标签打开扫码链接',
      'login.codePlaceholder': '配对码',
      'login.submitCode': '提交',
      'login.rebind': '重新绑定',
      'login.cancel': '取消重绑',
      'login.retry': '重试',
      'footer.hint': '按 Esc 关闭',
      'hint.show': '说明',
    }

    const EN = {
      'action.label': 'weBot Settings',
      'action.hint': 'Open weBot settings (WeChat channel)',
      'panel.title': 'weBot Settings',
      'panel.subtitle': 'WeChat ↔ DeepSeek Harness',
      'panel.close': 'Close',
      'panel.crashed': 'The panel failed to render',
      'status.heading': 'Connection status',
      'status.loading': 'Reading status…',
      'status.refresh': 'Refresh',
      'status.error': 'Could not read status: {reason}',
      'status.bound': 'Bound',
      'status.connected': 'Connected',
      'status.boundNote': 'Not listening',
      'status.pollingNote': 'WeChat messages land here',
      'status.unbound': 'Not bound',
      'status.field.stateFile': 'State file',
      'account.id': 'Bot ID',
      'account.user': 'WeChat user',
      'account.boundAt': 'Bound at',
      'account.polling': 'Long poll',
      'account.workspace': 'Session directory',
      'account.sessions': 'Live sessions',
      'common.yes': 'live',
      'common.no': 'off',
      'bind.heading': 'Session binding',
      'bind.hint':
        'WeChat messages enter this DSH session, so it shows up in DSH and you can continue the conversation there.',
      'bind.current': 'Bound session',
      'bind.cwd': 'Directory',
      'bind.auto': 'Create one automatically',
      'bind.change': 'Choose a session',
      'bind.close': 'Close list',
      'bind.loading': 'Reading sessions…',
      'bind.error': 'Could not read sessions: {reason}',
      'bind.retry': 'Retry',
      'bind.empty': 'No sessions available',
      'bind.detach': 'Unbind (a new session starts on the next message)',
      'bind.failed': 'Could not bind',
      'bind.untitled': 'Untitled session',
      'bind.running': 'running',
      'bind.commands': 'Send these in WeChat — they never reach the agent:',
      'bind.usageHeading': 'How to use it',
      'usage.list': 'List this machine’s sessions, with numbers and short ids',
      'usage.switchNum': 'Switch to number 3 — counted as shown on your screen',
      'usage.switchId': 'Switch by short id — unaffected by renumbering',
      'usage.new': 'Start a new session',
      'usage.current': 'Show which session you are in',
      'usage.cancel': 'Stop the turn that is running',
      'usage.help': 'Show this list in WeChat',
      'approval.mode': 'Where to answer permission requests',
      'approval.phone': 'On the phone (this channel takes them)',
      'approval.desktop': 'On the desktop (channel stays out)',
      'approval.hint':
        'Before a risky action the agent stops and waits for your go-ahead. On "phone", the request is sent to WeChat — reply 1 allow once, 2 reject, 3 cancel. On "desktop", it still pops up on the computer and this channel does not touch it. Pick one: a request has exactly one owner, and starting both leaves a dialog on the other side that nothing can close.',
      'approval.timeout': 'Give up after',
      'approval.timeoutUnit': 'seconds without a reply (5–300)',
      'approval.timeoutHint':
        'No answer within this time counts as a reject, so the agent never proceeds on its own. A reject is not a failure: the agent will say it did not get permission, and you can let it try again.',
      'merge.label': 'File merge',
      'merge.unit': 'seconds to wait for your follow-up text',
      'merge.hint':
        'After a file: text you type within this window is sent together with it; silence sends the file on its own. 0 = never wait.',
      'merge.maxMedia': 'Attachments per message',
      'merge.maxMediaUnit': 'files (the rest are ignored)',
      'merge.maxMediaHint':
        'When one WeChat message carries several pictures, how many are handled. The rest are neither downloaded nor sent on.',
      'reply.max.label': 'Longest message',
      'reply.max.unit': 'characters (split above this)',
      'reply.max.hint':
        'How much text one WeChat message may hold. A longer answer is cut at a newline or full stop and sent as several messages.',
      'list.max.label': '/list rows',
      'list.max.unit': 'rows (the rest are hidden)',
      'list.max.hint': 'How many sessions `/list` prints. A phone screen cannot hold more than that anyway.',
      'promptRefresh.label': 'Prompt refresh',
      'promptRefresh.unit': 'turns between full resends',
      'done.enable': 'Enabled',
      'group.approval': 'Permissions',
      'group.media': 'Files and attachments',
      'group.reply': 'Messages and commands',
      'group.done': 'Task finished',
      'done.delay': 'Wait seconds',
      'done.delayHint':
        'How long to watch the desk before deciding whether to notify. More pointer travel than the threshold below, or steady typing, during that window means you are there and nothing is sent.',
      'done.travelLabel': 'Pointer threshold',
      'done.travelUnit': 'px (more travel than this means you are there)',
      'done.travelHint':
        'How far the pointer must travel in total to count as "somebody is here". The default 120 px is about four pointer widths: a bumped desk or a hand brushing the mouse is nowhere near it, so the reminder survives; reaching for the mouse clears it immediately.',
      'done.hint':
        'When on: if another session finishes and the pointer stays under the threshold for the wait window, one line goes to WeChat - "[系统提示] workspace · session · DSH 已跑完". '
        + 'Only sessions other than the WeChat one (that one already answers you). '
        + 'The message is sent by the channel, without the AI. '
        + 'Reading the pointer needs one PowerShell process per decision, alive for the whole window.',
      'promptRefresh.hint':
        'The full prompt is no longer sent every message; a one-line tool reminder goes out each turn. Editing the prompt triggers a resend.',
      'persona.heading': 'Prompt',
      'persona.anchorLabel': 'Reminder sent every turn',
      'persona.anchorHint':
        'This one is appended on every turn, never skipped. It does exactly one job: remind the agent that it must call send_to_wechat or you receive nothing. Change the wording freely - leaving the box saves it. Clearing it turns it off, and then a forgotten tool call is silent.',
      'scenario.label': 'Scenario prompt',
      'scenario.hint':
        'A complete "where we are and how to talk" note. Keep as many as you like and switch between them - a work voice and a chat voice, for example. Only the selected one is sent.',
      'scenario.add': 'Add a scenario prompt',
      'scenario.edit': 'Edit',
      'scenario.delete': 'Delete',
      'scenario.undo': 'Undo delete',
      'scenario.pending': '(to be deleted)',
      'scenario.pendingHint': 'It is only removed when the panel closes; until then 撤销删除 brings it back.',
      'scenario.addTitle': 'Add a scenario prompt',
      'scenario.editTitle': 'Edit scenario prompt',
      'scenario.nameLabel': 'Name',
      'scenario.contentLabel': 'Content',
      'scenario.save': 'Save',
      'scenario.cancel': 'Cancel',
      'prompt.enable': 'Send the scenario prompt',
      'prompt.enableHint':
        'Off means the long note is never appended, only the every-turn reminder. Useful when you want the work done without any persona.',
      'prompt.enableState': 'This switch governs the scenario prompt below and its resend interval',
      'persona.hint': 'Appended after the message; leaving the box saves it, no restart needed.',
      'login.phase.idle': 'Preparing',
      'login.phase.starting': 'Fetching the QR code',
      'login.phase.waiting': 'Waiting for a scan',
      'login.phase.scanned': 'Scanned, confirming',
      'login.phase.need_verifycode': 'Pairing code needed',
      'login.phase.refreshing': 'Refreshing the QR code',
      'login.phase.confirmed': 'Done',
      'login.phase.failed': 'Failed',
      'login.phase.cancelled': 'Cancelled',
      'login.phase.already-bound': 'Already bound',
      'login.preparing': 'Preparing the handshake…',
      'login.scanTitle': 'Scan with WeChat',
      'login.scanHint': 'Then follow the prompt on your phone',
      'login.qrAlt': 'WeChat login QR code',
      'login.refreshed': 'Refreshed {count} time(s)',
      'login.linkHint': 'If the QR code will not render,',
      'login.openLink': 'open the scan link in a new tab',
      'login.codePlaceholder': 'Pairing code',
      'login.submitCode': 'Submit',
      'login.rebind': 'Bind another account',
      'login.cancel': 'Cancel rebinding',
      'login.retry': 'Retry',
      'footer.hint': 'Press Esc to close',
      'hint.show': 'Show explanation',
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const t = ctx.locale.bind(NS)

        ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'dsh-webot: dictionaries')

        // One stable component identity: a per-render wrapper would remount the
        // slot entry on every owner render.
        const ActionButton = (props) => h(WebotEntry, { ...(props || {}), t })

        ctx.slots.inject('settings.action', () =>
          ctx.slots.register(
            {
              name: 'settings.action',
              id: 'webot-open',
              order: 1,
              label: () => t('action.label'),
              locale: NS,
            },
            ActionButton,
          ),
        )
      },
    }
  },
})
