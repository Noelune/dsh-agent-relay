// 从线上 adapter 抽出真实源码，喂给 python 跑（下一份脚本）
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const p = join(process.env.LOCALAPPDATA, 'hermes', 'plugins', 'agent-relay', 'adapter.py')
const src = readFileSync(p, 'utf8')
writeFileSync('.adapter-src.txt', src)
// 确认关键片段确实来自线上文件（不是我以为的版本）
const checks = {
  'payload 带 wait_seconds': /pull_payload\["wait_seconds"\] = int\(self\.wait_seconds\)/.test(src),
  '超时随 hold 放大': /pull_timeout = self\.wait_seconds \+ 20\.0/.test(src),
  '挂住即续期不叠加等待': /hold_started\)\s*>=\s*self\.wait_seconds \* 0\.9/.test(src),
  '旧 broker 回退到 poll_seconds': /timeout=self\.poll_seconds\)\n            except asyncio\.TimeoutError/.test(src),
  'urlopen 用传入超时': /urlopen\(request, timeout=timeout\)/.test(src),
}
console.log('线上文件片段核对:', JSON.stringify(checks))
process.exit(Object.values(checks).every(Boolean) ? 0 : 1)
