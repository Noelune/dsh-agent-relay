#!/usr/bin/env node
/**
 * Record the hash of the deployed Hermes relay adapter as the repo baseline.
 *
 * A hash, not a copy: snapshotting the 1,476-line file into the repo duplicated
 * it wholesale, which is exactly the kind of accumulation this project is trying
 * to stop. `relay doctor` compares the live file against this fingerprint and
 * reports drift; refresh this after you deliberately change the deployed file.
 *
 *   node setup/capture-adapter.mjs [--path <adapter.py>] [--out <baseline.json>]
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const DEFAULT_ADAPTER = join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'hermes', 'plugins', 'agent-relay', 'adapter.py')
export const DEFAULT_OUT = join(REPO, 'adapters', 'hermes', 'deployed-adapter.json')

export function buildBaseline(data, previous) {
  const text = data.toString('utf8')
  return {
    note: '基线指纹，不是副本：用于 relay doctor 检测线上 Hermes 适配器是否偏离仓库记录。',
    path: (previous?.path) ?? 'AppData/Local/hermes/plugins/agent-relay/adapter.py',
    sha256: createHash('sha256').update(data).digest('hex'),
    lines: text.split('\n').length,
    bytes: data.length,
    captured: new Date().toISOString().slice(0, 10),
  }
}

export function main(argv = process.argv.slice(2)) {
  const pick = (name) => { const i = argv.indexOf(`--${name}`); return i !== -1 ? argv[i + 1] : undefined }
  const src = pick('path') ?? DEFAULT_ADAPTER
  const out = pick('out') ?? DEFAULT_OUT
  if (!existsSync(src)) {
    console.error(`找不到部署适配器：${src}`)
    return 1
  }
  let previous = null
  try { previous = JSON.parse(readFileSync(out, 'utf8')) } catch { /* first capture */ }
  const baseline = buildBaseline(readFileSync(src), previous)
  writeFileSync(out, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8')
  console.log(`已记录基线：${out}\n  sha256 ${baseline.sha256.slice(0, 16)}…  ${baseline.lines} 行  ${baseline.bytes} 字节  ${baseline.captured}`)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main()
}
