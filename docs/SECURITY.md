# Security

## Threat model

In scope:

- **Local forgery** — another local process (or user) forging messages between
  your agents. Mitigated by HMAC-SHA256 signatures with a shared secret.
- **Replay** — an attacker re-sending a captured request. Mitigated by the
  `X-Relay-Timestamp` window (±300 s) and message-id idempotency.
- **Brute force** — guessing the shared secret over HTTP. Mitigated by per-agent
  lockout (5 consecutive failures → 5 minute lock) and per-IP rate limits.
- **Eavesdropping on remote deployments** — mitigated ONLY by TLS. HMAC does
  not encrypt; a public plaintext broker leaks message content by design.

Out of scope (by design):

- **Malicious peer content** — relay messages are data, not instructions.
  Every adapter must treat incoming bodies as untrusted input.
- **Compromise of a machine holding the secret** — the secret grants full
  access to the relay; protect it like a password.

## Secret management

- Generated locally by `setup.js init` (`crypto.randomBytes(32)`).
- Stored in `broker/config.yaml` — gitignored; never commit.
- Agents read it from environment variables (`DSH_RELAY_SECRET`,
  `RELAY_SECRET`) or their own config stores.
- Rotate by regenerating and updating every agent.
- Remote deployments: distribute out-of-band; consider per-agent secrets in a
  future protocol version.

## Network

- Default bind: `127.0.0.1` only.
- Remote mode: `host: 0.0.0.0` requires TLS termination in front (see
  DEPLOY.md Mode B). The README and DEPLOY.md both state this explicitly.
- Rate limits: 600 req/min on loopback, 120 req/min otherwise (configurable).

## Application-level guards

- `POST /messages` validates: `to` required, `from` must match the auth
  header, self-send rejected, recipient must have registered.
- Body size cap: 1 MB per request.
- Message TTL: 7 days (configurable); expired messages are dropped.
- No content logging: broker logs events and ids only; the dsh plugin keeps an
  in-memory id-level history; CLI/Python clients print only what you ask them
  to print.
- Constant-time signature comparison (`timingSafeEqual`).

## Routing ACL (v1.1)

- Optional per-agent send whitelists: `agents.<name>.allowed_targets` in
  `broker/config.yaml`. A sender with an `allowed_targets` list may only send
  to those recipients (else `403 forbidden`).
- An agent without an entry may send to anyone (v1.0 default) — add ACL entries
  to tighten a shared broker.
- Lease-based delivery (`/v1/pull`, `/v1/ack`) adds replay protection at the
  message level: a pulled message is leased to one recipient and only they may
  ack it (`403` otherwise).

## Reporting

This is a community-maintained project. For security issues, open a GitHub
issue (or, for sensitive details, contact the maintainers via the repository)
— critical vulnerabilities get priority attention.
