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

    const FIELD_NAME = { flex: '0 0 96px', color: 'var(--dsw-alias-label-secondary)' }

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

    const TEXT_INPUT = {
      boxSizing: 'border-box',
      height: '28px',
      width: '140px',
      padding: '0 8px',
      borderRadius: 'var(--dsw-radius-sm)',
      border: '0.5px solid var(--dsw-alias-border-l3)',
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
      border: '0.5px solid var(--dsw-alias-border-l3)',
      background: 'var(--dsw-alias-bg-base)',
      color: 'var(--dsw-alias-label-primary)',
      fontFamily: 'inherit',
      fontSize: '12px',
      lineHeight: '18px',
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
        setStatus({ phase: 'loading' })
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
      // `null` means "not editing": the box shows the saved value. While editing
      // it holds exactly what was typed, including the empty string — a controlled
      // input that falls back to the saved value whenever the draft is empty can
      // never be cleared, which is why editing 30 down to 5 needed a workaround.
      const [timeoutDraft, setTimeoutDraft] = React.useState(null)

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

      /**
       * Commit the timeout draft. Called on Enter and on blur only.
       *
       * The draft is `null` when the box is not being edited, which makes it show
       * the saved value; while editing it holds exactly what was typed, including
       * `''`. Resolution happens only here:
       *
       *   empty / not a number -> revert to the saved value
       *   in range             -> submit
       *   out of range         -> clamp into 5..300 and submit the clamped value
       */
      function commitTimeout() {
        if (timeoutDraft === null) return
        const raw = String(timeoutDraft).trim()

        if (raw === '') {
          setTimeoutDraft(null)
          return
        }
        const seconds = Number(raw)
        if (!Number.isFinite(seconds)) {
          setTimeoutDraft(null)
          return
        }

        const clamped = Math.min(300, Math.max(5, Math.round(seconds)))
        // Show the corrected number immediately, then persist it.
        setTimeoutDraft(String(clamped))
        void setApprovalTimeout(clamped)
      }

      function setApprovalTimeout(seconds) {
        setBindError('')
        post(SETTINGS_URL, { approvalTimeoutSec: seconds })
          .then((body) => {
            if (!body || body.ok !== true) {
              setBindError((body && body.error) || t('bind.failed'))
              setTimeoutDraft(null)
              return
            }
            refreshStatus()
            setTimeoutDraft(null)
          })
          .catch((error) => {
            setBindError((error && error.message) || String(error))
            setTimeoutDraft(null)
          })
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
            { style: { ...PANEL_CARD, display: 'flex', alignItems: 'center', gap: '8px' } },
            h(StatusDot, {
              tone: status.data.connected
                ? 'var(--dsw-alias-state-success-primary)'
                : 'var(--dsw-alias-state-warn-primary)',
            }),
            h('span', { style: { fontSize: '13px', lineHeight: '20px', fontWeight: 600 } },
              status.data.connected ? t('status.connected') : t('status.bound')),
            h('span', { style: { fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)' } },
              status.data.connected ? t('status.pollingNote') : t('status.boundNote')),
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
            'div',
            { style: { ...FIELD_ROW, alignItems: 'center', marginTop: '10px' } },
            h('span', { style: FIELD_NAME }, t('approval.mode')),
            h(
              'select',
              {
                value: status.data.approvalMode || 'phone',
                onChange: (event) => setApprovalMode(event.target.value),
                'aria-label': t('approval.mode'),
                style: SELECT,
              },
              h('option', { value: 'phone' }, t('approval.phone')),
              h('option', { value: 'desktop' }, t('approval.desktop')),
            ),
          ),
          h(
            'div',
            { style: { ...FIELD_ROW, alignItems: 'center' } },
            h('span', { style: FIELD_NAME }, t('approval.timeout')),
            h('input', {
              type: 'number',
              min: 5,
              max: 300,
              value:
                timeoutDraft === null
                  ? String(status.data.approvalTimeoutSec || 30)
                  : timeoutDraft,
              onChange: (event) => setTimeoutDraft(event.target.value),
              onBlur: commitTimeout,
              onKeyDown: (event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  event.currentTarget.blur()
                }
              },
              'aria-label': t('approval.timeout'),
              style: { ...TEXT_INPUT, width: '80px', letterSpacing: 'normal' },
            }),
            h('span', { style: { ...MUTED, margin: 0 } }, t('approval.timeoutUnit')),
          ),
          h('p', { style: MUTED }, t('approval.hint')),
          h('p', { style: MUTED }, t('bind.commands')),
          h('div', { style: { marginTop: '12px', display: 'flex', gap: '8px' } },
            h(Btn, {
              label: t('login.rebind'),
              onClick: () => {
                setForce(true)
                restart()
              },
            }),
            h(Btn, { label: t('status.refresh'), onClick: refreshStatus }),
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
              h('h3', { style: SECTION_TITLE }, t('next.heading')),
              h('p', { style: MUTED }, t('next.body')),
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
      'bind.commands': '在微信里发 /help 可以用 /list、/switch、/new、/current、/cancel 管理会话。',
      'approval.mode': '权限弹窗',
      'approval.phone': '只在手机（通道接管）',
      'approval.desktop': '只在桌面（通道不介入）',
      'approval.hint':
        '两者不能同时生效：请求只有一个归属，如果两边都开，输的那一边会在界面上留下一个关不掉的弹窗——宿主没有撤回接口。',
      'approval.timeout': '超时',
      'approval.timeoutUnit': '秒（5–300）内没回复就自动拒绝',
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
      'next.heading': '这一步做到了什么',
      'next.body':
        'M6 把权限请求推到了手机上：agent 要执行敏感操作时会先把「工具 + 原因」发到微信，回 1 允许一次 / 2 拒绝 / 3 取消。只接管这个通道自己的会话，桌面上你正在用的会话仍然在桌面弹窗。',
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
      'bind.commands':
        'Send /help in WeChat to manage sessions with /list, /switch, /new, /current and /cancel.',
      'approval.mode': 'Permission prompts',
      'approval.phone': 'Phone only (channel claims)',
      'approval.desktop': 'Desktop only (channel stays out)',
      'approval.hint':
        'These cannot both be on. A request has exactly one owner, and if both sides are started the loser leaves a dialog on screen that nothing can close — the host has no withdraw call.',
      'approval.timeout': 'Timeout',
      'approval.timeoutUnit': 'seconds (5–300) before an automatic reject',
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
      'next.heading': 'What this milestone proves',
      'next.body':
        'M6 delivers permission prompts to the phone: when the agent wants to run something sensitive it sends the tool and the reason to WeChat, and you answer 1 allow once / 2 reject / 3 cancel. It only claims prompts for sessions this channel owns — a session you are driving at the desk keeps its desktop prompt.',
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
