/**
 * dsh-agent-relay — browser half (optional).
 *
 * Adds a relay glyph to the sidebar footer action row. Clicking it opens a
 * small status panel: broker URL, agent name, online peers, inbox count and
 * the last poll error. Read-only — no message bodies are shown.
 *
 * Cordis plugin protocol (rc.6): the factory must RETURN the plugin object
 * (`exports.apply` + `exports.inject`); a missing return makes the loader see
 * `undefined` and fail boot with "invalid plugin … received undefined".
 */
window.__ModuleLoader__.load({
  id: 'dsh-agent-relay',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports
    var react = require('react')

    var STATUS_API = '/api/dsh-agent-relay/status'
    var POLL_MS = 10000

    var CSS = [
      '.dsh-relay-trigger{width:36px;height:36px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;border-radius:18px;flex:none;justify-content:center;align-items:center;padding:0 6px;gap:6px;font-family:inherit;font-size:13px;transition:background-color .12s,color .12s;display:inline-flex}',
      '.dsh-relay-trigger[data-wide="row"]{width:auto;height:32px;border-radius:8px;padding:0 10px}',
      '.dsh-relay-trigger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.dsh-relay-trigger[data-open="true"]{background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary)}',
      '.dsh-relay-panel{position:fixed;z-index:1000;width:300px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:10px;box-shadow:var(--dsw-shadow-lv2);padding:12px;display:flex;flex-direction:column;gap:8px;font-size:13px;color:var(--dsw-alias-label-primary)}',
      '.dsh-relay-panel h3{margin:0;font-size:14px;font-weight:600}',
      '.dsh-relay-row{display:flex;justify-content:space-between;gap:8px}',
      '.dsh-relay-row .k{color:var(--dsw-alias-label-secondary)}',
      '.dsh-relay-peer{display:flex;justify-content:space-between;padding:2px 0}',
      '.dsh-relay-dot{display:inline-block;width:8px;height:8px;border-radius:4px;margin-right:6px}',
      '.dsh-relay-err{color:var(--dsw-alias-state-error-primary);white-space:pre-wrap;word-break:break-all}'
    ].join('\n')

    function RelayGlyph(props) {
      return react.createElement('svg', {
        width: props.size || 16, height: props.size || 16, viewBox: '0 0 16 16',
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.3,
        strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true'
      }, react.createElement('path', { d: 'M2.5 8h6.5' }),
        react.createElement('circle', { cx: '11.5', cy: '8', r: '2' }),
        react.createElement('path', { d: 'M2.5 4h3' }), react.createElement('path', { d: 'M2.5 12h3' }))
    }

    function RelayPanel(props) {
      var pair = react.useState(null)
      var status = pair[0]
      var setStatus = pair[1]
      react.useEffect(function () {
        var cancelled = false
        var timer = null
        var tick = function () {
          window.fetch(STATUS_API, { cache: 'no-store' })
            .then(function (r) { return r.json() })
            .then(function (b) { if (!cancelled) setStatus(b) })
            .catch(function () { /* broker down; keep last state */ })
          timer = window.setTimeout(tick, POLL_MS)
        }
        tick()
        return function () { cancelled = true; if (timer) window.clearTimeout(timer) }
      }, [])
      var peers = (status && status.peers) || []
      return react.createElement('div', { className: 'dsh-relay-panel' },
        react.createElement('h3', null, 'Agent Relay'),
        react.createElement('div', { className: 'dsh-relay-row' },
          react.createElement('span', { className: 'k' }, 'Broker'),
          react.createElement('span', null, status ? status.brokerUrl : '…')),
        react.createElement('div', { className: 'dsh-relay-row' },
          react.createElement('span', { className: 'k' }, 'Agent'),
          react.createElement('span', null, status ? status.agent : '…')),
        react.createElement('div', { className: 'dsh-relay-row' },
          react.createElement('span', { className: 'k' }, 'Inbox'),
          react.createElement('span', null, status ? String(status.inboxCount) : '…')),
        react.createElement('div', null,
          peers.map(function (p) {
            return react.createElement('div', { className: 'dsh-relay-peer', key: p.agent },
              react.createElement('span', null,
                react.createElement('span', { className: 'dsh-relay-dot', style: { background: p.online ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-label-tertiary)' } }),
                p.agent),
              react.createElement('span', null, p.online ? 'online' : 'offline'))
          })),
        status && status.lastError
          ? react.createElement('div', { className: 'dsh-relay-err' }, status.lastError)
          : null)
    }

    function RelayButton(props) {
      var wide = props.wide === true
      var pair = react.useState(false)
      var open = pair[0]
      var setOpen = pair[1]
      var ref = react.useRef(null)
      react.useEffect(function () {
        if (!open) return undefined
        var onDown = function (e) {
          if (ref.current && !ref.current.contains(e.target)) setOpen(false)
        }
        document.addEventListener('mousedown', onDown)
        return function () { document.removeEventListener('mousedown', onDown) }
      }, [open])
      return react.createElement(react.Fragment, null,
        react.createElement('button', {
          ref: ref, className: 'dsh-relay-trigger', 'data-wide': wide ? 'row' : 'rail',
          'data-open': open ? 'true' : 'false', title: 'Agent Relay status',
          onClick: function () { setOpen(!open) }
        }, react.createElement(RelayGlyph, { size: wide ? 14 : 16 })),
        open ? react.createElement(RelayPanel, null) : null)
    }

    var inject = ['slots']

    function apply(ctx) {
      var style = document.createElement('style')
      style.textContent = CSS
      document.head.appendChild(style)

      ctx.slots.inject('sidebar.footer.action', function () {
        return ctx.slots.register({
          name: 'sidebar.footer.action',
          id: 'dsh-agent-relay',
          inject: function () { return {} }
        }, RelayButton)
      })
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  }
})
