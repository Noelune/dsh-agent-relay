/**
 * dsh-agent-relay — host half (cordis plugin for DeepSeek Harness).
 *
 * Registers four model tools:
 *   relay_send    — send a message to another agent via the broker
 *   relay_recv    — pull new messages addressed to this agent
 *   relay_peers   — list registered agents and their online status
 *   relay_history — local send/receive log of this process (in memory)
 *
 * A background worker registers a heartbeat and polls the inbox on a
 * configurable interval; received messages are buffered and surfaced by
 * relay_recv. Message content is never written to disk or logs by this plugin.
 *
 * Configuration (env vars or plugin settings):
 *   DSH_RELAY_BROKER_URL        default http://127.0.0.1:19121
 *   DSH_RELAY_AGENT             default "dsh-<hostname>" (set a stable name!)
 *   DSH_RELAY_SECRET            required — run "node setup/setup.js init"
 *   DSH_RELAY_POLL_INTERVAL_MS  default 5000
 *
 * Without a secret the tools load but answer with a clear "not configured"
 * message (graceful degradation).
 */
import { hostname, homedir } from 'node:os'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { RelayClient, RelayError } from './client.js'

export const name = 'dsh-agent-relay'
export const inject = ['tools']

const MAX_HISTORY = 500
const HISTORY_CAP = 200
const RECEIPTS_FILE = join(homedir(), '.dsh-agent-relay-receipts.json')
const RECEIPT_TTL_MS = 86_400_000 // 1 day

function resolveConfig(config = {}) {
  const env = process.env
  const brokerUrl = config.brokerUrl ?? env.DSH_RELAY_BROKER_URL ?? 'http://127.0.0.1:19121'
  const agent = config.agentName ?? env.DSH_RELAY_AGENT ?? `dsh-${hostname()}`
  const secret = config.secret ?? env.DSH_RELAY_SECRET ?? ''
  const pollIntervalMs = Number(config.pollIntervalMs ?? env.DSH_RELAY_POLL_INTERVAL_MS ?? 5000)
  const leaseSeconds = Number(config.leaseSeconds ?? env.DSH_RELAY_LEASE_SECONDS ?? 600)
  return {
    brokerUrl,
    agent,
    secret,
    pollIntervalMs: Number.isFinite(pollIntervalMs) ? Math.max(1000, pollIntervalMs) : 5000,
    leaseSeconds: Number.isFinite(leaseSeconds) ? Math.max(1, leaseSeconds) : 600,
  }
}

/** JSON render for tool outputs. */
function renderJson(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

/** Load completed-message receipts (durability across restarts). Best-effort. */
function loadReceipts() {
  try {
    if (!existsSync(RECEIPTS_FILE)) return {}
    const raw = JSON.parse(readFileSync(RECEIPTS_FILE, 'utf8'))
    const out = {}
    const now = Date.now()
    for (const [id, r] of Object.entries(raw.receipts ?? {})) {
      if (r.completedAt && now - r.completedAt > RECEIPT_TTL_MS) continue
      out[id] = r
    }
    return out
  } catch {
    return {}
  }
}

/** Persist receipts atomically (tmp + rename). Best-effort. */
function saveReceipts(receipts) {
  try {
    const tmp = RECEIPTS_FILE + '.tmp'
    writeFileSync(tmp, JSON.stringify({ receipts }, null, 2), 'utf8')
    renameSync(tmp, RECEIPTS_FILE)
  } catch { /* durability nicety, not critical */ }
}

export function apply(ctx, config = {}) {
  const cfg = resolveConfig(config)
  const inbox = []          // unread incoming messages (newest last)
  const history = []        // local send/receive log, in memory only
  const seen = new Set()    // processed message ids (dedup, PROTOCOL §5)
  let lastError = null
  let lastPollAt = null

  const client = cfg.secret
    ? new RelayClient({ brokerUrl: cfg.brokerUrl, agent: cfg.agent, secret: cfg.secret })
    : null
  let handshakeDone = false
  const receipts = loadReceipts()

  function notConfigured(action) {
    return {
      ok: false,
      error: `dsh-agent-relay not configured: set DSH_RELAY_SECRET (${action}). Deploy the broker first — read docs/AGENT-DEPLOY.md (in this plugin package, or the repo root) and follow it end-to-end. Optional: DSH_RELAY_BROKER_URL, DSH_RELAY_AGENT.`,
    }
  }

  function pushHistory(entry) {
    history.push(entry)
    if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY)
  }

  /** One poll round: version check (once) + heartbeat + lease-pull inbox. */
  async function pollOnce() {
    if (!client) return
    try {
      if (!handshakeDone) {
        await client.handshake() // PROTOCOL §4 — validate broker version once
        handshakeDone = true
      }
      await client.register()
      const { messages } = await client.pull(50, cfg.leaseSeconds)
      for (const msg of messages ?? []) {
        if (seen.has(msg.id)) continue
        seen.add(msg.id)
        if (msg.type === 'ack') {
          pushHistory({ direction: 'in', kind: 'ack', id: msg.id, replyTo: msg.replyTo, ts: msg.ts, status: msg.body?.status })
          continue
        }
        const receipt = receipts[msg.id]
        if (receipt && receipt.status === 'completed') {
          // Already handled in a previous session: replay the cached reply
          // (idempotent via the original reply id), then ack completed — never
          // re-run the turn.
          try {
            await client.send({
              to: msg.from,
              body: { text: receipt.responseText ?? '' },
              replyTo: msg.id,
              kind: 'reply',
              rootId: msg.rootId ?? msg.id,
              parentId: msg.id,
              id: receipt.replyId,
            })
            await client.ackOutcome(msg.id, 'completed')
            pushHistory({ direction: 'in', kind: 'replayed', id: msg.id, from: msg.from, ts: msg.ts })
          } catch { /* lease expires and the broker re-delivers later */ }
          continue
        }
        inbox.push(msg)
        pushHistory({ direction: 'in', kind: 'message', id: msg.id, from: msg.from, ts: msg.ts })
      }
      lastError = null
    } catch (err) {
      lastError = err instanceof RelayError ? `${err.code}: ${err.message}` : String(err?.message ?? err)
    } finally {
      lastPollAt = new Date().toISOString()
    }
  }

  // Heartbeat + inbox polling worker.
  if (client) {
    const timer = setInterval(pollOnce, cfg.pollIntervalMs)
    timer.unref?.()
    pollOnce().catch(() => {})
    ctx.on?.(ctx.lifecycle?.dispose ?? 'dispose', () => clearInterval(timer))
  }

  ctx.tools.register(defineTool({
    name: 'relay_send',
    description: 'Send a message to another agent through the local relay broker. Use when you need a review, a question, or a task from a peer agent (dsh/Codex/Claude/Hermes/OpenClaw). Replies arrive asynchronously via relay_recv. When replying to a request you received, pass its id as replyTo so the peer can correlate and the delivery is acknowledged.',
    parameters: {
      target: { type: 'string', required: true, description: 'Recipient agent name (see relay_peers).' },
      content: { type: 'string', required: true, description: 'Message content — make it self-contained; the peer does not see this conversation.' },
      replyTo: { type: 'string', description: 'Optional message id this is a reply to (a request you received via relay_recv).' },
      ack: { type: 'boolean', description: 'Request a delivery receipt (default false).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean', required: true },
          accepted: { type: 'boolean' },
          id: { type: 'string' },
          duplicate: { type: 'boolean' },
          error: { type: 'string' },
        },
      },
      render: renderJson,
    },
    async execute(args) {
      if (!client) return notConfigured('relay_send needs a secret')
      try {
        const body = { text: args.content }
        const result = await client.send({
          to: args.target,
          body,
          ack: Boolean(args.ack),
          replyTo: args.replyTo ?? null,
          kind: args.replyTo ? 'reply' : undefined,
        })
        pushHistory({ direction: 'out', kind: 'message', id: result.id, to: args.target, ts: new Date().toISOString() })
        if (args.replyTo) {
          // Record a receipt so a redelivered request is replayed, never re-run.
          receipts[args.replyTo] = { status: 'completed', responseText: args.content, replyId: result.id, completedAt: Date.now() }
          saveReceipts(receipts)
          try { await client.ackOutcome(args.replyTo, 'completed') } catch { /* best-effort */ }
        }
        return { ok: true, accepted: result.accepted, id: result.id, duplicate: result.duplicate === true }
      } catch (err) {
        return { ok: false, error: err instanceof RelayError ? `${err.code}: ${err.message}` : String(err?.message ?? err) }
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'relay_recv',
    description: 'Pull new relay messages addressed to this agent (buffered by the plugin worker; optionally fetches live). Returns unread messages; each message id is returned only once.',
    parameters: {
      limit: { type: 'number', description: 'Maximum messages to return (default 20).' },
      live: { type: 'boolean', description: 'Fetch from the broker immediately instead of the local buffer (default false).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean', required: true },
          messages: { type: 'array' },
          error: { type: 'string' },
        },
      },
      render: renderJson,
    },
    async execute(args) {
      if (!client) return notConfigured('relay_recv needs a secret')
      const limit = Math.min(Math.max(1, Number(args.limit ?? 20)), 100)
      try {
        if (args.live) {
          await pollOnce()
        }
        const out = inbox.splice(0, limit)
        return { ok: true, messages: out }
      } catch (err) {
        return { ok: false, error: err instanceof RelayError ? `${err.code}: ${err.message}` : String(err?.message ?? err) }
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'relay_peers',
    description: 'List agents registered with the relay broker and whether they are currently online (heartbeat within 90 s).',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean', required: true },
          peers: { type: 'array' },
          error: { type: 'string' },
        },
      },
      render: renderJson,
    },
    async execute() {
      if (!client) return notConfigured('relay_peers needs a secret')
      try {
        const peers = await client.peers()
        return { ok: true, peers }
      } catch (err) {
        return { ok: false, error: err instanceof RelayError ? `${err.code}: ${err.message}` : String(err?.message ?? err) }
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'relay_history',
    description: "Show this process's recent relay activity (sends, receives, acks). In-memory only — no message bodies are stored.",
    parameters: {
      limit: { type: 'number', description: 'Maximum entries (default 50).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean', required: true },
          entries: { type: 'array' },
        },
      },
      render: renderJson,
    },
    async execute(args) {
      const limit = Math.min(Math.max(1, Number(args.limit ?? 50)), HISTORY_CAP)
      return { ok: true, entries: history.slice(-limit).reverse() }
    },
  }))

  // Optional loopback status route for the browser half (client-ui.js).
  ctx.inject?.(['webServer'], (hostCtx) => {
    const host = hostCtx
    host.effect?.(() => {
      const server = host.webServer?.httpServer ?? host.webServer?.server
      if (!server) return undefined
      const handle = (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        if (req.method === 'GET' && url.pathname === '/api/dsh-agent-relay/status') {
          const body = JSON.stringify({
            ok: true,
            configured: Boolean(client),
            brokerUrl: cfg.brokerUrl,
            agent: cfg.agent,
            pollIntervalMs: cfg.pollIntervalMs,
            lastPollAt,
            lastError,
            inboxCount: inbox.length,
          })
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(body)
          return true
        }
        return false
      }
      if (typeof server.on === 'function') {
        server.on('request', handle)
        return () => server.off('request', handle)
      }
      return undefined
    }, 'dsh-agent-relay: status route')
  })

  return { client, cfg, pollOnce }
}
