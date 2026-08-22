/**
 * dsh-agent-relay broker entrypoint.
 *
 *   node broker/src/index.js [--config path/to/config.yaml]
 *
 * Default config path: ./config.yaml (relative to the broker directory).
 */
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig, normalizeConfig } from './config.js'
import { createAuthenticator } from './auth.js'
import { createStore } from './store.js'
import { createV2Store } from './store-v2.js'
import { createBrokerServer } from './server.js'

const here = dirname(fileURLToPath(import.meta.url))
const BROKER_DIR = resolve(here, '..')

function parseArgs(argv) {
  const args = { config: join(BROKER_DIR, 'config.yaml') }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--config' && argv[i + 1]) {
      args.config = resolve(argv[i + 1])
      i++
    }
  }
  return args
}

const { config: configPath } = parseArgs(process.argv.slice(2))
const config = normalizeConfig(loadConfig(configPath))
const store = createStore({
  ttlDays: config.messageTtlDays,
  persist: config.persist,
  dataDir: resolve(BROKER_DIR, config.dataDir),
  storage: config.storage,
  maxAttempts: config.maxAttempts,
})
// Both stores resolve dataDir against the broker directory — a relative
// dataDir (the './data' default) must not depend on the process CWD.
const storeV2 = createV2Store({
  dataDir: resolve(BROKER_DIR, config.dataDir),
  persist: config.persist,
  leaseSeconds: config.leaseSeconds,
  maxAttempts: config.maxAttempts,
})
const auth = createAuthenticator({
  secret: config.secret,
  agents: config.agents,
  lockAfterFailures: config.lockAfterFailures,
  lockMinutes: config.lockMinutes,
  rateLimitLoopback: config.rateLimitLoopback,
  rateLimitRemote: config.rateLimitRemote,
})
const server = createBrokerServer({ config, store, auth, storeV2 })

server.listen(config.port, config.host, () => {
  console.log(`[relay-broker] listening on http://${config.host}:${config.port}`)
  console.log(`[relay-broker] protocol 1.0 | storage=${config.storage} | persist=${config.persist} | ttl=${config.messageTtlDays}d`)
})

server.on('error', (err) => {
  console.error(`[relay-broker] fatal: ${err.message}`)
  process.exit(1)
})

function shutdown() {
  store.close?.()
  storeV2.close?.()
  server.close(() => process.exit(0))
}
process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
