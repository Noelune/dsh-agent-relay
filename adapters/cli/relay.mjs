#!/usr/bin/env node
/**
 * dsh-agent-relay CLI — the v2/v3 wire-protocol client for scripts, cron jobs
 * and agent wrappers. Zero dependencies beyond the repo's own client.
 *
 *   node relay.mjs v2 ask    codex "审一下这个函数"   # hand off, wait for the answer
 *   node relay.mjs v2 send   codex "note"            # deliver, do not wait
 *   node relay.mjs v2 pull   --limit 4 --wait 30      # long-poll my inbox
 *   node relay.mjs v2 ack    <id> completed|retry
 *   node relay.mjs v2 status <id>… | recent | query
 *   node relay.mjs doctor                              # is the circle working?
 *
 * The v1 command set (register/recv/peers/handshake) went away with the v1
 * generation; every command here speaks docs/PROTOCOL-V2.md.
 *
 * Config sources (lowest -> highest): ~/.dsh/agent-relay.json (the deployment's
 * own runtime config), ~/.dsh-relay.json, environment, flags. With the
 * deployment file present nothing else is needed: `node relay.mjs v2 pull` —
 * but note that it then speaks as that file's `agent`, so pass `--agent` to act
 * for a different member.
 */
import { RelayClientV2 } from '../../lib/client-v2.js'
import { resolveSecret } from '../../lib/credentials.mjs'
import { relaySettings } from '../../lib/relay-config.mjs'

// Requests are retained for days by default so an offline peer does not imply a
// lost handoff; --ttl overrides per call.
const DEFAULT_TTL_SECONDS = 7 * 86400

const HELP = `dsh-agent-relay CLI — wire protocol v2/v3

Usage:
  node relay.mjs v2 <command> [options]
  node relay.mjs doctor [--json] [--quiet]

Commands
  health                       broker liveness, protocol, presence, backlog
  ask <target> <body>          hand off and wait for the answer; a peer nobody can
                               wake exits 3 at once (message stays retained) unless
                               --wait-offline is given
  send <target> <body>         queue a request without waiting (exit 3 when the
                               peer is unreachable: --mode read|continue|write)
  pull                         claim messages for --agent (--limit --lease --wait
                               --root) — --wait is a broker-held long-poll
  ack <id> <completed|retry>   settle a claim (--error --token)
  status <id> [<id>...]        delivery status of messages you are party to
  recent                       recent traffic for --agent (--limit)
  query                        search (--kind --status --topic --limit)
  requeue <id>                 put a stuck message back in line
  cancel <id>                  drop a message you own
  doctor                       who can actually receive, queue backlog, credential
                               drift between the broker config and the .env,
                               storage shape, deployed-adapter drift

Options
  --broker <url>      default http://127.0.0.1:19121   (env DSH_RELAY_BROKER_URL)
  --agent <name>      this agent                        (env DSH_RELAY_AGENT)
  --secret <hex>      credential                        (env DSH_RELAY_SECRET)
  --secret-env-file <path>
                      read AGENT_RELAY_<AGENT>_SECRET from a dotenv the deployment
                      already has, instead of storing a secret in this config
  --session <s> --context <s> --topic <s> --ttl <seconds> --ttl-wait <seconds>
  --limit <n> --lease <s> --wait <s> --root <id> --mode <m> --json --help

Credential precedence: --secret, environment, --secret-env-file, then
secret_ref + vault module. Values are never printed.
Exit codes: 0 ok, 2 bad usage, 3 the peer could not be reached.
`

/** Read `--name <value>`; a flag followed by another flag has no value. */
function flagOf(argv, name, fallback = undefined) {
  const i = argv.indexOf(`--${name}`)
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback
}

function loadConfig(argv) {
  // One shared resolver for the identity/credential layer (see
  // lib/relay-config.mjs): deployment config, personal file, env, flags.
  const flags = {}
  for (const name of ['broker', 'agent', 'secret', 'secret-env', 'secret-env-file', 'secret-ref', 'vault-module', 'key-id', 'python']) {
    const value = flagOf(argv, name)
    if (value !== undefined) flags[name] = value
  }
  const cfg = relaySettings({ flags })
  return {
    brokerUrl: cfg.endpoint,
    agent: cfg.agent || null,
    secret: cfg.secret,
    secretEnv: cfg.secretEnv,
    secretEnvFile: cfg.secretEnvFile,
    secretRef: cfg.secretRef,
    vaultModule: cfg.vaultModule,
    keyId: cfg.keyId,
    python: cfg.python,
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
  // `doctor` is read-only and needs no identity: it inspects the broker, the
  // queue, both credential files and the storage shape in one pass.
  if (command === 'doctor') {
    const { runDoctor, formatReport } = await import('../../setup/doctor.mjs')
    const flag = (name) => {
      const i = argv.indexOf(name)
      return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined
    }
    const report = await runDoctor({
      broker: flag('--broker'), config: flag('--config'), envFile: flag('--env-file'), dataDir: flag('--data-dir'),
    })
    if (argv.includes('--json')) console.log(JSON.stringify(report, null, 2))
    else console.log(formatReport(report, { quiet: argv.includes('--quiet') }))
    process.exitCode = report.status === 'fail' ? 1 : report.status === 'warn' ? 2 : 0
    return
  }
  const cfg = loadConfig(argv)
  if (!cfg.agent) die(`--agent <name> is required for "${command}" (or DSH_RELAY_AGENT)`)
  if (!cfg.secret) cfg.secret = await resolveSecret(cfg)
  if (!cfg.secret) die('no credential: pass --secret, set DSH_RELAY_SECRET, or point --secret-env-file at the deployment dotenv')

  const print = (obj) => { if (cfg.json) console.log(JSON.stringify(obj)); else console.log(JSON.stringify(obj, null, 2)) }

  // ---- v2/v3 wire protocol ----
  if (command === 'v2') {
    const v2 = new RelayClientV2({ endpoint: cfg.brokerUrl, agent: cfg.agent, secret: cfg.secret, keyId: cfg.keyId })
    const sub = argv[1]
    const flag = (name, fallback) => flagOf(argv, name.replace(/^--/, ''), fallback)
    try {
      switch (sub) {
        case 'health': print(await v2.health()); return
        case 'ask': {
          // Hand the task over and wait for the answer, so a delegation reads
          // like a function call. An unreachable peer exits 3 immediately
          // instead of burning the deadline; --wait-offline opts back in.
          const target = argv[2]
          const body = argv[3]
          if (!target || body === undefined) die('usage: node relay.mjs v2 ask <target> <body> [--ttl-wait <s>] [--mode …] [--context C] [--wait-offline]')
          const result = await v2.ask({
            target,
            body,
            context: flag('--context', undefined),
            sessionRef: flag('--session', cfg.agent),
            executionMode: flag('--mode', 'read'),
            timeoutSeconds: Number(flag('--ttl-wait', 240)) || 240,
            waitOffline: argv.includes('--wait-offline'),
          })
          if (cfg.json) print(result)
          else if (result.ok) console.log(result.reply)
          else {
            console.error(`${result.reason} · message_id=${result.message_id} · ${result.hint ?? ''}`)
            process.exitCode = 3
          }
          return
        }
        case 'send': {
          const target = argv[2]
          const body = argv[3]
          if (!target || body === undefined) die('usage: node relay.mjs v2 send <target> <body> [--mode read|continue|write]')
          const sent = await v2.sendRequestDetailed({
            target,
            body,
            sessionRef: flag('--session', cfg.agent),
            idempotencyKey: `${cfg.agent}:${Date.now()}`,
            ttlSeconds: Number(flag('--ttl', DEFAULT_TTL_SECONDS)) || DEFAULT_TTL_SECONDS,
            executionMode: flag('--mode', 'read'),
            context: flag('--context', undefined),
            topic: flag('--topic', undefined),
          })
          print(sent)
          // Non-zero when nobody is listening and nobody can be woken, so shell
          // scripts can branch on reachability without parsing the JSON.
          if (!sent.target_online && !sent.will_wake) process.exitCode = 3
          return
        }
        case 'pull': {
          const limit = Number(flag('--limit', 8))
          const lease = flag('--lease', undefined)
          // --wait turns this into a long-poll held by the broker; --root claims
          // one conversation only, leaving the rest of the inbox alone.
          const messages = await v2.pull({
            limit,
            leaseSeconds: lease ? Number(lease) : undefined,
            waitSeconds: Number(flag('--wait', 0)) || 0,
            matchRootId: flag('--root', undefined),
          })
          print({ count: messages.length, messages })
          return
        }
        case 'ack': {
          const id = argv[2]
          const outcome = argv[3]
          if (!id || (outcome !== 'completed' && outcome !== 'retry')) die('usage: node relay.mjs v2 ack <id> <completed|retry>')
          print(await v2.ack(id, outcome, flag('--error', undefined)))
          return
        }
        case 'status': {
          const ids = argv.slice(2).filter((a) => !a.startsWith('--'))
          if (!ids.length) die('usage: node relay.mjs v2 status <id> [<id>...]')
          print({ messages: await v2.status(ids) })
          return
        }
        case 'recent': {
          const messages = await v2.recent(Number(flag('--limit', 20)))
          print({ count: messages.length, messages })
          return
        }
        case 'query': {
          const filters = {}
          for (const k of ['kind', 'status', 'topic', 'limit']) {
            const v = flag(`--${k}`, undefined)
            if (v !== undefined) filters[k] = v
          }
          const messages = await v2.query(filters)
          print({ count: messages.length, messages })
          return
        }
        case 'requeue': {
          const id = argv[2]
          if (!id) die('usage: node relay.mjs v2 requeue <id>')
          print(await v2.requeue(id))
          return
        }
        case 'cancel': {
          const id = argv[2]
          if (!id) die('usage: node relay.mjs v2 cancel <id>')
          print(await v2.cancel(id))
          return
        }
        default:
          die('unknown v2 subcommand "' + sub + '" — run with --help')
      }
    } catch (err) {
      die(`error: ${err?.message ?? err}`)
    }
    return
  }

}

main().catch((err) => die(`error: ${err?.message ?? err}`))
