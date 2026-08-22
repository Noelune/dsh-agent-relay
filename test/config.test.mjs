import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig, normalizeConfig } from '../broker/src/config.js'

function baseConfig(overrides = {}) {
  return {
    broker: {
      secret: 'test-secret',
      ...overrides.broker,
    },
    security: {
      ...overrides.security,
    },
    agents: overrides.agents,
  }
}

test('config: rejects invalid safety and delivery limits at startup', () => {
  const invalid = [
    ['broker.messageTtlDays', baseConfig({ broker: { messageTtlDays: -1 } })],
    ['broker.leaseSeconds', baseConfig({ broker: { leaseSeconds: 0 } })],
    ['broker.leaseSeconds', baseConfig({ broker: { leaseSeconds: 86401 } })],
    ['broker.maxAttempts', baseConfig({ broker: { maxAttempts: -1 } })],
    ['broker.rateLimitLoopback', baseConfig({ broker: { rateLimitLoopback: 0 } })],
    ['broker.rateLimitRemote', baseConfig({ broker: { rateLimitRemote: 1.5 } })],
    ['security.lockAfterFailures', baseConfig({ security: { lockAfterFailures: 0 } })],
    ['security.lockMinutes', baseConfig({ security: { lockMinutes: -1 } })],
  ]

  for (const [name, loaded] of invalid) {
    assert.throws(() => normalizeConfig(loaded), new RegExp(`invalid ${name.replace('.', '\\.')}`))
  }
})

test('config: rejects the removed TLS label instead of claiming HTTPS', () => {
  assert.throws(() => normalizeConfig(baseConfig({ broker: { tls: true } })), /broker\.tls.*not supported/)
})

test('config: parses documented inline ACL arrays', () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-config-'))
  const path = join(dir, 'config.yaml')
  try {
    writeFileSync(path, [
      'broker:',
      '  secret: test-secret',
      'agents:',
      '  alpha:',
      '    allowed_targets: [beta, gamma]',
    ].join('\n'), 'utf8')
    const config = normalizeConfig(loadConfig(path))
    assert.deepEqual(config.agents.alpha.allowedTargets, ['beta', 'gamma'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('config: accepts optional per-agent secrets alongside routing ACLs', () => {
  const config = normalizeConfig(baseConfig({
    agents: {
      alpha: { secret: 'alpha-secret', allowed_targets: ['beta'] },
      beta: { secret: 'beta-secret' },
    },
  }))
  assert.deepEqual(config.agents.alpha, {
    secret: 'alpha-secret',
    keys: { legacy: { secret: 'alpha-secret', notAfter: null } },
    allowedTargets: ['beta'],
    allowedReadTargets: ['beta'],
    allowedContinueTargets: ['beta'],
    allowedWriteTargets: [],
  })
  assert.deepEqual(config.agents.beta, {
    secret: 'beta-secret',
    keys: { legacy: { secret: 'beta-secret', notAfter: null } },
    allowedTargets: null,
    allowedReadTargets: null,
    allowedContinueTargets: null,
    allowedWriteTargets: [],
  })
})

test('config: per-mode ACL — write closed by default, read/continue from allowed_targets', () => {
  const config = normalizeConfig(baseConfig({
    agents: {
      alpha: { allowed_targets: ['beta'], allowed_write_targets: ['gamma'] },
      delta: { allowed_read_targets: ['beta'], allowed_continue_targets: ['beta', 'gamma'], allowed_write_targets: ['beta'] },
    },
  }))
  assert.deepEqual(config.agents.alpha.allowedReadTargets, ['beta'])
  assert.deepEqual(config.agents.alpha.allowedContinueTargets, ['beta'])
  assert.deepEqual(config.agents.alpha.allowedWriteTargets, ['gamma'])
  assert.deepEqual(config.agents.delta.allowedReadTargets, ['beta'])
  assert.deepEqual(config.agents.delta.allowedContinueTargets, ['beta', 'gamma'])
  assert.deepEqual(config.agents.delta.allowedWriteTargets, ['beta'])
})

test('config: agent target lists are lowercased (v2 matches on lowercase names)', () => {
  const config = normalizeConfig(baseConfig({
    agents: {
      alpha: { allowed_targets: ['Beta'], allowed_read_targets: ['Gamma', 'beta'] },
    },
  }))
  assert.deepEqual(config.agents.alpha.allowedTargets, ['beta'])
  assert.deepEqual(config.agents.alpha.allowedReadTargets, ['gamma', 'beta'])
})
