#!/usr/bin/env node
/**
 * dsh-agent-relay CLI client — wire protocol v1.0.
 *
 * Zero-dependency Node client for scripts, cron jobs, Codex/Claude wrappers:
 *
 *   node relay.mjs register --secret <s> --agent alpha
 *   node relay.mjs send beta "hello from alpha" --secret <s> --agent alpha
 *   node relay.mjs recv --secret <s> --agent alpha
 *   node relay.mjs peers --secret <s> --agent alpha
 *   node relay.mjs watch --secret <s> --agent alpha     # continuous polling
 *
 * Config sources (lowest -> highest priority):
 *   ~/.dsh-relay.json  { "brokerUrl", "agent", "secret" }
 *   env  DSH_RELAY_BROKER_URL / DSH_RELAY_AGENT / DSH_RELAY_SECRET
 *   flags --broker / --agent / --secret
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { RelayClient } from '../../lib/client.js'

const STATE_FILE = join(homedir(), '.dsh-relay-state.json')

/** Per-broker/per-agent poll cursor, so each CLI process only sees NEW messages. */
function loadState() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')) } catch { return {} }
}
function saveState(state) {
  try { writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8') } catch { /* best-effort */ }
}

const HELP = `dsh-agent-relay CLI — wire protocol v1.0

Usage:
  node relay.mjs <command> [options]

Commands:
  register                     register/heartbeat this agent
  send <target> <content>      send a message to another agent
  recv [--limit N] [--once]    pull new messages (polls until empty unless --once)
  peers                        list registered agents and online status
  watch                        poll forever, printing new messages as they arrive
  handshake                    check broker version compatibility

Options:
  --broker <url>    broker base URL   (env DSH_RELAY_BROKER_URL, default http://127.0.0.1:19121)
  --agent <name>    this agent name   (env DSH_RELAY_AGENT)
  --secret <hex>    shared HMAC secret (env DSH_RELAY_SECRET; or ~/.dsh-relay.json)
  --limit <n>       max messages to return (default 50)
  --json            machine-readable output
  --help            show this help
`;

function loadConfig(argv) {
  const env = process.env
  const file = join(homedir(), '.dsh-relay.json')
  let fileCfg = {}
  try {
    if (existsSync(file)) fileCfg = JSON.parse(readFileSync(file, 'utf8'))
  } catch { /* ignore malformed file */ }
  const flag = { brokerUrl: null, agent: null, secret: null }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--broker') flag.brokerUrl = argv[++i]
    else if (argv[i] === '--agent') flag.agent = argv[++i]
    else if (argv[i] === '--secret') flag.secret = argv[++i]
  }
  return {
    brokerUrl: flag.brokerUrl ?? env.DSH_RELAY_BROKER_URL ?? fileCfg.brokerUrl ?? 'http://127.0.0.1:19121',
    agent: flag.agent ?? env.DSH_RELAY_AGENT ?? fileCfg.agent ?? null,
    secret: flag.secret ?? env.DSH_RELAY_SECRET ?? fileCfg.secret ?? null,
    json: argv.includes('--json'),
  }
}

function die(message) {
  console.error(message)
  process.exit(2)
}

async function main() {
  const argv = process.argv.slice(2)
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    console.log(HELP)
    return
  }
  const command = argv[0]
  const cfg = loadConfig(argv)
  // peers/handshake are read-only and do not need an agent identity.
  const NEEDS_AGENT = new Set(['register', 'send', 'recv', 'watch'])
  if (NEEDS_AGENT.has(command) && !cfg.agent) die('missing agent name: pass --agent <name> or set DSH_RELAY_AGENT')
  if (!cfg.secret) die('missing secret: pass --secret <hex> or set DSH_RELAY_SECRET (generate with "node setup/setup.js init")')
  const client = new RelayClient({ brokerUrl: cfg.brokerUrl, agent: cfg.agent, secret: cfg.secret })

  const print = (obj) => { if (cfg.json) console.log(JSON.stringify(obj)); else console.log(JSON.stringify(obj, null, 2)) }

  try {
    switch (command) {
      case 'handshake': {
        const info = await client.handshake()
        print(info)
        return
      }
      case 'register': {
        print(await client.register())
        return
      }
      case 'send': {
        const target = argv[1]
        const content = argv[2]
        if (!target || content === undefined) die('usage: node relay.mjs send <target> <content>')
        const result = await client.send({ to: target, body: { text: content }, ack: argv.includes('--ack') })
        print(result)
        return
      }
      case 'recv': {
        const limit = Number(argv[argv.indexOf('--limit') + 1] ?? 50)
        const state = loadState()
        const stateKey = `${cfg.brokerUrl}|${cfg.agent}`
        if (argv.includes('--reset')) delete state[stateKey]
        client.since = state[stateKey]?.since ?? null
        let out = []
        if (argv.includes('--once')) {
          const r = await client.recv(limit)
          out = r.messages ?? []
        } else {
          // Drain: keep polling until the broker returns no new messages.
          for (let i = 0; i < 5; i++) {
            const r = await client.recv(limit)
            const batch = r.messages ?? []
            out = out.concat(batch)
            if (batch.length === 0) break
          }
        }
        // Receiver semantics (PROTOCOL §4/§5): send receipts for requested acks.
        for (const msg of out) {
          if (msg.ack && msg.type === 'message') {
            try { await client.ack(msg.id, 'ok') } catch { /* best-effort */ }
          }
        }
        state[stateKey] = { since: client.since }
        saveState(state)
        print({ count: out.length, messages: out })
        return
      }
      case 'peers': {
        print({ peers: await client.peers() })
        return
      }
      case 'watch': {
        console.error(`[relay-cli] watching inbox of ${cfg.agent} at ${cfg.brokerUrl} (Ctrl+C to stop)`)
        await client.register()
        const seen = new Set()
        setInterval(async () => {
          try {
            const r = await client.recv(50)
            for (const msg of r.messages ?? []) {
              if (seen.has(msg.id)) continue
              seen.add(msg.id)
              if (msg.type === 'ack') {
                console.error(`[ack ${msg.replyTo}] ${msg.body?.status}`)
              } else {
                console.log(JSON.stringify({ from: msg.from, id: msg.id, ts: msg.ts, body: msg.body }))
                if (msg.ack) { try { await client.ack(msg.id, 'ok') } catch { /* best-effort */ } }
              }
            }
          } catch { /* broker unreachable; retry on next tick */ }
        }, 2000)
        await new Promise(() => {})
        return
      }
      default:
        die(`unknown command "${command}" — run with --help`)
    }
  } catch (err) {
    die(`error: ${err?.message ?? err}`)
  }
}

main().catch((err) => die(`error: ${err?.message ?? err}`))
