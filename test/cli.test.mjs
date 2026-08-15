import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const cliPath = join(repoRoot, 'adapters', 'cli', 'relay.mjs')

async function withMockBroker(handler, run) {
  const server = createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    return await run(`http://127.0.0.1:${server.address().port}`)
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
}

function runCli(command, brokerUrl) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, command, '--broker', brokerUrl, '--agent', 'cli-test', '--secret', 'a'.repeat(64), '--json'])
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (status) => resolve({ status, stdout, stderr }))
  })
}

function startCli(command, brokerUrl) {
  return spawn(process.execPath, [cliPath, command, '--broker', brokerUrl, '--agent', 'cli-test', '--secret', 'a'.repeat(64), '--json'])
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

test('CLI recent and query issue exactly one request and print one consistent result', async () => {
  const calls = { recent: 0, query: 0 }
  await withMockBroker((req, res) => {
    if (req.url === '/v1/recent') {
      calls.recent += 1
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ messages: [{ id: `recent-${calls.recent}` }] }))
      return
    }
    if (req.url === '/v1/messages/query') {
      calls.query += 1
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ messages: [{ id: `query-${calls.query}` }] }))
      return
    }
    res.writeHead(404).end()
  }, async (brokerUrl) => {
    const recent = await runCli('recent', brokerUrl)
    assert.equal(recent.status, 0, recent.stderr)
    assert.deepEqual(JSON.parse(recent.stdout), { count: 1, messages: [{ id: 'recent-1' }] })

    const query = await runCli('query', brokerUrl)
    assert.equal(query.status, 0, query.stderr)
    assert.deepEqual(JSON.parse(query.stdout), { count: 1, messages: [{ id: 'query-1' }] })
  })
  assert.deepEqual(calls, { recent: 1, query: 1 })
})

test('CLI watch never overlaps slow inbox polls', async () => {
  let activePolls = 0
  let maxActivePolls = 0
  await withMockBroker((req, res) => {
    if (req.url === '/register') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
      return
    }
    if (req.url?.startsWith('/messages?')) {
      activePolls += 1
      maxActivePolls = Math.max(maxActivePolls, activePolls)
      setTimeout(() => {
        activePolls -= 1
        if (!res.destroyed) {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end('{"messages":[],"cursor":null}')
        }
      }, 2500)
      return
    }
    res.writeHead(404).end()
  }, async (brokerUrl) => {
    const child = startCli('watch', brokerUrl)
    try {
      await delay(4300)
    } finally {
      child.kill()
      await new Promise((resolve) => child.once('close', resolve))
    }
  })
  assert.equal(maxActivePolls, 1)
})
