// Standalone relay-agent harness: boot a broker, spawn the relay-agent with a
// mock backend, send a request, and assert the reply. Copied into a temp dir
// with lib/ + broker/ + adapters/ and run as a subprocess. Exits 0 on success.
import { createStore } from './broker/src/store.js'
import { createAuthenticator } from './broker/src/auth.js'
import { createBrokerServer } from './broker/src/server.js'
import { createV2Store } from './broker/src/store-v2.js'
import { RelayClientV2 } from './lib/client-v2.js'
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'

const SHARED = 'relay-agent-harness-secret'
const DATA_DIR = process.cwd() + '/data'
mkdirSync(DATA_DIR, { recursive: true })

const config = {
  host: '127.0.0.1', port: 0, secret: SHARED, tls: false,
  rateLimitLoopback: 1e6, rateLimitRemote: 1e6, messageTtlDays: 7,
  persist: false, dataDir: DATA_DIR, lockAfterFailures: 5, lockMinutes: 5,
  leaseSeconds: 600, maxAttempts: 3, notifyFailedToSender: true, agents: {},
}
const store = createStore({ ttlDays: 7, persist: false, dataDir: DATA_DIR })
const auth = createAuthenticator({ secret: SHARED, lockAfterFailures: 5, lockMinutes: 5, rateLimitLoopback: 1e6, rateLimitRemote: 1e6 })
const v2Store = createV2Store({ dataDir: DATA_DIR, persist: false, leaseSeconds: 600, maxAttempts: 3 })
const server = createBrokerServer({ config, store, auth, storeV2: v2Store })
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port

// Spawn the standalone relay agent (from the copied adapters/ dir).
const agent = spawn(process.execPath, [
  'adapters/relay-agent.mjs',
  '--agent', 'codex',
  '--broker', `http://127.0.0.1:${port}`,
  '--secret', SHARED,
  '--backend-cmd', `node ${process.cwd()}/backend.mjs`,
  '--cwd', DATA_DIR,
  '--poll-seconds', '1',
], { cwd: process.cwd(), encoding: 'utf8' })
let agentOut = ''
agent.stdout.setEncoding('utf8').on('data', (c) => { agentOut += c })
agent.stderr.setEncoding('utf8').on('data', (c) => { agentOut += c })

// Give the agent a moment to join.
await new Promise((r) => setTimeout(r, 1500))

const alpha = new RelayClientV2({ endpoint: `http://127.0.0.1:${port}`, agent: 'alpha', secret: SHARED })
const messageId = await alpha.sendRequest({ target: 'codex', body: '请审查这段代码', sessionRef: 'alpha', idempotencyKey: 'relay-agent:1', ttlSeconds: 3600, executionMode: 'read' })

let reply = null
for (let i = 0; i < 30; i++) {
  await new Promise((r) => setTimeout(r, 250))
  const inbox = await alpha.pull({ limit: 5 })
  reply = inbox.find((m) => m.kind === 'reply' && m.parent_id === messageId)
  if (reply) break
}

let status = []
if (reply) {
  status = await alpha.status([messageId])
}

agent.kill()
await new Promise((resolve) => server.close(resolve))

if (!reply) { console.error('FAIL: no reply from relay-agent\n' + agentOut); process.exit(1) }
if (!reply.body.includes('mock 后端回复')) { console.error('FAIL: unexpected reply body: ' + reply.body.slice(0, 80)); process.exit(1) }
if (status[0]?.status !== 'completed') { console.error('FAIL: request not completed'); process.exit(1) }

console.log('OK relay-agent reply + completed')
process.exit(0)
