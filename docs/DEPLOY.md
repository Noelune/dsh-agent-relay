# Deployment Guide

Two modes:

- **Mode A — single machine (default, recommended):** broker and all agents on
  one computer, everything on loopback. Zero network exposure, 5-minute setup.
- **Mode B — distributed (advanced):** agents on different machines share one
  broker. Requires a server, TLS, and careful secret management.

---

## Mode A — single machine

### 1. Clone and install

```sh
git clone https://github.com/Noelune/dsh-agent-relay.git
cd dsh-agent-relay
# broker has no third-party dependencies; nothing to install for the CLI either
```

### 2. Initialize (generates a random secret + config)

```sh
node setup/setup.js init
```

This writes `broker/config.yaml` with a fresh 64-hex-char secret. **Never
commit this file** (it is gitignored).

### 3. Start the broker

```sh
node setup/setup.js start
# or, foreground with a custom config:
node broker/src/index.js --config broker/config.yaml
```

Verify:

```sh
node setup/setup.js selfcheck
```

### 4. Connect agents

**dsh (recommended):**

```sh
dsh plugin --profile web add dsh-agent-relay
# then configure the shared secret (env or plugin settings):
export DSH_RELAY_SECRET=<the-secret-from-config.yaml>
export DSH_RELAY_AGENT=dsh-agent          # pick a stable name
```

**CLI client** (scripts, Codex/Claude wrappers):

```sh
export DSH_RELAY_AGENT=alpha
export DSH_RELAY_SECRET=<the-secret>
node adapters/cli/relay.mjs register
node adapters/cli/relay.mjs send beta "hello from alpha"
node adapters/cli/relay.mjs recv
node adapters/cli/relay.mjs peers
```

**Python client** (Hermes-style agents):

```python
from adapters.hermes.relay_client import RelayClient

client = RelayClient("http://127.0.0.1:19121", agent="beta", secret="<the-secret>")
client.register()
client.send("alpha", {"text": "hi"})
```

### 5. Verify the round trip

```sh
# terminal 1
node adapters/cli/relay.mjs watch --agent beta --secret <secret>
# terminal 2
node adapters/cli/relay.mjs send beta "hello" --agent alpha --secret <secret>
# terminal 1 prints the message
```

---

## Mode B — distributed (advanced)

Requirements: a server with a public (or VPN-reachable) address, TLS, and
discipline about secret handling.

### 1. Broker on the server

```sh
git clone https://github.com/Noelune/dsh-agent-relay.git
cd dsh-agent-relay
node setup/setup.js init
# edit broker/config.yaml:
#   host: 0.0.0.0
#   rateLimitRemote: 120
```

### 2. TLS — mandatory

HMAC only proves the sender; it does not encrypt. On a public network, run the
broker behind a reverse proxy with TLS (nginx / Caddy / cloud load balancer)
terminating HTTPS, forwarding to 127.0.0.1:19121. The broker itself stays
loopback-bound behind the proxy:

```nginx
server {
  listen 443 ssl;
  server_name relay.example.com;
  ssl_certificate     /etc/letsencrypt/live/relay.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/relay.example.com/privkey.pem;
  location / {
    proxy_pass http://127.0.0.1:19121;
    proxy_set_header X-Forwarded-For $remote_addr;
  }
}
```

### 3. Agents point at the HTTPS URL

```sh
export DSH_RELAY_BROKER_URL=https://relay.example.com
export DSH_RELAY_SECRET=<same-secret-everywhere>
```

### 4. Hardening checklist

- [ ] TLS only (no plaintext HTTP on the public interface)
- [ ] Secret distributed out-of-band (password manager / sealed envelope), rotated regularly
- [ ] Restrict `GET /messages` polling to known agents (HMAC already does this)
- [ ] Watch the broker logs for repeated `locked` events (brute-force attempts)
- [ ] Keep `config.yaml` out of version control everywhere

For Docker, mount a generated `broker/config.yaml` or provide `RELAY_SECRET`; the image refuses to start with the example placeholder.

---

## v1.1 configuration (optional)

The broker ships with lease-based reliable delivery enabled by default:

- `broker.leaseSeconds` (default **600**) — how long a pulled message is leased before it is
  re-queued for another attempt.
- `broker.maxAttempts` (default **3**) — retries allowed before a message is marked `failed`.
- `broker.storage` (default **sqlite**) — uses Node's built-in SQLite when available; Node 20 falls
  back to JSONL automatically. Set `jsonl` explicitly for compatibility or migration testing.

Per-agent routing ACL is optional and off by default (v1.0 compatible). To restrict who may send to
whom, add an `agents` block to `broker/config.yaml`:

```yaml
agents:
  alpha:
    allowed_targets: [beta, gamma]
```

An agent with `allowed_targets` may only send to the listed names (else `403 forbidden`); an agent
without an entry may send to anyone. The dsh plugin records completed replies as receipts
(`~/.dsh-agent-relay-receipts.json`) so a restarted agent replays, not re-runs, finished requests.

## Containerized deployment (optional)

```sh
docker build -t dsh-agent-relay-broker -f broker/Dockerfile .
docker run -p 19121:19121 -v $PWD/broker/data:/app/data dsh-agent-relay-broker
```

Or the demo compose stack (broker + two CLI agents):

```sh
cp setup/docker-compose.yml . && RELAY_SECRET=<secret> docker compose up --build
```

## Upgrading

- Wire protocol changes bump the protocol version in `docs/PROTOCOL.md`; the
  broker and all adapters negotiate it on startup and refuse mismatches loudly.
- Plugin API changes of dsh itself are tracked in [CHANGELOG.md](../CHANGELOG.md)
  with upgrade notes. This project is tested against dsh 0.1.0-rc.6.

## Switching from the self-use Python broker (Phase 7)

This repository is the converged home of the v2 wire protocol and the advanced
capabilities that previously lived in the self-use Python broker (`relay/`)
and the custom dsh plugin. To cut over without losing history:

1. **Prepare the Node broker config** mirroring your self-use `agent_relay`
   section — per-agent secrets and per-mode ACLs (note: the config loader is a
   YAML subset — use nested mappings + inline arrays, not flow `{...}` maps):

   ```yaml
   broker:
     host: 127.0.0.1
     port: 19122              # NEW port first; keep the old broker running
     secret: <shared-hex>     # or configure per-agent secrets under agents:
     storage: sqlite
     dataDir: ./data
     leaseSeconds: 600
     maxAttempts: 3
     notifyFailedToSender: true

   agents:
     codex:
       secret: <hex>
       allowed_read_targets: [claude, hermes, openclaw, dsh]
       allowed_write_targets: []
     claude:
       secret: <hex>
       allowed_read_targets: [codex, hermes, openclaw, dsh]
       allowed_write_targets: []
     hermes:
       secret: <hex>
       allowed_read_targets: [codex, claude, openclaw, dsh]
       allowed_write_targets: [claude]
     openclaw:
       secret: <hex>
       allowed_read_targets: [codex, claude, hermes, dsh]
       allowed_write_targets: []
     dsh:
       secret: <hex>
       allowed_read_targets: [codex, claude, hermes, openclaw]
       allowed_write_targets: []
   ```

2. **Migrate the message history** from the self-use database:

   ```bash
   node setup/migrate-v2.mjs \
     --source "D:/AI机器人/飞书CodexClaude机器人/data/agent-relay.db" \
     --data-dir ./data
   ```

   (requires Node ≥ 22.13 for built-in SQLite; imports every `relay_messages`
   row into `relay-v2.db` preserving state, attempts, idempotency.)

3. **Start the Node broker on the new port** and validate with
   `node setup/setup.js selfcheck` plus a `v2 send/pull/ack` round trip.

4. **Point each agent at the new port** — set the relay endpoint to
   `http://127.0.0.1:19122` (for the dsh plugin, either
   `~/.dsh/agent-relay.json` `endpoint` or the `DSH_RELAY_BROKER_URL` env), and
   for standalone codex/claude agents run
   `node adapters/relay-agent.mjs --agent <name> --broker http://127.0.0.1:19122 ...`.

5. **Smoke-test the whole circle**: every agent can send/receive; `agent_relay_peers`
   shows all members online; a write request reaches an allowed target.

6. **Cut over**: stop the self-use Python broker on 19121, change the Node
   broker port back to 19121 (or repoint clients), and remove the old
   `~/.dsh/agent-relay*.json` receipts if you want a clean slate.

7. **Retire** the self-use `relay/` package and the custom plugin code once the
   circle has run clean for 24 h — their capabilities now live in this repo.
