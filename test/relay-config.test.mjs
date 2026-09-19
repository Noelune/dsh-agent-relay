/**
 * The shared config resolver: every command-line entrypoint (CLI, MCP server,
 * inbox worker) reads identity and credentials through this, so one rule about
 * precedence and key spelling holds for all three.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { relaySettings } from '../lib/relay-config.mjs'

const FILE = {
  endpoint: 'http://127.0.0.1:19121',
  agent: 'Dsh',
  secret_ref: 'dsh-entry',
  vault_module: 'D:/vault/module.py',
  key_id: 'legacy',
}

test('layers resolve lowest to highest: file, then environment, then flag', () => {
  const fromFile = relaySettings({ flags: {}, env: {}, file: FILE })
  assert.deepEqual(
    { agent: fromFile.agent, endpoint: fromFile.endpoint, secretRef: fromFile.secretRef, keyId: fromFile.keyId },
    { agent: 'dsh', endpoint: 'http://127.0.0.1:19121', secretRef: 'dsh-entry', keyId: 'legacy' },
    'the agent name is folded to lowercase because that is the wire identity',
  )

  const fromEnv = relaySettings({ flags: {}, env: { AGENT_RELAY_AGENT: 'codex' }, file: FILE })
  assert.equal(fromEnv.agent, 'codex')

  const fromFlag = relaySettings({ flags: { agent: 'claude' }, env: { AGENT_RELAY_AGENT: 'codex' }, file: FILE })
  assert.equal(fromFlag.agent, 'claude')
})

test('both env prefixes and both key spellings are accepted', () => {
  // The CLI historically documented DSH_RELAY_*, the worker and MCP AGENT_RELAY_*;
  // the deployment file mixes secret_ref with secretRef. A member should not have
  // to know which file it is reading.
  const older = relaySettings({ flags: {}, env: { DSH_RELAY_AGENT: 'zcode', DSH_RELAY_BROKER_URL: 'http://127.0.0.1:2' }, file: {} })
  assert.deepEqual({ agent: older.agent, endpoint: older.endpoint }, { agent: 'zcode', endpoint: 'http://127.0.0.1:2' })

  const camel = relaySettings({ flags: {}, env: {}, file: { agent: 'qoder', secretRef: 'camel-entry', vaultModule: 'v.py', keyId: 'k2' } })
  assert.deepEqual(
    { agent: camel.agent, secretRef: camel.secretRef, vaultModule: camel.vaultModule, keyId: camel.keyId },
    { agent: 'qoder', secretRef: 'camel-entry', vaultModule: 'v.py', keyId: 'k2' },
  )
})

test('an empty value never shadows a real one, and the endpoint still defaults', () => {
  const out = relaySettings({ flags: { agent: '   ', broker: '' }, env: { AGENT_RELAY_AGENT: 'hermes' }, file: { endpoint: '' } })
  assert.equal(out.agent, 'hermes', 'a blank flag must not silence the env layer')
  assert.equal(out.endpoint, 'http://127.0.0.1:19121', 'a blank file entry falls through to the loopback default')
  assert.equal(relaySettings({ flags: {}, env: {}, file: {} }).endpoint, 'http://127.0.0.1:19121')
})
