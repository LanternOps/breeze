# Migrating Agents to a New Control-Plane URL

How to move an entire agent fleet to a new server URL (domain rename,
datacenter move, DR cutover) with zero per-device touch, using the
`AGENT_BACKUP_SERVER_URL` backup-URL mechanism (#2288).

Design doc: `docs/superpowers/specs/agent/2026-07-09-agent-backup-server-url-design.md`

## How it works

The API pushes a backup control-plane URL to every agent over the existing
authenticated heartbeat channel. Agents store it in `agent.yaml`
(`backup_server_url`) and do nothing with it while the primary is healthy.
After **10 consecutive failed heartbeats** to the primary (~10 minutes at the
default interval), the agent probes the backup with a fully authenticated
heartbeat. Only on an authenticated success does it **promote** the backup:
the in-memory and on-disk `server_url` swap, and the old primary is kept as
the new `backup_server_url` for rollback. The watchdog follows the persisted
swap (re-reading config on poll failures, transiently using the backup when
the agent process is dead — it never persists), and Breeze Assist re-reads
`agent.yaml` and retries once on transport failures.

Security properties:

- The backup URL only ever arrives over the authenticated agent↔server
  channel (heartbeat, enroll, and bootstrap responses).
- The primary `server_url` never changes until the agent completes a fully
  authenticated heartbeat against the backup (validate-before-persist).
- HTTPS-only, enforced independently on both the API (boot validation) and
  the agent (before persisting). `http://` is allowed only for localhost.
- No UI, DB row, or API route sets the value — compromised admin credentials
  cannot redirect the fleet; host access to the server env is required.

## Playbook

1. On the **current** instance, set
   `AGENT_BACKUP_SERVER_URL=https://new.example.com` (`.env` **and** the
   compose `environment:` mapping for the `api` service — a value in `.env`
   alone is not interpolated) and restart the API.
2. Wait for fleet pickup (one heartbeat cycle for online agents; slower for
   intermittently-online endpoints — leave the old URL up long enough to
   catch stragglers). The value is re-pushed on every heartbeat, so agents
   that appear later still receive it.
3. Move/rename the instance to the new URL (same database in the common
   case).
4. Decommission the old URL. Agents fail over within ~10 failed heartbeats
   (~10 min) and permanently swap to the new URL, keeping the old one as
   rollback backup.
5. On the **new** instance, either clear `AGENT_BACKUP_SERVER_URL` (agents
   drop the stale old-URL backup — an empty push clears; an absent key
   changes nothing) or point it at a future DR alias.
6. Watch the device list **"Server" column** (opt-in via the column picker on
   the Devices page) to confirm the fleet has moved: it shows the hostname
   each agent actually heartbeats to, and flips from the old domain to the
   new one as agents migrate.
7. If the TURN server is also moving, update `TURN_HOST` separately — remote
   desktop ICE config is minted per-session from that env var and is not
   affected by the agent server URL.

## Known limitation

The mechanism cannot rescue agents that already lost the old URL: the backup
must be delivered over a working heartbeat channel *before* the old URL goes
away. If an instance is already unreachable and no backup was pushed, those
agents need reinstallation (or a DNS-level fix that restores the old
hostname). Push the backup URL well in advance of any planned move — an
inert backup costs nothing.

## DNS resilience (last-known-good IP cache)

Independently of the backup URL, agents keep a per-hostname cache of the last
IP set that produced a successful connection (`dns-cache.json` in the agent
data dir), shared by the heartbeat HTTP client, the WebSocket dialer, and the
watchdog's client:

- Fresh DNS is always preferred; the cache is consulted **only** when
  resolution itself fails (never on connect errors), so normal DNS-based
  moves keep working.
- Cached-IP dials keep TLS `ServerName`/Host set to the original hostname —
  full certificate verification is preserved. The cache changes only *where
  we dial*, never *what we trust*; a stale or hijacked cached IP fails the
  TLS handshake rather than connecting somewhere untrusted.
- Interaction with failover: a DNS-only outage is absorbed by the IP cache
  (heartbeats keep succeeding), so the failure counter doesn't advance and
  agents don't spuriously migrate to the backup URL.

## Edge cases

- **Backup identical to primary:** agents ignore it (no-op).
- **Env var unset after being set:** the heartbeat pushes an empty value and
  agents clear their stored backup. A key that is absent entirely (older
  API) changes nothing.
- **Both URLs down:** agents keep retrying the primary and probing the
  backup every heartbeat cycle; the watchdog alternates its target every ~10
  polls. Existing backoff/retry behavior is unchanged.
- **Crash mid-swap:** the promotion writes both keys in a single config-file
  write, so the swap itself cannot be torn across writes. The write is a
  plain file rewrite (not fsync'd); in the unlikely event of power loss
  mid-write leaving a damaged agent.yaml, re-push the backup URL after
  restoring the config. As defense-in-depth, an on-disk backup equal to the
  primary is warned about and cleared at agent startup.
