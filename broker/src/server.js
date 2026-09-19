/**
 * HTTP server for the dsh-agent-relay wire protocol (v2/v3).
 * docs/PROTOCOL-V2.md is the contract; this file is the reference
 * implementation and owns liveness, delivery wake-ups and the long-poll
 * registry, while `v2-routes.js` owns the message endpoints and `v2-auth.js`
 * the signature schemes and ACLs. The v1 generation was removed on 2026-09-19.
 */
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import {
  PROTOCOL_VERSION as V2_VERSION,
  PRESENCE_STALE_SECONDS,
  MAX_WAIT_SECONDS,
} from './protocol.js'
import { createV2Store } from './store-v2.js'
import { cryptoRandomHex, sendJson, errorBody, readBody } from './http-utils.js'
import { isV2Request, verifyV2Request } from './v2-auth.js'
import { handleV2Routes } from './v2-routes.js'

const require = createRequire(import.meta.url)

const BROKER_NAME = 'dsh-agent-relay'
// Read the broker's own manifest so the path works in both the repo
// (broker/package.json) and the Docker image (/app/package.json) — never
// hard-code a version here.
const BROKER_VERSION = require('../package.json').version

const NOTIFY_FAILED_PREFIX = '[Relay] 你的内部协作消息未能送达'
// Floor for how long an "undelivered" notice stays claimable (7 days).
const NOTICE_MIN_RETENTION_SECONDS = 7 * 86400

/**
 * @param {object} deps
 * @param {object} deps.config - normalized broker config
 * @param {object} [deps.storeV2] - message store. The entrypoint passes one with
 *   `dataDir` resolved against the broker directory; the default here exists for
 *   tests and standalone use.
 */
export function createBrokerServer({ config, storeV2 = createV2Store({ dataDir: config.dataDir, persist: config.persist, leaseSeconds: config.leaseSeconds, maxAttempts: config.maxAttempts }) }) {
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
    // The worker must be pointed at the port we are *actually* listening on:
    // `broker.port` is 0 under an ephemeral listen (and a reverse proxy can move
    // it too), so reading the config here handed children `http://127.0.0.1:0`.
    const bound = server.address()
    const brokerUrl = `http://${bound?.address ?? config.host}:${bound?.port ?? config.port}`
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
          AGENT_RELAY_BROKER_URL: brokerUrl,
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

  /**
   * Wake every held puller of `agent`, or start its worker on demand.
   *
   * "On demand" must not mean "no request is parked right this second": a member
   * served by a pre-0.6 client (timer polling, e.g. the Feishu bot that answers
   * for codex/claude) almost never holds a pull, so that test would spawn a
   * competing headless worker and double-handle the message. Presence over the
   * last 90 s is the honest signal — a member that claimed recently is alive.
   *
   * @returns {boolean} true when a worker was started, reported back to the
   *   sender as `will_wake` so a client knows waiting is worthwhile.
   */
  function wakeAgent(agent, info = {}) {
    const set = waiters.get(agent)
    if (set && set.size) {
      for (const entry of [...set]) settleWaiter(entry)
      return false
    }
    const lastSeen = storeV2.lastPullAt?.[agent] ?? null
    if (lastSeen != null && Date.now() / 1000 - lastSeen <= PRESENCE_STALE_SECONDS) return false
    return spawnWorker(agent, info)
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

      // Liveness + protocol metadata. No auth.
      if (req.method === 'GET' && path === '/healthz') {
        const now = Math.floor(Date.now() / 1000)
        // Membership comes from the config: the only liveness signal clients
        // actually produce is when they last claimed (see `presence`), and the
        // v1 `/register` heartbeat that used to contribute here was never called
        // by any v2/v3 client.
        const agents = Object.keys(config.agents ?? {}).sort()
        const lastPullAt = storeV2.lastPullAt
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
          storage: 'sqlite',
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

      // Only the v2/v3 wire protocol is served. The v1 generation was removed
      // once the 2026-09-19 audit showed the relay database had not held a
      // single v1 message since 2026-08-15.
      if (!isV2Request(req)) {
        sendJson(res, 400, errorBody('bad_request', 'missing X-Agent-Relay-* headers — the v1 protocol was removed; see docs/PROTOCOL-V2.md'))
        return
      }
      const verdict = verifyV2Request(req, rawBody, config)
      if (!verdict.ok) {
        sendJson(res, verdict.status, errorBody(verdict.code, verdict.message))
        return
      }
      const agent = verdict.agent
      await handleV2Routes({ config, storeV2, agent, req, res, path, rawBody, notifyFailedSenders, wakeAgent, waitFor })
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
