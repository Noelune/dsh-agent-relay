/**
 * Credential resolution for the non-plugin entrypoints. The rule this locks:
 * a host config may **name** where a secret lives, but must not become a second
 * plaintext copy of it.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveSecret, readEnvFileSecret, describeSecretSource } from '../lib/credentials.mjs'

const DIR = mkdtempSync(join(tmpdir(), 'relay-cred-'))

test('readEnvFileSecret picks the member line and nothing else', () => {
  const file = join(DIR, 'bot.env')
  writeFileSync(file, [
    'FEISHU_APP_SECRET="do-not-touch-me"',
    "AGENT_RELAY_CODEX_SECRET='codex-secret-value'",
    'AGENT_RELAY_CLAUDE_SECRET=claude-secret-value',
    'AGENT_RELAY_MY_AGENT_SECRET=dashed-secret',
    '# AGENT_RELAY_COMMENTED_SECRET=ignored',
    '',
  ].join('\n'), 'utf8')

  assert.equal(readEnvFileSecret(file, 'codex'), 'codex-secret-value')
  assert.equal(readEnvFileSecret(file, 'CLAUDE'), 'claude-secret-value')
  assert.equal(readEnvFileSecret(file, 'my-agent'), 'dashed-secret', 'dashes map to underscores')
  assert.equal(readEnvFileSecret(file, 'hermes'), '', 'absent member resolves to nothing')
  assert.equal(readEnvFileSecret(join(DIR, 'nope.env'), 'codex'), '', 'a missing file is not an error')
})

test('precedence: inline > env > env file; no plaintext value is ever returned by the describer', async () => {
  const file = join(DIR, 'precedence.env')
  writeFileSync(file, 'AGENT_RELAY_DSH_SECRET=from-file\n', 'utf8')

  assert.equal(await resolveSecret({ agent: 'dsh', secret: 'inline', secretEnvFile: file }), 'inline')
  assert.equal(
    await resolveSecret({ agent: 'dsh', secretEnv: 'MY_RELAY', secretEnvFile: file }, { env: { MY_RELAY: 'from-env' } }),
    'from-env',
  )
  assert.equal(await resolveSecret({ agent: 'dsh', secretEnvFile: file }, { env: {} }), 'from-file')
  assert.equal(await resolveSecret({ agent: 'dsh' }, { env: {} }), '')

  assert.equal(describeSecretSource({ agent: 'dsh', secretEnvFile: file }, { env: {} }), `dotenv ${file}`)
  assert.equal(describeSecretSource({ agent: 'dsh', secret: 'inline' }, { env: {} }), 'inline secret (prefer secret_env_file or secret_ref)')
  assert.doesNotMatch(describeSecretSource({ agent: 'dsh', secret: 'super-secret-value' }, { env: {} }), /super-secret-value/)
})

test('an unresolvable vault reference yields no secret instead of throwing', async () => {
  const result = await resolveSecret({
    agent: 'codex', secretRef: 'missing-entry', vaultModule: join(DIR, 'no-such-vault.py'),
  }, { env: {} })
  assert.equal(result, '')
})

after(() => rmSync(DIR, { recursive: true, force: true }))
