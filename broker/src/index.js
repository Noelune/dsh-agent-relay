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
})
const auth = createAuthenticator({
  secret: config.secret,
  lockAfterFailures: config.lockAfterFailures,
  lockMinutes: config.lockMinutes,
  rateLimitLoopback: config.rateLimitLoopback,
  rateLimitRemote: config.rateLimitRemote,
})
const server = createBrokerServer({ config, store, auth })

server.listen(config.port, config.host, () => {
  const proto = config.tls ? 'https' : 'http'
  console.log(`[relay-broker] listening on ${proto}://${config.host}:${config.port}`)
  console.log(`[relay-broker] protocol 1.0 | persist=${config.persist} | ttl=${config.messageTtlDays}d`)
})

server.on('error', (err) => {
  console.error(`[relay-broker] fatal: ${err.message}`)
  process.exit(1)
})
