---
title: Horizontal API scaling and agent capacity program
status: approved by the owner 2026-10-07 (all five §9 decisions, as written). Advisor quorum 2026-10-07 (Fable author + Codex gpt-6-astra xhigh, read-only) agreed on W2 per-instance BullMQ queues, W3 owner-affinity, least-connections placement and server-paced drain. Its amendments are folded in: lease fencing (R7/W2a), the immediate first reconnect (§1, W1d), whole-lifecycle session routing, pre-send-only retry.
date: 2026-10-07
origin: production capacity incident on one hosted region, 2026-10-05..07, at v0.121.0
related: "worker split (BREEZE_ROLE, docs deploy/worker-split.mdx; plan ai-mcp/2026-08-27-ai-agents-wave3.5b-socket-affinity-relay.md); #8053 heartbeat transactions; #8055 single set_config; #8054 negative agent-auth cache; #7235 server-only release lane"
---

# Horizontal API scaling and agent capacity program

Evidence labels: **[V]** verified against `origin/main` at `04dbfc305e`, file:line cited.
**[M]** measured in production (incident telemetry, not reproducible from the repo).
**[I]** inferred, to be confirmed by W0 measurement.

## 1. Problem

One region ran one Node API process. That single event loop saturated at about
170–250 online agents [M]. The arithmetic matches: about 5 agent requests per
agent-minute at about 70 ms of API CPU each is about 350 CPU-ms per agent-minute.
One core gives 60,000 CPU-ms per minute, so it saturates near 170 agents [M/I].
At that cost, 10,000 agents would need about 833 req/s and about 58 cores before headroom.
A customer rollout doubled the agent count in one day.

The failure spiral [M]:

1. The event loop slows, so agent HTTP calls time out (30 s client timeout, 3
   retries — `agent/internal/heartbeat/heartbeat.go:1003`,
   `agent/internal/httputil/retry.go:28` [V]) and agent WebSockets reconnect.
2. The RLS GUC prologue (`applyAccessContextGucs`, `apps/api/src/db/index.ts:488`
   [V]) misses its deadline. Abandoned pool slots are not reclaimed fast enough,
   so the usable pool shrinks.
3. An API restart re-synchronizes every agent. When an established agent WS
   drops, the agent reconnects **immediately, with no delay**. Backoff (1 s → 60 s,
   ±30 % jitter) applies only after a *failed* connect, and it resets after any
   connection that lasted 30 s (`agent/internal/websocket/client.go:42-45,385-432`
   [V]). So every agent hits the restarted API at once, which restarts the spiral.

Shipped mitigations: a host resize; the worker split (121 of 161 job consumers off
the API; API CPU about 1.0 → 0.6 core at 250 agents [M]); #8055; #8054;
temporary edge load-shedding. #8053 (about 12 transactions and 50–80 queries per
heartbeat) is in progress.

That still leaves about 144 API CPU-ms per agent-minute [M], or about 400
agents per core. The target is 10,000+ agents. No single-process tuning closes a
25× gap with headroom, and one process is a SPOF. Breeze needs **N API
instances per region**, and a lower per-agent cost so N stays small.

Earlier "10k agent" k6 runs prove nothing about this. `load-tests/scenarios/heartbeat.js:43-63`
[V] uses one shared token, fake agent IDs and a toy payload.

## 2. Goals and non-goals

**Goals**

| # | Goal | Target |
|---|---|---|
| G1 | Capacity per region | M1 = 1,000 agents, M2 = 5,000, M3 = 10,000, each with N+1 API instances |
| G2 | Per-agent efficiency KPI | API CPU-ms per agent-minute: ≤60 (M1), ≤25 (M2), ≤15 (M3). At M3 that is ≥2,000 agents per instance at ≤50 % event-loop utilization |
| G3 | Latency | p95 heartbeat ≤300 ms at the milestone load, ≤1 s during a drain or failover |
| G4 | DB load | ≤8 DB transactions per agent-minute (M1), ≤4 (M3). Today it is ≥18: 12 per heartbeat + 3 per unifi-collectors poll × 2/min (#8053) |
| G5 | Availability | No single API process is a SPOF. Killing any one instance loses no queued command and fails no in-flight HTTP request more than once |
| G6 | Deploys | A rolling deploy moves agent sockets gradually: no instance takes more than 2× its steady-state WS accept rate, and no reconnect storm |

**Non-goals**: multi-region active-active; moving off Postgres/Redis; Kubernetes;
sharding tenants across databases; changing the self-host default (one `all`
container stays the default and must keep working).

## 3. Capacity model

**Request mix per agent-minute** [I, to be measured by W0]: 1 heartbeat
(`DefaultHeartbeatIntervalSeconds = 60`, `agent/internal/config/config.go:355`
[V]); 2 `unifi-collectors` polls (every 30 s, #8053); about 2 more from inventory
and collector PUTs, command results, and monitor results, plus WS ping and
message frames. The heartbeat is about 12 transactions [M].

**KPIs** (W0 dashboard; export per instance and per region):

| KPI | Definition | Source |
|---|---|---|
| Agent cost | API-role process CPU-ms ÷ online agents, per minute | process CPU + presence-lease count |
| Heartbeat latency | p50/p95/p99 of `POST /agents/:id/heartbeat` | existing Prometheus `/metrics` (`routes/metrics.ts` [V]) |
| DB intensity | Δ`xact_commit` ÷ online agents, per minute | `pg_stat_database` |
| Saturation | event-loop utilization and lag p99; pool in-use/waiting; prologue-deadline expiries | process metrics |

**Next bottlenecks once the API scales out:**

- **Postgres connections.** Each process opens up to `DB_POOL_MAX` (default 30,
  `db/index.ts:39-48` [V]), plus side clients (health probe, reclaimer). The
  repo's compose sets no `max_connections`, so it is the Postgres default of 100
  [V]. Six API instances plus one worker at 30 each is 210. Budget rule:
  `Σ(pool_max) + side_clients ≤ 0.8 × max_connections`. Lower the per-instance
  pool as tx/heartbeat falls. Add PgBouncer in transaction mode at M2: the GUCs
  are `set_config(…, true)`, so they are transaction-local and survive
  transaction pooling [V]. The driver needs prepared-statement compatibility
  [I].
- **Postgres CPU and WAL.** At M3 and 4 tx per agent-minute, agents alone are
  about 670 tx/s [I]. This is why G4 is a gate and not a nice-to-have.
- **Redis.** Compose defaults to `maxmemory 256mb`, `noeviction` [V]. Presence
  leases (90 s TTL, `services/agentPresence.ts:10` [V]) are refreshed for every
  agent, and the per-instance relay queues add load. The remote-WS shared lease
  requires a **standalone single-primary** Redis (`services/remoteWsRedisTopology.ts:75`
  [V]), so Sentinel or Cluster HA would make remote sessions refuse admission.
- **Ingress.** One cloudflared connector and one Caddy are each a SPOF.
  Cloudflared supports several connectors on one tunnel [I].
- **Co-located jobs.** Backups and other jobs on the app host compete for the
  same CPUs [M]. Move them off-host, or nice them and schedule them away from
  peak load.

## 4. Readiness gaps at `origin/main` (verified)

| # | Gap | Evidence |
|---|---|---|
| R1 | Agent sockets live in a per-process `activeConnections` map. `sendCommandToAgent` and `isAgentConnected` check local memory only, and throw on the worker role | `routes/agentWs.ts:278, 4766-4774, 4779, 4864` |
| R2 | The relay uses ONE shared BullMQ queue, `agent-command-relay`, with `attempts: 1`. A consumer on the wrong instance checks its local socket map first, so it usually acks `offline` (otherwise `owner_mismatch`). With more than one API instance, a pickup by the wrong instance drops the command and reports it as offline | `services/agentCommandRelay.ts:42, 204-255`; `jobs/agentCommandRelayWorker.ts:36-45`. The 3.5b plan explicitly deferred multi-replica support (plan line 16) |
| R3 | 20 non-test files call `sendCommandToAgent`/`isAgentConnected` directly. 26 import `routes/agentWs` (adding `getConnectedAgentIds`, `disconnectAgent`, `broadcastToAgents`). Only 8 files reference the relay API (`dispatchCommandToAgent`/`isAgentConnectedAnywhere`) | e.g. `services/commandQueue.ts:286,301,1346,1548`; `scriptDispatch.ts:874`; `dispatchDeviceCommand.ts:307`; `wakeOnLan.ts:274,349,464` |
| R4 | Remote sessions are process-local. The shared lease prevents double ownership but forwards no frames | `routes/desktopWs.ts:197,201`; `terminalWs.ts:113,118`; `tunnelWs.ts:58-75`; `services/remoteWsSharedLease.ts` |
| R5 | Other in-process state (full list in W4): pending command awaits, orphaned-result expectations, AI streaming sessions, local-only tenant socket disconnect, integration settings maps | `services/agentCommandAwait.ts:43`; `agentWs.ts:562`; `streamingSessionManager.ts:787`; `tenantLifecycle.ts:75-85`; `routes/integrations.ts:29-32` |
| R6 | No socket drain on shutdown, and the server sends agents no backoff hint [I: no close-code or delay signalling found in `index.ts` shutdown or `agentWs.ts`]. Agents honour HTTP `Retry-After` per request only (`httputil/retry.go:64,132`, capped at 300 s) | as cited |
| R7 | **Presence fencing breaks with overlapping sockets.** When a pong or heartbeat refresh fails its token check, the socket re-writes the lease unconditionally as long as *its own* local map still holds it. With one instance, the local-map guard is enough. With N, a half-open old socket on A and the new socket on B both pass their local guard, so they overwrite each other's lease. `clearAgentPresenceUnfenced` deletes without a token | `routes/agentWs.ts:3066-3072, 3082-3086`; `services/agentPresence.ts:85` |
| R8 | Trusted proxies must be pinned at /32 (`config/validate.ts:430-436`). The repo compose pins Caddy on a fixed subnet (`docker-compose.yml:101,732,1096`). The hosted compose drifted from this and lost its pin when Docker reassigned IPs on reboot [M] | as cited |

Already built and reused: per-boot `INSTANCE_ID` (`services/instanceIdentity.ts`);
presence leases with `instanceId` and `connectionToken` (`agentWs.ts:2829`); the
sealed, AAD-bound relay envelope with an ack channel and at-most-once send claims;
Redis pub/sub for credential revocation and partner trust (`agentWs.ts:364,481`);
`global` vs `socket-owner` worker placement (`services/workerRegistry.ts`);
DB-claimed winners for incident jobs (`jobs/incidentJobs.ts`, `FOR UPDATE SKIP LOCKED`).

## 5. Recommended architecture (summary)

- **N stateless-for-HTTP API instances per region.** Agent HTTP goes to any
  instance. An agent WS goes to any instance, and that instance owns the socket.
- **The presence lease is the routing table, and it is strictly fenced.** A
  superseded socket never re-takes the lease. A command for an agent goes to the
  lease's instance through that instance's own relay queue.
- **Viewer remote sessions route to the agent's owner (W3).** Frames are not
  forwarded between instances.
- **Each instance has two identities.** A stable **slot** (`api-1`…`api-N`) is
  used for addressing. The per-boot `INSTANCE_ID` is used for fencing.
- **Admission control and a server-paced drain** live in the API and the agent,
  not at the edge.

## 6. Workstreams

Each wave ships on its own and is behind topology: with one API instance, every
new path is either the old path or unreachable.

### W0 — Realistic agent simulator, perf gate, KPI dashboard

| Wave | Scope | Acceptance |
|---|---|---|
| W0a | Go simulator (`load-tests/agentsim/`). It enrolls N devices through a real enrollment key and stores a distinct token for each, and it reuses the agent's own payload structs. Cadences match production: heartbeat 60 s, unifi-collectors 30 s, inventory PUTs, a persistent WS with pings, and command-result replies | 2,000 simulated agents against a lab stack; the server sees 2,000 distinct device rows and presence leases; the mix is within ±10 % of production's 5 req/agent-min |
| W0b | Storm scenarios: kill the API, drop every socket, inject a slow event loop, roll a deploy | Each scenario reports the reconnect curve, p95/p99, pool-size recovery, and the error budget |
| W0c | KPI dashboard (§3) per instance and region, plus a manual/nightly `perf` workflow on fixed hardware that fails on a >15 % KPI regression | The first baseline is committed; a deliberately slowed handler reds the gate |
| W0d | Per-PR mechanical gate: tests assert transaction and query counts per heartbeat and per hot agent route (the pattern #8053 introduces) | A new query on the heartbeat path fails CI |

### W1 — Per-agent efficiency and storm resilience

| Wave | Scope | Acceptance |
|---|---|---|
| W1a | Land #8053. Part 1 (shipped in #8128) took the steady-state heartbeat from 9 to 3 transactions and from 96 to 69 statements, and collector-less unifi polls to 0 transactions. Part 2 is two PRs, sized by the measured statement trace below. **W1a-1**: build the device, org and group hierarchy once per heartbeat from data that is already loaded and pass it explicitly to every resolver; skip topology negotiation when materialization is off; per-org caches for probe rules, org helper settings and `pam_org_config`; one `agent_versions` read instead of three; join the site timezone into the core device read; drop empty savepoints. **W1a-2**: one batched policy-assignment read for all feature types instead of one per resolver; fold the OneDrive context into the policy context; cache monitoring's "no policy applies" with invalidation | W1a-1: steady-state heartbeat ≤30 statements, ≤3 tx. W1a-2: ≤16 statements, ≤2 tx. ≤1 tx per unifi poll in the common case. The budget suite asserts each number |
| W1b | A **cluster cache** primitive: in-process TTL cache plus Redis pub/sub invalidation by key (ids only, no payload). Use it for the trust keyset, delegations, per-org update config and topology flags | KPI ≤60 CPU-ms/agent-min (M1). A cache test proves a write on instance A invalidates instance B within 1 s |
| W1c | API-side admission control. Shed by priority when event-loop lag or pool wait crosses a threshold: inventory and collector PUTs first, heartbeats last, with `503` + `Retry-After`. Rate-limit WS upgrades per instance with a token bucket, and refuse excess upgrades with close code 1013 and a delay hint. Remove the edge load-shedding | Under a W0b storm, p95 heartbeat stays ≤1 s and the pool never drops below 80 % of max |
| W1d | Agent: (1) add jitter to the **first** reconnect after an established socket drops; today it is immediate. (2) Honour an application-level `drain` message `{reconnectWithinMs}` sent before the close; a close code alone cannot carry a delay. Spread the reconnect uniformly over that window. (3) Honour `Retry-After` **at the loop level**, deferring the next cycle rather than only the retry. (4) Jitter startup and periodic requests. *This ships to customer machines, so full rigor applies.* Old agents still rely on W1c | 10k simulated agents told "reconnect within 120 s" arrive spread over 120 s ±10 %. An unannounced API kill produces no reconnect spike above the W1c admission rate |
| W1e | Prologue and pool reclamation. When the prologue deadline expires, the slot must return to the pool within a bound; the pool max is restored | W0b slow-loop chaos: pool returns to max within 30 s of the stall ending |

**Heartbeat statement trace (W1a sizing, [M] on a test stack at `origin/main` `99bbbc7029`, 2026-10-07).** The steady-state beat is 69 statements over 3 transactions: the org block, the OneDrive system context and the shared policy context. With the per-device Redis caches warm it is 47; with the 120 s cache TTL and 60 s beats, a fleet averages about 58 [I]. Agent auth adds about 4 more and is not counted [I].

| Bucket | Statements | W1a lever |
|---|---|---|
| Device, org and group lookups repeated by 11 resolvers | 32 | W1a-1 hierarchy pass-through (−31) |
| Per-feature policy-assignment reads | 10 | W1a-2 batched read (−9) |
| BEGIN/COMMIT, RLS prologue, savepoints | 14 | W1a-1 drops empty or redundant savepoints; W1a-2 removes one transaction |
| Other config reads (probe rules, helper settings, PAM org config, site timezone) | 4 | W1a-1 per-org caches and join (−4) |
| `agent_versions` (agent, helper, watchdog) | 3 | W1a-1 single read (−2); not cached, because the version offered must match the bytes served |
| Topology lock read, with materialization off | 1 | W1a-1 skip (−3, counting its 2 savepoints from the row above) |
| Writes, command claim, core device read | 5 | kept |

Two findings from the trace: the monitoring resolver never caches "no policy applies" (`helpers.ts` ~2686), so a device without a monitoring policy pays 8 statements on every beat even when warm; and the budget suite's payload omits `securityCapabilities`, which adds 2 statements a current agent never causes. The realistic floor after W1a-1 and W1a-2 is about 12 statements over 2 transactions; a generation-stamped whole-config cache could take a warm beat to about 7, at the cost of bumping a generation on every config write surface.

### W2 — Multi-instance command routing

Recommendation (quorum-agreed): a **BullMQ queue per boot instance**,
`agent-command-relay:{instanceId}`, consumed only by that instance. The sealed
envelope, ack channel and `claimRelaySend` claim stay. Redis Streams would add
recovery machinery without solving ownership. Pub/sub with an ack loses
messages while the consumer is busy.

**Retry semantics.** Retry only a **pre-send** `owner_mismatch` or `offline`,
where the claim was never taken. Re-read the lease, re-seal for the new owner
(the AAD binds `targetInstanceId`), keep the `commandId` and the original 5 s
deadline (`RELAY_DELIVERY_DEADLINE_MS`), and bound the retries with jitter.
Never replay an `indeterminate` send automatically: BullMQ stalled jobs can run
again, and only the claim prevents a double send. Unify the claim across the
local, relay and polling delivery paths. Jobs in a dead instance's queue expire
through `expiresAt`. Live instances reap queues whose instance is no longer in
the registry.

| Wave | Scope | Acceptance |
|---|---|---|
| W2a | **Ownership fencing (R7), before any second instance.** A failed refresh re-acquires the lease only when the key is absent (`SET NX`). A socket whose token has been superseded closes itself instead of overwriting the lease. Remove `clearAgentPresenceUnfenced`. Add a live-instance registry (`instance:{id}` with a TTL heartbeat and the instance's slot) | Two overlapping sockets for one agent on two instances: the lease converges to the newer one within one ping interval and never flaps |
| W2b | Per-instance queues, the pre-send retry, dead-queue reaping, and metrics: relay queue age and the `owner_mismatch`, `offline`, `expired` and `indeterminate` rates | With 3 API instances, 10,000 dispatches from random instances: 100 % `sent`, 0 dropped by owner mismatch, 0 double sends under injected stalls |
| W2c | One routing module, `services/agentRouting.ts` (the name is a placeholder): `dispatch`, `isOnline`, `disconnect`, `disconnectWhere(orgIds)` and `broadcast`. The cluster-wide operations fan out over pub/sub. Migrate all 20 direct callers and the 26 importers. An import-graph contract test fails CI when any file outside {`agentWs.ts`, the relay consumer, `agentRouting.ts`} imports `sendCommandToAgent`, `isAgentConnected`, `getConnectedAgentIds`, `disconnectAgent` or `broadcastToAgents` | A synthetic offender reds the test; the allowlist is the only importer |
| W2d | Result delivery: `agentCommandAwait` waiters can sit on a different instance from the socket owner. Publish results by `commandId` over pub/sub, with `device_commands` as the durable fallback | An await started on A for an agent on B resolves |

### W3 — Remote sessions across instances

Options:

| Option | Latency | Bandwidth | Complexity | When an instance dies |
|---|---|---|---|---|
| (a) Owner-affinity: the viewer ticket mint reads the lease and returns a slot-addressed URL (`/i/<slot>/…`); Caddy routes by path prefix; the session ends cleanly and the viewer re-resolves if the agent moves | Unchanged (one hop) | Unchanged | Low–medium: slot routing plus a ticket bound to an instance | The session drops, as it does today; the viewer reconnects through a fresh ticket |
| (b) Frame forwarding between instances through Redis Streams | +1 Redis round trip per frame | Every byte crosses Redis twice; desktop WS fallback is heavy | High: ordering, backpressure, memory in a `noeviction` Redis | Same as (a) plus a partial-forward state |
| (b′) Direct instance-to-instance WS | +1 hop | Doubles internal traffic | High: a mesh, auth between instances, discovery | As (b) |
| (c) Hybrid: (a) as the default, (b) only for small control messages | as (a) | as (a) | Medium | as (a) |

**Recommendation (quorum-agreed): (a), with WebRTC kept for desktop media.**
WS carries terminal, tunnel and the desktop fallback, and all three already end
when the agent's socket moves.

Route the **whole session lifecycle** to the owner: setup, signalling, the
viewer upgrade and teardown. Pinning only the viewer upgrade would miss the
session state that setup creates. Each ticket (`services/remoteSessionAuth.ts`)
is bound to the owner's ownership generation (`instanceId` + `connectionToken`).
An instance refuses a ticket bound to another generation, so a slot never acts
as authorization.

A stable slot name (`api-1…N`) makes static Caddy path routes possible. A
registry that maps boot ids to endpoints would also work; the slot is simpler
with a fixed compose topology. If forwarding is ever needed, prefer
authenticated direct WS between instances with bounded buffers over Redis
Streams. Forwarding still cannot save a session when the owner dies.

| Wave | Scope | Acceptance |
|---|---|---|
| W3a | Slot identity (`BREEZE_INSTANCE_SLOT`), separate from the boot id. Caddy path routing per slot; the whole lifecycle routed to the owner; generation-bound tickets | A viewer on any public entry reaches the agent's owner. A ticket on the wrong slot, or a stale ticket after an owner move, is refused |
| W3b | Move-aware teardown: when the lease owner changes, the old owner ends its sessions with a "reconnect" reason and the viewer re-mints | Forced agent reconnect mid-terminal: the viewer is back within 5 s |

### W4 — Process-local state sweep

| Item | Today | Action |
|---|---|---|
| `agentCommandAwait` pending (`:43`) | local | W2d pub/sub by `commandId` |
| `orphanedResultExpectations` (`agentWs.ts:562`) | recorded on the sending instance, which is the owner | Correct by construction under W2. Durability is optional: they are lost on a restart today too |
| AI streaming sessions (`streamingSessionManager.ts:787`) | local | Record the owner slot in Redis; route stream reconnects by slot, the same way as W3 [I: check the resume path] |
| `incidentJobs` `running` flags | local overlap guard; the cross-process winner is DB-claimed (`SKIP LOCKED`) [V] | No change |
| Topology `setInterval` loops (`jobs/topology*.ts`) | timers on every process that runs them | Audit each tick for a DB claim or advisory lock. Where there is none, move it to a BullMQ repeatable job or a Redis-locked leader |
| `tenantLifecycle` disconnect (`:75-85`) | local only | W2b `disconnectWhere`, fanned out |
| `routes/integrations.ts:29-32` settings maps | per-process, so they silently diverge | Persist them or delete them (they look like stubs [I]) |
| Rate limiter fallbacks (`agentWs.ts:4210`, "in-memory fallback only") | limits multiply by N | Confirm Redis is primary; document that the fallback is per-instance |
| Per-process caches (#8054 negative auth cache and others) | fine if bounded by TTL and conservative | Classify each; anything that needs cluster consistency moves to the W1b primitive |
| About 430 module-level `Map`/`Set` declarations in 276 files [V, by grep; most are constants] | not classified | A mechanical inventory plus a contract test with a classified allowlist (stateless constant / per-process OK / cluster-unsafe), modelled on `workerEntrypointClosure.contract.test.ts` |

Acceptance for W4: the contract test runs in the Test API job, and the
`cluster-unsafe` class is empty or each entry links an issue.

### W5 — Deployment topology and operations

| Wave | Scope | Acceptance |
|---|---|---|
| W5a | N API containers on one host, as explicit services `api-1..api-N` from a YAML anchor (stable slot names; no `deploy.replicas`). Caddy runs multiple upstreams, `least_conn`, with active health checks for HTTP and agent WS, plus slot paths from W3. Two cloudflared connectors. **Not Node `cluster`**: workers would share the same per-process-state problem and lose separate restarts and per-container metrics | Kill any `api-k`: agents reconnect elsewhere within the W1d window; no command lost (W2a test) |
| W5b | A trusted-proxy model that survives IP changes: every proxy hop on the fixed compose subnet with a static IP (already the repo pattern), with deploy tooling that generates the `/32` list from compose and checks it at boot | Reboot the host: API boots, client IPs stay correct |
| W5c | Server-paced rolling deploy. Start the replacement capacity first. Mark one instance draining: its readiness fails, so Caddy sends it no new connections, but its relay consumer and existing sessions stay alive. It then sends the `drain` message (W1d) and closes agent sockets in randomized, rate-limited batches over D minutes (default 5). Remote sessions go last, with a bounded grace period. When it reaches 0 sockets or times out, restart it and move to the next. Set Caddy `stream_close_delay` so a Caddy reload does not drop every socket at once. Release tooling: land #7235 (server-only lane); generate the deploy service list from compose (`api-*`, `worker`, `web`, `portal`) and assert version parity for all of them | A deploy at 2,000 simulated agents: no instance exceeds 2× its steady-state accept rate, p95 heartbeat ≤1 s throughout |
| W5d | Multi-host (only at M3, or when one host's CPU is exhausted): Postgres on its own host or managed, PgBouncer, API hosts behind Caddy or a load balancer | M3 capacity test passes |

## 7. Tenancy, security, observability, rollout

**Tenancy.** RLS context is per transaction (`set_config(…, true)`), so more
instances share nothing new. Each worker boundary rebuilds the tenant and RLS
context rather than inheriting it. Relay queues are keyed by instance, never
tenant. Payloads stay sealed with AAD bound to `agentId`, `commandId`,
`targetInstanceId` and `expiresAt`. Every instance must share the encryption
keyring, and a key rotation must keep the previous key readable across a
rolling deploy. Cache invalidations carry ids only; the
receiver reloads under its own RLS context. Slot paths add reachability, not
authority: every slot runs the full auth chain, and tickets stay one-time and
instance-bound. Shedding decisions never read tenant data outside the request's
context.

**Observability.** Every metric is labelled by `slot`: event-loop utilization
and lag, CPU, owned sockets (presence leases per `instanceId`), WS accept rate,
relay queue age and outcomes, pool in-use/waiting, prologue expiries, shed
counts per route. One panel shows socket ownership and draining state.

**Rollout and rollback.** W0 is tooling. W1a–c and W1e are server-side; roll
back by revert. W1d follows the agent release rings. W2–W4 do nothing with one
API instance: deploying `api-2` turns them on, and going back to one `api`
rolls them back. W5 goes region by region, the incident region first, after W0
shows the M1 KPI.

## 8. Risks and open decisions

**Risks.** (1) Lease staleness: a dead instance's lease lives up to 90 s, so
commands to it read `offline` until it expires. Mitigation: owners clear their
leases on drain, and the live-instance registry lets dispatchers ignore leases
of dead instances. (2) Agent changes in W1d ship to customer machines and land
on a slow agent rollout, so the server-side controls must work alone. (3)
Redis becomes more central and is still a single primary. (4) Hidden
socket-local callers. W2c and W4 exist for this, because code review has a
poor record at catching contract misses. (5) Self-host regressions: every wave
must keep the single `all` container working unchanged.

| # | Decision | Options | Recommendation |
|---|---|---|---|
| D1 | API scale-out unit | Node `cluster` / N containers on one host / multi-host now | N containers on one host now; multi-host at M3 |
| D2 | Remote sessions | (a) affinity / (b) forwarding / (c) hybrid | (a) |
| D3 | Relay transport per instance | BullMQ queue per instance / Redis Stream per instance / pub/sub + ack | **BullMQ queue per boot instance** (quorum-agreed): it reuses today's consumer, claim and ack; pub/sub loses messages while the consumer is busy |
| D4 | Redis HA | Single primary + AOF / Sentinel / managed | Single primary through M2 (the remote-WS lease requires it); revisit at M3 |
| D5 | Connection pooling | Raise `max_connections` / smaller per-instance pools / PgBouncer | Smaller pools now, PgBouncer at M2 |
| D6 | Agent placement at the edge | Round robin / consistent hash on `agentId` | `least_conn`; hashing makes routing depend on Caddy features and reshuffles agents whenever N changes |
| D7 | Capacity targets | As §2 | Adopt; revise after the W0 baseline |

## 9. Decisions needed from the owner (ranked)

1. **Adopt the targets** (M1/M2/M3 and the ≤15 CPU-ms/agent-min KPI at M3) and
   make W0 + W1a the next work, ahead of any scale-out.
2. **Approve N-containers-on-one-host (D1)** as the first topology for the
   region with the incident. A second API instance takes live traffic only
   after W2a–c, W3a and the W4 contract test have all landed. The order is
   W2 → W3 → W4 → W5a.
3. **Remote sessions by owner-affinity (D2)**: sessions end, rather than
   migrate, when an agent changes instance.
4. **Agent protocol change (W1d)**: server-paced reconnect windows and
   loop-level `Retry-After`. This touches shipped agent behaviour.
5. **Redis stays single-primary through M2 (D4)**, and PgBouncer comes at M2
   (D5).
