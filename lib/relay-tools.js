/**
 * The five relay tools (send/status/history/peers/retry) plus their JSON
 * rendering. Client/receipts/routes arrive as accessors because they are
 * created asynchronously once the shared secret resolves.
 *
 * Extracted from lib/index.js (2026-08-29 stabilization split).
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { memorySearch, formatMemoryContext } from './memory-bridge.js'
import { MAX_BODY_CHARS } from './relay-plugin-core.js'

/** JSON render for tool outputs. */
function renderJson(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

export function createRelayTools({ cfg, getClient, notConfigured, getReceipts, getRoutes }) {
  function toolOutput() {
    return { schema: { type: 'object', additionalProperties: true }, render: renderJson }
  }

  async function executeSend(args, exec) {
    const client = getClient()
    if (!client) return notConfigured('agent_relay_send needs a secret')
    const target = String(args.target || '').trim().toLowerCase()
    const message = String(args.message || '')
    const mode = String(args.mode || 'read').trim().toLowerCase()
    let context = String(args.context || '')
    if (!/^[a-z0-9_-]{1,32}$/.test(target)) throw new Error('target 必须是合法 agent 名')
    if (!message || message.length > MAX_BODY_CHARS) throw new Error('message 长度必须为 1-' + MAX_BODY_CHARS + ' 字符')
    if (!['read', 'continue', 'write'].includes(mode)) throw new Error('mode 必须是 read/continue/write')
    // Optional shared-memory attachment: search the unified-agent-memory vault
    // and append the excerpts to the request context.
    if (args.memory_query) {
      const mem = await memorySearch({ cmd: cfg.memoryCmd, query: String(args.memory_query).slice(0, 200) })
      context = context ? context + formatMemoryContext(mem) : formatMemoryContext(mem).replace(/^\n/, '')
    }
    const peerMode = mode === 'continue' ? 'read' : mode
    const sessionId = (exec && exec.agent && exec.agent.id) ? String(exec.agent.id) : ''
    const messageId = await client.sendRequest({
      target, body: message, sessionRef: cfg.agent,
      idempotencyKey: `${cfg.agent}:${Date.now()}:${Math.random().toString(16).slice(2, 10)}`,
      executionMode: peerMode, context: context || undefined,
    })
    if (sessionId) getRoutes()?.set(messageId, { id: messageId, session_id: sessionId, target })
    const result = { message_id: messageId, target, mode }
    if (mode === 'continue') result.note = 'continue 是发起方本地策略；对端收到的是 read 请求'
    return result
  }

  async function executeStatus(args) {
    const client = getClient()
    if (!client) return notConfigured('agent_relay_status needs a secret')
    const ids = (Array.isArray(args.message_ids) ? args.message_ids : []).map(String).filter(Boolean).slice(0, 100)
    if (!ids.length) return { messages: [] }
    return { messages: await client.status(ids) }
  }

  async function executeHistory(args) {
    const client = getClient()
    if (!client) return notConfigured('agent_relay_history needs a secret')
    const raw = Number(args.limit)
    const limit = Number.isFinite(raw) && raw >= 1 && raw <= 50 ? Math.floor(raw) : 20
    return { messages: await client.recent(limit) }
  }

  async function executePeers() {
    const client = getClient()
    if (!client) return notConfigured('agent_relay_peers needs a secret')
    const health = await client.health()
    const now = Date.now() / 1000
    const queues = health?.queues || {}
    const lastPull = health?.last_pull_at || {}
    const peers = (health?.agents || []).sort().map((name) => {
      const last = lastPull[name]
      const q = queues[name] || {}
      return {
        agent: name,
        online: typeof last === 'number' ? now - last <= 15 : true,
        last_seen_seconds: typeof last === 'number' ? Math.round(now - last) : null,
        queued: Number(q.queued || 0),
        leased: Number(q.leased || 0),
        failed: Number(q.failed || 0),
        expired: Number(q.expired || 0),
        completed: Number(q.completed || 0),
      }
    })
    return { protocol_version: health?.protocol_version, peers }
  }

  async function executeRetry(args) {
    const client = getClient()
    if (!client) return notConfigured('agent_relay_retry needs a secret')
    const mid = String(args.message_id || '').trim().slice(0, 128)
    if (!mid) throw new Error('message_id 不能为空')
    return client.requeue(mid)
  }

  const toolDefs = [
    {
      name: 'agent_relay_send',
      description: `向本机 agent-relay 协作圈内的其他 Agent（${cfg.circleMembers.length ? cfg.circleMembers.join('、') : '用 agent_relay_peers 查询成员'}）发送协作请求（审查、问题核查、实现任务）。请求必须自包含：对方看不到你的对话，必要背景写进 message 或 context。可传 memory_query 让系统自动把 unified-agent-memory 共享记忆摘录挂进 context（需配置 UNIFIED_MEMORY_CMD）。`,
      parameters: {
        target: { type: 'string', required: true, description: '接收请求的成员 agent' },
        message: { type: 'string', required: true, description: '自包含的请求内容' },
        context: { type: 'string', description: '可选上下文：项目/工作区路径、约束、相关记忆摘录' },
        memory_query: { type: 'string', description: '可选：在共享记忆库中搜索的查询词，命中的记忆摘录会自动追加到 context' },
        mode: { type: 'string', enum: ['read', 'continue', 'write'], description: 'read=审查/分析（默认）；continue=对方答复后你继续原任务；write=对方在隔离工作区修改（仅当对方允许 write 时生效）' },
      },
      execute: executeSend,
    },
    {
      name: 'agent_relay_status',
      description: '查询此前通过 agent_relay_send 发送的请求的投递状态（queued/leased/completed/failed/expired）。',
      parameters: { message_ids: { type: 'array', items: { type: 'string' }, required: true, description: 'agent_relay_send 返回的 message_id 列表' } },
      execute: executeStatus,
    },
    {
      name: 'agent_relay_history',
      description: '列出本 DSH 实例近期参与（作为发起方或接收方）的 agent-relay 消息，用于追溯协作。',
      parameters: { limit: { type: 'integer', description: '最大返回条数（1-50，默认 20）' } },
      execute: executeHistory,
    },
    {
      name: 'agent_relay_peers',
      description: '列出 agent-relay 协作圈成员及其在线状态、队列负载、最近活跃时间，用于决定找谁协作。',
      parameters: {},
      execute: executePeers,
    },
    {
      name: 'agent_relay_retry',
      description: '将一条 failed/expired 的 agent-relay 消息重新入队以便再次投递。在 agent_relay_status 显示失败/过期后使用。',
      parameters: { message_id: { type: 'string', required: true, description: 'agent_relay_send 返回的 message_id' } },
      execute: executeRetry,
    },
  ]

  return { toolDefs, toolOutput, executePeers, executeHistory }
}
