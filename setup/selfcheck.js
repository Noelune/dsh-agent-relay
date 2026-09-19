#!/usr/bin/env node
/**
 * setup/selfcheck.js — verify a dsh-agent-relay deployment (also wired into CI).
 *
 * Checks:
 *   1. broker/config.yaml exists with a strong secret
 *   2. a broker answering protocol 1.0 is reachable (optional)
 *   3. the dsh plugin module loads (optional, when @deepseek-ai/dsh-tools is present)
 *   4. an end-to-end message round-trip between two scratch agents (optional, --e2e)
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'
import { RelayClientV2 } from '../lib/client-v2.js'

const here = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(here, '..')
const CONFIG_PATH = join(ROOT, 'broker', 'config.yaml')

function loadSecret() {
  const raw = readFileSync(CONFIG_PATH, 'utf8')
  const m = /secret:\s*([0-9a-fA-F]+)/.exec(raw)
  return m ? m[1] : null
}

function getPort(url) {
  try { return new URL(url).port } catch { return null }
}

async function main() {
  const args = process.argv.slice(2)
  const failures = []
  const info = []

  // 1. config
  if (!existsSync(CONFIG_PATH)) {
    failures.push('broker/config.yaml missing — run "node setup/setup.js init"')
  } else {
    const secret = loadSecret()
    if (!secret || secret.length < 32) failures.push('broker.secret missing or too short')
    else info.push('config.yaml: ok (secret present)')
  }

  // 2. broker connectivity (against the configured URL or env override)
  const brokerUrl = process.env.DSH_RELAY_BROKER_URL ?? 'http://127.0.0.1:19121'
  let brokerOk = false
  try {
    const res = await fetch(brokerUrl + '/', { signal: AbortSignal.timeout(3000) })
    const body = await res.json()
    if (body.protocol === '1.0' && body.broker === 'dsh-agent-relay') {
      brokerOk = true
      info.push(`broker: ${body.broker} ${body.version} at ${brokerUrl}`)
    } else {
      failures.push(`broker at ${brokerUrl} answers unexpected payload (protocol ${body.protocol})`)
    }
  } catch {
    failures.push(`broker not reachable at ${brokerUrl} — start it with "node setup/setup.js start"`)
  }

  // 3. plugin module loads
  try {
    const mod = await import('../lib/index.js')
    if (mod.name !== 'dsh-agent-relay') failures.push('plugin module exports unexpected name')
    else info.push('plugin module: loads, name=dsh-agent-relay')
  } catch (err) {
    failures.push(`plugin module failed to load: ${err.message}`)
  }

  // 4. optional e2e round trip on a scratch broker (v2/v3 wire protocol)
  if (args.includes('--e2e') && brokerOk && loadSecret()) {
    const secret = loadSecret()
    const opts = { endpoint: brokerUrl, secret, timeoutMs: 30000 }
    const alpha = new RelayClientV2({ agent: 'selfcheck-alpha', ...opts })
    const beta = new RelayClientV2({ agent: 'selfcheck-beta', ...opts })
    const nonce = String(Date.now())
    const sent = await alpha.sendRequestDetailed({
      target: 'selfcheck-beta',
      body: `selfcheck round-trip ${nonce}`,
      sessionRef: 'selfcheck',
      idempotencyKey: `selfcheck:${nonce}`,
    })
    // A held claim, so this measures real delivery latency rather than a poll period.
    const inbox = await beta.pull({ limit: 8, waitSeconds: 10 })
    const got = inbox.find((m) => m.message_id === sent.message_id)
    if (!got) {
      failures.push(`e2e: message ${sent.message_id} not delivered in 10 s (target_online=${sent.target_online})`)
    } else {
      await beta.ack(got.message_id, 'completed', undefined, got.lease_token)
      info.push(`e2e round-trip: ${sent.message_id} delivered to selfcheck-beta (peer_online=${sent.target_online})`)
    }
  }

  console.log('selfcheck:')
  for (const line of info) console.log(`  ok: ${line}`)
  for (const line of failures) console.log(`  FAIL: ${line}`)
  console.log(failures.length ? `${failures.length} problem(s)` : 'all checks passed')
  process.exit(failures.length ? 1 : 0)
}

main().catch((err) => { console.error(err); process.exit(1) })
