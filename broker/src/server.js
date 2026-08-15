/**
 * HTTP server implementing the dsh-agent-relay wire protocol v1.0.
 * See docs/PROTOCOL.md — this file is the reference implementation.
 */
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { normalizeEnvelope } from './store.js'
import { MAX_LEASE_SECONDS } from './config.js'

const require = createRequire(import.meta.url)

const PROTOCOL_VERSION = '1.0'
const BROKER_NAME = 'dsh-agent-relay'
// Read the broker's own manifest so the path works in both the repo
// (broker/package.json) and the Docker image (/app/package.json) — never
// hard-code a version here.
const BROKER_VERSION = require('../package.json').version
const HEARTBEAT_TTL_SECONDS = 90
const MAX_BODY_BYTES = 1024 * 1024

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
 */
export function createBrokerServer({ config, store, auth }) {
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

      const verdict = auth.check(req, rawBody)
      if (!verdict.ok) {
        sendJson(res, verdict.status, errorBody(verdict.code, verdict.message))
        return
      }
      const agent = verdict.agent

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
