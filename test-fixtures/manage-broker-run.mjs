// Manage-broker fixture: apply the plugin with manageBroker and NO running
// broker; it must spawn the bundled broker and become reachable. Exits 0 on OK.
import { RelayClientV2 } from './lib/client-v2.js'
import { apply as applyPlugin } from './lib/index.js'

const SECRET = 'manage-broker-secret'
const PORT = 19100 + Math.floor(Math.random() * 500) // random, avoid orphan collisions
const DATA = process.cwd() + '/data'
const { mkdirSync, writeFileSync } = await import('node:fs')
mkdirSync(DATA, { recursive: true })

const cfgPath = process.cwd() + '/broker-config.yaml'
writeFileSync(cfgPath, [
  'broker:',
  '  host: 127.0.0.1',
  '  port: ' + PORT,
  '  secret: ' + SECRET,
  '  storage: sqlite',
  '  dataDir: ' + DATA,
  '  persist: false',
  'agents: {}',
].join('\n'), 'utf8')

const recorded = { tools: [], cleanups: [] }
const ctx = {
  agents: { get: () => null, list: () => [], create: async () => { throw new Error('not used') }, resume: async () => { throw new Error('not used') } },
  tools: { register(d) { recorded.tools.push(d); return () => {} } },
  systemPrompt: { section() { return () => {} } },
  webServer: { register() { return () => {} } },
  timeout: (a, b) => (typeof a === 'function' ? setTimeout(a, b) : new Promise((r) => setTimeout(r, a))),
  interval(fn, ms) { const t = setInterval(fn, ms); return () => clearInterval(t) },
  effect(fn) { recorded.cleanups.push(fn); return () => {} },
  get() { return null },
}

applyPlugin(ctx, { endpoint: `http://127.0.0.1:${PORT}`, agentName: 'dsh', secret: SECRET, brokerConfigPath: cfgPath, manageBroker: true })

const client = new RelayClientV2({ endpoint: `http://127.0.0.1:${PORT}`, agent: 'dsh', secret: SECRET })
let healthy = false
for (let i = 0; i < 90; i++) {
  await new Promise((r) => setTimeout(r, 300))
  try {
    const h = await client.health()
    if (h.ok) { healthy = true; break }
  } catch { /* keep waiting */ }
}
if (!healthy) { console.error('FAIL: plugin did not spawn a reachable broker'); process.exit(1) }
if (!recorded.tools.some((t) => t.name === 'agent_relay_send')) { console.error('FAIL: tools not registered'); process.exit(1) }
// Run the plugin's cleanups so the managed broker is killed (no orphan).
for (const fn of recorded.cleanups) { try { fn() } catch { /* ignore */ } }
console.log('OK manage-broker spawned the broker')
// Let the child-process handle close before exiting (avoids a Windows libuv
// assertion when process.exit runs while the killed child is still closing).
await new Promise((r) => setTimeout(r, 500))
process.exit(0)
