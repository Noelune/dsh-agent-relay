/**
 * CLI surface for the v2/v3 protocol: one request per read command, a
 * broker-held long-poll for `pull --wait`, and reachability in the exit code so
 * shell scripts can branch on it without parsing JSON.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const cliPath = join(repoRoot, 'adapters', 'cli', 'relay.mjs')
const SECRET = 'a'.repeat(64)

function json(res, payload, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(payload))
}

async function withMockBroker(handler, run) {
  const server = createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    return await run(`http://127.0.0.1:${server.address().port}`)
  } finally {
    server.closeAllConnections?.()
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
}

function runCli(args, brokerUrl) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [cliPath, 'v2', ...args, '--broker', brokerUrl, '--agent', 'cli-test', '--secret', SECRET, '--json'])
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
    child.on('error', rejectPromise)
    child.on('close', (status) => resolvePromise({ status, stdout, stderr }))
  })
}

test('every v2 request carries the signed X-Agent-Relay-* headers', async () => {
  const seen = []
  await withMockBroker((req, res) => {
    seen.push({
      url: req.url,
      agent: req.headers['x-agent-relay-agent'],
      signature: req.headers['x-agent-relay-signature'],
      timestamp: req.headers['x-agent-relay-timestamp'],
    })
    json(res, { messages: [] })
  }, async (brokerUrl) => {
    const out = await runCli(['recent'], brokerUrl)
    assert.equal(out.status, 0, out.stderr)
  })
  assert.equal(seen.length, 1)
  assert.equal(seen[0].agent, 'cli-test')
  assert.match(seen[0].signature, /^[0-9a-f]{64}$/)
  assert.ok(Number(seen[0].timestamp) > 0)
})

test('recent and query each issue exactly one request and print one consistent result', async () => {
  const calls = { recent: 0, query: 0 }
  await withMockBroker((req, res) => {
    if (req.url === '/v1/recent') {
      calls.recent += 1
      return json(res, { messages: [{ message_id: `recent-${calls.recent}` }] })
    }
    if (req.url === '/v1/messages/query') {
      calls.query += 1
      return json(res, { messages: [{ message_id: `query-${calls.query}` }] })
    }
    return json(res, { error: { code: 'not_found', message: 'no route' } }, 404)
  }, async (brokerUrl) => {
    const recent = await runCli(['recent'], brokerUrl)
    assert.equal(recent.status, 0, recent.stderr)
    assert.deepEqual(JSON.parse(recent.stdout), { count: 1, messages: [{ message_id: 'recent-1' }] })

    const query = await runCli(['query', '--kind', 'request'], brokerUrl)
    assert.equal(query.status, 0, query.stderr)
    assert.deepEqual(JSON.parse(query.stdout), { count: 1, messages: [{ message_id: 'query-1' }] })
  })
  assert.deepEqual(calls, { recent: 1, query: 1 })
})

test('pull --wait issues a single broker-held long-poll, never a poll loop', async () => {
  const bodies = []
  await withMockBroker((req, res) => {
    if (req.url !== '/v1/pull') return json(res, { error: { code: 'not_found', message: 'no route' } }, 404)
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      bodies.push(JSON.parse(raw))
      // Hold it the way the real broker does, then answer empty at the deadline.
      setTimeout(() => json(res, { messages: [] }), 300)
    })
  }, async (brokerUrl) => {
    const out = await runCli(['pull', '--limit', '4', '--wait', '5'], brokerUrl)
    assert.equal(out.status, 0, out.stderr)
    assert.deepEqual(JSON.parse(out.stdout), { count: 0, messages: [] })
  })
  assert.equal(bodies.length, 1, 'one held request is enough — the CLI must not poll')
  assert.equal(bodies[0].wait_seconds, 5)
  assert.equal(bodies[0].limit, 4)
  assert.equal(bodies[0].agent, 'cli-test')
})

test('send reports presence and exits 3 when the peer cannot be reached', async () => {
  let online = false
  await withMockBroker((req, res) => {
    if (req.url !== '/v1/messages') return json(res, {}, 404)
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      json(res, {
        message_id: 'f'.repeat(32),
        created: true,
        root_id: 'r1',
        protocol_version: 3,
        target_online: online,
        last_seen_at: online ? Math.floor(Date.now() / 1000) : null,
        will_wake: false,
        ...(online ? {} : { hint: '目标未取件' }),
      })
    })
  }, async (brokerUrl) => {
    online = true
    const ok = await runCli(['send', 'peer', 'hello'], brokerUrl)
    assert.equal(ok.status, 0, ok.stderr)
    assert.equal(JSON.parse(ok.stdout).target_online, true)

    online = false
    const offline = await runCli(['send', 'peer', 'hello again'], brokerUrl)
    assert.equal(offline.status, 3, 'exit 3 so a script can branch on reachability')
    assert.equal(JSON.parse(offline.stdout).target_online, false)
  })
})

test('the default retention sent is days, not the old one hour', async () => {
  let ttl = 0
  await withMockBroker((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      ttl = JSON.parse(raw).ttl_seconds
      json(res, { message_id: 'e'.repeat(32), created: true, target_online: true, will_wake: false })
    })
  }, async (brokerUrl) => {
    const out = await runCli(['send', 'peer', 'body'], brokerUrl)
    assert.equal(out.status, 0, out.stderr)
  })
  assert.equal(ttl, 7 * 86400)
})

test('doctor needs no identity and still reports a broken broker', async () => {
  const child = spawn(process.execPath, [
    cliPath, 'doctor', '--broker', 'http://127.0.0.1:1', '--config', join(repoRoot, 'definitely-missing.yaml'),
  ], { encoding: 'utf8' })
  let stdout = ''
  child.stdout.setEncoding('utf8').on('data', (c) => { stdout += c })
  const status = await new Promise((resolvePromise) => child.once('close', resolvePromise))
  assert.equal(status, 1, stdout)
  assert.match(stdout, /broker\s+.*不可达/)
})
