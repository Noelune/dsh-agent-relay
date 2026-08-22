const MAX_LIST = 20
const MAX_ERROR = 240

function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function count(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0
}

function nullableCount(value) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : null
}

function timestamp(value) {
  const date = typeof value === 'number' ? new Date(value * 1000) : new Date(String(value || ''))
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

export function sanitizeRelayError(value, maxLength = MAX_ERROR) {
  const source = text(value)
  if (!source) return null
  return source
    .replace(/(authorization|proxy-authorization)\s*:\s*[^\r\n]+/ig, '$1: [redacted]')
    .replace(/(cookie|set-cookie)\s*:\s*[^\r\n]+/ig, '$1: [redacted]')
    .replace(/\bbearer\s+[a-z0-9._~+/=-]+/ig, 'Bearer [redacted]')
    .replace(/\b[a-f0-9]{64}\b/ig, '[redacted-signature]')
    .replace(/(secret|token|signature|password|passwd|api[_-]?key|lease[_-]?token|session[_-]?ref)\s*[:=]\s*[^\s,;]+/ig, '$1=[redacted]')
    .slice(0, Math.max(1, Math.floor(Number(maxLength) || MAX_ERROR)))
}

export function mapRelayPeer(peer) {
  return {
    agent: text(peer?.agent),
    online: peer?.online === true,
    lastSeenSeconds: nullableCount(peer?.last_seen_seconds ?? peer?.lastSeenSeconds),
    queued: count(peer?.queued),
    leased: count(peer?.leased),
    failed: count(peer?.failed),
    expired: count(peer?.expired),
  }
}

export function mapRelayMessage(message, localAgent) {
  const origin = text(message?.origin ?? message?.from)
  const target = text(message?.target ?? message?.to)
  const outgoing = origin === text(localAgent)
  return {
    direction: outgoing ? 'out' : 'in',
    peer: outgoing ? target : origin,
    kind: text(message?.kind ?? message?.type) || 'message',
    status: text(message?.status) || 'unknown',
    timestamp: timestamp(message?.created_at ?? message?.ts),
  }
}

export function buildRelayStatusSnapshot({ cfg, peers, messages, protocolVersion = null, lastError, connected, now = new Date() } = {}) {
  const configured = Boolean(cfg && text(cfg.endpoint) && text(cfg.agent))
  const isConnected = configured && connected === true
  return {
    ok: isConnected,
    broker: { connected: isConnected, protocolVersion },
    agent: configured ? text(cfg.agent) : null,
    refreshedAt: now instanceof Date && !Number.isNaN(now.getTime()) ? now.toISOString() : new Date().toISOString(),
    peers: Array.isArray(peers) ? peers.map(mapRelayPeer).filter((peer) => peer.agent).slice(0, MAX_LIST) : [],
    recentMessages: Array.isArray(messages) ? messages.map((message) => mapRelayMessage(message, cfg?.agent)).filter((message) => message.peer).slice(0, MAX_LIST) : [],
    lastError: sanitizeRelayError(lastError),
  }
}
