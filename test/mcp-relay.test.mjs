/**
 * End-to-end MCP surface: a host talking to the relay through stdio JSON-RPC.
 *
 * This is the P2 goal in one file — joining the circle is a host config entry and
 * a `relay_ask` call, with no resident poller on either side.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createStore } from '../broker/src/store.js'
import { createAuthenticator } from '../broker/src/auth.js'
import { createBrokerServer } from '../broker/src/server.js'
import { createV2Store } from '../broker/src/store-v2.js'
import { RelayClientV2 } from '../lib/client-v2.js'

const SHARED = 'mcp-test-secret'
const HERE = resolve(fileURLToPath(import.meta.url), '..', '..')
const DATA_DIR = mkdtempSync(join(tmpdir(), 'relay-mcp-'))
let server
let port
let v2Store

before(async () => {
  const config = {
    host: '127.0.0.1', port: 0, secret: SHARED, tls: false,
    rateLimitLoopback: 1e6, rateLimitRemote: 1e6, messageTtlDays: 7,
    persist: false, dataDir: DATA_DIR, lockAfterFailures: 5, lockMinutes: 5,
    leaseSeconds: 600, maxAttempts: 3, notifyFailedToSender: true,
    agents: { claude: {}, codex: {}, offlinepeer: {} },
  }
  v2Store = createV2Store({ dataDir: DATA_DIR, persist: false, leaseSeconds: 600, maxAttempts: 3 })
  const store = createStore({ ttlDays: 7, persist: false, dataDir: DATA_DIR })
  const auth = createAuthenticator({ secret: SHARED, lockAfterFailures: 5, lockMinutes: 5, rateLimitLoopback: 1e6, rateLimitRemote: 1e6 })
  server = createBrokerServer({ config, store, auth, storeV2: v2Store })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  port = server.address().port
})

after(async () => {
  server.releaseWaiters?.()
  server.closeAllConnections?.()
  await new Promise((r) => server.close(r))
  v2Store.close()
  rmSync(DATA_DIR, { recursive: true, force: true })
})

/** Drive the MCP server as a host would: newline-delimited JSON-RPC over stdio. */
function mcpSession() {
  const child = spawn(process.execPath, [join(HERE, 'mcp', 'relay-mcp.mjs')], {
    env: { ...process.env, AGENT_RELAY_AGENT: 'claude', AGENT_RELAY_SECRET: SHARED, AGENT_RELAY_BROKER_URL: `http://127.0.0.1:${port}` },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.setEncoding('utf8').on('data', (c) => { stderr += c })
  const pending = new Map()
  let buffer = ''
  child.stdout.setEncoding('utf8').on('data', (chunk) => {
    buffer += chunk
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (!line) continue
      let message
      try { message = JSON.parse(line) } catch { continue }
      const settle = pending.get(message.id)
      if (settle) {
        pending.delete(message.id)
        settle(message)
      }
    }
  })
  let nextId = 1
  return {
    child,
    get stderr() { return stderr },
    request(method, params) {
      const id = nextId++
      return new Promise((resolvePromise, rejectPromise) => {
        pending.set(id, resolvePromise)
        setTimeout(() => {
          if (pending.delete(id)) rejectPromise(new Error(`MCP ${method} timed out; stderr:\n${stderr}`))
        }, 20_000).unref()
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      })
    },
    notify(method, params) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
    },
    close() {
      child.stdin.end()
      child.kill()
    },
  }
}

const contentText = (response) => (response.result?.content ?? []).map((c) => c.text ?? '').join('\n')

test('initialize + tools/list expose the five collaboration tools', async () => {
  const session = mcpSession()
  try {
    const init = await session.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test-host', version: '0' } })
    assert.equal(init.result.protocolVersion, '2025-06-18')
    assert.equal(init.result.serverInfo.name, 'agent-relay')
    assert.ok(init.result.instructions.includes('relay_ask'))

    const list = await session.request('tools/list', {})
    assert.deepEqual(
      list.result.tools.map((t) => t.name).sort(),
      ['relay_agents', 'relay_ask', 'relay_inbox', 'relay_send', 'relay_status'],
    )
    const ask = list.result.tools.find((t) => t.name === 'relay_ask')
    assert.deepEqual(ask.inputSchema.required, ['target', 'request'])
  } finally {
    session.close()
  }
})

test('relay_ask hands off and returns the peer answer in one call', async () => {
  const session = mcpSession()
  const peer = new RelayClientV2({ endpoint: `http://127.0.0.1:${port}`, agent: 'codex', secret: SHARED })
  try {
    // Keep the peer's presence fresh, as a live member would.
    await peer.pull({ limit: 1 })
    const inflight = session.request('tools/call', { name: 'relay_ask', arguments: { target: 'codex', request: '这个函数有并发问题吗？', timeout_seconds: 25 } })

    let question = null
    for (let i = 0; i < 40 && !question; i++) {
      await new Promise((r) => setTimeout(r, 100))
      const inbox = await peer.pull({ limit: 8 })
      question = inbox.find((m) => m.body.includes('并发问题'))
    }
    assert.ok(question, 'the request must reach the peer')
    assert.match(question.body, /并发问题/, 'the wire body is the raw request; framing is added at consumption')
    await peer.sendReply(question, '有：第 3 行缺少互斥。', `reply:${question.message_id}`)

    const response = await inflight
    const text = contentText(response)
    assert.match(text, /有：第 3 行缺少互斥/)
    assert.match(text, /codex 的回答/)
    assert.notEqual(response.result?.isError, true)
  } finally {
    session.close()
  }
})

test('relay_ask on an offline peer answers at once and keeps the request', async () => {
  const session = mcpSession()
  try {
    const started = Date.now()
    const response = await session.request('tools/call', { name: 'relay_ask', arguments: { target: 'offlinepeer', request: '在吗？' } })
    const text = contentText(response)
    assert.ok(Date.now() - started < 5000, 'must not burn the ask deadline')
    assert.match(text, /不在线/)
    assert.match(text, /message_id=/, 'the durable id is returned so the caller can follow up')
    const ids = [/id=([0-9a-f]{32})/.exec(text)?.[1]]
    assert.ok(ids[0])
    const status = await session.request('tools/call', { name: 'relay_status', arguments: { message_ids: ids } })
    assert.match(contentText(status), /queued/)
  } finally {
    session.close()
  }
})

test('relay_agents reports who is awake, and relay_inbox drains what peers sent me', async () => {
  const session = mcpSession()
  const sender = new RelayClientV2({ endpoint: `http://127.0.0.1:${port}`, agent: 'codex', secret: SHARED })
  try {
    await sender.sendRequest({ target: 'claude', body: '帮我看下这份 diff', sessionRef: 'codex', idempotencyKey: 'mcp:inbox:1' })

    const agents = contentText(await session.request('tools/call', { name: 'relay_agents', arguments: {} }))
    assert.match(agents, /我是 claude/)
    assert.match(agents, /codex/)
    assert.match(agents, /offlinepeer/)

    const inbox = contentText(await session.request('tools/call', { name: 'relay_inbox', arguments: { limit: 4 } }))
    assert.match(inbox, /帮我看下这份 diff/)
    assert.match(inbox, /codex → 我/)
    assert.match(inbox, /untrusted peer data/, 'peer content must arrive framed as untrusted data')

    // mark_done is the default: the same request must not appear twice.
    const again = contentText(await session.request('tools/call', { name: 'relay_inbox', arguments: { limit: 4 } }))
    assert.equal(again, '收件箱为空。')
  } finally {
    session.close()
  }
})
