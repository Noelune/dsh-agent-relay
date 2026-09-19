/**
 * `relay doctor` is the operator's single question — "is the circle working?" —
 * so its verdicts and exit codes are behaviour worth locking.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBrokerServer } from '../broker/src/server.js'
import { createV2Store } from '../broker/src/store-v2.js'
import { runDoctor, formatReport } from '../setup/doctor.mjs'

const SECRET = 'doctor-secret'

async function withBroker(agents, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'relay-doctor-'))
  const config = {
    host: '127.0.0.1', port: 0, secret: SECRET, tls: false,
    rateLimitLoopback: 1e6, rateLimitRemote: 1e6, messageTtlDays: 7,
    persist: false, dataDir: dir, lockAfterFailures: 5, lockMinutes: 5,
    leaseSeconds: 600, maxAttempts: 3, notifyFailedToSender: true, agents,
  }
  const storeV2 = createV2Store({ dataDir: dir, persist: false, leaseSeconds: 600, maxAttempts: 3 })
  const server = createBrokerServer({ config, storeV2 })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  try {
    return await fn({ port: server.address().port, dir, storeV2 })
  } finally {
    server.releaseWaiters?.()
    server.closeAllConnections?.()
    await new Promise((r) => server.close(r))
    storeV2.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

const find = (report, name) => report.checks.find((c) => c.name === name)

test('doctor reports an unreachable broker as fail', async () => {
  const report = await runDoctor({ broker: 'http://127.0.0.1:1', config: join(tmpdir(), 'nope.yaml') })
  assert.equal(find(report, 'broker').status, 'fail')
  assert.equal(report.status, 'fail')
})

test('doctor separates members that can receive from members that cannot', async () => {
  await withBroker({ awake: {}, deaf: {} }, async ({ port, dir }) => {
    // `awake` has claimed; `deaf` never has.
    const { RelayClientV2 } = await import('../lib/client-v2.js')
    const client = new RelayClientV2({ endpoint: `http://127.0.0.1:${port}`, agent: 'awake', secret: SECRET })
    await client.pull({ limit: 1 })

    const yaml = join(dir, 'config.yaml')
    writeFileSync(yaml, [
      'agents:',
      '  awake:',
      '    secret: doctor-secret',
      '  deaf:',
      '    secret: doctor-secret',
      '',
    ].join('\n'), 'utf8')
    const envFile = join(dir, 'bot.env')
    writeFileSync(envFile, 'AGENT_RELAY_AWAKE_SECRET=doctor-secret\nAGENT_RELAY_DEAF_SECRET=doctor-secret\n', 'utf8')
    writeFileSync(join(dir, 'relay-v2.db'), 'x'.repeat(2048), 'utf8')

    const report = await runDoctor({
      broker: `http://127.0.0.1:${port}`, config: yaml, envFile, dataDir: dir,
      deployedAdapter: join(dir, 'none.py'), adapterBaseline: join(dir, 'none.py'),
    })
    const members = find(report, 'members')
    assert.equal(members.status, 'warn', 'somebody is deaf → warn')
    assert.match(members.detail, /听不到：deaf/)
    assert.equal(find(report, 'secrets').status, 'ok')
    assert.equal(find(report, 'on-demand').status, 'warn', 'no wake_command configured yet')
    assert.match(formatReport(report), /✓ secrets/)
  })
})

test('doctor tells an operator which member can be woken, and flags credential drift by name only', async () => {
  await withBroker({ awake: {}, deaf: {} }, async ({ port, dir }) => {
    const yaml = join(dir, 'config.yaml')
    writeFileSync(yaml, [
      'agents:',
      '  awake:',
      '    secret: doctor-secret',
      '    wake_command: "node worker --once"',
      '  deaf:',
      '    secret: doctor-secret',
      '',
    ].join('\n'), 'utf8')
    const envFile = join(dir, 'bot.env')
    writeFileSync(envFile, 'AGENT_RELAY_AWAKE_SECRET=doctor-secret\nAGENT_RELAY_DEAF_SECRET=WRONG-OTHER-VALUE\n', 'utf8')
    writeFileSync(join(dir, 'relay-v2.db'), 'x'.repeat(1024), 'utf8')

    const report = await runDoctor({
      broker: `http://127.0.0.1:${port}`, config: yaml, envFile, dataDir: dir,
      deployedAdapter: join(dir, 'none.py'), adapterBaseline: join(dir, 'none.py'),
    })
    assert.match(find(report, 'on-demand').detail, /可被唤醒：awake/)
    assert.match(find(report, 'on-demand').detail, /仍无法投递：deaf/)
    const secrets = find(report, 'secrets')
    assert.equal(secrets.status, 'fail')
    assert.match(secrets.detail, /漂移 deaf/)
    assert.ok(!JSON.stringify(report).includes('WRONG-OTHER-VALUE'), 'a secret value must never appear in the report')
  })
})

test('doctor flags a plaintext secret file', async () => {
  await withBroker({ awake: {} }, async ({ port, dir }) => {
    const yaml = join(dir, 'config.yaml')
    writeFileSync(yaml, 'agents:\n  awake:\n    secret: doctor-secret\n', 'utf8')
    const envFile = join(dir, 'bot.env')
    writeFileSync(envFile, 'AGENT_RELAY_AWAKE_SECRET=doctor-secret\n', 'utf8')
    const agentConfig = join(dir, 'agent-relay.json')
    writeFileSync(agentConfig, JSON.stringify({ agent: 'awake', secret: 'a'.repeat(64) }), 'utf8')
    writeFileSync(join(dir, 'relay-v2.db'), 'x'.repeat(1024), 'utf8')

    const report = await runDoctor({
      broker: `http://127.0.0.1:${port}`, config: yaml, envFile, dataDir: dir,
      agentConfig, deployedAdapter: join(dir, 'none.py'), repoAdapter: join(dir, 'none.py'),
    })
    assert.equal(find(report, 'plaintext').status, 'fail')
  })
})


test('doctor detects drift between the deployed adapter and its recorded baseline', async () => {
  await withBroker({ awake: {} }, async ({ port, dir }) => {
    const { createHash } = await import('node:crypto')
    const deployed = join(dir, 'adapter.py')
    const baseline = join(dir, 'baseline.json')
    const yaml = join(dir, 'config.yaml')
    const envFile = join(dir, 'bot.env')
    const live = 'print("live adapter")\n'
    writeFileSync(deployed, live, 'utf8')
    writeFileSync(baseline, JSON.stringify({ sha256: createHash('sha256').update(live, 'utf8').digest('hex'), lines: 2 }), 'utf8')
    writeFileSync(yaml, 'agents:\n  awake:\n    secret: doctor-secret\n', 'utf8')
    writeFileSync(envFile, 'AGENT_RELAY_AWAKE_SECRET=doctor-secret\n', 'utf8')
    writeFileSync(join(dir, 'relay-v2.db'), 'x'.repeat(1024), 'utf8')

    const args = {
      broker: `http://127.0.0.1:${port}`, config: yaml, envFile, dataDir: dir,
      deployedAdapter: deployed, adapterBaseline: baseline,
    }
    assert.equal(find(await runDoctor(args), 'adapter').status, 'ok')

    writeFileSync(deployed, 'print("somebody edited it")\n', 'utf8')
    const drifted = find(await runDoctor(args), 'adapter')
    assert.equal(drifted.status, 'fail')
    assert.match(drifted.detail, /偏离基线/)
  })
})
