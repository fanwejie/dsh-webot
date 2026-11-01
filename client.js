/**
 * dsh-webot — Client half (M1 skeleton).
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
 * there is *always* painted behind the settings dialog: the reported symptom was
 * a panel that only appeared after closing Settings.
 *
 * Rendering the panel from the header action's own subtree puts it inside the
 * dialog's `z-index:1000` stacking context, so `position: fixed` reaches the
 * viewport (no transformed ancestor between) and paints above the dialog's mask
 * and panel. No portal, no `document.body` append, no second application root.
 *
 * ## Styling
 *
 * The button copies the host's `Button variant="outline" size="sm"` recipe from
 * `dsh-client-ui-primitives` byte for byte (28px, 12/18, `.5px` `border-l3`,
 * `radius-sm`, hover `interactive-bg-hover`) because the primitive itself must
 * not be imported. The panel copies the settings dialog's own geometry so it
 * reads as a sibling surface rather than a bolted-on window.
 */
window.__ModuleLoader__.load({
  id: 'dsh-webot',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const NS = 'dsh-webot'
    const STATUS_URL = '/api/webot/status'
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
     * Styles. Theme tokens only; literal colours appear in artwork only.
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
      border: '0.5px solid var(--dsw-alias-border-l3)',
      borderRadius: 'var(--dsw-radius-sm)',
      background: 'transparent',
      color: 'var(--dsw-alias-label-primary)',
      cursor: 'pointer',
      fontFamily: 'inherit',
      fontSize: '12px',
      lineHeight: '18px',
      whiteSpace: 'nowrap',
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

    const FIELD_ROW = {
      display: 'flex',
      alignItems: 'baseline',
      gap: '12px',
      padding: '6px 0',
      fontSize: '12px',
      lineHeight: '18px',
    }

    const FIELD_NAME = { flex: '0 0 96px', color: 'var(--dsw-alias-label-secondary)' }

    const FIELD_VALUE = {
      flex: '1 1 auto',
      minWidth: '0',
      color: 'var(--dsw-alias-label-primary)',
      fontVariantNumeric: 'tabular-nums',
      wordBreak: 'break-all',
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
     * Status
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

    function StatusBlock({ t }) {
      const [tick, setTick] = React.useState(0)
      const [state, setState] = React.useState({ phase: 'loading' })

      React.useEffect(() => {
        let cancelled = false
        setState({ phase: 'loading' })
        fetch(STATUS_URL, { credentials: 'same-origin' })
          .then((response) =>
            response.ok ? response.json() : Promise.reject(new Error('HTTP ' + response.status)),
          )
          .then((json) => {
            if (!cancelled) setState({ phase: 'ready', json })
          })
          .catch((error) => {
            if (!cancelled) setState({ phase: 'error', reason: (error && error.message) || String(error) })
          })
        return () => {
          cancelled = true
        }
      }, [tick])

      const json = state.phase === 'ready' ? state.json : null
      const connected = !!(json && json.connected)
      const phase = json && json.phase ? String(json.phase) : 'idle'
      const phaseText = connected ? translate(t, 'status.phase.' + phase) || phase : t('status.phase.idle')

      const dotColor = connected
        ? 'var(--dsw-alias-state-success-primary)'
        : state.phase === 'error'
          ? 'var(--dsw-alias-state-error-primary)'
          : 'var(--dsw-alias-state-idle-primary)'

      const summary = connected
        ? t('status.connected')
        : state.phase === 'loading'
          ? t('status.loading')
          : t('status.disconnected')

      const [refreshHover, setRefreshHover] = React.useState(false)

      return h(
        'section',
        null,
        h(
          'div',
          {
            style: {
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '12px',
              marginBottom: '12px',
            },
          },
          h('h3', { style: { margin: 0, fontSize: '13px', lineHeight: '20px', fontWeight: 600 } }, t('status.heading')),
          h(
            'button',
            {
              type: 'button',
              onClick: () => setTick((n) => n + 1),
              onMouseEnter: () => setRefreshHover(true),
              onMouseLeave: () => setRefreshHover(false),
              style: refreshHover
                ? { ...GHOST_BUTTON, background: 'var(--dsw-alias-interactive-bg-hover)' }
                : GHOST_BUTTON,
            },
            t('status.refresh'),
          ),
        ),
        h(
          'div',
          {
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              padding: '12px 14px',
              borderRadius: 'var(--dsw-radius-md)',
              background: 'var(--dsw-alias-bg-layer-1)',
              border: '0.5px solid var(--dsw-alias-border-l1)',
            },
          },
          h('span', {
            'aria-hidden': 'true',
            style: { width: '8px', height: '8px', borderRadius: '50%', background: dotColor, flex: '0 0 auto' },
          }),
          h('span', { style: { fontSize: '13px', lineHeight: '20px', fontWeight: 600 } }, summary),
          h(
            'span',
            { style: { fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)' } },
            state.phase === 'ready' ? phaseText : '',
          ),
        ),
        state.phase === 'error'
          ? h(
              'p',
              {
                style: {
                  margin: '10px 0 0',
                  fontSize: '12px',
                  lineHeight: '18px',
                  color: 'var(--dsw-alias-state-error-primary)',
                },
              },
              t('status.error', { reason: state.reason }),
            )
          : null,
        h(
          'div',
          { style: { marginTop: '10px' } },
          field(t('status.field.endpoint'), STATUS_URL),
          json ? field(t('status.field.version'), String(json.version || '—')) : null,
          json ? field(t('status.field.milestone'), String(json.milestone || '—')) : null,
          json && json.checkedAt ? field(t('status.field.checkedAt'), String(json.checkedAt)) : null,
        ),
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
              h(
                'h2',
                { id: TITLE_ID, style: { margin: 0, fontSize: '16px', lineHeight: '24px', fontWeight: 500 } },
                t('panel.title'),
              ),
              h(
                'p',
                {
                  style: {
                    margin: '2px 0 0',
                    fontSize: '12px',
                    lineHeight: '18px',
                    color: 'var(--dsw-alias-label-secondary)',
                  },
                },
                t('panel.subtitle'),
              ),
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
            h(StatusBlock, { t }),
            h(
              'section',
              {
                style: {
                  marginTop: '20px',
                  padding: '12px 14px',
                  borderRadius: 'var(--dsw-radius-md)',
                  background: 'var(--dsw-alias-bg-layer-1)',
                  borderLeft: '3px solid var(--dsw-alias-brand-primary)',
                },
              },
              h(
                'h3',
                { style: { margin: 0, fontSize: '13px', lineHeight: '20px', fontWeight: 600 } },
                t('next.heading'),
              ),
              h(
                'p',
                {
                  style: {
                    margin: '4px 0 0',
                    fontSize: '12px',
                    lineHeight: '18px',
                    color: 'var(--dsw-alias-label-secondary)',
                  },
                },
                t('next.body'),
              ),
            ),
          ),
          h('div', { style: FOOTER }, h('span', null, t('footer.hint')), h('span', null, t('panel.subtitle'))),
        ),
      )
    }

    /** The single `settings.action` entry: the button, plus its panel while open. */
    function WebotEntry({ t }) {
      const visible = usePanelVisible()
      return h(
        React.Fragment,
        null,
        h(OpenButton, { t, active: visible }),
        visible ? h(PanelView, { t }) : null,
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
      'status.heading': '连接状态',
      'status.loading': '正在读取状态…',
      'status.refresh': '刷新',
      'status.connected': '已连接',
      'status.disconnected': '未连接',
      'status.phase.idle': '尚未绑定微信',
      'status.phase.connected': '长连接已建立',
      'status.phase.reconnecting': '正在重连',
      'status.phase.failed': '连接失败',
      'status.error': '读取状态失败：{reason}',
      'status.field.endpoint': '状态接口',
      'status.field.version': '版本',
      'status.field.milestone': '里程碑',
      'status.field.checkedAt': '读取时间',
      'next.heading': '这一步做到了什么',
      'next.body':
        'M1 只有三样东西：设置右上角的按钮、它打开的这个面板、以及面板背后真的在跑的 status 接口。扫码绑定在 M2 接入，之后才是消息收发。',
      'footer.hint': '按 Esc 关闭',
    }

    const EN = {
      'action.label': 'weBot Settings',
      'action.hint': 'Open weBot settings (WeChat channel)',
      'panel.title': 'weBot Settings',
      'panel.subtitle': 'WeChat ↔ DeepSeek Harness',
      'panel.close': 'Close',
      'status.heading': 'Connection status',
      'status.loading': 'Reading status…',
      'status.refresh': 'Refresh',
      'status.connected': 'Connected',
      'status.disconnected': 'Not connected',
      'status.phase.idle': 'No WeChat account bound yet',
      'status.phase.connected': 'Long poll is live',
      'status.phase.reconnecting': 'Reconnecting',
      'status.phase.failed': 'Connection failed',
      'status.error': 'Could not read status: {reason}',
      'status.field.endpoint': 'Endpoint',
      'status.field.version': 'Version',
      'status.field.milestone': 'Milestone',
      'status.field.checkedAt': 'Read at',
      'next.heading': 'What this milestone proves',
      'next.body':
        'M1 is three things only: the button in the settings header, the panel it opens, and the status endpoint really running behind it. QR binding lands in M2; message delivery after that.',
      'footer.hint': 'Press Esc to close',
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
