import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { memorySearch, formatMemoryContext } from '../lib/memory-bridge.js'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const mockCmd = `node ${join(repoRoot, 'test-fixtures', 'memory-mock.mjs')}`

test('memorySearch runs the CLI and returns the <memory-data> output', async () => {
  const result = await memorySearch({ cmd: mockCmd, query: 'staging 服务器', limit: 5 })
  assert.equal(result.ok, true)
  assert.ok(result.output.includes('<memory-data>'))
  assert.ok(result.output.includes('query=staging 服务器'))
  assert.ok(result.output.includes('limit=5'))
})

test('memorySearch without a command reports not configured', async () => {
  const result = await memorySearch({ cmd: '', query: 'x' })
  assert.equal(result.ok, false)
  assert.match(result.error, /not configured/)
})

test('memorySearch surfaces a failing command', async () => {
  const result = await memorySearch({ cmd: 'node definitely-not-a-real-script-xyz.mjs', query: 'x' })
  assert.equal(result.ok, false)
  assert.ok(result.error)
})

test('formatMemoryContext wraps a result and explains an unavailable bridge', () => {
  const block = formatMemoryContext({ ok: true, output: '<memory-data>stuff</memory-data>' })
  assert.ok(block.includes('共享记忆摘录'))
  assert.ok(block.includes('<memory-data>'))
  const missing = formatMemoryContext({ ok: false, error: 'memory command not configured' })
  assert.ok(missing.includes('UNIFIED_MEMORY_CMD'))
})
