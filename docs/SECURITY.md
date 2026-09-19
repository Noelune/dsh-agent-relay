# Security

## Threat model

The broker is a **loopback** service for agents on one machine. Everything below
is judged against that boundary; a listener reachable from a network is a
different system and this design does not secure it.

In scope:

- **Local forgery** — another local process (or user) sending messages as one of
  your agents. Mitigated by HMAC-SHA256 over the method, path, timestamp and
  canonical body digest, with a per-agent secret (or a shared one). A sender also
  has to name a target its ACL allows.
- **Replay** — re-sending a captured request. Mitigated by the ±300 s
  `X-Agent-Relay-Timestamp` window, and by delivery credentials: each claim
  issues a fresh `lease_token` that only the claiming recipient may present, and
  only while its lease is live.
- **Duplicate processing** — a retry after a lost ack delivering twice. Delivery
  is at-least-once by design; `(origin, idempotency_key)` dedups resends, and the
  token rule means a stale ack cannot move a message that has already moved on.

Explicitly **not** in place, so nobody mistakes a config key for a control:

- **No rate limiting and no auth-failure lockout.** `broker.rateLimit*` and
  `security.lock*` were v1 features and were removed with the v1 generation
  (`broker/src/auth.js`); old config files still load with those keys ignored.
  The control that exists instead is the bind address.
- **No encryption.** HMAC authenticates, it does not conceal. `broker.tls` is
  rejected at startup, and binding `0.0.0.0` is unsupported — if a circle ever
  spans machines, terminate TLS at a real reverse proxy and treat the broker as
  loopback-only behind it.
- **No content inspection.** Relay messages are data, not instructions. Every
  adapter must treat an incoming body as untrusted input, including one that
  arrives signed.
- **No defence against a compromised account.** A process running as your user
  can read `config.yaml`, the dotenv, and the queue file. Protect the secret like
  a password, because it is one.

## Secret management

- Generated locally (`crypto.randomBytes(32)`) by `node setup/setup.js init`.
- Stored in `broker/config.yaml`, which is gitignored — never commit it.
- Members resolve a credential in this order: inline setting → `AGENT_RELAY_SECRET`
  / `DSH_RELAY_SECRET` → `secret_env_file`, which reads
  `AGENT_RELAY_<NAME>_SECRET` from a dotenv the deployment **already** has →
  `secret_ref` + `vault_module`, which asks an external vault (on this machine:
  a DPAPI-protected store) for one named entry. The point of the last two is that
  joining a circle never requires writing the secret into a new plaintext file.
- Per-agent secrets and a v3 keyring (`agents.<name>.keys.<id>.{secret,not_after}`)
  allow rotation and revocation without touching other members; the implicit
  `legacy` key is the agent's single secret, so one config serves both signature
  generations.
- `add-member.mjs`, `sync-secrets.mjs`, `doctor.mjs` and the CLI report *where* a
  credential came from and whether two stores agree. None of them ever prints a
  value.

## Network

- Default bind `127.0.0.1:19121`. Requests from a non-loopback peer are accepted
  only if the operator deliberately reconfigured the host, which this guide does
  not recommend.
- The published port on a container must be bound to loopback
  (`-p 127.0.0.1:19121:19121`).

## Application-level guards

- A request without `X-Agent-Relay-*` headers is refused with `400` and a pointer
  to the protocol doc — there is no unauthenticated route except `GET /healthz`.
- Body cap 1 MiB per request; message and context length limits in characters,
  enforced against code points, not UTF-16 units.
- Per-mode routing ACL (`allowed_read_targets`, `allowed_continue_targets`,
  `allowed_write_targets`). A member with no entry may send read/continue to
  anyone; **write is closed unless explicitly granted**, and replies never carry
  write privileges. The ACL covers *requests*: an answer is authorised by the
  conversation it belongs to, so excluding a member blocks initiating traffic to
  it without blocking your reply to theirs.
- `requeue` is for the recipient, `cancel` for the originator, and only
  `security.admin_agents` may act on somebody else's message.
- Retention: an unclaimed request lives `broker.messageTtlDays` (7 days by
  default, `ttl_seconds` clamped to 60 s … 30 days); terminal rows are purged
  after 30 days, and with them their idempotency entry.
- No content logging: the broker logs ids and outcomes, never bodies. The dsh
  plugin keeps an in-memory id-level history; the CLI prints only what you ask.
- Constant-time signature comparison (`timingSafeEqual`).

## `wake_command` is the sharpest edge

To make an offline member reachable, the broker runs a configured command. That
means **anything a member's `wake_command` names is executed as the broker's
user** the moment someone sends it a message. Treat `config.yaml` accordingly:
file-system permissions on it are the authorization check, and it should never be
writable by another account or generated from untrusted input. Two constraints
limit the blast radius: the command template comes from the config, not from a
request, and the credential is handed to the child through its **environment**,
never on the command line, because argv is readable by every process on the box.

## Reporting

Open a GitHub issue (or, for sensitive details, contact the maintainers through
the repository). Anything that lets one member act as another, read another
member's messages, or reach `wake_command` without the config is treated as a
security bug, not a design property.
