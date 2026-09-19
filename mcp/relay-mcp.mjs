#!/usr/bin/env node
/**
 * relay-mcp — the Model Context Protocol front door to the agent relay.
 *
 * Why this exists: every host previously needed its own adapter plus a resident
 * poller to receive anything, and 4 of the 6 circle members were deaf because
 * nobody kept those processes alive (2026-09-19 audit). An MCP server inverts
 * that: the host starts it with the session and reaps it at the end, so joining
 * the circle is three config lines per agent and zero daemons.
 *
 * Transport: stdio JSON-RPC 2.0, newline-delimited (per the MCP stdio
 * transport). Zero dependencies beyond the repo's own client.
 *
 * Tools (six, all of them a single call away):
 *   relay_ask     — hand off and wait for the answer (the synchronous shape)
 *   relay_send    — hand off without waiting
 *   relay_inbox   — claim what peers sent me
 *   relay_reply   — answer one of those, on the same conversation thread
 *   relay_status  — did my request land / get answered?
 *   relay_agents  — who is in the circle, who is awake right now
 *
 * Configuration (lowest → highest): ~/.dsh/agent-relay.json, environment, flags.
 *   AGENT_RELAY_AGENT / AGENT_RELAY_SECRET / AGENT_RELAY_BROKER_URL
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { RelayClientV2 } from '../lib/client-v2.js'
import { resolveSecret } from '../lib/credentials.mjs'
import { loadFileConfig, relaySettings } from '../lib/relay-config.mjs'
import { normalizeMessage, buildInboundPrompt } from '../lib/relay-plugin-core.js'

const PROTOCOL_LATEST = '2025-06-18'
const SERVER_INFO = { name: 'agent-relay', version: readVersion() }

function readVersion() {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version || '0.0.0'
  } catch {
    return '0.0.0'
  }
}

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]
    if (!key.startsWith('--')) continue
    const name = key.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) out[name] = true
    else {
      out[name] = next
      i++
    }
  }
  return out
}

const str = (v) => (typeof v === 'string' ? v : undefined)

/** Identity + credentials come from the shared resolver; only MCP adds a default. */
export function resolveSettings(flags = {}, env = process.env, file = loadFileConfig()) {
  return {
    ...relaySettings({ flags, env, file }),
    defaultAskSeconds: Number(str(flags['ask-timeout']) ?? env.AGENT_RELAY_ASK_TIMEOUT ?? file.ask_timeout ?? 240),
  }
}

const text = (value) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] })
const toolError = (message) => ({ isError: true, content: [{ type: 'text', text: message }] })

/** The tool surface the model sees. Keep this small — it is the whole product. */
export const TOOLS = [
  {
    name: 'relay_ask',
    description: '把任务交给协作圈里的另一个 Agent 并等待它的回答（推荐用于"让 X 看一下"）。对方不在线时立刻返回 peer_offline，而不是干等超时；请求本身会留存数天，等对方上线后自动投递。',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: '接收方 agent 名（用 relay_agents 查在线成员）' },
        request: { type: 'string', description: '自包含的请求：对方看不到你当前的对话，请写足背景与你要的产出格式' },
        context: { type: 'string', description: '可选：项目路径、约束、相关记忆摘录' },
        mode: { type: 'string', enum: ['read', 'continue', 'write'], description: 'read=只读审查（默认）；write=允许对方在隔离工作区改动' },
        timeout_seconds: { type: 'integer', description: '最多等待多久（默认 240 秒），超时后仍可用 relay_status 追结果' },
      },
      required: ['target', 'request'],
    },
  },
  {
    name: 'relay_send',
    description: '异步投递：交出去就返回，不等回答。适合不阻塞当前任务的委托，之后用 relay_status 查。',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string' },
        request: { type: 'string' },
        context: { type: 'string' },
        mode: { type: 'string', enum: ['read', 'continue', 'write'] },
      },
      required: ['target', 'request'],
    },
  },
  {
    name: 'relay_inbox',
    description: '取别人发给我的协作请求。默认读完即确认；传 mark_done=false 只查看不确认。',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: '最多取几条（1-8，默认 4）' },
        wait_seconds: { type: 'integer', description: '没有消息时最多挂多久（默认 0＝立即返回）' },
        mark_done: { type: 'boolean', description: '取到即 ack completed（默认 true）' },
      },
    },
  },
  {
    name: 'relay_reply',
    description: '把答案回到某条收到的请求上（同一条会话线）。传 relay_inbox 给出的 message_id 作为 parent_id。',
    inputSchema: {
      type: 'object',
      properties: {
        parent_id: { type: 'string', description: '要回答的那条请求的 message_id' },
        answer: { type: 'string', description: '回答正文（对方看不到你的会话，结论和必要依据要写全）' },
      },
      required: ['parent_id', 'answer'],
    },
  },
  {
    name: 'relay_status',
    description: '查我发起的请求到哪一步了（queued/leased/completed/failed/expired），或直接看最近的往来。',
    inputSchema: {
      type: 'object',
      properties: {
        message_ids: { type: 'array', items: { type: 'string' }, description: 'relay_send/relay_ask 返回的 id 列表；省略则返回最近往来' },
      },
    },
  },
  {
    name: 'relay_agents',
    description: '列出协作圈成员、谁此刻在线（最近取过件）、各自队列积压，用来决定找谁。',
    inputSchema: { type: 'object', properties: {} },
  },
]

/** @param {RelayClientV2} client @param {object} settings */
export function makeToolHandler(client, settings) {
  const sessionRef = settings.agent
  return async function callTool(name, args = {}) {
    const target = String(args.target ?? '').trim().toLowerCase()
    switch (name) {
      case 'relay_ask': {
        if (!target || !args.request) return toolError('relay_ask 需要 target 与 request')
        const result = await client.ask({
          target,
          body: String(args.request),
          context: args.context ? String(args.context) : undefined,
          sessionRef,
          executionMode: args.mode ? String(args.mode) : 'read',
          timeoutSeconds: Number(args.timeout_seconds ?? settings.defaultAskSeconds),
          waitOffline: Boolean(args.wait_offline),
        })
        if (!result.ok && result.reason === 'peer_offline') {
          return text([
            `对方当前不在线：${target}（${result.hint ?? '请求已留存'}）`,
            `message_id=${result.message_id}，稍后可用 relay_status 查结果，或让对方上线后自动投递。`,
          ].join('\n'))
        }
        if (!result.ok) {
          return text(`等待超时（${result.waited_seconds}s），请求仍在留存中：message_id=${result.message_id}，可用 relay_status 继续追。`)
        }
        return text(`【${target} 的回答 · ${result.waited_seconds}s】\n${result.reply}`)
      }
      case 'relay_send': {
        if (!target || !args.request) return toolError('relay_send 需要 target 与 request')
        const sent = await client.sendRequestDetailed({
          target, body: String(args.request), context: args.context ? String(args.context) : undefined,
          sessionRef, idempotencyKey: `mcp:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
          executionMode: args.mode ? String(args.mode) : 'read',
        })
        return text([
          `已投递给 ${target}：message_id=${sent.message_id}`,
          sent.target_online === false ? `注意：对方此刻不在线，消息将留存等待自动投递（${sent.hint ?? ''}）` : '对方在线，稍后可用 relay_status 查结果',
        ].join('\n'))
      }
      case 'relay_inbox': {
        const limit = Math.max(1, Math.min(Number(args.limit ?? 4) || 4, 8))
        const messages = await client.pull({ limit, waitSeconds: Number(args.wait_seconds ?? 0) || 0 })
        if (!messages.length) return text('收件箱为空。')
        const markDone = args.mark_done !== false
        const rendered = []
        for (const raw of messages) {
          const msg = normalizeMessage(raw)
          // Ack only after the caller actually received it; a crash before that
          // re-queues on lease expiry rather than swallowing the request.
          if (markDone) await client.ack(msg.message_id, 'completed', undefined, msg.lease_token).catch(() => {})
          rendered.push(`--- ${msg.origin} → 我 · ${msg.kind} · id=${msg.message_id} · ${msg.execution_mode} ---\n${buildInboundPrompt(msg)}\n（回答请用 relay_reply，parent_id=${msg.message_id}）`)
        }
        return text(rendered.join('\n\n'))
      }
      case 'relay_reply': {
        const parentId = String(args.parent_id ?? '').trim()
        const answer = String(args.answer ?? '')
        if (!parentId || !answer) return toolError('relay_reply 需要 parent_id 与 answer')
        try {
          const replyId = await client.replyTo(parentId, answer)
          return text(`已回答 ${parentId.slice(0, 8)}…：reply_id=${replyId}（对方在线时会自动收到）`)
        } catch (err) {
          return toolError(`relay_reply 失败：${err?.message ?? err}`)
        }
      }
      case 'relay_status': {
        const ids = Array.isArray(args.message_ids) ? args.message_ids.map(String).filter(Boolean).slice(0, 50) : []
        if (!ids.length) {
          const recent = await client.recent(15)
          if (!recent.length) return text('最近没有往来记录。')
          return text(recent.map((m) => `${m.created_at ? new Date(m.created_at * 1000).toLocaleString() : '?'}  ${m.origin}→${m.target}  ${m.status}  id=${m.message_id}`).join('\n'))
        }
        const rows = await client.status(ids)
        return text(rows.map((m) => `id=${m.message_id}  ${m.origin}→${m.target}  ${m.status}  attempts=${m.attempts}${m.last_error ? `  error=${m.last_error}` : ''}`).join('\n'))
      }
      case 'relay_agents': {
        const health = await client.health()
        const presence = health.presence ?? {}
        const lines = (health.agents ?? []).filter((name) => name !== settings.agent).map((name) => {
          const seen = presence[name]
          const queue = health.queues?.[name]
          const last = seen?.last_pull_at ? new Date(seen.last_pull_at * 1000).toLocaleString() : '从未'
          return `${seen?.online ? '●' : '○'} ${name}  上次取件 ${last}  队列 ${queue ? `待投${queue.queued}/处理中${queue.leased}` : '未知'}`
        })
        return text([`我是 ${settings.agent}（broker ${health.broker} v${health.version}，协议 v${health.protocol_version}）`, ...lines].join('\n'))
      }
      default:
        return toolError(`未知工具：${name}`)
    }
  }
}

/* -- JSON-RPC over stdio -------------------------------------------------- */

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
}

function replyError(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`)
}

export async function serve({ input = process.stdin, settings } = {}) {
  const resolved = { ...(settings ?? resolveSettings(parseArgs(process.argv.slice(2)))) }
  if (!resolved.agent) throw new Error('relay-mcp: missing agent name (--agent / AGENT_RELAY_AGENT)')
  if (!resolved.secret) resolved.secret = await resolveSecret(resolved)
  if (!resolved.secret) throw new Error(`relay-mcp: no credential for ${resolved.agent} — set AGENT_RELAY_SECRET, or secret_ref + vault_module for a DPAPI-backed entry`)
  const client = new RelayClientV2({
    endpoint: resolved.endpoint, agent: resolved.agent, secret: resolved.secret, keyId: resolved.keyId,
    // ask() holds a request for up to its deadline; the socket must outlast it.
    timeoutMs: (resolved.defaultAskSeconds || 240) * 1000 + 30_000,
  })
  const callTool = makeToolHandler(client, resolved)
  let buffer = ''

  input.setEncoding('utf8')
  for await (const chunk of input) {
    buffer += chunk
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (!line) continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        continue // non-JSON noise on stdin is not ours to answer
      }
      await handle(message)
    }
  }

  async function handle(message) {
    const { id, method, params } = message
    if (method === 'initialize') {
      return reply(id, {
        protocolVersion: PROTOCOL_LATEST,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        instructions: '本机 Agent 协作圈。委派任务优先用 relay_ask（会直接等到回答）；不确定谁在线先查 relay_agents。',
      })
    }
    if (method === 'notifications/initialized' || method?.startsWith('notifications/')) return undefined
    if (method === 'ping') return reply(id, {})
    if (method === 'tools/list') return reply(id, { tools: TOOLS })
    if (method === 'tools/call') {
      const name = String(params?.name ?? '')
      try {
        return reply(id, await callTool(name, params?.arguments ?? {}))
      } catch (err) {
        return reply(id, toolError(`调用 ${name} 失败：${err.message}`))
      }
    }
    if (id !== undefined) return replyError(id, -32601, `method not found: ${method}`)
    return undefined
  }
}

// Only start serving when executed directly (`node mcp/relay-mcp.mjs`), so the
// module stays importable from tests and from other entrypoints.
const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (invokedDirectly) {
  serve().catch((err) => {
    process.stderr.write(`relay-mcp: ${err.message}\n`)
    process.exitCode = 1
  })
}
