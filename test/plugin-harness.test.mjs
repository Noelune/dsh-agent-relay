import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, cpSync, writeFileSync, mkdirSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Assemble a self-contained temp dir (lib/ + broker/ + a stub dsh-tools
 * package + the harness script) and run it as a subprocess. The plugin's
 * `@deepseek-ai/dsh-tools` import is resolved inside the temp dir, so the stub
 * never touches the repo's node_modules. This exercises the plugin end-to-end
 * against a real broker with a mocked dsh host.
 */
function runHarness() {
  return new Promise((resolve) => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-plugin-harness-'))
    try {
      // lib/ + broker/ + fixtures
      cpSync(join(repoRoot, 'lib'), join(dir, 'lib'), { recursive: true })
      cpSync(join(repoRoot, 'broker'), join(dir, 'broker'), { recursive: true })
      // stub dsh-tools so lib/index.js can import it
      const stubDir = join(dir, 'node_modules', '@deepseek-ai', 'dsh-tools')
      mkdirSync(stubDir, { recursive: true })
      cpSync(join(repoRoot, 'test-fixtures', 'dsh-tools-stub', 'index.js'), join(stubDir, 'index.js'))
      writeFileSync(join(stubDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-tools', version: '0.0.0-stub', type: 'module', main: 'index.js' }))
      cpSync(join(repoRoot, 'test-fixtures', 'plugin-harness-run.mjs'), join(dir, 'run.mjs'))

      const child = spawn(process.execPath, ['run.mjs'], { cwd: dir, encoding: 'utf8' })
      let stdout = ''
      let stderr = ''
      child.stdout.setEncoding('utf8').on('data', (c) => { stdout += c })
      child.stderr.setEncoding('utf8').on('data', (c) => { stderr += c })
      child.on('close', (status) => {
        rmSync(dir, { recursive: true, force: true })
        resolve({ status, stdout, stderr })
      })
      child.on('error', (err) => {
        rmSync(dir, { recursive: true, force: true })
        resolve({ status: -1, stdout, stderr: String(err.message) })
      })
    } catch (err) {
      resolve({ status: -1, stdout: '', stderr: String(err.message) })
    }
  })
}

test('dsh plugin (v2) round-trips against a real broker with a mocked dsh host', async () => {
  const result = await runHarness()
  assert.equal(result.status, 0, `harness failed (${result.status})\n${result.stdout}\n${result.stderr}`)
  assert.ok(result.stdout.includes('OK'), result.stdout)
}, { timeout: 60000 })
