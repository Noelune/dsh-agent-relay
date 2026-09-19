# Deployment Guide

One supported topology: the broker and every member run on the same machine and
talk over loopback (`127.0.0.1:19121`). There is no second mode. The reason is
in [ARCHITECTURE.md](ARCHITECTURE.md#design-decisions) — short version: HMAC proves who
sent a request, it does not encrypt anything, so putting this broker on a network
would trade a zero-exposure design for a home-made HTTPS replacement. If a
cross-machine circle is ever needed, the honest answer is a TLS-terminated tunnel
in front of the loopback port, not a different configuration here.

An agent-driven variant of this walkthrough — role, decision points, a
Definition-of-Done checklist and a report format — is
[AGENT-DEPLOY.md](AGENT-DEPLOY.md). `lib/index.js` points the model at that file.

---

## 1. Requirements

- Node.js **≥ 22.13** — the broker uses the built-in `node:sqlite`; there are no
  third-party dependencies to install, for the broker or for the CLI.
- Port 19121 free (change `broker.port` in the config if it is not).

## 2. Init, start, check

```sh
node setup/setup.js init      # writes broker/config.yaml with a random 64-hex secret
node setup/setup.js start     # or foreground: node broker/src/index.js --config broker/config.yaml
node setup/doctor.mjs         # one command: is the circle actually working?
```

`config.yaml` holds a credential — never commit it, never paste it into a log or
a chat. To start the broker at login on Windows, a one-line `.bat` is enough:

```bat
cd /d "C:\path\to\dsh-agent-relay"
start "" /b node broker\src\index.js --config "%USERPROFILE%\.dsh\relay-broker\config-19121.yaml"
```

`doctor` reads the things that used to take six manual probes: broker version and
protocol, which members are online (a claim within the last 90 s), queue backlog,
failed/expired history, which members can be woken on demand, whether the broker
YAML and the agent-side dotenv still agree, plaintext keys outside the vault, the
SQLite/WAL size, and whether the deployed Hermes adapter matches its baseline.
Exit code 0/1/2 = ok/fail/warn; `--json` for scripts.

## 3. Add members

```sh
node setup/add-member.mjs <name>           # secret + broker YAML block + agent .env entry + default ACLs
node setup/add-member.mjs <name> --show    # also print the generated secret once
node setup/sync-secrets.mjs                # check for drift between the two stores (exit 1 on drift)
node setup/sync-secrets.mjs --apply        # repair, backing up first
```

Restart the broker afterwards; the exact command is printed. Credential values
are never echoed by either tool.

Three ways to speak to the broker. None of them needs a resident polling process:

| Face | For | Where |
|---|---|---|
| MCP server | a host that starts the agent per session — 3 lines of config, no daemon | `mcp/relay-mcp.mjs` (`relay_ask/send/inbox/reply/status/agents`) |
| CLI | scripts, cron, wrapper prompts | `adapters/cli/relay.mjs v2 …` |
| Python | stdlib-only hosts | `adapters/hermes/relay_client_v2.py` (`RelayClientV2`) |

Config layers for the CLI, MCP server and worker are shared and lowest-first:
the deployment's own `~/.dsh/agent-relay.json`, then `~/.dsh-relay.json`, then the
environment (`AGENT_RELAY_*`, also `DSH_RELAY_*`), then flags. Identity and
credential resolution: `--secret` → env var → `--secret-env-file` (an existing
dotenv, read at runtime) → `secret_ref` + `vault_module` (a DPAPI-backed vault
entry). With the deployment config in place a bare `node adapters/cli/relay.mjs
v2 pull` works — it then speaks as that file's `agent`, so pass `--agent` to act
for somebody else. Exit code 3 means the peer could not be reached.

## 4. Make an offline member reachable

A member is reachable in one of two ways: somebody is polling for it, or the
broker can start it. The second is what `wake_command` is for — when a message
lands for an agent with no recent claim activity, the broker spawns that command
once; the worker claims, processes, acks and exits when the queue drains.

```sh
node setup/enable-wake.mjs --agent <name>           # dry run: shows what would be written
node setup/enable-wake.mjs --agent <name> --apply   # writes it, backing up the config first
```

The child gets `AGENT_RELAY_AGENT`, `AGENT_RELAY_SECRET` and
`AGENT_RELAY_BROKER_URL` in its **environment**, never on the command line (argv
is world-readable in the process list), and the broker URL is the address it is
actually bound to. Members with a claim in the last 90 s are not woken again, so a
resident poller and an on-demand worker cannot both serve the same message.

## 5. Verify the round trip

```sh
# A: hold a long-poll open (the broker answers as soon as something lands)
node adapters/cli/relay.mjs v2 pull --wait 30 --agent beta --secret-env-file <env>
# B: send — the response says whether the peer is reachable at all
node adapters/cli/relay.mjs v2 send beta "hello" --agent alpha --secret-env-file <env>
#   -> { message_id, created, root_id, target_online, last_seen_at, will_wake, hint? }
node adapters/cli/relay.mjs v2 ack <message_id> completed --agent beta --secret-env-file <env>
node adapters/cli/relay.mjs v2 status <message_id> --agent beta --secret-env-file <env>
```

`target_online: false` is not an error: the message is durably queued and
`hint` says what happens next (retained for `ttl`, and the sender gets an
"undelivered" reply if nobody ever claims it). `will_wake: true` means the broker
started the recipient for you. `v2 ask <target> <body>` does the whole
send-and-wait-for-the-answer handoff in one call.

Delivery semantics worth knowing while you test: at-least-once, a 600 s lease per
claim, 3 attempts before `failed`, and a `lease_token` on every claim that acks
and renewals must present.

## 6. Container (optional)

```sh
docker build -t dsh-agent-relay-broker -f broker/Dockerfile .
docker run -p 127.0.0.1:19121:19121 -v "$PWD/broker/data:/app/data" dsh-agent-relay-broker
# or the demo stack (broker + two CLI members):
cp setup/docker-compose.yml . && RELAY_SECRET=<secret> docker compose up --build
```

Bind the published port to loopback as above. The image refuses to start with the
placeholder secret.

## 7. Configuration

[`broker/config.example.yaml`](../broker/config.example.yaml) is the annotated
authority — copy it and read the comments. The defaults that matter:

| Key | Default | Effect |
|---|---|---|
| `broker.leaseSeconds` | 600 | how long a claim is exclusive before it re-queues |
| `broker.maxAttempts` | 3 | claims allowed before a request becomes `failed` |
| `broker.messageTtlDays` | 7 | how long an unclaimed request is retained |
| `broker.notifyFailedToSender` | true | an "undelivered" reply goes back to the sender |
| `security.admin_agents` | none | may requeue/cancel any message |

There is no rate limiting or auth-failure lockout to configure — those were v1
features and are not implemented; the loopback bind is the boundary
([SECURITY.md](SECURITY.md)).

ACLs are per mode: `allowed_read_targets`, `allowed_continue_targets`,
`allowed_write_targets` (the legacy `allowed_targets` covers read + continue).
A member with no entry may send read/continue to anyone; **write is closed unless
explicitly granted**. `ttl_seconds` is clamped to 60 s … 30 days, and terminal
messages are purged after 30 days.

## 8. Migrating from the self-use Python broker

```sh
node setup/migrate-v2.mjs --source "<path>/agent-relay.db" --data-dir ./data
```

Imports every `relay_messages` row into `relay_v2_messages`, preserving status,
attempts and idempotency keys. Start the Node broker on a **new** port first, run
`node setup/doctor.mjs` plus a `v2 send`/`pull`/`ack` round trip, then repoint the
members and move to 19121.

## 9. Upgrading

Wire-protocol changes bump `PROTOCOL_VERSION` in [PROTOCOL-V2.md](PROTOCOL-V2.md);
the broker and every client negotiate it and fail loudly on a mismatch instead of
degrading silently. Config-shape changes get an "Upgrade notes" entry in
[CHANGELOG.md](../CHANGELOG.md).
