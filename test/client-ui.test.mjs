import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../lib/client-ui.js', import.meta.url), 'utf8')

test('sidebar client renders relay monitoring sections and only polls while open', () => {
  assert.match(source, /在线 Agent/)
  assert.match(source, /队列负载/)
  assert.match(source, /最近错误/)
  assert.match(source, /最近消息/)
  assert.match(source, /POLL_MS/)
  assert.match(source, /window\.clearTimeout/)
  assert.match(source, /event\.key === 'Escape'/)
  assert.doesNotMatch(source, /message\.body|message\.context|lease_token/)
})
