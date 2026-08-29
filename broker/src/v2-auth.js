/**
 * Stateless v2/v3 request verification and per-agent authorization ACLs
 * (2026-08-29 split out of server.js). The stateful v1.1 authenticator with
 * rate limiting lives in auth.js; the HTTP server glues both together.
 */
import {
  SIGNATURE_HEADERS as V2_HEADERS,
  MAX_CLOCK_SKEW_SECONDS as V2_SKEW,
  verifySignature as verifyV2Signature,
} from './protocol.js'

/** Per-agent routing ACL (v1.1). Absent entry / null targets = allow all. */
export function canSend(config, from, to) {
  const entry = config.agents?.[from]
  if (entry && entry.allowedTargets) return entry.allowedTargets.includes(to)
  return true
}

/** A v2 request is identified by the presence of its agent header. */
export function isV2Request(req) {
  return req.headers[V2_HEADERS.agent] !== undefined
}

/** An agent's keyring: explicit `keys`, its single secret, or the shared one. */
export function keyRingFor(config, entry) {
  if (entry?.keys) return entry.keys
  if (entry?.secret) return { legacy: { secret: entry.secret, notAfter: null } }
  return null
}

/** True when any configured agent signs with its own credential (isolated auth). */
export function isolatedAuth(config) {
  return Object.values(config.agents ?? {}).some((entry) => {
    if (!entry) return false
    if (entry.secret) return true
    if (!entry.keys) return false
    return Object.entries(entry.keys).some(([id, key]) => id !== 'legacy' || key?.secret !== config.secret)
  })
}

/**
 * Authenticate a v2/v3 request (X-Agent-Relay-* headers).
 *
 * Bilingual by design: a request carrying X-Agent-Relay-Key-Id uses the v3
 * signature scheme (agent\nkeyId\nts\nMETHOD\npath\ndigest, verified against
 * the agent's keyring entry, honoring not_after expiry); a request without it
 * uses the v2 scheme (agent\nts\nMETHOD\npath\ndigest) signed with the agent's
 * legacy secret. Mirrors the self-use broker's `_authenticated_payload` for v3
 * clients while keeping every existing v2 client working. In isolated mode an
 * unconfigured agent name is rejected (self-use parity).
 */
export function verifyV2Request(req, rawBody, config) {
  const agent = String(req.headers[V2_HEADERS.agent] || '').trim().toLowerCase()
  const timestamp = req.headers[V2_HEADERS.timestamp] || ''
  const signature = req.headers[V2_HEADERS.signature] || ''
  const keyId = String(req.headers[V2_HEADERS.keyId] || '').trim()
  if (!agent || !timestamp || !signature) {
    return { ok: false, status: 401, code: 'unauthenticated', message: 'missing authentication headers' }
  }
  const entry = config.agents?.[agent]
  if (!entry && isolatedAuth(config)) {
    return { ok: false, status: 401, code: 'unknown_agent', message: 'agent is not configured' }
  }
  const ring = keyRingFor(config, entry) ?? { legacy: { secret: config.secret, notAfter: null } }
  const keyCfg = keyId ? ring[keyId] : ring.legacy
  if (!keyCfg || !keyCfg.secret) {
    return { ok: false, status: 401, code: keyId ? 'unknown_key' : 'unknown_agent', message: keyId ? 'unknown relay key id' : 'agent is not configured' }
  }
  if (keyCfg.notAfter != null && Date.now() / 1000 > keyCfg.notAfter) {
    return { ok: false, status: 401, code: 'unknown_key', message: 'expired relay key' }
  }
  const ts = Number(timestamp)
  if (!Number.isFinite(ts) || Math.abs(Math.floor(Date.now() / 1000) - ts) > V2_SKEW) {
    return { ok: false, status: 401, code: 'unauthenticated', message: 'timestamp skew' }
  }
  const body = Buffer.from(rawBody || '', 'utf8')
  if (!verifyV2Signature(agent, keyCfg.secret, req.method ?? 'GET', req.url ?? '/', timestamp, body, signature, keyId)) {
    return { ok: false, status: 401, code: 'unauthenticated', message: 'invalid signature' }
  }
  return { ok: true, agent }
}

/** Public v2/v3 message view (lease credentials are included for the puller). */
export function v2PublicMessage(m) {
  const result = {
    message_id: m.message_id,
    root_id: m.root_id,
    parent_id: m.parent_id ?? null,
    origin: m.origin,
    target: m.target,
    kind: m.kind,
    body: m.body,
    session_ref: m.session_ref ?? '',
    created_at: m.created_at,
    expires_at: m.expires_at,
    execution_mode: m.execution_mode,
  }
  if (m.context) result.context = m.context
  if (m.topic) result.topic = m.topic
  if (m.lease_token) result.lease_token = m.lease_token
  if (m.lease_until != null) result.lease_until = m.lease_until
  if (m.allow_shared_write) result.allow_shared_write = true
  return result
}

/**
 * v2 per-mode ACL (self-use compatible). An agent without a config entry may
 * send read/continue to anyone (v1-compatible permissive default) but **write
 * is always closed unless explicitly granted** via allowed_write_targets.
 */
export function v2CanSend(config, from, to, mode) {
  const entry = config.agents?.[from]
  if (!entry) return mode !== 'write'
  let list
  if (mode === 'write') list = entry.allowedWriteTargets ?? []
  else if (mode === 'continue') list = entry.allowedContinueTargets ?? entry.allowedTargets
  else list = entry.allowedReadTargets ?? entry.allowedTargets
  if (list == null) return true // no ACL restriction → allow all (v1 default)
  return list.includes(to)
}
