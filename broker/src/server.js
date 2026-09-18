/**
 * HTTP server implementing the dsh-agent-relay wire protocol.
 * See docs/PROTOCOL.md (v1) and docs/PROTOCOL-V2.md (v2) — this file is the
 * reference implementation.
 *
 * 2026-08-29 split: http-utils.js (HTTP helpers), v2-auth.js (v2/v3
 * verification + ACLs) and v2-routes.js (the active v2 protocol) are
 * extracted; the frozen legacy v1 routes stay inline pending deprecation.
 */
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { normalizeEnvelope } from './store.js'
import { MAX_LEASE_SECONDS } from './config.js'
import {
  PROTOCOL_VERSION as V2_VERSION,
  PRESENCE_STALE_SECONDS,
  MAX_WAIT_SECONDS,
} from './protocol.js'
import { createV2Store } from './store-v2.js'
import { cryptoRandomHex, sendJson, errorBody, parseJsonObject, clampLimit, readBody } from './http-utils.js'
import { canSend, isV2Request, verifyV2Request } from './v2-auth.js'
import { handleV2Routes } from './v2-routes.js'
import { randomUUID } from 'node:crypto'

const require = createRequire(import.meta.url)

const PROTOCOL_VERSION = '1.0'
const BROKER_NAME = 'dsh-agent-relay'
// Read the broker's own manifest so the path works in both the repo
// (broker/package.json) and the Docker image (/app/package.json) — never
// hard-code a version here.
const BROKER_VERSION = require('../package.json').version
const HEARTBEAT_TTL_SECONDS = 90

const NOTIFY_FAILED_PREFIX = '[Relay] 你的内部协作消息未能送达'
// Floor for how long an "undelivered" notice stays claimable (7 days).
const NOTICE_MIN_RETENTION_SECONDS = 7 * 86400

/**
 * @param {object} deps
 * @param {object} deps.config - normalized broker config
 * @param {object} deps.store - message store
 * @param {object} deps.auth - authenticator
 * @param {object} [deps.storeV2] - v2 message store. The broker entrypoint
 *   passes one with dataDir resolved against the broker directory; the
 *   default here is a convenience for tests and standalone use.
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
      // The notice must outlive the failure it reports. With the old 3600 s TTL
      // a sender that was itself briefly away lost the *error report* silently —
      // exactly the failure mode this notice exists to surface.
      const noticeTtl = Math.max(NOTICE_MIN_RETENTION_SECONDS, config.messageTtlDays * 86400)
      const storedNotice = storeV2.create({
        message_id: cryptoRandomHex(),
        root_id: row.root_id,
        parent_id: row.message_id,
        origin: row.target,
        target: row.origin,
        kind: 'reply',
        body: notice,
        session_ref: row.session_ref ?? '',
        created_at: now,
        expires_at: now + noticeTtl,
        execution_mode: row.execution_mode || 'read',
        context: '',
        topic: row.topic || '',
      }, `undelivered:${row.message_id}`)
      wakeAgent(row.origin, { messageId: storedNotice.message_id, rootId: row.root_id })
    }
  }

  /**
   * Long-poll registry: agent -> Set of held pull requests. A message created
   * for that agent settles the held requests immediately, which is what turns
   * delivery latency from "up to one poll period" into "as soon as it lands".
   */
  const waiters = new Map()
  const MAX_WAITERS_PER_AGENT = 16

  function dropWaiter(entry) {
    if (entry.timer) { clearTimeout(entry.timer); entry.timer = null }
    const set = waiters.get(entry.agent)
    if (!set) return
    set.delete(entry)
    if (!set.size) waiters.delete(entry.agent)
  }

  function settleWaiter(entry) {
    if (entry.done) return
    entry.done = true
    let messages = []
    try {
      messages = storeV2.pull(entry.agent, Date.now() / 1000, entry.opts)
    } catch (err) {
      console.error(`[relay-broker] long-poll claim failed for ${entry.agent}: ${err.message}`)
    }
    dropWaiter(entry)
    entry.resolve(messages)
  }

  function settleWaiterEmpty(entry) {
    if (entry.done) return
    entry.done = true
    dropWaiter(entry)
    entry.resolve([])
  }

  /**
   * Targeted push delivery. A member listed in `agents.<name>.wake_command` is
   * started on demand when a message lands and nobody is polling for it, which
   * is what removes the old precondition "the recipient must already be running
   * a poller" — the 2026-09-19 audit's root cause (4 of 6 members were deaf).
   * One in-flight wake per agent; the worker claims and exits by itself.
   */
  const waking = new Set()

  function fillWakeTemplate(template, { messageId = '', rootId = '', agent: agentName = '' } = {}) {
    return String(template)
      .replace(/\{message_id\}/g, messageId)
      .replace(/\{root_id\}/g, rootId)
      .replace(/\{agent\}/g, agentName)
  }

  function spawnWorker(agentName, info) {
    const entry = config.agents?.[agentName]
    const template = entry?.wakeCommand
    if (!template || waking.has(agentName)) return false
    const command = fillWakeTemplate(template, { ...info, agent: agentName })
    waking.add(agentName)
    let child = null
    try {
      child = spawn(command, {
        shell: true,
        windowsHide: true,
        stdio: 'ignore',
        // The credential goes through the child's environment, never the command
        // line: argv is readable by every process on the box, and a secret there
        // would leak into shell history, logs and the process list.
        env: {
          ...process.env,
          AGENT_RELAY_AGENT: agentName,
          AGENT_RELAY_BROKER_URL: `http://${config.host}:${config.port}`,
          ...(entry?.secret || config.secret ? { AGENT_RELAY_SECRET: entry?.secret || config.secret } : {}),
        },
      })
    } catch (err) {
      waking.delete(agentName)
      console.error(`[relay-broker] wake ${agentName} failed to start: ${err.message}`)
      return false
    }
    child.once('error', (err) => {
      waking.delete(agentName)
      console.error(`[relay-broker] wake ${agentName} error: ${err.message}`)
    })
    child.once('exit', (code) => {
      waking.delete(agentName)
      console.log(`[relay-broker] wake ${agentName} exited (code ${code})`)
    })
    child.unref?.()
    // Never let a lost exit event wedge the agent permanently.
    const guard = setTimeout(() => waking.delete(agentName), 15 * 60 * 1000)
    guard.unref?.()
    console.log(`[relay-broker] waking ${agentName} for message ${info.messageId ?? '?'}`) // ids only, never content
    return true
  }

  /** Wake every held puller of `agent`, or start it on demand when none exist. */
  function wakeAgent(agent, info = {}) {
    const set = waiters.get(agent)
    if (set && set.size) {
      for (const entry of [...set]) settleWaiter(entry)
      return
    }
    spawnWorker(agent, info)
  }

  /**
   * Hold a pull request for up to `waitSeconds`. Resolves with whatever the
   * claim finds — possibly empty if a competing puller won the message, in
   * which case the client simply asks again. A disconnected client is settled
   * on the response's `close` event so aborts cannot leak registry entries.
   */
  function waitFor(agent, { limit, leaseSeconds, matchRootId, waitSeconds, res }) {
    const existing = waiters.get(agent)
    if (existing && existing.size >= MAX_WAITERS_PER_AGENT) return Promise.resolve([])
    return new Promise((resolve) => {
      const entry = {
        agent,
        opts: { limit, leaseSeconds, matchRootId },
        done: false,
        timer: null,
        resolve,
      }
      entry.timer = setTimeout(() => settleWaiter(entry), Math.max(1, waitSeconds) * 1000)
      entry.timer.unref?.()
      if (!existing) waiters.set(agent, new Set())
      waiters.get(agent).add(entry)
      if (res && typeof res.once === 'function') res.once('close', () => settleWaiterEmpty(entry))
    })
  }

  const server = createServer(async (req, res) => {
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
        const lastPullAt = storeV2.lastPullAt
        // Presence per agent, from the only signal v2 clients actually produce:
        // when they last claimed. (v1's /register heartbeat stays empty because
        // no v2 client ever registers — that is why `agents` falls back to config.)
        const presence = {}
        for (const name of agents) {
          const seen = lastPullAt[name] ?? null
          presence[name] = {
            last_pull_at: seen,
            online: seen != null && now - seen <= PRESENCE_STALE_SECONDS,
            age_seconds: seen == null ? null : Math.max(0, Math.round(now - seen)),
          }
        }
        sendJson(res, 200, {
          ok: true,
          protocol_version: V2_VERSION,
          broker: BROKER_NAME,
          version: BROKER_VERSION,
          storage: store.storage,
          signature_schemes: ['v2', 'v3'],
          long_poll: { max_wait_seconds: MAX_WAIT_SECONDS, held: server.heldPulls() },
          presence,
          agents,
          queues: storeV2.queueStats(agents),
          last_pull_at: lastPullAt,
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
        await handleV2Routes({ config, storeV2, agent, req, res, path, rawBody, notifyFailedSenders, wakeAgent, waitFor })
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

  // Delivery failure notices must not depend on the dead recipient pulling:
  // the periodic sweep in the entrypoint calls this so a sender still learns
  // that its request went nowhere (2026-09-19 defect: notifyFailedSenders used
  // to run only from the pull/ack routes).
  server.notifyFailedSenders = notifyFailedSenders
  server.wakeAgent = wakeAgent
  server.heldPulls = () => [...waiters.values()].reduce((sum, set) => sum + set.size, 0)
  /** Release every held long-poll; used by the shutdown path. */
  server.releaseWaiters = () => {
    for (const set of [...waiters.values()]) {
      for (const entry of [...set]) settleWaiterEmpty(entry)
    }
    waiters.clear()
  }
  return server
}
