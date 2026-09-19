/**
 * Shared broker fixture for tests: one place that knows how to boot an
 * isolated, non-persisting broker on an ephemeral port and shut it down
 * without racing held long-polls.
 *
 *   const fx = await startBroker({ agents: { alpha: {} } })
 *   ... use fx.endpoint / fx.port / fx.store ...
 *   await fx.stop()
 *
 * Protocol-wire tests deliberately keep their own signing helpers: signing the
 * request by hand is the point of those tests, so they must not depend on the
 * client under test.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBrokerServer } from '../../broker/src/server.js'
import { createV2Store } from '../../broker/src/store-v2.js'

export const TEST_SECRET = 'shared-secret-value'

export function tempDataDir(prefix = 'relay-test-') {
  return mkdtempSync(join(tmpdir(), prefix))
}

/** @returns {Promise<{server, store, config, port, endpoint, dir, stop}>} */
export async function startBroker({
  secret = TEST_SECRET,
  agents = {},
  dataDir = tempDataDir(),
  leaseSeconds = 600,
  maxAttempts = 3,
  messageTtlDays = 7,
  notifyFailedToSender = true,
  persist = false,
} = {}) {
  const config = {
    host: '127.0.0.1', port: 0, secret, tls: false,
    rateLimitLoopback: 1e6, rateLimitRemote: 1e6, messageTtlDays,
    persist, dataDir, lockAfterFailures: 5, lockMinutes: 5,
    leaseSeconds, maxAttempts, notifyFailedToSender, agents,
  }
  const store = createV2Store({ dataDir, persist, leaseSeconds, maxAttempts })
  const server = createBrokerServer({ config, storeV2: store })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  return {
    server, store, config, port, dir: dataDir,
    endpoint: `http://127.0.0.1:${port}`,
    async stop({ removeDir = true } = {}) {
      server.releaseWaiters?.()
      server.closeAllConnections?.()
      await new Promise((resolve) => server.close(resolve))
      store.close()
      if (removeDir) rmSync(dataDir, { recursive: true, force: true })
    },
  }
}
