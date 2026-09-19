/**
 * Integration test for the *generated* wake command.
 *
 * `setup/enable-wake.mjs` produces a command line with nested quotes, absolute
 * paths and backslashes, which then goes through: the YAML-subset parser →
 * `spawn(shell: true)` → cmd.exe → Node's argv → relay-agent's own flag parser →
 * the backend. Every one of those hops can eat quoting, so the exact produced
 * string is tested here against a real broker with a **stub backend** (no agent
 * CLI, no API cost).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig, normalizeConfig } from '../broker/src/config.js'
import { createBrokerServer } from '../broker/src/server.js'
import { createV2Store } from '../broker/src/store-v2.js'
import { RelayClientV2 } from '../lib/client-v2.js'
import { wakeCommandFor, planWakeConfig } from '../setup/enable-wake.mjs'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SECRET = 'wake-it-secret'

function stubBackend(dir, name) {
  // Stands in for codex-backend.mjs: prompt on stdin, answer on stdout.
  const file = join(dir, `${name}-stub.mjs`)
  writeFileSync(file, [
    "const chunks = []",
    "for await (const c of process.stdin) chunks.push(c)",
    "const prompt = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8')",
    "process.stdout.write('STUB-REPLY to: ' + prompt.slice(0, 40))",
    '',
  ].join('\n'), 'utf8')
  return file
}

async function bootBroker(dir, agentsConfig) {
  const config = {
    host: '127.0.0.1', port: 0, secret: SECRET, tls: false,
    rateLimitLoopback: 1e6, rateLimitRemote: 1e6, messageTtlDays: 7,
    persist: false, dataDir: dir, lockAfterFailures: 5, lockMinutes: 5,
    leaseSeconds: 600, maxAttempts: 3, notifyFailedToSender: true,
    agents: agentsConfig,
  }
  const storeV2 = createV2Store({ dataDir: dir, persist: false, leaseSeconds: 600, maxAttempts: 3 })
  const server = createBrokerServer({ config, storeV2 })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { server, storeV2, port: server.address().port, config }
}

test('the generated wake_command survives the broker YAML parser verbatim', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wake-yaml-'))
  try {
    const command = wakeCommandFor('codex', { cwd: 'C:/Users/zhaowei' })
    const yaml = [
      'broker:',
      '  host: 127.0.0.1',
      '  port: 19121',
      '  secret: abc123',
      'agents:',
      '  codex:',
      '    secret: codex-secret',
      `    wake_command: "${command}"`,
      '',
    ].join('\n')
    const file = join(dir, 'config.yaml')
    writeFileSync(file, yaml, 'utf8')
    const config = normalizeConfig(loadConfig(file))
    assert.equal(config.agents.codex.wakeCommand, command, 'quotes and backslashes must round-trip')
    assert.ok(config.agents.codex.wakeCommand.includes('--backend-cmd "'), 'the inner quoting is preserved')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('planWakeConfig inserts once, is idempotent, and rejects unknown members', () => {
  const base = ['broker:', '  secret: x', 'agents:', '  codex:', '    secret: a', '  dsh:', '    secret: b', ''].join('\n')
  const first = planWakeConfig(base, ['codex'], { codex: 'node worker --once' })
  assert.equal(first.plan[0].status, 'add')
  assert.match(first.text, /^ {4}wake_command: "node worker --once"$/m)

  const second = planWakeConfig(first.text, ['codex'], { codex: 'node worker --once' })
  assert.equal(second.plan[0].status, 'already', 'running it twice must not stack lines')
  assert.equal(second.text, first.text)

  const bad = planWakeConfig(base, ['nobody'], { nobody: 'x' })
  assert.equal(bad.plan[0].status, 'unknown_agent')
  // Other members are untouched.
  assert.match(second.text, /  dsh:\n {4}secret: b/)
})

test('an offline member is woken by the real generated command and its answer comes back', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wake-e2e-'))
  let broker = null
  try {
    const stub = stubBackend(dir, 'codex')
    // Same shape as the generated command, with the stub in place of the CLI.
    const command = wakeCommandFor('codex', { cwd: dir })
      .replace(join(REPO_ROOT, 'adapters', 'backends', 'codex-backend.mjs'), stub)
    broker = await bootBroker(dir, {
      alpha: { secret: SECRET, allowedReadTargets: ['codex'] },
      codex: { secret: SECRET, wakeCommand: command },
    })
    const endpoint = `http://127.0.0.1:${broker.port}`
    const alpha = new RelayClientV2({ endpoint, agent: 'alpha', secret: SECRET })

    const started = Date.now()
    const result = await alpha.ask({ target: 'codex', body: '这段代码有并发问题吗', timeoutSeconds: 40 })
    assert.equal(result.ok, true, `the woken worker must answer: ${JSON.stringify(result)}`)
    assert.match(result.reply, /STUB-REPLY/)
    assert.ok(Date.now() - started < 35_000, 'the roundtrip must not wait for a poll period')

    // The worker claimed with the credential the broker injected via env, and it
    // acked: nothing is left pending for this member. Queue stats are keyed by the
    // message *target*, so the request counts under codex and the reply under alpha.
    const q = broker.storeV2.queueStats(['alpha', 'codex'])
    assert.equal(q.codex.queued, 0)
    assert.equal(q.codex.completed, 1, 'the request was claimed and finished')
    assert.equal(q.alpha.completed, 1, 'the reply was delivered and finished')
    assert.equal(q.codex.failed, 0)
    assert.equal(q.codex.expired, 0)
  } finally {
    broker?.server.releaseWaiters?.()
    broker?.server.closeAllConnections?.()
    await new Promise((r) => broker?.server.close(r))
    broker?.storeV2.close()
    rmSync(dir, { recursive: true, force: true })
  }
}, { timeout: 60_000 })

test('a member that is alive is never woken, so nothing is double-served', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wake-alive-'))
  const marker = join(dir, 'spawned.marker')
  let broker = null
  try {
    const helper = join(dir, 'spawn-helper.mjs')
    writeFileSync(helper, `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(marker)}, 'x')\n`, 'utf8')
    const command = `"${process.execPath}" ${helper}`
    broker = await bootBroker(dir, {
      alpha: { secret: SECRET },
      codex: { secret: SECRET, wakeCommand: command },
    })
    const endpoint = `http://127.0.0.1:${broker.port}`
    const peer = new RelayClientV2({ endpoint, agent: 'codex', secret: SECRET })
    const alpha = new RelayClientV2({ endpoint, agent: 'alpha', secret: SECRET })

    await peer.pull({ limit: 1 }) // a timer poll registers presence
    const result = await alpha.ask({ target: 'codex', body: 'hi', timeoutSeconds: 3 })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'timeout', 'the live peer simply never answered — but no worker was started')
    assert.equal(existsSync(marker), false, 'a present member must not be woken behind its own back')
  } finally {
    broker?.server.releaseWaiters?.()
    broker?.server.closeAllConnections?.()
    await new Promise((r) => broker?.server.close(r))
    broker?.storeV2.close()
    rmSync(dir, { recursive: true, force: true })
  }
}, { timeout: 60_000 })
