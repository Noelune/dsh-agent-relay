/**
 * dsh-agent-relay browser half: compact, read-only footer status panel.
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
      '.dsh-relay-trigger{width:36px;height:36px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:0;border-radius:18px;flex:none;justify-content:center;align-items:center;padding:0 6px;display:inline-flex;transition:background-color .12s,color .12s}',
      '.dsh-relay-trigger[data-wide="row"]{width:auto;height:32px;border-radius:8px;padding:0 10px}',
      '.dsh-relay-trigger:hover,.dsh-relay-trigger:focus-visible{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);outline:0}',
      '.dsh-relay-trigger[data-open="true"]{background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary)}',
      '.dsh-relay-panel{position:fixed;z-index:1000;width:320px;left:8px;bottom:60px;max-height:calc(100dvh - 72px);overflow-y:auto;overscroll-behavior:contain;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;box-shadow:var(--dsw-shadow-lv2);padding:12px;display:flex;flex-direction:column;gap:12px;font-size:12px;color:var(--dsw-alias-label-primary)}',
      '@media(max-width:640px){.dsh-relay-panel{left:8px;right:8px;width:auto;bottom:64px;max-height:calc(100dvh - 80px)}}',
      '.dsh-relay-heading{display:flex;align-items:center;justify-content:space-between;gap:8px}.dsh-relay-heading h3{margin:0;font-size:14px;font-weight:600}',
      '.dsh-relay-section{display:flex;flex-direction:column;gap:5px}.dsh-relay-sectionTitle{color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:600}.dsh-relay-row{display:flex;align-items:center;justify-content:space-between;gap:8px;min-width:0}.dsh-relay-name,.dsh-relay-message{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dsh-relay-muted{color:var(--dsw-alias-label-secondary)}.dsh-relay-dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:5px;background:var(--dsw-alias-label-tertiary)}.dsh-relay-dot[data-online="true"]{background:var(--dsw-alias-state-success-primary)}.dsh-relay-bad{color:var(--dsw-alias-state-error-primary)}.dsh-relay-warn{color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-label-secondary)}.dsh-relay-error{padding:7px 8px;border-radius:6px;background:var(--dsw-alias-state-error-background);color:var(--dsw-alias-state-error-primary);word-break:break-word}.dsh-relay-queues{display:grid;grid-template-columns:minmax(0,1fr) repeat(4,auto);gap:4px 8px;align-items:center}.dsh-relay-empty{color:var(--dsw-alias-label-tertiary)}',
    ].join('\n')

    function RelayGlyph(props) {
      return react.createElement('svg', { width: props.size || 16, height: props.size || 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.35, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
        react.createElement('path', { d: 'M2.5 5h6.25m0 0-2-2m2 2-2 2M13.5 11H7.25m0 0 2-2m-2 2 2 2' }))
    }

    function timeText(value) {
      var date = new Date(String(value || ''))
      return Number.isNaN(date.getTime()) ? '未知时间' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    }

    function BrokerSection(props) {
      var data = props.data
      var broker = data && data.broker
      return react.createElement('div', { className: 'dsh-relay-section' },
        react.createElement('div', { className: 'dsh-relay-sectionTitle' }, 'Broker'),
        react.createElement('div', { className: 'dsh-relay-row' }, react.createElement('span', { className: 'dsh-relay-muted' }, broker && broker.connected ? '已连接' : '不可达'), react.createElement('span', null, broker && broker.protocolVersion ? 'v' + broker.protocolVersion : '—')),
        react.createElement('div', { className: 'dsh-relay-row' }, react.createElement('span', { className: 'dsh-relay-muted' }, '刷新'), react.createElement('span', null, data ? timeText(data.refreshedAt) : '加载中…')))
    }

    function PeersSection(props) {
      var peers = props.peers || []
      return react.createElement('div', { className: 'dsh-relay-section' },
        react.createElement('div', { className: 'dsh-relay-sectionTitle' }, '在线 Agent'),
        peers.length ? peers.map(function (peer) {
          return react.createElement('div', { className: 'dsh-relay-row', key: peer.agent }, react.createElement('span', { className: 'dsh-relay-name' }, react.createElement('span', { className: 'dsh-relay-dot', 'data-online': peer.online ? 'true' : 'false' }), peer.agent), react.createElement('span', { className: 'dsh-relay-muted' }, peer.online ? '在线' : '离线'))
        }) : react.createElement('span', { className: 'dsh-relay-empty' }, '暂无 Agent 状态'))
    }

    function QueuesSection(props) {
      var peers = props.peers || []
      return react.createElement('div', { className: 'dsh-relay-section' },
        react.createElement('div', { className: 'dsh-relay-sectionTitle' }, '队列负载'),
        peers.length ? react.createElement('div', { className: 'dsh-relay-queues' }, peers.map(function (peer) {
          var hasIssue = Number(peer.failed || 0) + Number(peer.expired || 0) > 0
          return react.createElement(react.Fragment, { key: peer.agent + '-queue' }, react.createElement('span', { className: 'dsh-relay-name' }, peer.agent), react.createElement('span', null, 'Q ' + Number(peer.queued || 0)), react.createElement('span', null, 'L ' + Number(peer.leased || 0)), react.createElement('span', { className: Number(peer.failed || 0) ? 'dsh-relay-bad' : '' }, 'F ' + Number(peer.failed || 0)), react.createElement('span', { className: hasIssue ? 'dsh-relay-warn' : '' }, 'E ' + Number(peer.expired || 0)))
        })) : react.createElement('span', { className: 'dsh-relay-empty' }, '暂无队列数据'))
    }

    function ErrorSection(props) {
      var value = props.refreshError || props.lastError
      return react.createElement('div', { className: 'dsh-relay-section' }, react.createElement('div', { className: 'dsh-relay-sectionTitle' }, '最近错误'), value ? react.createElement('div', { className: 'dsh-relay-error' }, props.refreshError ? '刷新失败：' + value : value) : react.createElement('span', { className: 'dsh-relay-empty' }, '无错误'))
    }

    function MessagesSection(props) {
      var messages = props.messages || []
      return react.createElement('div', { className: 'dsh-relay-section' },
        react.createElement('div', { className: 'dsh-relay-sectionTitle' }, '最近消息'),
        messages.length ? messages.map(function (message, index) {
          return react.createElement('div', { className: 'dsh-relay-row', key: [message.direction, message.peer, message.status, message.timestamp, index].join(':') }, react.createElement('span', { className: 'dsh-relay-message' }, (message.direction === 'out' ? '发至 ' : '来自 ') + message.peer + ' · ' + message.status), react.createElement('span', { className: 'dsh-relay-muted' }, timeText(message.timestamp)))
        }) : react.createElement('span', { className: 'dsh-relay-empty' }, '暂无消息状态'))
    }

    function RelayPanel() {
      var statePair = react.useState(null)
      var status = statePair[0]
      var setStatus = statePair[1]
      var errorPair = react.useState(null)
      var refreshError = errorPair[0]
      var setRefreshError = errorPair[1]
      react.useEffect(function () {
        var cancelled = false
        var timer = null
        function refresh() {
          window.fetch(STATUS_API, { cache: 'no-store' })
            .then(function (response) { if (!response.ok) throw new Error('HTTP ' + response.status); return response.json() })
            .then(function (value) { if (!cancelled) { setStatus(value); setRefreshError(null) } })
            .catch(function (error) { if (!cancelled) setRefreshError(String(error && error.message || error).slice(0, 120)) })
            .finally(function () { if (!cancelled) timer = window.setTimeout(refresh, POLL_MS) })
        }
        refresh()
        return function () { cancelled = true; if (timer !== null) window.clearTimeout(timer) }
      }, [])
      return react.createElement('div', { className: 'dsh-relay-panel', role: 'dialog', 'aria-label': 'Agent Relay 状态' },
        react.createElement('div', { className: 'dsh-relay-heading' }, react.createElement('h3', null, 'Agent Relay'), react.createElement('span', { className: status && status.broker && status.broker.connected ? '' : 'dsh-relay-warn' }, status ? (status.agent || '未配置') : '加载中…')),
        react.createElement(BrokerSection, { data: status }),
        react.createElement(PeersSection, { peers: status && status.peers }),
        react.createElement(QueuesSection, { peers: status && status.peers }),
        react.createElement(ErrorSection, { lastError: status && status.lastError, refreshError: refreshError }),
        react.createElement(MessagesSection, { messages: status && status.recentMessages }))
    }

    function RelayButton(props) {
      var pair = react.useState(false)
      var open = pair[0]
      var setOpen = pair[1]
      var ref = react.useRef(null)
      react.useEffect(function () {
        if (!open) return undefined
        function onDown(event) { if (ref.current && !ref.current.contains(event.target)) setOpen(false) }
        function onKey(event) { if (event.key === 'Escape') setOpen(false) }
        document.addEventListener('mousedown', onDown)
        document.addEventListener('keydown', onKey)
        return function () { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
      }, [open])
      var wide = props.wide === true
      return react.createElement('div', { ref: ref }, react.createElement('button', { type: 'button', className: 'dsh-relay-trigger', 'data-wide': wide ? 'row' : 'rail', 'data-open': open ? 'true' : 'false', title: 'Agent Relay 状态', 'aria-label': 'Agent Relay 状态', 'aria-expanded': open, onClick: function () { setOpen(!open) } }, react.createElement(RelayGlyph, { size: wide ? 14 : 16 })), open ? react.createElement(RelayPanel, null) : null)
    }

    function apply(ctx) {
      ctx.effect(function () {
        var style = document.createElement('style')
        style.dataset.plugin = 'dsh-agent-relay'
        style.textContent = CSS
        document.head.appendChild(style)
        return function () { style.remove() }
      }, 'dsh-agent-relay: styles')
      var slots = ctx.get('slots')
      if (slots === undefined) return
      slots.inject('sidebar.footer.action', function () {
        return slots.register({ name: 'sidebar.footer.action', id: 'dsh-agent-relay', order: 125, label: 'Agent Relay' }, RelayButton)
      })
    }

    exports.apply = apply
    exports.inject = ['slots']
    return module.exports
  },
})
