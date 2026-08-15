import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

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

test('Python relay client contract', () => {
  const python = findPython()
  assert.ok(python, 'Python 3.10+ is required to test the shipped Python adapter')
  // Run the test file directly instead of `python -m unittest test/...`: the
  // `test` package name collides with the Python standard library's `test`
  // package on some interpreters (notably Linux), which shadows the local
  // directory and breaks module-path resolution.
  const result = spawnSync(
    python.command,
    [...python.prefix, 'test/test_relay_client.py', '-v'],
    { cwd: repoRoot, encoding: 'utf8' },
  )
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
})
