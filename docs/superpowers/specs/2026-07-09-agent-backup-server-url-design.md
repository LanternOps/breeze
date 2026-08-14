# Agent Backup Server URL (Control-Plane Failover) — Design

**Date:** 2026-07-09
**Issue:** #2288 — "Add a secure control-plane URL migration workflow for agents"
**Status:** Approved design, pending implementation plan

## Problem

Agents persist a single `server_url` locally. If a self-hosted Breeze instance's
public URL changes (domain rename, new reverse proxy, new hosting provider),
existing agents keep calling the old URL forever. Today the only workarounds are
keeping the old hostname alive indefinitely, manually editing every endpoint's
config, or re-enrolling the fleet.

Issue #2288 proposes a full two-phase migration workflow (per-agent state
machine, staged rollout, MFA, signed migration offers, six-state status UI). We
are deliberately building something much smaller that solves the same problem:
a **backup server URL** pushed to agents over the existing trusted channel.
Agents persist it and naturally fail over when the primary stops answering.
Migration becomes: set the backup URL, wait for fleet pickup, decommission the
old URL.

## Goals

- An admin can pre-position a second control-plane URL on the entire fleet with
  one config change and zero per-agent interaction.
- Agents survive DNS outages: a DNS failure alone neither severs the control
  plane nor triggers a false failover.
- Agents fail over automatically and permanently when the primary URL dies,
  with validate-before-persist semantics (nothing is written until the backup
  authenticates the device).
- Rollback is inherent: the old URL is retained as the new backup.
- Operators can see which control-plane URL each agent is actually using.

## Non-goals (explicitly rejected from #2288)

- Per-agent migration orchestration / state machine (Pending/Validating/…).
- Staged rollout controls — pushing the backup URL is inert; nothing changes
  until the primary actually fails, so there is no rollout risk to stage.
- MFA / step-up auth — the setting is an env var; changing it requires host
  access, a stronger bar than any web-UI auth.
- Signed migration offers — the offer already rides the authenticated
  agent↔server channel; a compromised control plane can redirect agents in any
  design, including #2288's.
- Any admin UI for *setting* the value.

**Known limitation (document, don't build around):** this cannot rescue agents
that already lost contact with the old URL before the backup was pushed. Same
limitation exists in #2288's design.

## Design

### 1. API: `AGENT_BACKUP_SERVER_URL` env var

- New **optional** instance-level env var `AGENT_BACKUP_SERVER_URL`.
- Validated at boot by the API config validator: must parse as a URL with
  scheme `https` (`http` permitted only for `localhost`/`127.0.0.1`, for dev).
  A malformed value **refuses to boot** — never silently ignored.
- Logged at boot (value included) so the active setting is visible in server
  logs — this is the audit surface, alongside host-level `.env` change control.
- Self-hosted deploy docs: the var must be added to `/opt/breeze/.env` **and**
  mapped in the `api` service `environment:` block of the droplet
  `docker-compose.yml` (compose interpolation rule).

### 2. Push channel: heartbeat `configUpdate`

- The heartbeat route (`apps/api/src/routes/agents/heartbeat.ts`,
  `mergedConfigUpdate` assembly around line 799) always includes
  `backup_server_url` in `configUpdate`:
  - env var set → its value;
  - env var unset → `""` (empty string).
- **Empty string means "clear"**; key **absent** means "no change" (older API
  versions). This lets an instance retract a previously-pushed backup.
- Enrollment seeding: the bootstrap redemption response
  (`/api/v1/installer/bootstrap`, which already returns an authoritative
  `serverUrl`) and the enroll response also return `backupServerUrl` when
  configured, so new agents are born with it.

### 3. Agent config

- New non-secret field `backup_server_url` on `Config`
  (`agent/internal/config/config.go`), persisted in `agent.yaml` alongside
  `server_url`, written via existing `SetAndPersist` atomic-write plumbing.
- Validation mirrors `server_url` (parseable URL, http/https) **plus**
  https-only with a localhost exemption.
- `applyConfigUpdate` (`agent/internal/heartbeat/heartbeat.go:1650`) handles
  the new key (snake_case and camelCase, matching existing keys):
  - value differs from stored → validate, `SetAndPersist`;
  - value equals the current **primary** `server_url` → ignore (a backup
    identical to the primary is useless and would break swap semantics);
  - empty string → clear the stored backup.

### 4. Failover: heartbeat loop only

The heartbeat loop is the single failure detector and the only place that
switches servers. All other in-process subsystems (WebSocket, file transfer,
updater, command results, PAM/terminal/elevation signaling — and remote-desktop
signaling, which rides the main WS) build URLs from the shared in-memory
`cfg.ServerURL` per-request. Note this is the **in-memory struct**, not a
re-read of `agent.yaml` — so the swap must update the in-memory config *and*
persist; once it does, every in-process consumer follows on its next
request/reconnect with no per-subsystem failover logic.

- Count **consecutive** heartbeat failures against the primary (any transport
  error or non-2xx response — a healthy control plane returns 2xx). Any
  success resets the counter.
- After **N = 10** consecutive failures (~10 min at default cadence; constant,
  not configurable for v1), and only if a backup URL is set, attempt one full
  authenticated heartbeat against the backup URL.
- **Backup heartbeat succeeds** (2xx, valid response) → **promote-and-swap**:
  update the in-memory config, then
  `SetAndPersist(server_url = backup, backup_server_url = old primary)`.
  Log prominently. The swap is the validate-before-persist step *and* the
  rollback mechanism: if the promotion was a false positive (or the new server
  later dies while the old one lives), the same logic swaps back. Flapping is
  bounded by the N-failure threshold on each side.
- **Backup heartbeat fails** → nothing persisted; stay on primary, keep
  counting, re-probe the backup on each subsequent failed cycle.
- The WebSocket client reconnect loop needs no failover logic of its own — it
  rebuilds its URL from `cfg.ServerURL` on each reconnect attempt and will
  land on the new primary after a swap. Verify (and fix if needed) that it
  re-reads the (in-memory) config rather than caching the derived URL.

### 5. Sidecar processes (independent in-memory URL copies)

Three long-lived processes each `config.Load()` once at startup and never
watch `agent.yaml`, so a persisted swap does not reach them automatically:

**Watchdog** (`breeze-watchdog`) — constructs its `FailoverClient`, log
shipper, and updater with the startup `cfg.ServerURL`.

- When watchdog polls/requests start failing, it re-`Load()`s the config and
  rebuilds/updates those clients (add `UpdateBaseURL` or reconstruct), picking
  up a swap the agent already persisted.
- In true failover mode (agent process dead) with the primary also dead, the
  watchdog may use the backup URL **transiently** but never persists a swap —
  the agent owns persistence.

**Breeze Helper (Tauri, "Breeze Assist")** — reads `server_url` directly from
`agent.yaml` on first HTTP call and caches it for the process lifetime
(`apps/helper/src-tauri/src/lib.rs`, `ensure_http_state`). Fix: on an HTTP
request failure (transport error), invalidate the cached config, re-read
`agent.yaml`, and retry once. Self-heals after a swap without a helper restart.
(`load_agent_server_url`, the second independent reader used for portal-URL
validation, gets the same treatment or reads fresh each call.)

**Go desktop-helper** — its log shipper takes `cfg.ServerURL` at startup, but
the process is re-spawned per user session, so it picks up a swap on the next
spawn. No change needed; a stale log-shipper URL for the remainder of one
session is acceptable.

**Unaffected by design:** the viewer app and web UI derive the API URL from
the technician's browser origin / deep-link, not `agent.yaml`; TURN/STUN
servers are minted per-session by the API from `TURN_HOST`/`TURN_SECRET` and
are decoupled from the agent's control-plane URL.

### 6. DNS resilience: last-known-good IP cache

DNS failures should not take down the fleet (or trigger false URL failovers).
The agent gets a dial-level fallback shared by the HTTP client, the WebSocket
dialer, and the watchdog's clients:

- On every **successful** connection to a server hostname, persist the
  resolved IP(s) for that hostname to a small state file in the agent data
  dir (replace-on-success, kept indefinitely — no TTL knob; write only when
  the value changes).
- On a **DNS resolution failure** (specifically DNS errors, not connect
  errors), fall back to the cached IPs for that hostname, dialing the IP
  directly while keeping TLS `ServerName` and the Host header set to the
  original hostname — certificate verification against the real hostname
  still applies, so a hijacked or stale cached IP fails the TLS handshake
  rather than connecting somewhere untrusted.
- Fresh DNS is always preferred when it resolves; the cache never overrides a
  live answer, so normal DNS-based moves keep working.
- Keyed per-hostname, so it automatically covers both the primary and the
  backup URL.
- Interaction with failover: a DNS-only outage is absorbed by the IP cache
  (heartbeats keep succeeding), so the N-failure counter doesn't advance and
  agents don't spuriously migrate to the backup URL. A stale cached IP simply
  fails to dial/handshake and flows into the existing failure path.
- The Tauri helper keeps ordinary OS resolution — end-user chat degrading
  during a DNS outage is acceptable; the management plane is what must
  survive.

A hard-coded IP pin (`server_ip_override`) was considered and **rejected**:
the last-known-good cache covers every agent that has connected at least once
(i.e. every enrolled agent) with zero new config surface.

### 7. Visibility: active-server column

- Agent includes the URL it used for this heartbeat in the heartbeat payload
  (optional field `serverUrl`; older APIs must strip/ignore unknown fields —
  verify the Zod schema is non-strict for this route).
- API persists it on the device row: new nullable `agent_server_url` text
  column on `devices` (validated as a URL, length-capped ~512, written in the
  same UPDATE as `last_seen` — no extra write). Plain `ADD COLUMN IF NOT
  EXISTS` migration; `devices` RLS is unchanged.
- Web device list gets a column labeled **"Server"** (hidden/low-priority on
  narrow layouts) showing the hostname of `agent_server_url`. During a
  migration on a shared database, the operator watches this column flip from
  the old domain to the new one — the lightweight replacement for #2288's
  per-agent status UI.

## Security considerations

- **Trust anchor:** the backup URL only ever arrives over the existing
  authenticated agent↔server channel (heartbeat/enroll/bootstrap responses).
- **Validate-before-persist:** the primary `server_url` never changes until the
  agent completes a fully authenticated heartbeat against the backup.
- **HTTPS-only** for the backup URL, enforced independently on both the API
  (boot validation) and the agent (before persisting), localhost exempt.
- **No in-app write path:** no UI, no DB row, no API route sets the value —
  compromised admin credentials cannot redirect the fleet; host access is
  required.
- **Config file exposure:** `backup_server_url` lives in world-readable
  `agent.yaml` like `server_url`; it is not a secret.
- **IP-cache safety:** cached-IP dials keep TLS `ServerName`/Host set to the
  original hostname — full certificate verification is preserved; the cache
  changes only *where we dial*, never *what we trust*. The cache file is
  derived state in the data dir, not config, and poisoning it achieves
  nothing an attacker couldn't do by answering DNS (TLS is the control).

## Migration playbook (goes in self-hosted docs)

1. On the current instance, set `AGENT_BACKUP_SERVER_URL=https://new.example.com`
   (`.env` + compose `environment:` mapping) and restart the API.
2. Wait for fleet pickup (one heartbeat cycle for online agents; slower for
   intermittently-online endpoints — leave the old URL up long enough to catch
   stragglers).
3. Move/rename the instance to the new URL (same database in the common case).
4. Decommission the old URL. Agents fail over within ~N failed heartbeats
   (~10 min) and permanently swap to the new URL, keeping the old one as
   rollback backup.
5. On the new instance, either clear `AGENT_BACKUP_SERVER_URL` (agents drop the
   stale old-URL backup) or point it at a future DR alias.
6. Watch the device list "Server" column to confirm the fleet has moved.
7. If the TURN server is also moving, update `TURN_HOST` separately — remote
   desktop ICE config is minted per-session from that env var and is not
   affected by the agent server URL.

## Edge cases

- **Backup identical to primary:** agent ignores it (no-op, logged at debug).
- **Env var unset after being set:** heartbeat pushes `""`; agents clear their
  stored backup. Key absent (old API) changes nothing.
- **Both URLs down:** agent keeps alternating probes indefinitely; existing
  backoff/retry behavior is unchanged.
- **Swap while offline mid-write:** `SetAndPersist` is atomic
  (tmp+fsync+rename); a crash leaves either the old or new config, both valid.
- **Heartbeat interval note:** the heartbeat ticker is created once at loop
  start; the failure counter lives inside the loop, so no restart semantics
  change.

## Testing

- **Go unit tests:** failure-counter reset/threshold behavior; probe-then-swap
  persistence (assert both keys after swap, in-memory and on disk); swap-back
  on reverse failure; clear-on-empty-string; ignore-when-equal-to-primary;
  https validation with localhost exemption; `applyConfigUpdate` snake/camel
  key handling; watchdog config re-load on poll failure.
- **Go unit tests (DNS cache):** IP persisted on successful dial (and only
  rewritten on change); DNS-error → cached-IP fallback with hostname
  `ServerName` preserved; live DNS preferred over cache; connect (non-DNS)
  errors do not consult the cache; stale cached IP fails through to normal
  error path.
- **Helper (Rust) test:** cached config invalidated and re-read from
  `agent.yaml` after a transport-level request failure, retried once.
- **API tests:** boot validation (malformed value refuses to start; http
  non-localhost rejected); `configUpdate` contains value / empty string;
  bootstrap + enroll responses include `backupServerUrl`; heartbeat payload
  `serverUrl` persisted to `devices.agent_server_url` (validated, capped).
- **Web test:** device list renders the Server column from
  `agent_server_url`.
- **Manual/e2e:** one pass with a real agent against two local stacks —
  push backup, kill primary, observe swap in agent log and column flip.
