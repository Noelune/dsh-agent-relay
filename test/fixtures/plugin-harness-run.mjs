// Mock-dsh harness fixture: drive the real dsh-agent-relay plugin against a
// real broker. Copied into a temp dir together with lib/ + broker/ and a stub
// @deepseek-ai/dsh-tools package, then run as a subprocess (so the stub never
// touches the repo's node_modules). Exits 0 on success.
import { createStore } from './broker/src/store.js'
import { createAuthenticator } from './broker/src/auth.js'
import { createBrokerServer } from './broker/src/server.js'
import { createV2Store } from './broker/src/store-v2.js'
import { RelayClientV2 } from './lib/client-v2.js'
import { apply as applyPlugin } from './lib/index.js'

const SHARED = 'harness-secret-value'
const DATA_DIR = process.cwd() + '/data'
const { mkdirSync } = await import('node:fs')
mkdirSync(DATA_DIR, { recursive: true })

// ---- real broker ----
const config = {
  host: '127.0.0.1', port: 0, secret: SHARED, tls: false,
  rateLimitLoopback: 1e6, rateLimitRemote: 1e6, messageTtlDays: 7,
  persist: false, dataDir: DATA_DIR, lockAfterFailures: 5, lockMinutes: 5,
  leaseSeconds: 600, maxAttempts: 3, notifyFailedToSender: true,
  agents: {
    dsh: { allowedReadTargets: ['alpha'], allowedWriteTargets: ['alpha'] },
    alpha: { allowedWriteTargets: ['dsh'] },
  },
}
const store = createStore({ ttlDays: 7, persist: false, dataDir: DATA_DIR })
const auth = createAuthenticator({ secret: SHARED, lockAfterFailures: 5, lockMinutes: 5, rateLimitLoopback: 1e6, rateLimitRemote: 1e6 })
const v2Store = createV2Store({ dataDir: DATA_DIR, persist: false, leaseSeconds: 600, maxAttempts: 3 })
const server = createBrokerServer({ config, store, auth, storeV2: v2Store })
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port

// ---- mock dsh host ----
const recorded = { tools: [], permissions: [], approvals: [], sessions: [] }
const agentHandles = new Map()

class MockAgent {
  constructor(sessionId) {
    this.sessionId = sessionId
    this.session = { seq: 0, events: [] }
    this.status = 'idle'
  }
  get agent() { return this }
  followup(msg) {
    this.session.events.push({ seq: ++this.session.seq, type: 'user/message', data: msg })
    this.status = 'running'
    setTimeout(() => {
      this.session.events.push({ seq: ++this.session.seq, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '（模拟回复）已处理完毕。' }] } } })
      this.status = 'idle'
    }, 120)
  }
  steer(msg) { this.session.events.push({ seq: ++this.session.seq, type: 'user/message', data: msg }) }
  cancel() { this.status = 'idle' }
  async whenIdle() { while (this.status !== 'idle') await new Promise((r) => setTimeout(r, 20)) }
  async dispose() { agentHandles.delete(this.sessionId) }
}

const ctx = {
  agents: {
    get(id) { return agentHandles.get(id) ?? null },
    list() { return [...agentHandles.values()] },
    async create({ sessionId }) { const a = new MockAgent(sessionId); agentHandles.set(sessionId, a); recorded.sessions.push(sessionId); return { agent: a } },
    async resume({ resumeSessionId }) { const a = new MockAgent(resumeSessionId); agentHandles.set(resumeSessionId, a); recorded.sessions.push(resumeSessionId); return { agent: a } },
  },
  tools: { register(def) { recorded.tools.push(def); return () => {} } },
  systemPrompt: { section() { return () => {} } },
  timeout: (a, b) => (typeof a === 'function' ? setTimeout(a, b) : new Promise((r) => setTimeout(r, a))),
  interval(fn, ms) { const t = setInterval(fn, ms); return () => clearInterval(t) },
  effect() { return () => {} },
  get(name) {
    switch (name) {
      case 'sandboxPolicy': return { workspaceRoot: DATA_DIR }
      case 'agentDefaultModel': return { currentSelection: () => ({ provider: 'mock', model: 'mock-model' }) }
      case 'sessionPersistence': return null
      case 'workspaceRegistry': return { archiveSession: async () => {} }
      case 'permissionPresets': return { set: (session, mode) => { recorded.permissions.push(mode) } }
      case 'approval': return { setPolicy: (agent, policy) => { recorded.approvals.push(policy) } }
      case 'sessionTitle': return { rename: async () => {} }
      case 'sessionQuery': return { listSessions: async () => [] }
      default: return null
    }
  },
}

applyPlugin(ctx, { brokerUrl: `http://127.0.0.1:${port}`, agentName: 'dsh', secret: SHARED })

const names = recorded.tools.map((t) => t.name)
if (names.length !== 5 || !names.every((n) => ['agent_relay_send', 'agent_relay_status', 'agent_relay_history', 'agent_relay_peers', 'agent_relay_retry'].includes(n))) {
  console.error('FAIL: unexpected tool set', names)
  process.exit(1)
}

// ---- read-mode request: alpha -> dsh ----
const alpha = new RelayClientV2({ endpoint: `http://127.0.0.1:${port}`, agent: 'alpha', secret: SHARED })
const readId = await alpha.sendRequest({ target: 'dsh', body: '请审查这段代码', sessionRef: 'alpha', idempotencyKey: 'harness:read', ttlSeconds: 3600, executionMode: 'read' })
let reply = null
for (let i = 0; i < 30; i++) {
  await new Promise((r) => setTimeout(r, 250))
  const inbox = await alpha.pull({ limit: 5 })
  reply = inbox.find((m) => m.kind === 'reply' && m.parent_id === readId)
  if (reply) break
}
if (!reply) { console.error('FAIL: no reply for read request'); process.exit(1) }
if (!recorded.permissions.includes('read-only')) { console.error('FAIL: read mode did not set read-only preset'); process.exit(1) }
if (!recorded.approvals.includes('never')) { console.error('FAIL: approval policy not set to never'); process.exit(1) }
if (!recorded.sessions.some((s) => s.startsWith('agent-relay-'))) { console.error('FAIL: no relay session created'); process.exit(1) }
const readStatus = await alpha.status([readId])
if (readStatus[0]?.status !== 'completed') { console.error('FAIL: request not completed'); process.exit(1) }

// ---- write-mode request: workspace-write preset ----
const writeId = await alpha.sendRequest({ target: 'dsh', body: '请修改这个文件', sessionRef: 'alpha', idempotencyKey: 'harness:write', ttlSeconds: 3600, executionMode: 'write' })
for (let i = 0; i < 30; i++) {
  await new Promise((r) => setTimeout(r, 250))
  const inbox = await alpha.pull({ limit: 5 })
  reply = inbox.find((m) => m.kind === 'reply' && m.parent_id === writeId)
  if (reply) break
}
if (!reply) { console.error('FAIL: no reply for write request'); process.exit(1) }
if (!recorded.permissions.includes('workspace-write')) { console.error('FAIL: write mode did not set workspace-write preset'); process.exit(1) }

// ---- tools ----
const sendTool = recorded.tools.find((t) => t.name === 'agent_relay_send')
const out = await sendTool.execute({ target: 'alpha', message: '回个话', mode: 'read' }, { agent: { id: 'user-session-1' } })
if (!out.message_id) { console.error('FAIL: agent_relay_send returned no message_id'); process.exit(1) }
const peersTool = recorded.tools.find((t) => t.name === 'agent_relay_peers')
const peers = await peersTool.execute()
if (!Array.isArray(peers.peers) || !peers.peers.some((p) => p.agent === 'dsh')) { console.error('FAIL: peers missing dsh'); process.exit(1) }

console.log('OK read-mode reply / write-mode preset / tools / completed')
await new Promise((resolve) => server.close(resolve))
process.exit(0)
