/**
 * HTTP server implementing the dsh-agent-relay wire protocol.
 * See docs/PROTOCOL.md (v1) and docs/PROTOCOL-V2.md (v2) — this file is the
 * reference implementation.
 */
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { randomUUID, randomBytes } from 'node:crypto'
import { normalizeEnvelope } from './store.js'
import { MAX_LEASE_SECONDS } from './config.js'
import {
  PROTOCOL_VERSION as V2_VERSION,
  SIGNATURE_HEADERS as V2_HEADERS,
  MAX_CLOCK_SKEW_SECONDS as V2_SKEW,
  MAX_BODY_CHARS as V2_MAX_BODY,
  EXECUTION_MODES as V2_MODES,
  TTL_MIN_SECONDS as V2_TTL_MIN,
  TTL_MAX_SECONDS as V2_TTL_MAX,
  RelayMessage,
  codePointLength,
  truncateCodePoints,
  verifySignature as verifyV2Signature,
} from './protocol.js'
import { createV2Store } from './store-v2.js'

const require = createRequire(import.meta.url)

const PROTOCOL_VERSION = '1.0'
const BROKER_NAME = 'dsh-agent-relay'
// Read the broker's own manifest so the path works in both the repo
// (broker/package.json) and the Docker image (/app/package.json) — never
// hard-code a version here.
const BROKER_VERSION = require('../package.json').version
const HEARTBEAT_TTL_SECONDS = 90
const MAX_BODY_BYTES = 1024 * 1024

/** 32-hex-char id (matches the self-use broker's uuid.uuid4().hex). */
function cryptoRandomHex(bytes = 16) {
  return randomBytes(bytes).toString('hex')
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(payload)
}

function errorBody(code, message) {
  return { error: { code, message } }
}

function parseJson(raw) {
  try { return JSON.parse(raw) } catch { return null }
}

function parseJsonObject(raw) {
  const parsed = parseJson(raw)
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
}

function clampLimit(value, fallback = 50) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.min(Math.max(1, Math.floor(n)), 200) : fallback
}

/** Per-agent routing ACL (v1.1). Absent entry / null targets = allow all. */
function canSend(config, from, to) {
  const entry = config.agents?.[from]
  if (entry && entry.allowedTargets) return entry.allowedTargets.includes(to)
  return true
}

/** A v2 request is identified by the presence of its agent header. */
function isV2Request(req) {
  return req.headers[V2_HEADERS.agent] !== undefined
}

/**
 * Authenticate a v2 request (X-Agent-Relay-* headers, v2 signature scheme).
 * Mirrors the self-use broker's `_authenticated_payload`: when any configured
 * agent has a per-agent secret (isolated mode), the agent must be configured
 * and sign with its own secret; otherwise every agent name signs with the
 * shared secret (v1-compatible).
 */
function verifyV2Request(req, rawBody, config) {
  const agent = String(req.headers[V2_HEADERS.agent] || '').trim().toLowerCase()
  const timestamp = req.headers[V2_HEADERS.timestamp] || ''
  const signature = req.headers[V2_HEADERS.signature] || ''
  if (!agent || !timestamp || !signature) {
    return { ok: false, status: 401, code: 'unauthenticated', message: 'missing v2 authentication headers' }
  }
  const entry = config.agents?.[agent]
  const isolated = Object.values(config.agents ?? {}).some((agentCfg) => agentCfg?.secret)
  const secret = isolated ? (entry?.secret ?? null) : config.secret
  if (!secret) {
    return { ok: false, status: 401, code: 'unknown_agent', message: 'agent is not configured' }
  }
  const ts = Number(timestamp)
  if (!Number.isFinite(ts) || Math.abs(Math.floor(Date.now() / 1000) - ts) > V2_SKEW) {
    return { ok: false, status: 401, code: 'unauthenticated', message: 'timestamp skew' }
  }
  const body = Buffer.from(rawBody || '', 'utf8')
  if (!verifyV2Signature(agent, secret, req.method ?? 'GET', req.url ?? '/', timestamp, body, signature)) {
    return { ok: false, status: 401, code: 'unauthenticated', message: 'invalid signature' }
  }
  return { ok: true, agent }
}

/** Public v2 message view (excludes broker-managed status/attempt fields). */
function v2PublicMessage(m) {
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
  return result
}

/**
 * v2 per-mode ACL (self-use compatible). An agent without a config entry may
 * send read/continue to anyone (v1-compatible permissive default) but **write
 * is always closed unless explicitly granted** via allowed_write_targets.
 */
function v2CanSend(config, from, to, mode) {
  const entry = config.agents?.[from]
  if (!entry) return mode !== 'write'
  let list
  if (mode === 'write') list = entry.allowedWriteTargets ?? []
  else if (mode === 'continue') list = entry.allowedContinueTargets ?? entry.allowedTargets
  else list = entry.allowedReadTargets ?? entry.allowedTargets
  if (list == null) return true // no ACL restriction → allow all (v1 default)
  return list.includes(to)
}

const NOTIFY_FAILED_PREFIX = '[Relay] 你的内部协作消息未能送达'

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    let tooLarge = false
    const chunks = []
    req.on('data', (chunk) => {
      if (tooLarge) return
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        tooLarge = true
        reject(Object.assign(new Error('body too large'), { code: 'bad_request' }))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * @param {object} deps
 * @param {object} deps.config - normalized broker config
 * @param {object} deps.store - message store
 * @param {object} deps.auth - authenticator
 * @param {object} [deps.storeV2] - transitional v2 message store (Phase 1)
 */
export function createBrokerServer({ config, store, auth, storeV2 = createV2Store({ dataDir: config.dataDir, persist: config.persist, leaseSeconds: config.leaseSeconds, maxAttempts: config.maxAttempts }) }) {
  /**
   * When a request exhausts its attempts or expires, send an "undelivered"
   * reply back to the origin so the requester learns the peer never processed
   * it. Guarded by notified_at so each request produces at most one notice.
   */
  function notifyFailedSenders() {
    if (config.notifyFailedToSender === false) return
    const now = Date.now() / 1000
    for (const row of storeV2.getFailedToNotify()) {
      if (!storeV2.markNotified(row.message_id, now)) continue
      const reason = row.status === 'expired'
        ? '原因: 消息在队列中过期，对端从未处理'
        : `原因: ${String(row.last_error || 'unknown').slice(0, 300)}`
      const body = String(row.body || '')
      const notice = `${NOTIFY_FAILED_PREFIX}：\n目标 agent: ${row.target}\n尝试次数: ${row.attempts}/${config.maxAttempts}\n${reason}\n\n原始消息（前 ${Math.min(body.length, 400)} 字）：\n${body.slice(0, 400)}`
      storeV2.create({
        message_id: cryptoRandomHex(),
        root_id: row.root_id,
        parent_id: row.message_id,
        origin: row.target,
        target: row.origin,
        kind: 'reply',
        body: notice,
        session_ref: row.session_ref ?? '',
        created_at: now,
        expires_at: now + 3600,
        execution_mode: row.execution_mode || 'read',
        context: '',
        topic: row.topic || '',
      }, `undelivered:${row.message_id}`)
    }
  }

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname
    try {
      const rawBody = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : ''

      // Version negotiation and liveness need no auth.
      if (req.method === 'GET' && path === '/') {
        sendJson(res, 200, {
          protocol: PROTOCOL_VERSION,
          broker: BROKER_NAME,
          version: BROKER_VERSION,
          capabilities: {
            leaseDelivery: true,
            requestReply: true,
            filteredQuery: true,
            sqlitePersistence: store.sqliteSupported,
          },
          storage: store.storage,
        })
        return
      }

      // Public liveness + protocol metadata (v2). No auth.
      if (req.method === 'GET' && path === '/healthz') {
        const now = Math.floor(Date.now() / 1000)
        const peers = store.listPeers(now, HEARTBEAT_TTL_SECONDS).map((p) => p.agent)
        const agents = [...new Set([...peers, ...Object.keys(config.agents ?? {})])].sort()
        sendJson(res, 200, {
          ok: true,
          protocol_version: V2_VERSION,
          broker: BROKER_NAME,
          version: BROKER_VERSION,
          storage: store.storage,
          agents,
          queues: storeV2.queueStats(agents),
          last_pull_at: storeV2.lastPullAt,
          counters: {
            messages_created: storeV2.counters?.messages_created ?? 0,
            pulls: storeV2.counters?.pulls ?? 0,
          },
        })
        return
      }

      const v2 = isV2Request(req)
      const verdict = v2 ? verifyV2Request(req, rawBody, config) : auth.check(req, rawBody)
      if (!verdict.ok) {
        sendJson(res, verdict.status, errorBody(verdict.code, verdict.message))
        return
      }
      const agent = verdict.agent

      // ---- v2 endpoints (docs/PROTOCOL-V2.md) --------------------------
      if (v2) {
        if (req.method === 'POST' && path === '/v1/messages') {
          const parsed = parseJsonObject(rawBody)
          if (!parsed) {
            sendJson(res, 400, errorBody('bad_request', 'body must be a JSON object'))
            return
          }
          const origin = String(parsed.origin || '').trim().toLowerCase()
          const target = String(parsed.target || '').trim().toLowerCase()
          const kind = String(parsed.kind || '').trim().toLowerCase()
          const body = String(parsed.body || '').trim()
          const sessionRef = truncateCodePoints(parsed.session_ref, 300)
          const idempotencyKey = String(parsed.idempotency_key || '').trim().slice(0, 120)
          const parentId = parsed.parent_id ? String(parsed.parent_id).trim() : null
          const executionMode = String(parsed.execution_mode || 'read').trim().toLowerCase()
          if (origin !== agent) {
            sendJson(res, 403, errorBody('forbidden', 'origin does not match authenticated agent'))
            return
          }
          if (kind !== 'request' && kind !== 'reply') {
            sendJson(res, 400, errorBody('bad_request', 'invalid message kind'))
            return
          }
          if (!body || codePointLength(body) > V2_MAX_BODY || !idempotencyKey) {
            sendJson(res, 400, errorBody('bad_request', 'message body or idempotency key is invalid'))
            return
          }
          const now = Date.now() / 1000
          const requestedTtl = Math.floor(Number(parsed.ttl_seconds) || 3600)
          const ttl = Math.max(V2_TTL_MIN, Math.min(requestedTtl, V2_TTL_MAX))
          const topic = truncateCodePoints(parsed.topic, 200)
          let rootId = parsed.root_id ? String(parsed.root_id) : null
          let sessionRefFinal = sessionRef
          let executionModeFinal = executionMode
          let topicFinal = topic
          if (kind === 'request') {
            if (!V2_MODES.includes(executionMode)) {
              sendJson(res, 400, errorBody('bad_request', 'execution_mode must be read, continue, or write'))
              return
            }
            if (!v2CanSend(config, origin, target, executionMode)) {
              sendJson(res, 403, errorBody('forbidden', `target is not allowed for ${executionMode} mode`))
              return
            }
            rootId = rootId ?? cryptoRandomHex()
          } else {
            if (!parentId) {
              sendJson(res, 400, errorBody('bad_request', 'reply requires parent_id'))
              return
            }
            const parent = storeV2.get(parentId)
            if (!parent) {
              sendJson(res, 404, errorBody('no_such_message', 'parent relay message was not found'))
              return
            }
            if (parent.target !== origin || parent.origin !== target) {
              sendJson(res, 403, errorBody('forbidden', 'reply is not authorized for this message'))
              return
            }
            rootId = parent.root_id
            sessionRefFinal = parent.session_ref
            executionModeFinal = parent.execution_mode
            topicFinal = parent.topic
          }
          const message = new RelayMessage({
            message_id: cryptoRandomHex(),
            root_id: rootId,
            parent_id: parentId,
            origin,
            target,
            kind,
            body,
            session_ref: sessionRefFinal,
            created_at: now,
            expires_at: now + ttl,
            execution_mode: executionModeFinal,
            context: truncateCodePoints(parsed.context, V2_MAX_BODY),
            topic: topicFinal,
          })
          const { message_id, created } = storeV2.create(message, idempotencyKey)
          sendJson(res, 200, { message_id, created, protocol_version: V2_VERSION })
          return
        }

        if (req.method === 'POST' && path === '/v1/pull') {
          const parsed = parseJsonObject(rawBody)
          if (!parsed) {
            sendJson(res, 400, errorBody('bad_request', 'body must be a JSON object'))
            return
          }
          if (parsed.agent !== undefined && String(parsed.agent).trim().toLowerCase() !== agent) {
            sendJson(res, 403, errorBody('forbidden', 'agent does not match authenticated identity'))
            return
          }
          let limit = 8
          if (parsed.limit !== undefined) {
            const rawLimit = Number(parsed.limit)
            if (!Number.isFinite(rawLimit)) {
              sendJson(res, 400, errorBody('bad_request', 'limit must be an integer'))
              return
            }
            limit = Math.max(1, Math.min(Math.floor(rawLimit), 8))
          }
          let leaseSeconds
          if (parsed.lease_seconds !== undefined) {
            const raw = Number(parsed.lease_seconds)
            if (!Number.isFinite(raw)) {
              sendJson(res, 400, errorBody('bad_request', 'lease_seconds must be an integer'))
              return
            }
            leaseSeconds = Math.max(15, Math.min(Math.floor(raw), 3600))
          }
          const messages = storeV2.pull(agent, Date.now() / 1000, { limit, leaseSeconds })
          notifyFailedSenders() // surface expired/failed requests to their senders
          sendJson(res, 200, { messages: messages.map(v2PublicMessage) })
          return
        }

        if (req.method === 'POST' && path === '/v1/ack') {
          const parsed = parseJsonObject(rawBody)
          if (!parsed) {
            sendJson(res, 400, errorBody('bad_request', 'body must be a JSON object'))
            return
          }
          if (parsed.agent !== undefined && String(parsed.agent).trim().toLowerCase() !== agent) {
            sendJson(res, 403, errorBody('forbidden', 'agent does not match authenticated identity'))
            return
          }
          const messageId = String(parsed.message_id || '').trim()
          const outcome = String(parsed.outcome || '').trim().toLowerCase()
          const error = String(parsed.error || '').slice(0, 300)
          if (!messageId) {
            sendJson(res, 400, errorBody('bad_request', 'message_id is required'))
            return
          }
          try {
            storeV2.ack(messageId, agent, outcome, error, Date.now() / 1000)
          } catch (err) {
            const status = err.code === 'forbidden' ? 403 : 400
            sendJson(res, status, errorBody(err.code ?? 'bad_request', err.message))
            return
          }
          notifyFailedSenders() // a retry may have just exhausted the attempts
          sendJson(res, 200, { ok: true })
          return
        }

        if (req.method === 'POST' && path === '/v1/status') {
          const parsed = parseJsonObject(rawBody)
          if (!parsed || !Array.isArray(parsed.message_ids)) {
            sendJson(res, 400, errorBody('bad_request', 'message_ids array is required'))
            return
          }
          if (parsed.agent !== undefined && String(parsed.agent).trim().toLowerCase() !== agent) {
            sendJson(res, 403, errorBody('forbidden', 'agent does not match authenticated identity'))
            return
          }
          const ids = parsed.message_ids.map(String).filter(Boolean).slice(0, 100)
          sendJson(res, 200, { messages: storeV2.statusFor(agent, ids) })
          return
        }

        if (req.method === 'POST' && path === '/v1/recent') {
          const parsed = parseJsonObject(rawBody)
          if (!parsed) {
            sendJson(res, 400, errorBody('bad_request', 'body must be a JSON object'))
            return
          }
          if (parsed.agent !== undefined && String(parsed.agent).trim().toLowerCase() !== agent) {
            sendJson(res, 403, errorBody('forbidden', 'agent does not match authenticated identity'))
            return
          }
          const limit = Number.isFinite(Number(parsed.limit)) ? Math.max(1, Math.min(Math.floor(Number(parsed.limit)) || 20, 50)) : 20
          sendJson(res, 200, { messages: storeV2.recentFor(agent, Date.now() / 1000, limit) })
          return
        }

        if (req.method === 'POST' && path === '/v1/messages/query') {
          const parsed = parseJsonObject(rawBody)
          if (!parsed) {
            sendJson(res, 400, errorBody('bad_request', 'body must be a JSON object'))
            return
          }
          if (parsed.agent !== undefined && String(parsed.agent).trim().toLowerCase() !== agent) {
            sendJson(res, 403, errorBody('forbidden', 'agent does not match authenticated identity'))
            return
          }
          let since
          if (parsed.since !== undefined) {
            since = Number(parsed.since)
            if (!Number.isFinite(since)) {
              sendJson(res, 400, errorBody('bad_request', 'since must be a number'))
              return
            }
          }
          const messages = storeV2.queryMessages(agent, {
            limit: parsed.limit,
            message_id: parsed.message_id,
            root_id: parsed.root_id,
            origin: parsed.origin,
            target: parsed.target,
            kind: parsed.kind,
            status: parsed.status,
            topic: parsed.topic,
            since,
          })
          sendJson(res, 200, { agent, messages })
          return
        }

        if (req.method === 'POST' && path === '/v1/admin/status') {
          const parsed = parseJsonObject(rawBody)
          if (!parsed) {
            sendJson(res, 400, errorBody('bad_request', 'body must be a JSON object'))
            return
          }
          if (parsed.agent !== undefined && String(parsed.agent).trim().toLowerCase() !== agent) {
            sendJson(res, 403, errorBody('forbidden', 'agent does not match authenticated identity'))
            return
          }
          const limit = Number.isFinite(Number(parsed.limit)) ? Math.max(1, Math.min(Math.floor(Number(parsed.limit)), 100)) : 50
          const messages = storeV2.stuckFor(agent, Date.now() / 1000, limit)
          sendJson(res, 200, { agent, messages })
          return
        }

        if (req.method === 'POST' && path === '/v1/admin/requeue') {
          const parsed = parseJsonObject(rawBody)
          const messageId = String(parsed?.message_id || '').trim()
          if (!messageId) {
            sendJson(res, 400, errorBody('bad_request', 'message_id is required'))
            return
          }
          if (!storeV2.requeue(messageId, Date.now() / 1000)) {
            sendJson(res, 404, errorBody('no_such_message', 'message is not in a requeue-able state'))
            return
          }
          sendJson(res, 200, { ok: true, message_id: messageId })
          return
        }

        if (req.method === 'POST' && path === '/v1/admin/cancel') {
          const parsed = parseJsonObject(rawBody)
          const messageId = String(parsed?.message_id || '').trim()
          if (!messageId) {
            sendJson(res, 400, errorBody('bad_request', 'message_id is required'))
            return
          }
          if (!storeV2.cancel(messageId, Date.now() / 1000)) {
            sendJson(res, 404, errorBody('no_such_message', 'message is not in a cancellable state'))
            return
          }
          sendJson(res, 200, { ok: true, message_id: messageId })
          return
        }

        sendJson(res, 404, errorBody('not_found', `no v2 route ${req.method} ${path}`))
        return
      }

      if (req.method === 'POST' && path === '/register') {
        let parsed
        try {
          parsed = JSON.parse(rawBody || '{}')
        } catch {
          sendJson(res, 400, errorBody('bad_request', 'invalid JSON body'))
          return
        }
        if (parsed.agent !== undefined && parsed.agent !== agent) {
          sendJson(res, 400, errorBody('bad_request', 'body.agent must match X-Relay-Agent header'))
          return
        }
        const now = Math.floor(Date.now() / 1000)
        store.registerAgent(agent, now)
        sendJson(res, 200, { ok: true, agent, ts: now })
        return
      }

      if (req.method === 'GET' && path === '/peers') {
        const now = Math.floor(Date.now() / 1000)
        sendJson(res, 200, { peers: store.listPeers(now, HEARTBEAT_TTL_SECONDS) })
        return
      }

      if (req.method === 'POST' && path === '/messages') {
        let parsed
        try {
          parsed = JSON.parse(rawBody)
        } catch {
          sendJson(res, 400, errorBody('bad_request', 'invalid JSON body'))
          return
        }
        let msg
        try {
          msg = normalizeEnvelope(parsed, agent, new Date().toISOString())
        } catch (err) {
          sendJson(res, 400, errorBody(err.code ?? 'bad_request', err.message))
          return
        }
        if (msg.from !== agent) {
          sendJson(res, 400, errorBody('bad_request', 'envelope.from must match X-Relay-Agent header'))
          return
        }
        if (msg.to === agent) {
          sendJson(res, 400, errorBody('bad_request', 'cannot send a message to yourself'))
          return
        }
        if (!canSend(config, agent, msg.to)) {
          sendJson(res, 403, errorBody('forbidden', `agent "${agent}" is not allowed to send to "${msg.to}"`))
          return
        }
        const now = Math.floor(Date.now() / 1000)
        const targetKnown = store.listPeers(now, HEARTBEAT_TTL_SECONDS).some((p) => p.agent === msg.to)
        if (!targetKnown) {
          sendJson(res, 404, errorBody('no_such_agent', `recipient "${msg.to}" has never registered`))
          return
        }
        const result = store.add(msg)
        if (!result.added) {
          sendJson(res, 200, { accepted: true, id: msg.id, duplicate: true })
          return
        }
        sendJson(res, 201, { accepted: true, id: msg.id, duplicate: false })
        return
      }

      if (req.method === 'GET' && path === '/messages') {
        const since = url.searchParams.get('since') ?? null
        const limitRaw = Number(url.searchParams.get('limit') ?? 50)
        const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(1, Math.floor(limitRaw)), 200) : 50
        const { messages, cursor } = store.getSince(agent, since, limit)
        sendJson(res, 200, { messages, cursor })
        return
      }

      // ---- v1.1 lease-based delivery endpoints ----

      if (req.method === 'POST' && path === '/v1/pull') {
        const parsed = parseJsonObject(rawBody)
        if (!parsed) {
          sendJson(res, 400, errorBody('bad_request', 'body must be a JSON object'))
          return
        }
        if (parsed.agent !== undefined && parsed.agent !== agent) {
          sendJson(res, 400, errorBody('bad_request', 'body.agent must match X-Relay-Agent header'))
          return
        }
        const limit = clampLimit(parsed.limit)
        const requestedLease = parsed.leaseSeconds === undefined ? config.leaseSeconds : parsed.leaseSeconds
        const leaseSeconds = Number(requestedLease)
        if (!Number.isInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > MAX_LEASE_SECONDS) {
          sendJson(res, 400, errorBody('bad_request', `leaseSeconds must be an integer from 1 to ${MAX_LEASE_SECONDS}`))
          return
        }
        const messages = store.pull(agent, limit, leaseSeconds)
        sendJson(res, 200, { messages, count: messages.length })
        return
      }

      if (req.method === 'POST' && path === '/v1/ack') {
        const parsed = parseJsonObject(rawBody)
        if (!parsed || typeof parsed.messageId !== 'string' || !parsed.messageId || typeof parsed.leaseId !== 'string' || !parsed.leaseId) {
          sendJson(res, 400, errorBody('bad_request', 'messageId and leaseId are required'))
          return
        }
        if (parsed.outcome !== 'completed' && parsed.outcome !== 'retry') {
          sendJson(res, 400, errorBody('bad_request', 'outcome must be "completed" or "retry"'))
          return
        }
        const target = store.findById(parsed.messageId)
        if (!target) {
          sendJson(res, 404, errorBody('no_such_message', 'message id not found (expired or unknown)'))
          return
        }
        if (target.to !== agent) {
          sendJson(res, 403, errorBody('forbidden', 'only the recipient may acknowledge this message'))
          return
        }
        const r = store.ack(parsed.messageId, parsed.leaseId, parsed.outcome, typeof parsed.error === 'string' ? parsed.error : null)
        if (!r.ok) {
          const message = r.code === 'lease_mismatch' ? 'leaseId does not match the current lease' : 'message is not currently leased'
          sendJson(res, 409, errorBody(r.code, message))
          return
        }
        sendJson(res, 200, { ok: true, status: r.status, attempts: r.attempts })
        return
      }

      if (req.method === 'POST' && path === '/v1/status') {
        const parsed = parseJsonObject(rawBody)
        if (!parsed || !Array.isArray(parsed.messageIds)) {
          sendJson(res, 400, errorBody('bad_request', 'messageIds array is required'))
          return
        }
        const messages = store.getStatus(parsed.messageIds.slice(0, 200).map(String), agent)
        sendJson(res, 200, { messages })
        return
      }

      if (req.method === 'POST' && path === '/v1/recent') {
        const parsed = parseJsonObject(rawBody)
        if (!parsed) {
          sendJson(res, 400, errorBody('bad_request', 'body must be a JSON object'))
          return
        }
        if (parsed.agent !== undefined && parsed.agent !== agent) {
          sendJson(res, 400, errorBody('bad_request', 'body.agent must match X-Relay-Agent header'))
          return
        }
        const messages = store.getRecent(agent, clampLimit(parsed.limit))
        sendJson(res, 200, { messages, count: messages.length })
        return
      }

      if (req.method === 'POST' && path === '/v1/messages/query') {
        const parsed = parseJsonObject(rawBody)
        if (!parsed) {
          sendJson(res, 400, errorBody('bad_request', 'body must be a JSON object'))
          return
        }
        if (parsed.agent !== undefined && parsed.agent !== agent) {
          sendJson(res, 400, errorBody('bad_request', 'body.agent must match X-Relay-Agent header'))
          return
        }
        const messages = store.query({
          agent,
          limit: clampLimit(parsed.limit),
          kind: typeof parsed.kind === 'string' ? parsed.kind : undefined,
          status: typeof parsed.status === 'string' ? parsed.status : undefined,
          from: typeof parsed.from === 'string' ? parsed.from : undefined,
          to: typeof parsed.to === 'string' ? parsed.to : undefined,
        })
        sendJson(res, 200, { messages, count: messages.length })
        return
      }

      const ackMatch = /^\/messages\/([0-9a-fA-F-]+)\/ack$/.exec(path)
      if (req.method === 'POST' && ackMatch) {
        const target = store.findById(ackMatch[1])
        if (!target) {
          sendJson(res, 404, errorBody('no_such_message', 'message id not found (expired or unknown)'))
          return
        }
        if (target.to !== agent) {
          sendJson(res, 403, errorBody('forbidden', 'only the recipient may acknowledge this message'))
          return
        }
        let parsed
        try {
          parsed = JSON.parse(rawBody || '{}')
        } catch {
          sendJson(res, 400, errorBody('bad_request', 'invalid JSON body'))
          return
        }
        const status = parsed.status === 'error' ? 'error' : 'ok'
        const ack = normalizeEnvelope(
          {
            id: randomUUID(),
            to: target.from,
            type: 'ack',
            body: { status, error: status === 'error' ? String(parsed.error ?? 'unknown') : undefined },
            replyTo: target.id,
            ack: false,
          },
          agent,
          new Date().toISOString(),
        )
        store.add(ack)
        sendJson(res, 201, { accepted: true, id: ack.id })
        return
      }

      sendJson(res, 404, errorBody('not_found', `no route ${req.method} ${path}`))
    } catch (err) {
      // Never log message content — ids and events only.
      console.error(`[relay-broker] ${new Date().toISOString()} error: ${err.message}`)
      const status = err.code === 'bad_request' ? 400 : 503
      sendJson(res, status, errorBody(err.code === 'bad_request' ? 'bad_request' : 'busy', err.code === 'bad_request' ? err.message : 'internal broker error'))
    }
  })
}
