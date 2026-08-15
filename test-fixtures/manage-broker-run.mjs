// Manage-broker fixture: apply the plugin with manageBroker and NO running
// broker; it must spawn the bundled broker and become reachable. Exits 0 on OK.
import { RelayClientV2 } from './lib/client-v2.js'
import { apply as applyPlugin } from './lib/index.js'

const SECRET = 'manage-broker-secret'
const DATA = process.cwd() + '/data'
const { mkdirSync, writeFileSync } = await import('node:fs')
mkdirSync(DATA, { recursive: true })

const cfgPath = process.cwd() + '/broker-config.yaml'
writeFileSync(cfgPath, [
  'broker:',
  '  host: 127.0.0.1',
  '  port: 19129',
  '  secret: ' + SECRET,
  '  storage: sqlite',
  '  dataDir: ' + DATA,
  '  persist: false',
  'agents: {}',
].join('\n'), 'utf8')

const recorded = { tools: [] }
const ctx = {
  agents: { get: () => null, list: () => [], create: async () => { throw new Error('not used') }, resume: async () => { throw new Error('not used') } },
  tools: { register(d) { recorded.tools.push(d); return () => {} } },
  systemPrompt: { section() { return () => {} } },
  timeout: (a, b) => (typeof a === 'function' ? setTimeout(a, b) : new Promise((r) => setTimeout(r, a))),
  interval(fn, ms) { const t = setInterval(fn, ms); return () => clearInterval(t) },
  effect() { return () => {} },
  get() { return null },
}

applyPlugin(ctx, { endpoint: 'http://127.0.0.1:19129', agentName: 'dsh', secret: SECRET, brokerConfigPath: cfgPath, manageBroker: true })

const client = new RelayClientV2({ endpoint: 'http://127.0.0.1:19129', agent: 'dsh', secret: SECRET })
let healthy = false
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 300))
  try {
    const h = await client.health()
    if (h.ok) { healthy = true; break }
  } catch { /* keep waiting */ }
}
if (!healthy) { console.error('FAIL: plugin did not spawn a reachable broker'); process.exit(1) }
if (!recorded.tools.some((t) => t.name === 'agent_relay_send')) { console.error('FAIL: tools not registered'); process.exit(1) }
console.log('OK manage-broker spawned the broker')
process.exit(0)
