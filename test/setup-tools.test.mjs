import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { execPath } from 'node:process'
import { fileURLToPath } from 'node:url'
import { loadConfig } from '../broker/src/config.js'

// Regression tests for the member-secret tooling: sync-secrets.mjs and
// add-member.mjs must keep the broker YAML and the agent-side .env in
// agreement, and their YAML output must stay loadable by the broker's own
// config parser.

const SETUP_DIR = fileURLToPath(new URL('../setup/', import.meta.url))

function makeFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'relay-setup-tools-'))
  const config = join(dir, 'config.yaml')
  const env = join(dir, 'agents.env')
  writeFileSync(config, [
    'broker:',
    '  host: 127.0.0.1',
    '  port: 19121',
    '',
    'agents:',
    '  alpha:',
    '    secret: aaaa',
    '    allowed_read_targets: [beta]',
    '    allowed_write_targets: []',
    '  beta:',
    '    secret: bbbb',
    '    allowed_read_targets: [alpha]',
    '    allowed_write_targets: []',
    '',
  ].join('\n'))
  writeFileSync(env, 'AGENT_RELAY_ALPHA_SECRET=aaaa\nAGENT_RELAY_BETA_SECRET=bbbb\n')
  return { dir, config, env }
}

const run = (script, args) => spawnSync(execPath, [join(SETUP_DIR, script), ...args], { encoding: 'utf8' })

test('sync-secrets: matching fixture exits 0 with ok=2', () => {
  const f = makeFixture()
  try {
    const r = run('sync-secrets.mjs', ['--config', f.config, '--env', f.env])
    assert.equal(r.status, 0, r.stderr || r.stdout)
    assert.match(r.stdout, /ok=2 drift=0/)
  } finally {
    rmSync(f.dir, { recursive: true, force: true })
  }
})

test('sync-secrets: drifted .env exits 1 and names the member', () => {
  const f = makeFixture()
  try {
    writeFileSync(f.env, 'AGENT_RELAY_ALPHA_SECRET=aaaa\nAGENT_RELAY_BETA_SECRET=WRONG\n')
    const r = run('sync-secrets.mjs', ['--config', f.config, '--env', f.env])
    assert.equal(r.status, 1)
    assert.match(r.stdout, /DRIFT: beta/)
  } finally {
    rmSync(f.dir, { recursive: true, force: true })
  }
})

test('add-member: onboards gamma, rewrites inbound ACLs, yaml stays loadable', () => {
  const f = makeFixture()
  try {
    const r = run('add-member.mjs', ['gamma', '--config', f.config, '--env', f.env])
    assert.equal(r.status, 0, r.stderr || r.stdout)
    const text = readFileSync(f.config, 'utf8')
    assert.match(text, /  gamma:\n    secret: [0-9a-f]{64}\n    allowed_read_targets: \[alpha, beta\]\n    allowed_write_targets: \[\]\n/)
    assert.match(text, /allowed_read_targets: \[beta, gamma\]/)
    assert.match(text, /allowed_read_targets: \[alpha, gamma\]/)
    assert.match(readFileSync(f.env, 'utf8'), /AGENT_RELAY_GAMMA_SECRET=[0-9a-f]{64}/)
    const loaded = loadConfig(f.config)
    assert.ok(loaded?.agents?.gamma, 'broker loadConfig should expose the new member')
    const check = run('sync-secrets.mjs', ['--config', f.config, '--env', f.env])
    assert.equal(check.status, 0)
    assert.match(check.stdout, /ok=3 drift=0/)
  } finally {
    rmSync(f.dir, { recursive: true, force: true })
  }
})

test('add-member: refuses duplicate member', () => {
  const f = makeFixture()
  try {
    const r = run('add-member.mjs', ['alpha', '--config', f.config, '--env', f.env])
    assert.equal(r.status, 1)
    assert.match(r.stderr, /already exists/)
  } finally {
    rmSync(f.dir, { recursive: true, force: true })
  }
})

test('add-member: refuses unknown --read-targets', () => {
  const f = makeFixture()
  try {
    const r = run('add-member.mjs', ['gamma', '--read-targets', 'nobody', '--config', f.config, '--env', f.env])
    assert.equal(r.status, 1)
    assert.match(r.stderr, /unknown member/)
  } finally {
    rmSync(f.dir, { recursive: true, force: true })
  }
})
