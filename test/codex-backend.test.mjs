/**
 * Codex backend output handling. The captured fixture below is the real
 * `codex exec --json` stdout from a live 2026-09-19 run — the format the old
 * whole-payload `JSON.parse` could never read, which caused the relay to forward
 * the raw event dump as the peer's "answer".
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { extractCodexReply, buildCodexArgs, run } from '../adapters/backends/codex-backend.mjs'

const REAL_STREAM = [
  '{"type":"thread.started","thread_id":"01a0b764-6858-7b53-9378-ec49a68b89cf"}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Skill descriptions were shortened to fit the skills context budget."}}',
  '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"通了"}}',
  '{"type":"turn.completed","usage":{"input_tokens":17549,"output_tokens":27}}',
].join('\n')

test('extractCodexReply pulls the assistant text out of the event stream', () => {
  const result = extractCodexReply(REAL_STREAM)
  assert.equal(result.kind, 'answer')
  assert.equal(result.text, '通了')
  assert.ok(!result.text.includes('thread.started'), 'no event plumbing leaks into the reply')
  assert.ok(!result.text.includes('Skill descriptions'), 'harness notices are not the answer')
})

test('extractCodexReply handles the legacy result object, prose, and multi-part answers', () => {
  assert.equal(extractCodexReply('{"reply":"旧版答案"}').text, '旧版答案')
  assert.equal(extractCodexReply('就是两个并发写没加锁。').text, '就是两个并发写没加锁。')
  const two = [
    '{"type":"item.completed","item":{"type":"agent_message","text":"第一段"}}',
    '{"type":"item.completed","item":{"type":"agent_message","text":"第二段"}}',
  ].join('\n')
  assert.equal(extractCodexReply(two).text, '第一段\n\n第二段')
})

test('a run with no assistant text surfaces the error item instead of an empty reply', () => {
  const onlyErrors = '{"type":"item.completed","item":{"type":"error","message":"quota exceeded"}}'
  const result = extractCodexReply(onlyErrors)
  assert.equal(result.kind, 'error')
  assert.match(result.text, /quota exceeded/)
  assert.equal(extractCodexReply('').text, '')
  assert.equal(extractCodexReply('{"type":"turn.completed"}').text, '')
})

test('codex args keep flags ahead of the exec subcommand and read stdin', () => {
  const args = buildCodexArgs('D:/work', {})
  assert.deepEqual(args.slice(0, 2), ['--ask-for-approval', 'never'])
  assert.deepEqual(args.slice(-4), ['exec', '--json', '--skip-git-repo-check', '-'])
  assert.ok(args.includes('D:/work'))
  const sandboxed = buildCodexArgs('', { CODEX_SANDBOX: 'D:/sandbox', CODEX_MODEL: 'gpt-5.4' })
  assert.ok(sandboxed.includes('--sandbox') && sandboxed.includes('gpt-5.4'))
  assert.equal(sandboxed.includes('--cd'), false)
})

test('run() against a stub CLI emits only the answer', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-stub-'))
  // A fake `codex` that replays the captured stream, like the real CLI does.
  const fake = join(dir, 'fake-codex.mjs')
  writeFileSync(fake, `process.stdout.write(${JSON.stringify(REAL_STREAM + '\n')})\n`, 'utf8')
  const wrapper = join(dir, process.platform === 'win32' ? 'codex.cmd' : 'codex')
  writeFileSync(wrapper, process.platform === 'win32'
    ? `@echo off\r\n"${process.execPath}" "${fake}" %*\r\n`
    : `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`, 'utf8')
  chmodSync(wrapper, 0o755)

  let out = ''
  const code = await run('链路自检：只回复通了', {
    cwd: dir,
    resolved: { file: wrapper, args: [], shell: true },
    env: { ...process.env, CODEX_SANDBOX: '' },
    write: (s) => { out += s },
  })
  rmSync(dir, { recursive: true, force: true })

  assert.equal(code, 0)
  assert.equal(out.trim(), '通了', `got: ${out}`)
})

test('the backend module is importable without stealing stdin', () => {
  // Regression: script side effects at import time hung any caller that imports it.
  const dir = mkdtempSync(join(tmpdir(), 'codex-import-'))
  const probe = join(dir, 'probe.mjs')
  const target = pathToFileURL(join(process.cwd(), 'adapters', 'backends', 'codex-backend.mjs')).href
  writeFileSync(probe, `import { extractCodexReply } from '${target}'\nprocess.stdout.write(typeof extractCodexReply)\n`, 'utf8')
  const probe2 = spawnSync(process.execPath, [probe], { encoding: 'utf8', timeout: 15000 })
  rmSync(dir, { recursive: true, force: true })
  assert.equal(probe2.stdout, 'function', probe2.stderr)
  assert.equal(probe2.status, 0, probe2.stderr)
})
