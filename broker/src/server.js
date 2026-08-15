/**
 * HTTP server implementing the dsh-agent-relay wire protocol v1.0.
 * See docs/PROTOCOL.md — this file is the reference implementation.
 */
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { normalizeEnvelope } from './store.js'

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

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('body too large'), { code: 'bad_request' }))
        req.destroy()
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
        sendJson(res, 200, { protocol: PROTOCOL_VERSION, broker: BROKER_NAME, version: BROKER_VERSION })
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

      const ackMatch = /^\/messages\/([0-9a-fA-F-]+)\/ack$/.exec(path)
      if (req.method === 'POST' && ackMatch) {
        const target = store.findById(ackMatch[1])
        if (!target) {
          sendJson(res, 404, errorBody('no_such_message', 'message id not found (expired or unknown)'))
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
        const ack = {
          id: randomUUID(),
          from: agent,
          to: target.from,
          ts: new Date().toISOString(),
          type: 'ack',
          body: { status, error: status === 'error' ? String(parsed.error ?? 'unknown') : undefined },
          replyTo: target.id,
          ack: false,
        }
        store.add(ack)
        sendJson(res, 201, { accepted: true, id: ack.id })
        return
      }

      sendJson(res, 404, errorBody('not_found', `no route ${req.method} ${path}`))
    } catch (err) {
      // Never log message content — ids and events only.
      console.error(`[relay-broker] ${new Date().toISOString()} error: ${err.message}`)
      sendJson(res, 503, errorBody('busy', 'internal broker error'))
    }
  })
}
