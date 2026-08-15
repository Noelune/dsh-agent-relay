import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { createStore } from '../broker/src/store.js'
import { createAuthenticator } from '../broker/src/auth.js'
import { createBrokerServer } from '../broker/src/server.js'
import { createV2Store } from '../broker/src/store-v2.js'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const SECRET = randomBytes(32).toString('hex')
const DATA_DIR = mkdtempSync(join(tmpdir(), 'relay-pyv2-'))
let server
let port

before(async () => {
  const config = {
    host: '127.0.0.1', port: 0, secret: SECRET, tls: false,
    rateLimitLoopback: 100000, rateLimitRemote: 100000, messageTtlDays: 7,
    persist: false, dataDir: DATA_DIR, lockAfterFailures: 5, lockMinutes: 5,
    leaseSeconds: 600, maxAttempts: 3, notifyFailedToSender: true, agents: {},
  }
  const store = createStore({ ttlDays: 7, persist: false, dataDir: DATA_DIR })
  const auth = createAuthenticator({ secret: SECRET, lockAfterFailures: 5, lockMinutes: 5, rateLimitLoopback: 100000, rateLimitRemote: 100000 })
  const v2Store = createV2Store({ dataDir: DATA_DIR, persist: false, leaseSeconds: 600, maxAttempts: 3 })
  server = createBrokerServer({ config, store, auth, storeV2: v2Store })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = server.address().port
})

after(async () => {
  await new Promise((resolve) => server.close(resolve))
  rmSync(DATA_DIR, { recursive: true, force: true })
})

function findPython() {
  const candidates = process.platform === 'win32'
    ? [['py', ['-3']], ['python', []]]
    : [['python3', []], ['python', []]]
  for (const [command, prefix] of candidates) {
    const result = spawnSync(command, [...prefix, '--version'], { encoding: 'utf8' })
    if (result.status === 0) return { command, prefix }
  }
  return null
}

/** Run the Python client via async spawn so the in-process broker keeps serving. */
function runPython(python, args) {
  return new Promise((resolve) => {
    const child = spawn(python.command, [...python.prefix, ...args], { cwd: repoRoot, encoding: 'utf8' })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (c) => { stdout += c })
    child.stderr.setEncoding('utf8').on('data', (c) => { stderr += c })
    child.on('close', (status) => resolve({ status, stdout, stderr }))
    child.on('error', (err) => resolve({ status: -1, stdout, stderr: String(err.message) }))
  })
}

test('Python RelayClientV2 round-trips against the live Node broker', async () => {
  const python = findPython()
  assert.ok(python, 'Python 3.10+ is required for the cross-language client test')
  const result = await runPython(python, ['test/test_relay_client_v2.py', `http://127.0.0.1:${port}`, SECRET])
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
})
