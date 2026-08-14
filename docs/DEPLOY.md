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

---

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
