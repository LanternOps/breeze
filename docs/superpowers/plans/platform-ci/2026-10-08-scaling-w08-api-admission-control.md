---
tracking_issue: LanternOps/breeze#8139
wave_issue: LanternOps/breeze#8147
---

# API Admission Control (W08 / spec W1c) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the API's event loop or its Postgres pool falls behind, refuse low-priority agent work cheaply and truthfully before it costs anything: bulk telemetry first, then standard telemetry. Never refuse heartbeats or recovery traffic. Pace agent WebSocket upgrades per instance. All of this must work for the agents already in the field, so the edge load-shedding rules can be removed.

**Architecture:** A 1-second controller samples three signals: timestamped event-loop lag samples, DB pool wait (read from W04's request-pool gate: the oldest waiter and the grant-wait p95), and DB timeouts (#8243 pool-acquire timeouts plus prologue-deadline expiries). It moves through levels 0–3. It escalates after 2 ticks, or at once in an emergency, and steps down one level after 15 s below 60 % of the thresholds. An app-level Hono middleware, mounted right after the request logger, classifies each request against a table that is checked for completeness against the real agent router. At the current level it either admits the request or answers `503` with a `Retry-After`. That happens before global rate limiting, agent auth's DB transaction and any body read. Agent WS upgrades pass a per-instance token bucket and a cap on concurrent setups. A refusal is an HTTP `503` before the upgrade, never an accepted socket closed with 1013. A `DbPoolAcquireTimeoutError` or prologue timeout that reaches `app.onError` becomes `503` + `Retry-After` instead of `500`.

**Tech Stack:** Hono 4.13 + `@hono/node-ws` 1.3.1 (patched), postgres.js 3.4.9 via Drizzle, `prom-client` 15, `node:perf_hooks`, Vitest 4 (unit and integration configs), the Go agent simulator (`agent/tools/agentsim`, `load-tests/agentsim`).

**Spec:** `docs/superpowers/specs/platform-ci/2026-10-07-horizontal-api-scaling-design.md`, wave **W1c** (§6 "W1 — Per-agent efficiency and storm resilience"). Program index: `docs/superpowers/plans/platform-ci/2026-10-07-scaling-program-w0-w1.md`, row **W08**. Wave issue #8147, feature #8139. **Rigor: high.** This is agent-facing behaviour under load, and old agents in the field must not be harmed.

**Dependency order: #8243 → W04 (#8143) → W08 (#8147).**

- #8243 (`fix/8229-pool-acquire-budget`) bounds the pool wait with a typed `DbPoolAcquireTimeoutError` and times the RLS prologue from acquisition.
- W04 (`2026-10-08-scaling-w04-prologue-pool-reclamation.md`, amended to build on #8243) adds the FIFO request-pool gate `db/poolAdmission.ts`, its `breeze_db_pool_admission_*` series, and the prologue-expiry totals.
- W08 reads that gate as its pool signal and owns the mapping of those errors to `503` + `Retry-After`. Task 1 Step 0 refuses to start until both are on `main`.

## Global Constraints

- Spec W1c text, verbatim: "API-side admission control. Shed by priority when event-loop lag or pool wait crosses a threshold: inventory and collector PUTs first, heartbeats last, with `503` + `Retry-After`. Rate-limit WS upgrades per instance with a token bucket, and refuse excess upgrades with close code 1013 and a delay hint. Remove the edge load-shedding."
- Spec acceptance, verbatim: "Under a W0b storm, p95 heartbeat stays ≤1 s and the pool never drops below 80 % of max." This plan measures the second clause as *usable* pool (see Task 12 and "Design decision" D9).
- Spec §2 non-goal: "changing the self-host default (one `all` container stays the default and must keep working)". With no overload, the `all` container must behave exactly as today. The default mode is `observe`, which never refuses anything.
- Spec §7: "Shedding decisions never read tenant data outside the request's context." The middleware reads no DB, no Redis and no request body. It reads only the method, the path and in-process counters.
- **Two deliberate deviations from the spec's wording, with owner sign-off requested** (see "Design decision"):
  - Heartbeats are never shed in this wave. "Heartbeats last" means heartbeats are the last class still admitted.
  - A WS upgrade is refused with a pre-upgrade HTTP `503` + `Retry-After`. It is never accepted and then closed with 1013. The wire cannot carry 1013 before an upgrade, and shipped agents reconnect at once after any accepted socket closes.
- **#1105 / DB context rules:** the admission middleware runs outside any DB context and never opens one. Nothing here opens a second pooled connection. W08 does not edit `db/index.ts`. Its only DB-layer change is additive, in W04's `db/poolAdmission.ts` (`waitStats()`), and no `db/` module imports the admission services. `requestDatabasePool.test.ts` re-imports that graph under a hard time budget.
- **One pool measure.** W08 reads pool state only through `services/admission/poolSignals.ts`, which reads W04's gate. It publishes no `breeze_db_pool_*` series; W04 owns them.
- **No schema change, no migration, no new table.** The RLS and cascade lists in CLAUDE.md do not apply.
- Every new env var: listed in `apps/api/src/system/connections/internalEnvVars.ts`, mapped in the `x-api-env` anchor of **both** `docker-compose.yml` and `deploy/docker-compose.prod.yml` as `${VAR:-}`, commented in `.env.example`, and documented in `apps/docs/src/content/docs/deploy/environment.mdx`. Every consumer treats `''` as unset.
- No real hostnames, IPs, regions or droplet names in any committed file. That includes the Caddy-rule checklist below.
- **Test placement:** unit tests sit next to their source (`foo.ts` → `foo.test.ts`). The real-Postgres suite goes under `apps/api/src/__tests__/integration/`.
- **Vitest:** `cd apps/api && npx vitest run <file>` for unit tests, and `cd apps/api && npx vitest run -c vitest.integration.config.ts <file>` for integration. Never put `--` before `--run` with `pnpm --filter`. A path filter is a substring match, so check the reported file count every time.
- **Integration stack:** run `pnpm test-stack up` from the worktree root before the first integration run. Task 11 ends with `pnpm test-stack down`.
- **Typecheck** before each commit: `cd apps/api && npx tsc --noEmit -p tsconfig.json; echo "tsc exit $?"`. Read the exit code. Piping into `tail` hides a heap OOM as a pass.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. The PR body includes `Closes #8147` and ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

## Review Focus

1. **Someone moves the WS refusal into `onOpen` (accept, then close with 1013).** Every shipped agent would then reconnect in a tight loop. Expected: a refused upgrade is an HTTP `503` status line with `Retry-After` on the raw socket, and no WS handler ever runs. Tests: Task 9 (`agentAdmission.wsRefusal.test.ts`, real server and raw socket) and Task 8 (upgrade handler never invoked).
2. **One GC-sized stall in the self-host `all` role.** A 400 ms sample among 30 ms samples is normal there. Expected: the level stays 0. Only a sustained signal, or a stall of at least `emergencyMs`, escalates. Test: Task 4 (`admissionController.test.ts`, "a single spike does not escalate").
3. **A process with no W04 request-pool gate registered**, for example a unit-test process, or a future boot path that loads the API without the request pool. Expected: the pool signals read `available: false` with zeros. The controller decides on lag alone and never raises a false DB emergency or sheds forever. Test: Task 1 (`poolSignals.test.ts`, "reads as unavailable").
4. **Attacker-chosen agent ids or odd paths minting metric labels or getting shed.** Expected: two different agent ids produce one route label. A path with an empty segment, a trailing slash or an unknown action is not classified, so it is admitted and 404s as today. Tests: Task 5 (classifier) and Task 8 (metrics label).
5. **`observe` mode refuses something.** Expected: nothing is ever refused in `observe`, including WS upgrades when the simulated bucket is empty. Only `would_shed` counters move. Test: Task 7 (`admissionRuntime.test.ts`).

---

## Verified findings that shape this plan

Labels: **[V]** read in code at `origin/main` `864eafe525`. **[M]** production evidence from 2026-10-08. **[I]** inferred.

### Server side

| # | Finding | Evidence | Consequence |
|---|---|---|---|
| S1 | Global middleware order: `metricsMiddleware` → `requestPathLogger` → secureHeaders → `securityMiddleware` → global body limit → `globalRateLimit` (Redis; skips `/api/v1/agents/` but **not** `/api/v1/agent-ws/`) → prettyJSON → cors → `api` partner guard and audit → `/agents` router → `agentAuthMiddleware` | `index.ts:449-509, 667, 741`; `routes/agents/index.ts:57`; `middleware/globalRateLimit.ts:24` [V] | The shed point is an app-level `use('*')` right after `requestPathLogger`. Sheds are then counted and logged, and they run before every Redis or DB touch |
| S2 | `agentAuthMiddleware` runs a system DB transaction for the device lookup. For every route not in `SELF_MANAGED_DB_CONTEXT_ACTIONS`, it then wraps the **whole handler, including body read, gunzip and JSON parse**, in a request-long org context | `middleware/agentAuth.ts:626, 370-380, 1135` [V]; `POST /logs` reads, gunzips and parses inside it (`routes/agents/logs.ts:99-140`) [V] | Anything after auth is too late to be cheap. Separately, `/logs` pinning a pooled connection during gunzip is a #1105 bug; filed as a follow-up, not fixed here |
| S3 | WS upgrade (`routes/agentWs.ts:4695-4755`) runs a per-agent Redis limiter (6/min → 429), then `validateAgentToken` (system transaction), then the upgrade. `onOpen` does `markOnline`, a device load and the presence lease (`:2762-2930`). `onClose` and `onError` call `transitionDeviceOffline` at once (`:4106-4148, 4174-4195`) | [V] | Each upgrade costs at least 3 transactions. A mass drop costs one transaction per socket. The gate goes before all of it, and the offline write is deferred under load (Task 9) |
| S4 | `@hono/node-ws` writes a refused upgrade as a bare status line: `HTTP/1.1 <status>`, `Connection: close`, `Content-Length: 0`. **Response headers and body are dropped**, so a `Retry-After` never reaches the client | `node_modules/@hono/node-ws/dist/index.js:72-75` and `index.cjs:98-101` (v1.3.1) [V] | The spec's "delay hint" needs a `pnpm patch` that forwards a validated `Retry-After` (Task 9). Repo precedent: `patches/postgres@3.4.9.patch` |
| S5 | An accepted upgrade goes through the normal Hono chain via `app.request(url, { headers })` (GET). The upgrade helper returns `new Response()`, which is status 200 | `@hono/node-ws/dist/index.js:57-79, 84-146` [V] | The app-level middleware sees every upgrade. After `next()`, any status other than 200 means "not upgraded" |
| S6 | Event loop: `services/eventLoopMonitor.ts` samples `monitorEventLoopDelay` (20 ms resolution) into 1 s samples with `atMs`, `maxLagMs` and `meanLagMs`. `readLatestEventLoopLag()` carries no sample timestamp. ELU is measured nowhere | `eventLoopMonitor.ts:97-104, 383-398` [V] | Add `readEventLoopLagSamplesSince(afterMs)` so the controller reads each sample exactly once (Task 2) |
| S7 | Pool: postgres.js `max = DB_POOL_MAX` (default 30) exposes no in-use or waiting count. At `864eafe525` the 15 s "prologue" deadline was armed before `baseDb.transaction`, so time queued for a slot counted against it (#8229). **#8243 fixes that:** a separate acquire budget (`DB_POOL_ACQUIRE_TIMEOUT_MS`) raises a typed `DbPoolAcquireTimeoutError`, and the prologue is timed from acquisition. **W04** puts a FIFO permit gate (`db/poolAdmission.ts`) in front of every outermost opener, with `snapshot()`/`totals()` and `breeze_db_pool_admission_*` series. W04 defers the 503 mapping and the shedding policy to W08 (its design row (f)) | `db/index.ts:39-48, 785-818`; `db/prologueDeadline.ts:144-200` [V]; PR #8243 diff [V]; W04 plan [V, plan text] | W08 reads pool wait from W04's gate. It adds only `waitStats()` (oldest waiter, grant-wait p95), and it maps both typed timeouts to `503` + `Retry-After` (Tasks 1 and 10) |
| S8 | `devices.lastSeenAt` is refreshed by heartbeats and by `onOpen`, not by pongs. The offline detector's threshold is 5 min | `services/deviceLiveness.ts:13`; `agentWs.ts:1296-1302` [V] | Deferring `onClose` offline writes under load is bounded: the detector flips a truly gone device within 5 min |
| S9 | Metrics label a short-circuited request `unmatched`. `resolveRoutePattern` reads Hono's route path, which is `/*` for an app-level middleware, and `safeMatchedRouteLabel` does the same | `routes/metrics.ts:767-772`; `services/safeRequestLabel.ts:19-41` [V] | Both readers get an allowlisted override from the classifier's own template (Task 8) |
| S10 | Env vars reach the container only through the `x-api-env` anchor. Two contract tests check this (`config/envReadComposeCoverage.test.ts`, `config/envComposeParity.test.ts`), plus the internal-name ratchet in `system/connections/internalEnvVars.ts` | [V] | Task 3 registers every new var in all four places |

### Agent side: how shipped agents react (the compatibility contract)

| Agent behaviour | Evidence | What admission must do |
|---|---|---|
| `httputil.Do` retries 429/500/502/503/504 and network errors. That is 4 attempts (1 s, 2 s, 4 s, ±30 %). It honours `Retry-After` in seconds or as an HTTP-date, capped at 300 s, with +0–30 % jitter since v0.104 (#2728). Every caller wraps it in a 15–30 s context, so **`Retry-After` ≥ 30 means exactly one request per cycle**: the sleep runs into the context deadline. After the last attempt the caller gets an error, never the response | `agent/internal/httputil/retry.go:26-186`, `retryafter.go` [V] | A shed costs one cheap request per cycle on v0.64.3+ agents |
| **Before v0.64.3 (#551, 2026-05-02), `Retry-After` was ignored**: 4 attempts in about 7 s | `git show v0.64.1:agent/internal/httputil/retry.go` (Codex, re-checked) [V] | Legacy agents cost up to 4 shed responses per cycle, where Caddy's fake success cost 1. Budgeted under "Old-agent compatibility" |
| Heartbeat: 60 s ticker, synchronous send, 30 s context; a missed tick is dropped. `LastHeartbeat` in the state file is written **only on HTTP 200**. The watchdog restarts the agent when that file is stale for more than `HeartbeatStaleThreshold` = **3 min**; newer watchdogs veto twice via IPC, older ones do not | `heartbeat.go:1003, 2005, 2080, 4905-4960`; `config.go:391`; `watchdog/checks.go:18-30` [V] | **Never shed heartbeats.** Any gap over 3 min risks watchdog restarts, and each restart is a WS reconnect |
| The watchdog failover heartbeat uses the same `POST /:id/heartbeat` path (raw Do, every 30 s, only while the main agent is down). It polls commands only after that heartbeat succeeds | `watchdog/failover.go:311-561`; `cmd/breeze-watchdog/main.go:1218` [V] | Heartbeat and `GET /:id/commands` are protected |
| Inventory PUTs (software, disks, network, connections, registry and config state, warranty): a full snapshot every 15 min, dropped on failure. `changes` keeps its baseline and resends. `recovery-keys` does not advance its fingerprint. `patches/pending` retries at 5/10/20/40 min. `sessions` requeues events. `reliability` is persisted only on success | `heartbeat.go:2398-2449, 2848-2875, 4077-4087, 2506-2522, 4132-4138, 4147-4215` [V] | A truthful 503 loses nothing these routes keep. A fake success would have lost all of it |
| `eventlogs`: the collector cursor advances **at collect**, so a failed send loses those events for good | `collectors/eventlogs_windows.go:68`, `eventlogs_linux.go:63` [V] | `PUT /:id/eventlogs` is **protected** |
| `monitoring-results`: 15 s context, no requeue | `heartbeat.go:2337-2356` [V] | Standard class. A gap at level 2+ is explicitly accepted |
| `POST /logs`: raw Do in the shipper's own loop of 3 attempts. On 429/503 it **`time.Sleep(Retry-After)` with no context**, and `Stop()` waits for that loop. The buffer is 500 entries, and `Enqueue` drops when full instead of blocking | `logging/shipper.go:40, 188-193, 272-280, 540-680` [V] | `Retry-After` for `/logs` is 2–4 s. That bounds the shipper stall and the agent shutdown delay to about 10 s |
| `GET /unifi-collectors`: raw Do, no retry, every 30 s. A non-200 skips that tick, exactly like `{"collectors":[]}` | `unifi/collector.go:355-410` [V] | A 503 costs the same as the Caddy rule and is honest |
| `POST /process-sample`: every 180 s, `httputil.Do`, dropped on failure | `heartbeat.go:2610-2630` [V] | Bulk. Same cost as the Caddy rule on v0.64.3+ |
| WS: gorilla v1.5.3. A refused upgrade (non-101) is a failed connect, so the agent sleeps backoff ±30 % and doubles it up to 60 s. **The agent discards the response and never reads status or `Retry-After`.** An accepted socket that closes, with any code, causes an **immediate** reconnect with no sleep. Close codes are not parsed | `websocket/client.go:28-45, 350-442, 455-466` [V] | Refuse before the upgrade. Accept-then-1013 would be a tight reconnect loop on every shipped agent |
| Command results for HTTP-delivered commands are dropped on failure. WS command results go to an on-disk outbox | `heartbeat.go:6527-6561, 1312-1317, 1461-1477` [V] | `POST /:id/commands/:commandId/result` is protected |

## File structure

| File | Responsibility |
|---|---|
| Modify `apps/api/src/db/poolAdmission.ts` (+ test). This is W04's gate | Additive `waitStats()`: oldest waiter, grant-wait p95 over 3 s |
| Create `apps/api/src/services/admission/poolSignals.ts` (+ test) | The one adapter from W04/#8243 pool state to admission signals |
| Modify `apps/api/src/services/eventLoopMonitor.ts` (+ test) | `readEventLoopLagSamplesSince(afterMs)` |
| Create `apps/api/src/services/admission/admissionSignals.ts` (+ test) | One sampler: lag median, peak lag, DB pool wait, time since the last DB timeout, ELU |
| Create `apps/api/src/services/admission/admissionConfig.ts` (+ test) | Env parsing, defaults, fixed controller constants |
| Create `apps/api/src/services/admission/admissionController.ts` (+ test) | Pure level state machine with hysteresis and the emergency path |
| Create `apps/api/src/services/admission/agentRouteClasses.ts` (+ test) | Route → class table, the classifier, `Retry-After` ranges; completeness contract over the real `agentRoutes` |
| Create `apps/api/src/services/admission/wsUpgradeGate.ts` (+ test) | Token bucket and setup-slot semaphore |
| Create `apps/api/src/services/admission/admissionMetrics.ts` | prom-client series (leaf: `prom-client` + `metricsRegistry`) |
| Create `apps/api/src/services/admission/admissionRuntime.ts` (+ test) | Ties it together: tick, `decide()`, the process singleton, `shouldDeferOfflineTransition()` |
| Create `apps/api/src/middleware/agentAdmission.ts` (+ test) | The Hono middleware |
| Create `apps/api/src/middleware/dbSaturationResponse.ts` (+ test) | `DbPoolAcquireTimeoutError` / prologue timeout → `503` + `Retry-After` in `app.onError` |
| Modify `apps/api/src/index.ts`; create `apps/api/src/index.agentAdmission.test.ts` | Mount, start before `serve()`, stop on shutdown; source-level mount test |
| Modify `apps/api/src/routes/metrics.ts`, `apps/api/src/services/safeRequestLabel.ts` | Allowlisted route-label override for shed requests |
| Modify `apps/api/src/routes/agentWs.ts`; create `apps/api/src/middleware/agentAdmission.wsRefusal.test.ts` | Release setup slots from WS handlers; defer `onClose`/`onError` offline writes under load |
| Create `patches/@hono__node-ws@1.3.1.patch`; modify root `package.json` | Forward `Retry-After` on a refused upgrade |
| Modify `apps/api/src/system/connections/internalEnvVars.ts`, `docker-compose.yml`, `deploy/docker-compose.prod.yml`, `.env.example`, `apps/docs/src/content/docs/deploy/environment.mdx`, `apps/docs/src/content/docs/monitoring/stack.mdx` | Env and metric registration and docs |
| Create `apps/api/src/__tests__/integration/admissionControl.integration.test.ts` | Real Postgres with injected loop lag and real pool saturation |
| Create `load-tests/agentsim/admission-watch.sh`; modify `load-tests/agentsim/README.md` | Acceptance-run sampler and the storm recipe |

**Dependencies outside this wave**

- **#8161 (W0a simulator).** It is in the merge queue at `c7866a2871`. Task 12 needs it on `main`.
- **W06 (W0b storm scenarios).** If it has merged, Task 12 uses its scenarios. If not, Task 12's recipe below stands on its own.
- **#8243 → W04 (#8143).** Both must be on `main` before W08 starts. Task 1 Step 0 checks. W08 reads pool wait, waiting, in-use and effective permits from W04's gate (`getRequestPoolAdmission()`), and DB timeouts from the gate's `totals().acquireTimeouts` plus `getPrologueDeadlineExpiryTotals()`. It adds one additive method to the gate (`waitStats()`), publishes no pool gauges (W04 owns `breeze_db_pool_admission_*`), and owns the `503` mapping of #8243's `DbPoolAcquireTimeoutError`, which W04 deferred to W08. The D10 follow-up (per-class permit reservation) belongs on the gate's `acquire` options, next to `nested`, as W04's plan already says.

---

## Design decision

### Quorum

The draft design went to Codex (`gpt-6-astra`, reasoning `xhigh`, read-only sandbox) with the spec row, the production evidence, the verified findings above and the file paths. It was asked to find flaws and to propose its own design. Its verdict was **"revise before enforcement"**. It agreed with early placement, the pre-upgrade HTTP refusal and `observe` as the default. It rejected the draft's heartbeat shedding and its pool acceptance gate, and it corrected one claim about compatibility. Each point and its resolution:

| # | Topic | Draft (Fable) | Codex | Resolution |
|---|---|---|---|---|
| D1 | Heartbeat shedding | Shed at level 3, with a per-agent freshness guard (min gap 150 s) | Reject. The watchdog restarts the agent after 180 s without a 200, and older watchdogs have no veto. The watchdog and the main agent share `POST /:id/heartbeat`, so the guard confuses the two. A 150 s guard admits about one beat in three, not one in two | **Adopt Codex.** Verified: `config.go:391` (3 min), `heartbeat.go:4939-4956` (`LastHeartbeat` written only on 200), the watchdog branch at `heartbeat.ts:698`. Heartbeats are **never** shed in W08. "Heartbeats last" means they are the last class still admitted. A sustained level 3 with only protected traffic left means the instance is under-provisioned: that is an alert, and the fix is capacity (W5), not shedding. Owner sign-off requested as a spec deviation |
| D2 | WS refusal | Pre-upgrade HTTP 503 + `Retry-After`, with no accept-then-1013 | Strongly agrees. Also asks for a cap on concurrent setups (auth through `onOpen`), because a burst of 100 can start more setups than a 30-slot pool can serve. Also asks that tokens be clamped when the level drops | **Adopt both.** Burst 20; setups capped at 8, held until `onOpen` finishes (or 30 s); bucket capacity scales with level, so accumulated tokens are clamped. **Added by Fable, missed by both earlier passes:** `@hono/node-ws` drops all response headers on a refusal (S4), so the delay hint never reached the wire. Patched in Task 9. Spec wording change requested: "refuse excess upgrades **before the upgrade** with HTTP 503 and `Retry-After`" |
| D3 | Lag signal | Median of the last 3 per-second readings of `readLatestEventLoopLag()` | That function has no timestamp, so one sample can be counted twice. Add an immediate path for a severe stall | **Adopt.** `readEventLoopLagSamplesSince()` reads each sample once (Task 2). The median of the 3 newest samples drives the normal levels. Peak lag (in-flight stall, or the newest sample this tick) ≥ `emergencyMs` (1 s) jumps straight to level 3 |
| D4 | Pool signal | My own "transaction-start" tracker in `withDbAccessContext` (opener entry → callback), with expiries labelled by phase | It is really transaction-start latency, not pool-acquire time, so name it that way. Settle on the inner promise, and clean up on a rejection before the callback | **Superseded by coordination (#8243 → W04 → W08).** #8243 now bounds pool acquisition separately, and W04 puts a FIFO permit gate in front of every opener. A second tracker on the same seam would be a parallel measure of the same thing. W08 reads the gate through one adapter (`poolSignals.ts`) and adds only what the gate lacks: the oldest waiter's age and a 3 s grant-wait p95 (`waitStats()`). Codex's two points still hold, and the gate satisfies both: its permits are released on the underlying settle (W04 D2), and a waiter that times out is removed from the queue |
| D5 | Thresholds | Lag 150/400/1000 ms; pool 100/500/2000 ms; 2-tick escalation | Too loose for a 1 s p95 heartbeat. The thresholds should come from the latency budget, with immediate escalation and monotonic recovery | **Adopt.** A post-W01 heartbeat is about 4 transactions in sequence (3 + auth), each paying one pool wait, plus several loop hops. Holding p95 at or under 1 s with margin means pool waits stay under ~150 ms and loop lag under ~100 ms. Defaults: lag **100/250/600** ms, DB pool wait **75/200/600** ms, emergency **1000** ms; recovery one level per 15 s on `performance.now()`; a DB timeout in the last 30 s holds level 2 or higher. These are starting values. Re-calibrate them from the W06/W07 data before the default changes |
| D6 | Truthful 503 vs. the Caddy fake success | With `Retry-After` ≥ 30, a 503 costs one request per cycle, the same as a fake success | Wrong for agents before v0.64.3, which ignore `Retry-After` and make 4 attempts. Randomising `Retry-After` does not spread current agents' next cycle, because every sleep ends at the same context deadline | **Adopt the correction; keep truthful 503.** A fake success permanently loses data on the routes where the agent keeps state on failure (S-table: changes, recovery-keys, patches/pending, reliability, sessions), and it hides the loss. The legacy amplification is bounded and budgeted (see "Old-agent compatibility"). The `Retry-After` ranges are written as semantics for W09 agents, which will honour them at loop level. For current agents, any value ≥ 30 means "one attempt this cycle" |
| D7 | `/logs` `Retry-After` | 120–180 s | Two context-free sleeps block the shipper and `Stop()` for 4–6 min | **Both converge: 2–4 s.** The shipper stall and the agent shutdown delay stay at about 10 s or less |
| D8 | Route classes | eventlogs and monitoring-results in standard; `GET commands` already protected | eventlogs loses data for good (the cursor advances at collect); protect it or accept the loss explicitly. Same question for monitoring-results | **eventlogs is protected.** It is security evidence. **monitoring-results stays standard**, with the loss explicitly accepted: a level-2 shed leaves a gap in monitor results and does not create a false alert. That trade is listed under owner decisions |
| D9 | Pool acceptance gate | `pg_stat_activity` connections ≥ 0.8 × `DB_POOL_MAX` | Invalid: `max` is a ceiling, idle connections retire after 20 s, and 30 stuck backends would pass | **Adopt.** "The pool never drops below 80 % of max" is measured as usable capacity. Whenever the API has contexts waiting, it has at least 0.8 × `DB_POOL_MAX` `breeze-api` backends and none of them is stuck (`idle in transaction` > 5 s, or `active` on `ClientRead` > 15 s). Also: DB pool-wait p95 back under the level-1 threshold within 30 s of the storm ending. Heartbeat latency is measured client-side by the simulator, so a cheap 503 cannot flatter a server-side histogram |
| D10 | Reserved capacity | Level shedding only | Bound lower-priority concurrency and reserve DB headroom for heartbeat and control work, avoiding nested-permit deadlocks | **Partly adopted.** Bulk requests in flight are capped at 15 (half the default pool) at every level when `enforce` is set. That covers the 1–2 s before the controller reacts. A DB-level reservation per class belongs in W04's pool gate, which owns permits and can avoid nested-permit deadlocks. Follow-up issue at merge: "W04 gate: reserve permits for heartbeat/protected contexts" |
| D11 | `agent-ws` in the per-IP global bucket | not addressed | A fleet behind one NAT can spend operators' 300/min budget | **Acknowledged; pre-existing; out of scope.** Shedding happens before `globalRateLimit`, so W08 makes nothing worse. Follow-up issue: give `/api/v1/agent-ws/` an isolated bucket |
| D12 | Commands while WS is refused | not addressed | A refused agent can miss a command whose 30 s waiter expires | **Accepted and documented.** The same thing happens today whenever WS is down. Every heartbeat response still carries pending commands |
| D13 | `onClose` offline storm | not addressed | not addressed | **Added by Fable (spec question 4):** at level 1 or higher in `enforce`, `onClose`/`onError` skip the immediate `transitionDeviceOffline` write. Presence is still cleared at once. The offline detector flips a truly gone device within 5 min (S8). This removes one transaction per socket from a mass drop, which is exactly when there are thousands of them. It was not reviewed by the quorum; the owner should check it in review (Task 9) |
| D14 | Pool-acquire timeout → HTTP | not in the draft | not reviewed | **W08 owns it (W04 design row (f)).** `DbPoolAcquireTimeoutError` (#8243) and `DbAccessContextPrologueTimeoutError` reaching `app.onError` become `503` + `Retry-After` 30–45 s, with `code: DB_POOL_SATURATED`, instead of `500`. The caller's work never ran, so a retry is safe, and agents already retry a `500` 4 times; with `Retry-After` ≥ 30 they make one attempt. These are kept out of Sentry because saturation fails many requests at once; #8243's throttled log line and a counter carry the signal. Errors a route catches itself and turns into its own `500` are not covered. That is accepted, and the counter shows how many reach `onError` (Task 10) |
| D15 | DB-timeout floor | "prologue expiry in the last 30 s → level ≥ 2" | — | **Generalised after #8243:** any increase of `dbTimeoutsTotal` (pool-acquire timeouts + prologue expiries) in the last 30 s holds level 2 or higher. After #8243 an acquire timeout is the direct saturation signal; a prologue timeout is now BEGIN/`set_config` only, and still a strong overload sign |

### Final design

**Signal (sampled every 1 s, `api`/`all` roles only):**

- **Lag:** the median of the `maxLagMs` of the 3 newest distinct monitor samples.
- **Peak lag:** the larger of the in-flight stall and the newest sample consumed this tick.
- **DB pool wait:** from W04's gate, the larger of the p95 grant wait over the last 3 s and the age of the oldest waiter.
- **DB timeouts:** the time since `dbTimeoutsTotal` last increased (#8243 pool-acquire timeouts plus prologue-deadline expiries).
- **ELU:** exported only. In the `all` role, workers legitimately push ELU up without hurting latency.

**Levels:**

| Level | Enter when (for 2 consecutive ticks) | Effect in `enforce` |
|---|---|---|
| 0 | — | Bulk capped at 15 in flight; WS bucket 10/s, burst 20; at most 8 WS setups at once |
| 1 | lag ≥ 100 ms or DB pool wait ≥ 75 ms | + all **bulk** refused; WS ×0.5; `onClose` offline deferred |
| 2 | lag ≥ 250 ms or DB pool wait ≥ 200 ms, or any DB timeout in the last 30 s | + all **standard** refused; WS ×0.2 |
| 3 | lag ≥ 600 ms or DB pool wait ≥ 600 ms, or **at once** on peak lag or oldest waiter ≥ 1000 ms | WS ×0.05 (0.5/s). Heartbeat and protected traffic still admitted. Alert |

Recovery: one level down after 15 s continuously below 60 % of the current level's enter thresholds.

**Per-route policy** (the table lives in `agentRouteClasses.ts`; a contract test checks it against the real router):

- **protected (never shed):** heartbeat, rotate-token (+confirm), uninstall-intent, `GET commands`, command result, PAM observations and reconciliation, elevation-requests, **eventlogs**, winget-bootstrap, storage-sessions, and everything outside `/:id/` (enroll, renew-cert, downloads, admin approve/deny, org settings), the extension/ee agent mounts, and all UI routes.
- **standard (level ≥ 2), `Retry-After` 60–90 s:** config, monitoring-results, security/status, management/posture, security/recovery-keys, sessions, changes, patches (+pending, +installed), hardware-health, time-status, peripherals/events, boot-performance, reliability, topology/adjacency.
- **bulk (level ≥ 1, plus the in-flight cap), `Retry-After` 120–180 s:** hardware, software, disks, network, connections, warranty-info, registry-state, config-state, process-sample, unifi-telemetry. Overrides: **logs 2–4 s**; **unifi-collectors 30–45 s**.
- **ws_upgrade:** bucket and setup cap. `Retry-After` 5–120 s, sized from the refusals in the last 10 s divided by the effective rate.

**DB saturation:** `DbPoolAcquireTimeoutError` or a prologue timeout reaching `app.onError` → `503`, `Retry-After` 30–45 s, `code: DB_POOL_SATURATED` (D14).

**Response:** `503`, `Retry-After: <int>`, `Cache-Control: no-store`, and a body of `{error, code: 'ADMISSION_SHED' | 'WS_UPGRADE_REFUSED', retryAfterSeconds}`. `rejectReason` is set for the request log, and an allowlisted route label for metrics.

**Modes (`BREEZE_ADMISSION_MODE`):**

- `observe` (default): computes everything, counts `would_shed`, refuses nothing.
- `enforce`.
- `off`: the kill switch. The middleware becomes a pass-through, and the tick still publishes signal gauges.

`/ready` never depends on the admission level. One instance failing readiness would be a total outage.

### Old-agent compatibility (budget)

| Agent cohort | Reaction to a bulk/standard 503 | Cost versus the Caddy fake success |
|---|---|---|
| ≥ v0.104 | 1 attempt per cycle (`Retry-After` ≥ 30 runs into the context deadline) | Same request count. Truthful, and data kept where the agent keeps state |
| v0.64.3 – v0.103 | Same as above, without the additive jitter | Same |
| < v0.64.3 | 4 attempts in about 7 s (`Retry-After` ignored) | Up to 4× the cheap responses for `httputil` routes. Bulk is about 0.3 req/agent-min at production cadence (process-sample every 3 min, inventory every 15 min). At about 0.3 ms per shed that is about 0.4 ms CPU per agent-minute, against about 70 ms per admitted request. `unifi-collectors` (raw Do, no retry) and `/logs` (own loop of 3) do not depend on the version |
| Every shipped agent, WS | A refused upgrade is a failed connect: backoff 1→60 s ±30 %, and the response is ignored | Pre-upgrade refusal is the only safe form. Accept-then-close would be a tight loop |
| Every shipped agent, heartbeat | Never shed | — |

**Rollout gate:** before hosted `enforce`, run `SELECT agent_version, count(*) FROM devices WHERE status='online' GROUP BY 1` on the region. Record the share of agents below v0.64.3 in the PR or deploy note. If it is above 20 %, budget the 4× in the W06 storm run before enforcing.

---
## Tasks

### Task 1: Pool signals from the W04 gate

W08 builds no pool tracker of its own. It reads W04's request-pool gate (`db/poolAdmission.ts`, built on #8243). The only additions are two wait statistics on that gate, which W04 does not expose: the age of the oldest waiter, and the p95 grant wait over 3 s. A single adapter is the only W08 file that imports W04 names.

**Files:**
- Modify: `apps/api/src/db/poolAdmission.ts` (W04). `Waiter` gains `enqueuedAtMs`, the fast path and `drain()` record grant waits, and `PoolAdmission` gains `waitStats()`. All additive: W04's `snapshot()` shape and its `toEqual` tests are untouched.
- Modify: `apps/api/src/db/poolAdmission.test.ts` (one new `describe`)
- Create: `apps/api/src/services/admission/poolSignals.ts`
- Create: `apps/api/src/services/admission/poolSignals.test.ts`

**Interfaces:**
- Consumes (from #8243 and W04; Step 0 verifies the names on `main`): `createPoolAdmission({ permits, nestedReserve?, now? })`; `PoolAdmission.acquire(label, { timeoutMs? })`, `.snapshot(): { inUse, waiting, effectivePermits, … }`, `.totals(): { acquireTimeouts: Record<TimerLateness, number>, … }`; `PoolSlot.release(settlement)`; `registerRequestPoolAdmission`, `getRequestPoolAdmission`, `__resetRequestPoolAdmissionForTests`; `getPrologueDeadlineExpiryTotals(): Readonly<Record<TimerLateness, number>>` (`db/prologueDeadline.ts`).
- Produces (used by Tasks 2, 7 and 11):
  ```ts
  // db/poolAdmission.ts (additive)
  export const POOL_WAIT_STATS_WINDOW_MS = 3_000;
  export interface PoolWaitStats { oldestWaitMs: number; grantWaitP95Ms: number; grantsInWindow: number }
  // PoolAdmission gains: waitStats(): PoolWaitStats
  // services/admission/poolSignals.ts
  export interface PoolSignals {
    available: boolean; inUse: number; waiting: number; effectivePermits: number;
    oldestWaitMs: number; grantWaitP95Ms: number;
    /** Monotonic since boot: pool-acquire timeouts + prologue-deadline expiries. */
    dbTimeoutsTotal: number;
  }
  export function readPoolSignals(): PoolSignals;
  ```

- [ ] **Step 0: Confirm the dependency order (#8243 → W04 → W08) has landed**

```bash
git fetch origin && git rebase origin/main
grep -n "export function createPoolAdmission\|interface Waiter\|function drain\|export function getRequestPoolAdmission\|export function registerRequestPoolAdmission" apps/api/src/db/poolAdmission.ts
grep -n "export function getPrologueDeadlineExpiryTotals" apps/api/src/db/prologueDeadline.ts
grep -n "DbPoolAcquireTimeoutError\|DbAccessContextPrologueTimeoutError" apps/api/src/db/index.ts
```

Expected: every name is found. `db/index.ts` re-exports both error classes, as #8243 does.

- If `poolAdmission.ts` does not exist, W04 has not merged. **Stop: W08 does not start before it.**
- If W04's #8243 amendment renamed any of these names, apply this task's additions to the renamed equivalents. `poolSignals.ts` is the only W08 file that imports them, so no other task changes.

- [ ] **Step 1: Write the failing gate test**

Append to `apps/api/src/db/poolAdmission.test.ts`:

```ts
describe('waitStats (W08)', () => {
  it('reports the oldest waiter and the p95 grant wait over the last 3 s', async () => {
    let nowMs = 0;
    const gate = createPoolAdmission({ permits: 3, nestedReserve: 0, now: () => nowMs });
    const held = [await gate.acquire('a'), await gate.acquire('b'), await gate.acquire('c')];
    // Fast-path grants waited 0 ms.
    expect(gate.waitStats()).toEqual({ oldestWaitMs: 0, grantWaitP95Ms: 0, grantsInWindow: 3 });

    const first = gate.acquire('waiter-1', { timeoutMs: 0 });
    nowMs += 400;
    const second = gate.acquire('waiter-2', { timeoutMs: 0 });
    nowMs += 100;
    expect(gate.waitStats().oldestWaitMs).toBe(500);

    held[0]!.release('resolved');   // grants waiter-1 after 500 ms
    held[1]!.release('resolved');   // grants waiter-2 after 100 ms
    await Promise.all([first, second]);
    // waits [0, 0, 0, 100, 500]: ceil(0.95 * 5) = 5th smallest = 500
    expect(gate.waitStats()).toEqual({ oldestWaitMs: 0, grantWaitP95Ms: 500, grantsInWindow: 5 });

    nowMs += 3_001;
    expect(gate.waitStats()).toEqual({ oldestWaitMs: 0, grantWaitP95Ms: 0, grantsInWindow: 0 });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && npx vitest run src/db/poolAdmission.test.ts`
Expected: FAIL, "gate.waitStats is not a function". Every W04 test still passes. 1 file.

- [ ] **Step 3: Add the wait statistics to the gate**

In `db/poolAdmission.ts`, next to the other exported types:

```ts
/** W08: window for the grant-wait p95 that admission control reads. */
export const POOL_WAIT_STATS_WINDOW_MS = 3_000;

/** W08 admission-control inputs. Separate from snapshot() so W04's snapshot shape is unchanged. */
export interface PoolWaitStats {
  /** Age of the oldest waiter in either queue, ms; 0 when nobody waits. */
  oldestWaitMs: number;
  /** p95 wait of permits granted in the last POOL_WAIT_STATS_WINDOW_MS, ms (fast-path grants count as 0). */
  grantWaitP95Ms: number;
  grantsInWindow: number;
}
```

Add `waitStats(): PoolWaitStats;` to the `PoolAdmission` interface. Add `enqueuedAtMs: number;` to `interface Waiter`. Inside `createPoolAdmission`, after the `totals` declaration:

```ts
  let grantWaits: Array<{ atMs: number; waitMs: number }> = [];
  const recordGrant = (waitMs: number): void => {
    grantWaits.push({ atMs: now(), waitMs });
    if (grantWaits.length > 8_192) grantWaits = grantWaits.slice(-4_096);
  };
  const waitStats = (): PoolWaitStats => {
    const nowMs = now();
    const cutoff = nowMs - POOL_WAIT_STATS_WINDOW_MS;
    let first = 0;
    while (first < grantWaits.length && grantWaits[first]!.atMs < cutoff) first += 1;
    if (first > 0) grantWaits = grantWaits.slice(first);
    const waits = grantWaits.map((grant) => grant.waitMs).sort((a, b) => a - b);
    // Both queues are FIFO, so each head is that queue's oldest waiter.
    let oldestWaitMs = 0;
    for (const head of [topWaiters[0], nestedWaiters[0]]) {
      if (head) oldestWaitMs = Math.max(oldestWaitMs, nowMs - head.enqueuedAtMs);
    }
    return {
      oldestWaitMs,
      grantWaitP95Ms: waits.length === 0 ? 0 : waits[Math.max(0, Math.ceil(waits.length * 0.95) - 1)]!,
      grantsInWindow: waits.length,
    };
  };
```

Three one-line changes and one addition:

- In `drain()`, immediately before `waiter.resolve(makeSlot(waiter.label, waiter.nested));`, add `recordGrant(now() - waiter.enqueuedAtMs);`.
- The fast path becomes `if (nobodyAhead && canGrant(nested)) { recordGrant(0); return Promise.resolve(makeSlot(label, nested)); }`.
- The waiter literal becomes `const waiter: Waiter = { label, nested, resolve, timeout: null, enqueuedAtMs: now() };`.
- Add `waitStats,` to the returned object.

- [ ] **Step 4: Run it to verify it passes**

Run: `cd apps/api && npx vitest run src/db/poolAdmission.test.ts`
Expected: PASS, including every W04 test. 1 file.

- [ ] **Step 5: Write the failing adapter test**

`apps/api/src/services/admission/poolSignals.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';

const { prologueTotals } = vi.hoisted(() => ({ prologueTotals: { late: 0, 'on-time': 0 } }));
vi.mock('../../db/prologueDeadline', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../db/prologueDeadline')>()),
  getPrologueDeadlineExpiryTotals: () => ({ ...prologueTotals }),
}));

import {
  __resetRequestPoolAdmissionForTests,
  createPoolAdmission,
  registerRequestPoolAdmission,
} from '../../db/poolAdmission';
import { readPoolSignals } from './poolSignals';

afterEach(() => {
  __resetRequestPoolAdmissionForTests();
  prologueTotals.late = 0;
  prologueTotals['on-time'] = 0;
  vi.useRealTimers();
});

describe('readPoolSignals', () => {
  it('reads as unavailable — never as pressure — when this process has no request-pool gate (Review Focus 3)', () => {
    expect(readPoolSignals()).toEqual({
      available: false, inUse: 0, waiting: 0, effectivePermits: 0, oldestWaitMs: 0, grantWaitP95Ms: 0, dbTimeoutsTotal: 0,
    });
  });

  it('reads in-use, waiting, effective permits and the wait statistics from the gate', async () => {
    let nowMs = 0;
    const gate = createPoolAdmission({ permits: 2, nestedReserve: 0, now: () => nowMs });
    registerRequestPoolAdmission(gate);
    await gate.acquire('a');
    await gate.acquire('b');
    void gate.acquire('waiter', { timeoutMs: 0 });
    nowMs += 250;
    expect(readPoolSignals()).toEqual({
      available: true, inUse: 2, waiting: 1, effectivePermits: 2, oldestWaitMs: 250, grantWaitP95Ms: 0, dbTimeoutsTotal: 0,
    });
  });

  it('counts pool-acquire timeouts and prologue-deadline expiries together as DB timeouts', async () => {
    vi.useFakeTimers();
    const gate = createPoolAdmission({ permits: 1, nestedReserve: 0 });
    registerRequestPoolAdmission(gate);
    await gate.acquire('holder');
    const timedOut = gate.acquire('waiter', { timeoutMs: 1_000 }).catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(5_000);
    await timedOut;
    prologueTotals['on-time'] = 2;
    expect(readPoolSignals().dbTimeoutsTotal).toBe(3);
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `cd apps/api && npx vitest run src/services/admission/poolSignals.test.ts`
Expected: FAIL, "Failed to load url ./poolSignals". 1 file.

- [ ] **Step 7: Implement the adapter**

`apps/api/src/services/admission/poolSignals.ts`:

```ts
/**
 * W08 — the ONE place admission control reads DB pool state.
 *
 * Source: W04's request-pool gate (db/poolAdmission.ts, built on #8243) and
 * the prologue-deadline totals. W08 publishes no pool gauges of its own — W04
 * owns `breeze_db_pool_admission_*` — and never measures the pool a second way.
 *
 * Without a registered gate (unit tests; a process that never loaded the
 * request pool) the signals read `available: false` and zero. That is
 * "unknown", never "pressure": the controller then decides on lag alone and
 * cannot raise a false DB emergency.
 */
import { getRequestPoolAdmission } from '../../db/poolAdmission';
import { getPrologueDeadlineExpiryTotals } from '../../db/prologueDeadline';

export interface PoolSignals {
  available: boolean;
  inUse: number;
  waiting: number;
  effectivePermits: number;
  oldestWaitMs: number;
  grantWaitP95Ms: number;
  /** Monotonic since boot: pool-acquire timeouts + prologue-deadline expiries. */
  dbTimeoutsTotal: number;
}

function total(record: Readonly<Record<string, number>>): number {
  let sum = 0;
  for (const value of Object.values(record)) sum += value;
  return sum;
}

export function readPoolSignals(): PoolSignals {
  const prologueExpiries = total(getPrologueDeadlineExpiryTotals());
  const gate = getRequestPoolAdmission();
  if (!gate) {
    return {
      available: false, inUse: 0, waiting: 0, effectivePermits: 0, oldestWaitMs: 0, grantWaitP95Ms: 0,
      dbTimeoutsTotal: prologueExpiries,
    };
  }
  const snapshot = gate.snapshot();
  const stats = gate.waitStats();
  return {
    available: true,
    inUse: snapshot.inUse,
    waiting: snapshot.waiting,
    effectivePermits: snapshot.effectivePermits,
    oldestWaitMs: stats.oldestWaitMs,
    grantWaitP95Ms: stats.grantWaitP95Ms,
    dbTimeoutsTotal: total(gate.totals().acquireTimeouts) + prologueExpiries,
  };
}
```

- [ ] **Step 8: Run both, plus the W04 and #8243 seam suites**

Run: `cd apps/api && npx vitest run src/db/poolAdmission.test.ts src/services/admission/poolSignals.test.ts src/db/prologueDeadline src/db/requestDatabasePool.test.ts`
Expected: PASS. Read the file count. It includes `prologueDeadline.test.ts`, `prologueDeadline.acquire.test.ts` and `prologueDeadlineWiring.test.ts` from #8243 and W04. `requestDatabasePool.test.ts` stays inside its time budget.

- [ ] **Step 9: Typecheck and commit**

```bash
cd apps/api && npx tsc --noEmit -p tsconfig.json; echo "tsc exit $?"
cd ../.. && git add apps/api/src/db/poolAdmission.ts apps/api/src/db/poolAdmission.test.ts apps/api/src/services/admission/poolSignals.ts apps/api/src/services/admission/poolSignals.test.ts
git commit -m "feat(api): admission pool signals from the W04 gate (oldest waiter, grant-wait p95) (#8147)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Timestamped lag samples and the signal sampler

**Files:**
- Modify: `apps/api/src/services/eventLoopMonitor.ts`. Add the `samplesSince` method to `EventLoopLagMonitor` after `latest()` (~line 398), and an exported module function after `readLatestEventLoopLag` (~line 455).
- Modify: `apps/api/src/services/eventLoopMonitor.test.ts` (one new `describe`)
- Create: `apps/api/src/services/admission/admissionSignals.ts`
- Create: `apps/api/src/services/admission/admissionSignals.test.ts`

**Interfaces:**
- Consumes: Task 1 `readPoolSignals(): PoolSignals`.
- Produces (used by Tasks 4, 7 and 11):
  ```ts
  // eventLoopMonitor.ts
  export function readEventLoopLagSamplesSince(afterMs: number): readonly EventLoopLagSample[];
  // admissionSignals.ts
  export const LAG_WINDOW_SAMPLES = 3;
  export interface AdmissionSignals {
    lagMs: number | null; peakLagMs: number | null;
    dbWaitMs: number; oldestDbWaitMs: number;
    msSinceLastDbTimeout: number | null; eluRatio: number;
    pool: PoolSignals;
  }
  export interface SignalSampler { sample(): AdmissionSignals }
  export function createSignalSampler(deps?: SignalSamplerDeps): SignalSampler;
  ```

- [ ] **Step 1: Write the failing monitor test**

Append to `apps/api/src/services/eventLoopMonitor.test.ts`. Mirror the file's existing fake-histogram setup: it already builds an `EventLoopLagMonitor` with an injected `now` and `createHistogram`. Use the helper the file defines for that. If none exists, build a monitor the way its first `describe` does.

```ts
describe('samplesSince (W08)', () => {
  it('returns each completed sample strictly after the cursor, oldest first', () => {
    let nowMs = 10_000;
    const histogram = { enable: vi.fn(), disable: vi.fn(), reset: vi.fn(), max: 0, mean: 0 };
    const monitor = new EventLoopLagMonitor({
      now: () => nowMs,
      sampleIntervalMs: 1_000,
      createHistogram: () => histogram as never,
    });
    monitor.start();
    histogram.max = 50e6; nowMs += 1_000; monitor.sampleNow();   // 50 ms at 11_000
    histogram.max = 300e6; nowMs += 1_000; monitor.sampleNow();  // 300 ms at 12_000

    expect(monitor.samplesSince(0).map((s) => s.maxLagMs)).toEqual([50, 300]);
    expect(monitor.samplesSince(11_000).map((s) => s.maxLagMs)).toEqual([300]);
    expect(monitor.samplesSince(12_000)).toEqual([]);
    monitor.stop();
    expect(monitor.samplesSince(0)).toEqual([]);
  });

  it('readEventLoopLagSamplesSince is empty when no monitor runs', () => {
    __setEventLoopMonitorForTests(null);
    expect(readEventLoopLagSamplesSince(0)).toEqual([]);
  });
});
```

Add `readEventLoopLagSamplesSince` to the file's import from `./eventLoopMonitor` (along with `EventLoopLagMonitor`, `__setEventLoopMonitorForTests` and `vi`, if they are not already imported).

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && npx vitest run src/services/eventLoopMonitor.test.ts`
Expected: FAIL, "monitor.samplesSince is not a function". 1 file.

- [ ] **Step 3: Implement**

In the class, after `latest()`:

```ts
  /**
   * W08: completed samples recorded strictly after `afterMs` (this monitor's
   * clock), oldest first. Lets a periodic consumer read every sample exactly
   * once — `latest()` carries no timestamp, so polling it at a different
   * cadence double-counts or skips samples.
   */
  samplesSince(afterMs: number): readonly EventLoopLagSample[] {
    if (!this.histogram) return [];
    return this.samples.filter((sample) => sample.atMs > afterMs);
  }
```

After `readLatestEventLoopLag`:

```ts
/** W08: completed lag samples after `afterMs` (Date.now() clock); empty when no monitor runs. */
export function readEventLoopLagSamplesSince(afterMs: number): readonly EventLoopLagSample[] {
  return monitor?.samplesSince(afterMs) ?? [];
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd apps/api && npx vitest run src/services/eventLoopMonitor.test.ts`
Expected: PASS. 1 file.

- [ ] **Step 5: Write the failing sampler test**

`apps/api/src/services/admission/admissionSignals.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { EventLoopLagReading, EventLoopLagSample } from '../eventLoopMonitor';
import type { PoolSignals } from './poolSignals';
import { createSignalSampler } from './admissionSignals';

const pool = (over: Partial<PoolSignals> = {}): PoolSignals => ({
  available: true, inUse: 0, waiting: 0, effectivePermits: 30, oldestWaitMs: 0, grantWaitP95Ms: 0, dbTimeoutsTotal: 0, ...over,
});
const reading = (over: Partial<EventLoopLagReading> = {}): EventLoopLagReading => ({
  monitored: true, coversWindow: true, sampledMaxLagMs: 0, inFlightLagMs: 0, worstLagMs: 0, sampleCount: 1, ...over,
});

function harness() {
  const store: EventLoopLagSample[] = [];
  let latest = reading();
  let poolSnapshot = pool();
  let nowMs = 0;
  const sampler = createSignalSampler({
    readSamplesSince: (afterMs) => store.filter((s) => s.atMs > afterMs),
    readLatest: () => latest,
    readPool: () => poolSnapshot,
    now: () => nowMs,
    elu: (prev) => (prev ? { idle: 250, active: 750, utilization: 0.75 } : { idle: 0, active: 0, utilization: 0 }),
  });
  return {
    sampler,
    push: (atMs: number, maxLagMs: number) => store.push({ atMs, maxLagMs, meanLagMs: maxLagMs / 2 }),
    setLatest: (r: EventLoopLagReading) => { latest = r; },
    setPool: (p: PoolSignals) => { poolSnapshot = p; },
    advance: (ms: number) => { nowMs += ms; },
  };
}

describe('createSignalSampler', () => {
  it('takes the lower median of the newest three samples, reading each sample once', () => {
    const h = harness();
    h.push(1_000, 30); h.push(2_000, 400); h.push(3_000, 35);
    expect(h.sampler.sample().lagMs).toBe(35);       // [30, 35, 400] -> 35: one spike is filtered
    h.push(4_000, 500); h.push(5_000, 600);
    expect(h.sampler.sample().lagMs).toBe(500);      // window is now [35, 500, 600]
    expect(h.sampler.sample().lagMs).toBe(500);      // no new samples: window unchanged, nothing re-read
  });

  it('peak lag is the worst of the in-flight stall and the samples consumed this tick', () => {
    const h = harness();
    h.push(1_000, 1_200);
    h.setLatest(reading({ inFlightLagMs: 300 }));
    expect(h.sampler.sample().peakLagMs).toBe(1_200);
    h.setLatest(reading({ inFlightLagMs: 2_500 }));
    expect(h.sampler.sample().peakLagMs).toBe(2_500);
  });

  it('reports lag as unknown (null) when the monitor is not running', () => {
    const h = harness();
    h.push(1_000, 900);
    h.setLatest(reading({ monitored: false }));
    expect(h.sampler.sample()).toMatchObject({ lagMs: null, peakLagMs: null });
  });

  it('DB pool wait is the larger of the grant-wait p95 and the oldest waiter', () => {
    const h = harness();
    h.setPool(pool({ grantWaitP95Ms: 80, oldestWaitMs: 20 }));
    expect(h.sampler.sample()).toMatchObject({ dbWaitMs: 80, oldestDbWaitMs: 20 });
    h.setPool(pool({ grantWaitP95Ms: 10, oldestWaitMs: 900 }));
    expect(h.sampler.sample()).toMatchObject({ dbWaitMs: 900, oldestDbWaitMs: 900 });
  });

  it('reports the time since the DB timeout counter last moved (timeouts before the first sample do not count)', () => {
    const h = harness();
    h.setPool(pool({ dbTimeoutsTotal: 5 }));
    expect(h.sampler.sample().msSinceLastDbTimeout).toBeNull();
    h.advance(1_000);
    h.setPool(pool({ dbTimeoutsTotal: 7 }));
    expect(h.sampler.sample().msSinceLastDbTimeout).toBe(0);
    h.advance(4_000);
    expect(h.sampler.sample().msSinceLastDbTimeout).toBe(4_000);
  });

  it('reports ELU over the interval since the previous sample', () => {
    expect(harness().sampler.sample().eluRatio).toBe(0.75);
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `cd apps/api && npx vitest run src/services/admission/admissionSignals.test.ts`
Expected: FAIL, module not found. 1 file.

- [ ] **Step 7: Implement `admissionSignals.ts`**

```ts
/**
 * W08 admission signals, sampled once per controller tick.
 *
 * - lagMs: lower median of the `maxLagMs` of the newest LAG_WINDOW_SAMPLES
 *   distinct event-loop monitor samples. A single GC-sized spike in the `all`
 *   role does not move it; a sustained stall does.
 * - peakLagMs: the worst of the in-flight stall and the samples consumed this
 *   tick — drives the controller's emergency path.
 * - dbWaitMs: max(grant-wait p95 over W04's gate window, oldest waiter). The
 *   second term makes a stuck queue visible before any permit is granted.
 * - msSinceLastDbTimeout: time since the pool-acquire-timeout + prologue-expiry
 *   counter last increased; null until it has moved during this process's
 *   sampling (timeouts during boot/migrations do not count).
 * - eluRatio: event-loop utilization since the previous tick. Exported only:
 *   in the `all` role BullMQ workers legitimately push it up without hurting
 *   request latency, so it is not a trigger.
 *
 * `null` lag means "the monitor is not running" — unknown, never healthy; the
 * controller then decides on the DB signal alone.
 */
import { performance, type EventLoopUtilization } from 'node:perf_hooks';
import {
  readEventLoopLagSamplesSince,
  readLatestEventLoopLag,
  type EventLoopLagReading,
  type EventLoopLagSample,
} from '../eventLoopMonitor';
import { readPoolSignals, type PoolSignals } from './poolSignals';

export const LAG_WINDOW_SAMPLES = 3;

export interface AdmissionSignals {
  lagMs: number | null;
  peakLagMs: number | null;
  dbWaitMs: number;
  oldestDbWaitMs: number;
  msSinceLastDbTimeout: number | null;
  eluRatio: number;
  pool: PoolSignals;
}

export interface SignalSampler {
  sample(): AdmissionSignals;
}

export interface SignalSamplerDeps {
  readSamplesSince?: (afterMs: number) => readonly EventLoopLagSample[];
  readLatest?: () => EventLoopLagReading;
  readPool?: () => PoolSignals;
  /** Monotonic clock for the DB-timeout age. Defaults to performance.now(). */
  now?: () => number;
  /** `performance.eventLoopUtilization` shape: no arg = absolute, one arg = delta since it. */
  elu?: (prev?: EventLoopUtilization) => EventLoopUtilization;
}

export function createSignalSampler(deps: SignalSamplerDeps = {}): SignalSampler {
  const readSamplesSince = deps.readSamplesSince ?? readEventLoopLagSamplesSince;
  const readLatest = deps.readLatest ?? readLatestEventLoopLag;
  const readPool = deps.readPool ?? readPoolSignals;
  const now = deps.now ?? (() => performance.now());
  const elu = deps.elu ?? ((prev?: EventLoopUtilization) => performance.eventLoopUtilization(prev));

  const recent: number[] = [];
  let cursorMs = 0;
  let previousElu = elu();
  let lastDbTimeoutsTotal: number | null = null;
  let lastDbTimeoutAtMs: number | null = null;

  return {
    sample(): AdmissionSignals {
      const latest = readLatest();
      let newestThisTick = 0;
      if (!latest.monitored) {
        recent.length = 0;
        cursorMs = 0;
      } else {
        for (const sample of readSamplesSince(cursorMs)) {
          recent.push(sample.maxLagMs);
          if (recent.length > LAG_WINDOW_SAMPLES) recent.shift();
          cursorMs = sample.atMs;
          if (sample.maxLagMs > newestThisTick) newestThisTick = sample.maxLagMs;
        }
      }
      const sorted = [...recent].sort((a, b) => a - b);
      const lagMs = !latest.monitored ? null : sorted.length === 0 ? 0 : sorted[Math.floor((sorted.length - 1) / 2)]!;
      const peakLagMs = !latest.monitored ? null : Math.max(latest.inFlightLagMs, newestThisTick);

      const delta = elu(previousElu);
      previousElu = elu();

      const pool = readPool();
      const nowMs = now();
      if (lastDbTimeoutsTotal !== null && pool.dbTimeoutsTotal > lastDbTimeoutsTotal) lastDbTimeoutAtMs = nowMs;
      lastDbTimeoutsTotal = pool.dbTimeoutsTotal;
      return {
        lagMs,
        peakLagMs,
        dbWaitMs: Math.max(pool.grantWaitP95Ms, pool.oldestWaitMs),
        oldestDbWaitMs: pool.oldestWaitMs,
        msSinceLastDbTimeout: lastDbTimeoutAtMs === null ? null : nowMs - lastDbTimeoutAtMs,
        eluRatio: delta.utilization,
        pool,
      };
    },
  };
}
```

- [ ] **Step 8: Run it to verify it passes**

Run: `cd apps/api && npx vitest run src/services/admission/admissionSignals.test.ts src/services/eventLoopMonitor.test.ts`
Expected: PASS, 2 files.

- [ ] **Step 9: Typecheck and commit**

```bash
cd apps/api && npx tsc --noEmit -p tsconfig.json; echo "tsc exit $?"
cd ../.. && git add apps/api/src/services/eventLoopMonitor.ts apps/api/src/services/eventLoopMonitor.test.ts apps/api/src/services/admission/admissionSignals.ts apps/api/src/services/admission/admissionSignals.test.ts
git commit -m "feat(api): admission signal sampler with timestamped lag samples (#8147)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 3: Admission config, env registration and env docs

**Files:**
- Create: `apps/api/src/services/admission/admissionConfig.ts`
- Create: `apps/api/src/services/admission/admissionConfig.test.ts`
- Modify: `apps/api/src/system/connections/internalEnvVars.ts`. Add to the `// BREEZE_*` group, keeping it alphabetical.
- Modify: `docker-compose.yml` and `deploy/docker-compose.prod.yml`. Add to the `x-api-env` anchor, right after the `EVENT_LOOP_MONITOR_DISABLED` line.
- Modify: `.env.example`. Add after the event-loop block (~line 729).
- Modify: `apps/docs/src/content/docs/deploy/environment.mdx`. Add a new `### Agent admission control` section after `### Event-loop lag monitor`.

**Interfaces:**
- Consumes: nothing.
- Produces (used by Tasks 4, 6 and 7):
  ```ts
  export type AdmissionMode = 'off' | 'observe' | 'enforce';
  export type LevelThresholds = readonly [number, number, number];
  export interface AdmissionConfig {
    mode: AdmissionMode; lagMs: LevelThresholds; dbWaitMs: LevelThresholds; emergencyMs: number;
    bulkMaxInFlight: number; wsRatePerSec: number; wsBurst: number; wsMaxSetups: number;
  }
  export const ADMISSION_DEFAULTS: AdmissionConfig;
  export const ADMISSION_TICK_MS = 1_000;
  export const ADMISSION_ESCALATE_TICKS = 2;
  export const ADMISSION_RECOVER_MS = 15_000;
  export const ADMISSION_EXIT_RATIO = 0.6;
  export const ADMISSION_DB_TIMEOUT_FLOOR_MS = 30_000;
  export const ADMISSION_WS_LEVEL_SCALE: readonly [number, number, number, number]; // [1, 0.5, 0.2, 0.05]
  export function resolveAdmissionConfig(env?: NodeJS.ProcessEnv): { config: AdmissionConfig; warnings: string[] };
  ```

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { ADMISSION_DEFAULTS, resolveAdmissionConfig } from './admissionConfig';

describe('resolveAdmissionConfig', () => {
  it('defaults to observe with the documented thresholds', () => {
    const { config, warnings } = resolveAdmissionConfig({});
    expect(warnings).toEqual([]);
    expect(config).toEqual({
      mode: 'observe',
      lagMs: [100, 250, 600],
      dbWaitMs: [75, 200, 600],
      emergencyMs: 1_000,
      bulkMaxInFlight: 15,
      wsRatePerSec: 10,
      wsBurst: 20,
      wsMaxSetups: 8,
    });
    expect(config).toEqual(ADMISSION_DEFAULTS);
  });

  it('treats empty strings (compose ${VAR:-}) as unset', () => {
    const { config, warnings } = resolveAdmissionConfig({
      BREEZE_ADMISSION_MODE: '',
      BREEZE_ADMISSION_LAG_MS: '',
      BREEZE_ADMISSION_WS_BURST: '',
    });
    expect(warnings).toEqual([]);
    expect(config).toEqual(ADMISSION_DEFAULTS);
  });

  it('parses every knob', () => {
    const { config, warnings } = resolveAdmissionConfig({
      BREEZE_ADMISSION_MODE: ' Enforce ',
      BREEZE_ADMISSION_LAG_MS: '80, 200 ,500',
      BREEZE_ADMISSION_DB_WAIT_MS: '50,150,400',
      BREEZE_ADMISSION_EMERGENCY_MS: '800',
      BREEZE_ADMISSION_BULK_MAX_IN_FLIGHT: '6',
      BREEZE_ADMISSION_WS_RATE_PER_SEC: '2.5',
      BREEZE_ADMISSION_WS_BURST: '5',
      BREEZE_ADMISSION_WS_MAX_SETUPS: '3',
    });
    expect(warnings).toEqual([]);
    expect(config).toEqual({
      mode: 'enforce', lagMs: [80, 200, 500], dbWaitMs: [50, 150, 400], emergencyMs: 800,
      bulkMaxInFlight: 6, wsRatePerSec: 2.5, wsBurst: 5, wsMaxSetups: 3,
    });
  });

  it.each([
    ['BREEZE_ADMISSION_MODE', 'shed-everything', 'mode'],
    ['BREEZE_ADMISSION_LAG_MS', '300,200,600', 'lagMs'],
    ['BREEZE_ADMISSION_LAG_MS', '100,250', 'lagMs'],
    ['BREEZE_ADMISSION_DB_WAIT_MS', '0,200,600', 'dbWaitMs'],
    ['BREEZE_ADMISSION_EMERGENCY_MS', '-5', 'emergencyMs'],
    ['BREEZE_ADMISSION_BULK_MAX_IN_FLIGHT', '2.5', 'bulkMaxInFlight'],
    ['BREEZE_ADMISSION_WS_RATE_PER_SEC', '0', 'wsRatePerSec'],
    ['BREEZE_ADMISSION_WS_BURST', 'lots', 'wsBurst'],
    ['BREEZE_ADMISSION_WS_MAX_SETUPS', '0', 'wsMaxSetups'],
  ] as const)('%s=%s falls back to the default with a warning', (name, value, key) => {
    const { config, warnings } = resolveAdmissionConfig({ [name]: value });
    expect(config[key]).toEqual(ADMISSION_DEFAULTS[key]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(name);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && npx vitest run src/services/admission/admissionConfig.test.ts`
Expected: FAIL, module not found. 1 file.

- [ ] **Step 3: Implement `admissionConfig.ts`**

```ts
/**
 * W08 admission-control configuration (spec W1c, #8147).
 *
 * Operator knobs come from env. Every consumer treats '' as unset because
 * compose passes `${VAR:-}`. An invalid value never refuses boot: it falls
 * back to the default with a warning that names the variable — an admission
 * controller that crashed the API on a typo would be its own outage.
 *
 * The controller constants below are deliberately NOT env knobs: they shape
 * stability (tick, hysteresis), and exposing them invites oscillating configs.
 */
export type AdmissionMode = 'off' | 'observe' | 'enforce';
export type LevelThresholds = readonly [number, number, number];

export interface AdmissionConfig {
  /** off = kill switch; observe = compute and count, never refuse (default); enforce = refuse. */
  mode: AdmissionMode;
  /** Median event-loop lag (ms) that enters level 1 / 2 / 3. */
  lagMs: LevelThresholds;
  /** DB pool wait (ms, from W04's gate) that enters level 1 / 2 / 3. */
  dbWaitMs: LevelThresholds;
  /** Peak lag or oldest DB waiter (ms) that jumps straight to level 3. */
  emergencyMs: number;
  /** Bulk-class requests admitted concurrently, at every level, in enforce mode. */
  bulkMaxInFlight: number;
  /** Agent WS upgrades per second at level 0 (scaled by ADMISSION_WS_LEVEL_SCALE). */
  wsRatePerSec: number;
  /** Agent WS upgrade bucket capacity at level 0 (scaled likewise). */
  wsBurst: number;
  /** Agent WS upgrades between admission and the end of onOpen, at once. */
  wsMaxSetups: number;
}

export const ADMISSION_DEFAULTS: AdmissionConfig = Object.freeze({
  mode: 'observe',
  lagMs: [100, 250, 600] as const,
  dbWaitMs: [75, 200, 600] as const,
  emergencyMs: 1_000,
  bulkMaxInFlight: 15,
  wsRatePerSec: 10,
  wsBurst: 20,
  wsMaxSetups: 8,
}) as AdmissionConfig;

export const ADMISSION_TICK_MS = 1_000;
export const ADMISSION_ESCALATE_TICKS = 2;
export const ADMISSION_RECOVER_MS = 15_000;
export const ADMISSION_EXIT_RATIO = 0.6;
export const ADMISSION_DB_TIMEOUT_FLOOR_MS = 30_000;
export const ADMISSION_WS_LEVEL_SCALE = [1, 0.5, 0.2, 0.05] as const;

const MODES: readonly AdmissionMode[] = ['off', 'observe', 'enforce'];

function present(raw: string | undefined): string | null {
  const value = raw?.trim() ?? '';
  return value.length > 0 ? value : null;
}

export function resolveAdmissionConfig(env: NodeJS.ProcessEnv = process.env): {
  config: AdmissionConfig;
  warnings: string[];
} {
  const warnings: string[] = [];
  const warn = (name: string, raw: string, expected: string) =>
    warnings.push(`${name}=${JSON.stringify(raw)} is invalid (${expected}); using the default`);

  const positive = (name: string, raw: string | undefined, fallback: number, integer: boolean): number => {
    const value = present(raw);
    if (value === null) return fallback;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0 || (integer && !Number.isInteger(parsed))) {
      warn(name, value, integer ? 'a positive integer' : 'a positive number');
      return fallback;
    }
    return parsed;
  };

  const triplet = (name: string, raw: string | undefined, fallback: LevelThresholds): LevelThresholds => {
    const value = present(raw);
    if (value === null) return fallback;
    const parts = value.split(',').map((part) => Number(part.trim()));
    const valid = parts.length === 3
      && parts.every((part) => Number.isFinite(part) && part > 0)
      && parts[0]! < parts[1]! && parts[1]! < parts[2]!;
    if (!valid) {
      warn(name, value, 'three increasing positive numbers, e.g. "100,250,600"');
      return fallback;
    }
    return [parts[0]!, parts[1]!, parts[2]!] as const;
  };

  let mode = ADMISSION_DEFAULTS.mode;
  const rawMode = present(env.BREEZE_ADMISSION_MODE);
  if (rawMode !== null) {
    const normalized = rawMode.toLowerCase() as AdmissionMode;
    if (MODES.includes(normalized)) mode = normalized;
    else warn('BREEZE_ADMISSION_MODE', rawMode, 'off | observe | enforce');
  }

  return {
    config: {
      mode,
      lagMs: triplet('BREEZE_ADMISSION_LAG_MS', env.BREEZE_ADMISSION_LAG_MS, ADMISSION_DEFAULTS.lagMs),
      dbWaitMs: triplet('BREEZE_ADMISSION_DB_WAIT_MS', env.BREEZE_ADMISSION_DB_WAIT_MS, ADMISSION_DEFAULTS.dbWaitMs),
      emergencyMs: positive('BREEZE_ADMISSION_EMERGENCY_MS', env.BREEZE_ADMISSION_EMERGENCY_MS, ADMISSION_DEFAULTS.emergencyMs, false),
      bulkMaxInFlight: positive('BREEZE_ADMISSION_BULK_MAX_IN_FLIGHT', env.BREEZE_ADMISSION_BULK_MAX_IN_FLIGHT, ADMISSION_DEFAULTS.bulkMaxInFlight, true),
      wsRatePerSec: positive('BREEZE_ADMISSION_WS_RATE_PER_SEC', env.BREEZE_ADMISSION_WS_RATE_PER_SEC, ADMISSION_DEFAULTS.wsRatePerSec, false),
      wsBurst: positive('BREEZE_ADMISSION_WS_BURST', env.BREEZE_ADMISSION_WS_BURST, ADMISSION_DEFAULTS.wsBurst, true),
      wsMaxSetups: positive('BREEZE_ADMISSION_WS_MAX_SETUPS', env.BREEZE_ADMISSION_WS_MAX_SETUPS, ADMISSION_DEFAULTS.wsMaxSetups, true),
    },
    warnings,
  };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd apps/api && npx vitest run src/services/admission/admissionConfig.test.ts`
Expected: PASS, 1 file.

- [ ] **Step 5: Run the env contract tests and watch them go red**

Run: `cd apps/api && npx vitest run src/system/connections src/config/envReadComposeCoverage.test.ts src/config/envComposeParity.test.ts`
Expected: FAIL. The internal-env ratchet reports 8 unclassified names (`BREEZE_ADMISSION_*`). Note the reported file count.

- [ ] **Step 6: Register the vars everywhere**

`internalEnvVars.ts`, in the `// BREEZE_*` group (alphabetical):

```ts
  BREEZE_ADMISSION_BULK_MAX_IN_FLIGHT: 'agent admission control tuning',
  BREEZE_ADMISSION_DB_WAIT_MS: 'agent admission control tuning',
  BREEZE_ADMISSION_EMERGENCY_MS: 'agent admission control tuning',
  BREEZE_ADMISSION_LAG_MS: 'agent admission control tuning',
  BREEZE_ADMISSION_MODE: 'agent admission control mode / kill switch',
  BREEZE_ADMISSION_WS_BURST: 'agent admission control tuning',
  BREEZE_ADMISSION_WS_MAX_SETUPS: 'agent admission control tuning',
  BREEZE_ADMISSION_WS_RATE_PER_SEC: 'agent admission control tuning',
```

`docker-compose.yml` **and** `deploy/docker-compose.prod.yml`, in `x-api-env`, right after `EVENT_LOOP_MONITOR_DISABLED`:

```yaml
  # Agent admission control (W08, #8147). observe (default) never refuses;
  # enforce sheds low-priority agent work under event-loop / DB pressure; off
  # is the kill switch. Empty reads as unset, so the code defaults apply.
  BREEZE_ADMISSION_MODE: ${BREEZE_ADMISSION_MODE:-}
  BREEZE_ADMISSION_LAG_MS: ${BREEZE_ADMISSION_LAG_MS:-}
  BREEZE_ADMISSION_DB_WAIT_MS: ${BREEZE_ADMISSION_DB_WAIT_MS:-}
  BREEZE_ADMISSION_EMERGENCY_MS: ${BREEZE_ADMISSION_EMERGENCY_MS:-}
  BREEZE_ADMISSION_BULK_MAX_IN_FLIGHT: ${BREEZE_ADMISSION_BULK_MAX_IN_FLIGHT:-}
  BREEZE_ADMISSION_WS_RATE_PER_SEC: ${BREEZE_ADMISSION_WS_RATE_PER_SEC:-}
  BREEZE_ADMISSION_WS_BURST: ${BREEZE_ADMISSION_WS_BURST:-}
  BREEZE_ADMISSION_WS_MAX_SETUPS: ${BREEZE_ADMISSION_WS_MAX_SETUPS:-}
```

`.env.example`, after the event-loop block:

```bash
# Agent admission control. When the API's event loop or its database pool falls
# behind, refuse low-priority agent telemetry with 503 + Retry-After before it
# costs anything, and pace agent WebSocket reconnects. Heartbeats and recovery
# traffic are never refused. observe (default) only measures and counts;
# enforce refuses; off disables it.
# BREEZE_ADMISSION_MODE=observe
# BREEZE_ADMISSION_LAG_MS=100,250,600
# BREEZE_ADMISSION_DB_WAIT_MS=75,200,600
# BREEZE_ADMISSION_EMERGENCY_MS=1000
# BREEZE_ADMISSION_BULK_MAX_IN_FLIGHT=15
# BREEZE_ADMISSION_WS_RATE_PER_SEC=10
# BREEZE_ADMISSION_WS_BURST=20
# BREEZE_ADMISSION_WS_MAX_SETUPS=8
```

`environment.mdx`, a new section after the event-loop one:

```mdx
### Agent admission control

When the API falls behind — its event loop is slow, or requests queue for a
database connection — it can refuse low-priority agent work before that work
costs anything, and pace how fast agents reconnect their WebSockets. Refused
requests get `503` with a `Retry-After`, which every agent since v0.64.3 honours;
the agent keeps the data where it would on any failed send. Heartbeats, command
results, event logs, token rotation and uninstall are never refused.

`observe` is the default: the API computes everything and counts what it
*would* refuse (`breeze_admission_decisions_total{outcome="would_shed"}`) but
refuses nothing. Switch to `enforce` once those counters look right for your
fleet. `off` disables it.

| Variable | Default | Description |
|---|---|---|
| `BREEZE_ADMISSION_MODE` | `observe` | `off`, `observe` or `enforce`. |
| `BREEZE_ADMISSION_LAG_MS` | `100,250,600` | Median event-loop lag (ms) that raises the level to 1, 2 and 3. |
| `BREEZE_ADMISSION_DB_WAIT_MS` | `75,200,600` | Time requests wait for a database connection (ms) that raises the level to 1, 2 and 3. |
| `BREEZE_ADMISSION_EMERGENCY_MS` | `1000` | A single stall, or a database wait, this long jumps straight to level 3. |
| `BREEZE_ADMISSION_BULK_MAX_IN_FLIGHT` | `15` | Inventory-type uploads processed at once, at every level. |
| `BREEZE_ADMISSION_WS_RATE_PER_SEC` | `10` | Agent WebSocket connections accepted per second at level 0 (halved at 1, a fifth at 2, a twentieth at 3). |
| `BREEZE_ADMISSION_WS_BURST` | `20` | How many WebSocket connections can arrive at once before pacing starts. |
| `BREEZE_ADMISSION_WS_MAX_SETUPS` | `8` | WebSocket connections being set up at the same time. |

Level 1 refuses inventory-type uploads (hardware, software, disks, network,
process samples, agent logs, UniFi). Level 2 also refuses periodic status
uploads (security status, sessions, patches, monitoring results). Level 3 only
paces WebSockets harder — if an instance stays at level 3 it needs more
capacity, not more shedding. Invalid values fall back to the default with a
startup warning; they never stop the API from booting.
```

- [ ] **Step 7: Re-run the contract tests**

Run: `cd apps/api && npx vitest run src/system/connections src/config/envReadComposeCoverage.test.ts src/config/envComposeParity.test.ts src/services/admission/admissionConfig.test.ts`
Expected: PASS, with the same file count as Step 5.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/services/admission/admissionConfig.ts apps/api/src/services/admission/admissionConfig.test.ts apps/api/src/system/connections/internalEnvVars.ts docker-compose.yml deploy/docker-compose.prod.yml .env.example apps/docs/src/content/docs/deploy/environment.mdx
git commit -m "feat(api): admission control config and env registration (#8147)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The level controller

**Files:**
- Create: `apps/api/src/services/admission/admissionController.ts`
- Create: `apps/api/src/services/admission/admissionController.test.ts`

**Interfaces:**
- Consumes: Task 2 `AdmissionSignals`; Task 3 `AdmissionConfig`, `LevelThresholds`, `ADMISSION_ESCALATE_TICKS`, `ADMISSION_RECOVER_MS`, `ADMISSION_EXIT_RATIO`, `ADMISSION_DB_TIMEOUT_FLOOR_MS`.
- Produces (used by Task 7):
  ```ts
  export type AdmissionLevel = 0 | 1 | 2 | 3;
  export type AdmissionTrigger = 'none' | 'lag' | 'db' | 'db_timeout' | 'emergency';
  export interface ControllerStep { level: AdmissionLevel; previous: AdmissionLevel; changed: boolean; trigger: AdmissionTrigger }
  export function levelFor(value: number | null, thresholds: LevelThresholds, scale?: number): AdmissionLevel;
  export class AdmissionController {
    constructor(config: Pick<AdmissionConfig, 'lagMs' | 'dbWaitMs' | 'emergencyMs'>);
    readonly level: AdmissionLevel; readonly trigger: AdmissionTrigger;
    step(signals: AdmissionSignals, nowMs: number): ControllerStep;
  }
  ```

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import type { AdmissionSignals } from './admissionSignals';
import { ADMISSION_DEFAULTS } from './admissionConfig';
import { AdmissionController, levelFor } from './admissionController';

const quiet: AdmissionSignals = {
  lagMs: 20, peakLagMs: 25, dbWaitMs: 2, oldestDbWaitMs: 0, msSinceLastDbTimeout: null, eluRatio: 0.3,
  pool: { available: true, inUse: 1, waiting: 0, effectivePermits: 30, oldestWaitMs: 0, grantWaitP95Ms: 2, dbTimeoutsTotal: 0 },
};
const sig = (over: Partial<AdmissionSignals>): AdmissionSignals => ({ ...quiet, ...over });

function run(controller: AdmissionController, signals: AdmissionSignals[], startMs = 0, stepMs = 1_000) {
  let nowMs = startMs;
  return signals.map((s) => { nowMs += stepMs; return controller.step(s, nowMs); });
}

describe('levelFor', () => {
  it('maps a value onto 0..3 and treats null as 0', () => {
    expect([10, 100, 249, 250, 600, 5_000, null].map((v) => levelFor(v, [100, 250, 600]))).toEqual([0, 1, 1, 2, 3, 3, 0]);
    expect(levelFor(60, [100, 250, 600], 0.6)).toBe(1);
  });
});

describe('AdmissionController', () => {
  const make = () => new AdmissionController(ADMISSION_DEFAULTS);

  it('stays at 0 under quiet signals', () => {
    const c = make();
    run(c, Array(30).fill(quiet));
    expect(c.level).toBe(0);
  });

  it('a single spike does not escalate (Review Focus 2)', () => {
    const c = make();
    run(c, [quiet, sig({ lagMs: 400, dbWaitMs: 300 }), quiet, quiet]);
    expect(c.level).toBe(0);
  });

  it('escalates after two consecutive elevated ticks, to the lower of the two targets', () => {
    const c = make();
    const steps = run(c, [sig({ lagMs: 300 }), sig({ lagMs: 700 })]);
    expect(steps[1]).toMatchObject({ previous: 0, level: 2, changed: true, trigger: 'lag' });
    run(c, [sig({ lagMs: 700 }), sig({ lagMs: 700 })]);
    expect(c.level).toBe(3);
  });

  it('DB pool wait alone drives the level, and wins a tie with lag', () => {
    const c = make();
    const steps = run(c, [sig({ lagMs: 120, dbWaitMs: 90 }), sig({ lagMs: 120, dbWaitMs: 90 })]);
    expect(steps[1]).toMatchObject({ level: 1, trigger: 'db' });
  });

  it('jumps straight to 3 on an emergency stall or an emergency DB wait', () => {
    const a = make();
    expect(a.step(sig({ peakLagMs: 1_500 }), 1_000)).toMatchObject({ level: 3, changed: true, trigger: 'emergency' });
    const b = make();
    expect(b.step(sig({ oldestDbWaitMs: 1_000 }), 1_000)).toMatchObject({ level: 3, trigger: 'emergency' });
  });

  it('ignores lag when it is unknown (monitor off) and still reacts to the DB signal', () => {
    const c = make();
    run(c, [sig({ lagMs: null, peakLagMs: null, dbWaitMs: 250 }), sig({ lagMs: null, peakLagMs: null, dbWaitMs: 250 })]);
    expect(c.level).toBe(2);
  });

  it('steps down one level per 15 s continuously below 60 % of the current thresholds', () => {
    const c = make();
    run(c, [sig({ lagMs: 700 }), sig({ lagMs: 700 })]);            // -> 3 at t=2s
    run(c, Array(14).fill(quiet), 2_000);                          // t=3..16s: below since t=3s
    expect(c.level).toBe(3);
    run(c, Array(4).fill(quiet), 16_000);                          // t=17..20s: 15 s reached at t=18s
    expect(c.level).toBe(2);
    run(c, Array(30).fill(quiet), 20_000);
    expect(c.level).toBe(0);
    expect(c.trigger).toBe('none');
  });

  it('a signal between the exit and enter thresholds holds the level (hysteresis)', () => {
    const c = make();
    run(c, [sig({ lagMs: 300 }), sig({ lagMs: 300 })]);            // -> 2
    run(c, Array(60).fill(sig({ lagMs: 160 })), 2_000);             // 160 >= 0.6 * 250: not "below"
    expect(c.level).toBe(2);
  });

  it('a recent DB timeout holds level 2 and blocks recovery below it', () => {
    const c = make();
    run(c, [sig({ msSinceLastDbTimeout: 1_000 }), sig({ msSinceLastDbTimeout: 2_000 })]);
    expect(c.level).toBe(2);
    run(c, Array(25).fill(sig({ msSinceLastDbTimeout: 10_000 })), 2_000);
    expect(c.level).toBe(2);
    run(c, Array(40).fill(sig({ msSinceLastDbTimeout: 40_000 })), 27_000);
    expect(c.level).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && npx vitest run src/services/admission/admissionController.test.ts`
Expected: FAIL, module not found. 1 file.

- [ ] **Step 3: Implement `admissionController.ts`**

```ts
/**
 * W08 admission level state machine (spec W1c). Pure: no timers, no I/O.
 *
 * Levels: 0 normal, 1 shed bulk, 2 shed standard too, 3 critical (WS paced
 * hardest; protected traffic, heartbeats included, is never shed).
 *
 * Escalation: when the target level (max over the lag, DB pool-wait and
 * DB-timeout signals) is above the current one for ADMISSION_ESCALATE_TICKS
 * consecutive ticks, jump to the LOWEST target seen in that streak — a 2 then
 * a 3 lands on 2. An emergency (peak lag or oldest DB waiter >= emergencyMs)
 * jumps to 3 on the tick it is seen: by then latency is already lost.
 *
 * Recovery: one level down after ADMISSION_RECOVER_MS continuously below
 * ADMISSION_EXIT_RATIO x the current level's enter thresholds; the streak
 * restarts after each step. A DB timeout (pool-acquire or prologue) within ADMISSION_DB_TIMEOUT_FLOOR_MS
 * pins the target at 2 or higher at both scales, so it also blocks recovery.
 */
import {
  ADMISSION_ESCALATE_TICKS,
  ADMISSION_EXIT_RATIO,
  ADMISSION_DB_TIMEOUT_FLOOR_MS,
  ADMISSION_RECOVER_MS,
  type AdmissionConfig,
  type LevelThresholds,
} from './admissionConfig';
import type { AdmissionSignals } from './admissionSignals';

export type AdmissionLevel = 0 | 1 | 2 | 3;
export type AdmissionTrigger = 'none' | 'lag' | 'db' | 'db_timeout' | 'emergency';

export interface ControllerStep {
  level: AdmissionLevel;
  previous: AdmissionLevel;
  changed: boolean;
  trigger: AdmissionTrigger;
}

export function levelFor(value: number | null, thresholds: LevelThresholds, scale = 1): AdmissionLevel {
  if (value === null) return 0;
  if (value >= thresholds[2] * scale) return 3;
  if (value >= thresholds[1] * scale) return 2;
  if (value >= thresholds[0] * scale) return 1;
  return 0;
}

type ControllerConfig = Pick<AdmissionConfig, 'lagMs' | 'dbWaitMs' | 'emergencyMs'>;

function target(signals: AdmissionSignals, config: ControllerConfig, scale: number): { level: AdmissionLevel; trigger: AdmissionTrigger } {
  // DB first: pool wait is the direct cause of DB-bound request latency, so ties go to it.
  let level = levelFor(signals.dbWaitMs, config.dbWaitMs, scale);
  let trigger: AdmissionTrigger = level > 0 ? 'db' : 'none';
  const lag = levelFor(signals.lagMs, config.lagMs, scale);
  if (lag > level) {
    level = lag;
    trigger = 'lag';
  }
  const recentExpiry = signals.msSinceLastDbTimeout !== null
    && signals.msSinceLastDbTimeout < ADMISSION_DB_TIMEOUT_FLOOR_MS;
  if (recentExpiry && level < 2) {
    level = 2;
    trigger = 'db_timeout';
  }
  return { level, trigger };
}

export class AdmissionController {
  private current: AdmissionLevel = 0;
  private lastTrigger: AdmissionTrigger = 'none';
  private escalateStreak = 0;
  private streakMin: AdmissionLevel = 3;
  private belowSinceMs: number | null = null;

  constructor(private readonly config: ControllerConfig) {}

  get level(): AdmissionLevel {
    return this.current;
  }

  get trigger(): AdmissionTrigger {
    return this.lastTrigger;
  }

  step(signals: AdmissionSignals, nowMs: number): ControllerStep {
    const previous = this.current;

    const emergency = (signals.peakLagMs !== null && signals.peakLagMs >= this.config.emergencyMs)
      || signals.oldestDbWaitMs >= this.config.emergencyMs;
    if (emergency) {
      this.resetStreaks();
      if (this.current < 3) {
        this.current = 3;
        this.lastTrigger = 'emergency';
      }
      return this.result(previous);
    }

    const enter = target(signals, this.config, 1);
    if (enter.level > this.current) {
      this.belowSinceMs = null;
      this.escalateStreak += 1;
      this.streakMin = Math.min(this.streakMin, enter.level) as AdmissionLevel;
      if (this.escalateStreak >= ADMISSION_ESCALATE_TICKS) {
        this.current = this.streakMin;
        this.lastTrigger = enter.trigger;
        this.escalateStreak = 0;
        this.streakMin = 3;
      }
      return this.result(previous);
    }
    this.escalateStreak = 0;
    this.streakMin = 3;

    const exit = target(signals, this.config, ADMISSION_EXIT_RATIO);
    if (this.current === 0 || exit.level >= this.current) {
      this.belowSinceMs = null;
      return this.result(previous);
    }
    if (this.belowSinceMs === null) {
      this.belowSinceMs = nowMs;
      return this.result(previous);
    }
    if (nowMs - this.belowSinceMs >= ADMISSION_RECOVER_MS) {
      this.current = (this.current - 1) as AdmissionLevel;
      this.belowSinceMs = this.current > 0 ? nowMs : null;
      if (this.current === 0) this.lastTrigger = 'none';
    }
    return this.result(previous);
  }

  private resetStreaks(): void {
    this.escalateStreak = 0;
    this.streakMin = 3;
    this.belowSinceMs = null;
  }

  private result(previous: AdmissionLevel): ControllerStep {
    return { level: this.current, previous, changed: this.current !== previous, trigger: this.lastTrigger };
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd apps/api && npx vitest run src/services/admission/admissionController.test.ts`
Expected: PASS, 1 file. If the recovery-timing test is off by one tick, fix the **test's** tick arithmetic only after confirming the rule in the doc comment: the first tick below the exit thresholds starts the clock, and the step happens on the first tick at least 15 s later. Do not loosen the rule.

- [ ] **Step 5: Typecheck and commit**

```bash
cd apps/api && npx tsc --noEmit -p tsconfig.json; echo "tsc exit $?"
cd ../.. && git add apps/api/src/services/admission/admissionController.ts apps/api/src/services/admission/admissionController.test.ts
git commit -m "feat(api): admission level controller with hysteresis and emergency path (#8147)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 5: Route classes, classifier and completeness contract

**Files:**
- Create: `apps/api/src/services/admission/agentRouteClasses.ts`
- Create: `apps/api/src/services/admission/agentRouteClasses.test.ts`

**Interfaces:**
- Consumes: the real `agentRoutes` router (`apps/api/src/routes/agents/index.ts`), in the test only.
- Produces (used by Tasks 7 and 8):
  ```ts
  export type AdmissionClass = 'protected' | 'standard' | 'bulk' | 'ws_upgrade';
  export interface ClassifiedRequest { cls: AdmissionClass; key: string; label: string }
  export const AGENT_ROUTE_ADMISSION_CLASSES: Readonly<Record<string, Exclude<AdmissionClass, 'ws_upgrade'>>>;
  export const AGENT_WS_UPGRADE_ROUTE = '/api/v1/agent-ws/:id/ws';
  export const RETRY_AFTER_SECONDS: Readonly<Record<'bulk' | 'standard', readonly [number, number]>>;
  export const RETRY_AFTER_OVERRIDES: Readonly<Record<string, readonly [number, number]>>;
  export const WS_RETRY_AFTER_BOUNDS: readonly [number, number]; // [5, 120]
  export function classifyAgentRequest(method: string, path: string): ClassifiedRequest | null;
  export function retryAfterRange(req: ClassifiedRequest): readonly [number, number];
  ```

- [ ] **Step 1: Write the failing test**

```ts
/**
 * W08 — admission route classification completeness contract.
 *
 * Every endpoint on the core agent router must carry an explicit admission
 * class, so a new agent route cannot silently become sheddable (or silently
 * escape shedding). The list is read from the REAL Hono route table, as in
 * routes/agents/parkedRouteClassification.test.ts. HTTP only; the agent WS
 * upgrade is classified by path and pinned below.
 */
import { describe, expect, it } from 'vitest';
import { agentRoutes } from '../../routes/agents';
import {
  AGENT_ROUTE_ADMISSION_CLASSES,
  AGENT_WS_UPGRADE_ROUTE,
  RETRY_AFTER_OVERRIDES,
  classifyAgentRequest,
  retryAfterRange,
} from './agentRouteClasses';

const AGENT_ID = 'a'.repeat(64);
const UUID = '6f1c7a52-8d0e-4b8f-9a55-0f5a3d1c2b7e';
const MOUNT = '/api/v1/agents';
const MIN_ROUTE_COUNT = 64;

const table = [...new Set(agentRoutes.routes.map((route) => `${route.method} ${route.path}`))].sort();
const endpoints = table.filter((key) => !key.startsWith('ALL '));
const idScoped = endpoints.filter((key) => key.slice(key.indexOf(' ') + 1).startsWith('/:id/'));
const outside = endpoints.filter((key) => !idScoped.includes(key));

function materialise(key: string): { method: string; path: string } {
  const method = key.slice(0, key.indexOf(' '));
  const pattern = key.slice(key.indexOf(' ') + 1)
    .replace(':id', AGENT_ID)
    .replace(/:[A-Za-z]+/g, (param) => (param === ':name' || param === ':os' || param === ':arch' || param === ':op' ? 'x' : UUID));
  return { method, path: `${MOUNT}${pattern}` };
}

describe('agent route admission classes', () => {
  it('enumerates the real agent router', () => {
    expect(table.length).toBeGreaterThanOrEqual(MIN_ROUTE_COUNT);
    expect(idScoped).toContain('POST /:id/heartbeat');
  });

  it('classifies every /:id/ endpoint, and nothing that is not registered', () => {
    const unclassified = idScoped.filter((key) => !(key in AGENT_ROUTE_ADMISSION_CLASSES));
    const stale = Object.keys(AGENT_ROUTE_ADMISSION_CLASSES).filter((key) => !idScoped.includes(key));
    expect({ unclassified, stale }).toEqual({ unclassified: [], stale: [] });
  });

  it.each(idScoped)('%s classifies back to itself', (key) => {
    const { method, path } = materialise(key);
    expect(classifyAgentRequest(method, path)).toEqual({
      cls: AGENT_ROUTE_ADMISSION_CLASSES[key],
      key,
      label: `${MOUNT}${key.slice(key.indexOf(' ') + 1)}`,
    });
  });

  it.each(outside)('%s (outside /:id/) is never sheddable', (key) => {
    const { method, path } = materialise(key);
    const classified = classifyAgentRequest(method, path);
    expect(classified === null || classified.cls === 'protected').toBe(true);
  });

  it('never sheds heartbeats, recovery traffic or loss-sensitive uploads', () => {
    for (const key of [
      'POST /:id/heartbeat', 'GET /:id/commands', 'POST /:id/commands/:commandId/result',
      'POST /:id/rotate-token', 'POST /:id/rotate-token/confirm', 'POST /:id/uninstall-intent',
      'PUT /:id/eventlogs', 'POST /:id/elevation-requests',
    ]) {
      expect(AGENT_ROUTE_ADMISSION_CLASSES[key], key).toBe('protected');
    }
  });

  it('sheds inventory and collector uploads first', () => {
    for (const key of [
      'PUT /:id/hardware', 'PUT /:id/software', 'PUT /:id/disks', 'PUT /:id/network',
      'POST /:id/process-sample', 'POST /:id/logs', 'GET /:id/unifi-collectors',
    ]) {
      expect(AGENT_ROUTE_ADMISSION_CLASSES[key], key).toBe('bulk');
    }
  });

  it('keeps the log shipper Retry-After short: it sleeps without a context and Stop() waits on it', () => {
    // agent/internal/logging/shipper.go:571-575 + 188-193: two uncancellable
    // sleeps of Retry-After block shutdown. 4 s caps that at ~10 s.
    expect(RETRY_AFTER_OVERRIDES['POST /:id/logs']![1]).toBeLessThanOrEqual(4);
    expect(retryAfterRange(classifyAgentRequest('POST', `${MOUNT}/${AGENT_ID}/logs`)!)).toEqual([2, 4]);
  });

  it('every non-override Retry-After for httputil routes is >= 30 s (one attempt per agent cycle)', () => {
    for (const key of idScoped) {
      const req = classifyAgentRequest(materialise(key).method, materialise(key).path)!;
      if (req.cls === 'protected' || key in RETRY_AFTER_OVERRIDES) continue;
      expect(retryAfterRange(req)[0], key).toBeGreaterThanOrEqual(30);
    }
  });

  it('classifies the agent WS upgrade and nothing that merely resembles it', () => {
    expect(classifyAgentRequest('GET', `/api/v1/agent-ws/${AGENT_ID}/ws`)).toEqual({
      cls: 'ws_upgrade', key: 'GET /:id/ws', label: AGENT_WS_UPGRADE_ROUTE,
    });
    expect(classifyAgentRequest('POST', `/api/v1/agent-ws/${AGENT_ID}/ws`)).toBeNull();
    expect(classifyAgentRequest('GET', `/api/v1/agent-ws/${AGENT_ID}/ws/`)).toBeNull();
  });

  it('leaves odd and foreign paths unclassified (admitted; they 404 or route as today)', () => {
    for (const path of [
      `${MOUNT}/${AGENT_ID}/software/`,
      `${MOUNT}//${AGENT_ID}/software`,
      `${MOUNT}/${AGENT_ID}/no-such-action`,
      `/api/v1/ext/acme/agent/${AGENT_ID}/software`,
      `/api/v1/workspace/agent/crawl-config`,
      '/api/v1/devices',
    ]) {
      expect(classifyAgentRequest('PUT', path), path).toBeNull();
    }
  });

  it('labels by template, so attacker-chosen ids cannot mint label values (Review Focus 4)', () => {
    const a = classifyAgentRequest('PUT', `${MOUNT}/${'b'.repeat(64)}/software`);
    const b = classifyAgentRequest('PUT', `${MOUNT}/not-even-hex/software`);
    expect(a?.label).toBe(`${MOUNT}/:id/software`);
    expect(b?.label).toBe(a?.label);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && npx vitest run src/services/admission/agentRouteClasses.test.ts`
Expected: FAIL, module not found. 1 file.

- [ ] **Step 3: Implement `agentRouteClasses.ts`**

```ts
/**
 * W08 — which agent requests may be refused under load, and how.
 *
 * protected: never shed. Heartbeats (the agent's watchdog restarts it after
 *   3 min without a 200 — agent/internal/config/config.go:391), recovery
 *   (commands, results, token rotation, uninstall), loss-sensitive uploads
 *   (eventlogs: the collector cursor advances at collect, so a failed send is
 *   lost for good), interactive or in-progress work (elevation, backup storage
 *   sessions, winget bootstrap) and user-JWT admin routes.
 * standard: shed at level 2+. Periodic status; the agent drops, requeues or
 *   resends next cycle (monitoring-results gaps are an accepted loss).
 * bulk: shed at level 1+, and capped in flight at every level in enforce mode.
 *   Inventory snapshots, samples, logs and UniFi traffic.
 *
 * Keys are `METHOD /pattern` exactly as the core agent router registers them;
 * agentRouteClasses.test.ts fails on any registered `/:id/` endpoint missing
 * here, and on any entry here that is not registered. Routes OUTSIDE `/:id/`
 * (enroll, renew-cert, downloads, org settings) and other agent mounts
 * (extension gateway, ee/workspace crawl-config) are not classified and are
 * never shed in W08.
 */
export type AdmissionClass = 'protected' | 'standard' | 'bulk' | 'ws_upgrade';
type RouteClass = Exclude<AdmissionClass, 'ws_upgrade'>;

export interface ClassifiedRequest {
  cls: AdmissionClass;
  /** `METHOD /:id/...` key from the table (or `GET /:id/ws`). */
  key: string;
  /** Route template used as the metrics/log label. Never contains request data. */
  label: string;
}

export const AGENT_ROUTE_ADMISSION_CLASSES: Readonly<Record<string, RouteClass>> = Object.freeze({
  // protected
  'POST /:id/heartbeat': 'protected',
  'GET /:id/commands': 'protected',
  'POST /:id/commands/:commandId/result': 'protected',
  'POST /:id/commands/:commandId/pam-observations': 'protected',
  'POST /:id/pam/reconciliation-bindings': 'protected',
  'POST /:id/rotate-token': 'protected',
  'POST /:id/rotate-token/confirm': 'protected',
  'POST /:id/uninstall-intent': 'protected',
  'POST /:id/elevation-requests': 'protected',
  'PUT /:id/eventlogs': 'protected',
  'GET /:id/winget-bootstrap/manifest': 'protected',
  'GET /:id/winget-bootstrap/file/:name': 'protected',
  'POST /:id/storage-sessions/:sessionId/:op': 'protected',
  'GET /:id/storage-sessions/:sessionId/object': 'protected',
  'POST /:id/approve': 'protected',
  'POST /:id/deny': 'protected',
  // standard
  'GET /:id/config': 'standard',
  'PUT /:id/monitoring-results': 'standard',
  'PUT /:id/security/status': 'standard',
  'PUT /:id/management/posture': 'standard',
  'PUT /:id/security/recovery-keys': 'standard',
  'PUT /:id/sessions': 'standard',
  'PUT /:id/changes': 'standard',
  'PUT /:id/patches': 'standard',
  'PUT /:id/patches/pending': 'standard',
  'PUT /:id/patches/installed': 'standard',
  'PUT /:id/hardware-health': 'standard',
  'PUT /:id/time-status': 'standard',
  'PUT /:id/peripherals/events': 'standard',
  'POST /:id/boot-performance': 'standard',
  'POST /:id/reliability': 'standard',
  'POST /:id/topology/adjacency': 'standard',
  // bulk
  'PUT /:id/hardware': 'bulk',
  'PUT /:id/software': 'bulk',
  'PUT /:id/disks': 'bulk',
  'PUT /:id/network': 'bulk',
  'PUT /:id/connections': 'bulk',
  'PUT /:id/warranty-info': 'bulk',
  'PUT /:id/registry-state': 'bulk',
  'PUT /:id/config-state': 'bulk',
  'POST /:id/process-sample': 'bulk',
  'POST /:id/logs': 'bulk',
  'GET /:id/unifi-collectors': 'bulk',
  'POST /:id/unifi-telemetry': 'bulk',
});

export const AGENT_WS_UPGRADE_ROUTE = '/api/v1/agent-ws/:id/ws';
const AGENT_ROUTE_MOUNT = '/api/v1/agents';

/**
 * Retry-After ranges (seconds), jittered uniformly per response. For shipped
 * agents any value >= 30 means "one attempt this cycle" (httputil callers run
 * under a 15-30 s context); the ranges are the deferral W09 agents will honour
 * at loop level.
 */
export const RETRY_AFTER_SECONDS: Readonly<Record<'bulk' | 'standard', readonly [number, number]>> = Object.freeze({
  bulk: [120, 180] as const,
  standard: [60, 90] as const,
});

export const RETRY_AFTER_OVERRIDES: Readonly<Record<string, readonly [number, number]>> = Object.freeze({
  // The log shipper sleeps Retry-After with no context and Stop() waits for it
  // (agent/internal/logging/shipper.go:188-193, 571-575): keep it short.
  'POST /:id/logs': [2, 4] as const,
  // Raw Do, no retry, 30 s cadence: the value only matters to W09 agents.
  'GET /:id/unifi-collectors': [30, 45] as const,
});

export const WS_RETRY_AFTER_BOUNDS = [5, 120] as const;

interface Template {
  method: string;
  tail: readonly string[];
  key: string;
  cls: RouteClass;
  label: string;
}

const TEMPLATES: readonly Template[] = Object.entries(AGENT_ROUTE_ADMISSION_CLASSES).map(([key, cls]) => {
  const space = key.indexOf(' ');
  const pattern = key.slice(space + 1);
  return {
    method: key.slice(0, space),
    tail: pattern.split('/').slice(2),
    key,
    cls,
    label: `${AGENT_ROUTE_MOUNT}${pattern}`,
  };
});

/**
 * O(table) with no allocation beyond one split: runs on every request before
 * anything else. Exact shapes only — an empty segment (trailing or doubled
 * slash) or an unknown action returns null, which the middleware admits.
 */
export function classifyAgentRequest(method: string, path: string): ClassifiedRequest | null {
  const segments = path.split('/');
  if (segments.length < 6 || segments[0] !== '' || segments[1] !== 'api' || segments[2] !== 'v1') return null;
  for (let i = 1; i < segments.length; i += 1) {
    if (segments[i]!.length === 0) return null;
  }
  if (segments[3] === 'agent-ws') {
    return method === 'GET' && segments.length === 6 && segments[5] === 'ws'
      ? { cls: 'ws_upgrade', key: 'GET /:id/ws', label: AGENT_WS_UPGRADE_ROUTE }
      : null;
  }
  if (segments[3] !== 'agents') return null;
  const tail = segments.slice(5);
  for (const template of TEMPLATES) {
    if (template.method !== method || template.tail.length !== tail.length) continue;
    let match = true;
    for (let i = 0; i < tail.length; i += 1) {
      const expected = template.tail[i]!;
      if (!expected.startsWith(':') && expected !== tail[i]) {
        match = false;
        break;
      }
    }
    if (match) return { cls: template.cls, key: template.key, label: template.label };
  }
  return null;
}

export function retryAfterRange(req: ClassifiedRequest): readonly [number, number] {
  const override = RETRY_AFTER_OVERRIDES[req.key];
  if (override) return override;
  if (req.cls === 'bulk' || req.cls === 'standard') return RETRY_AFTER_SECONDS[req.cls];
  return WS_RETRY_AFTER_BOUNDS;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd apps/api && npx vitest run src/services/admission/agentRouteClasses.test.ts`
Expected: PASS, 1 file. If "classifies every /:id/ endpoint" lists an endpoint that is not in the table above (a route added since this plan was written), classify it, pick the class from that route's agent-side failure behaviour, and note the choice in the PR body. Never default it to `bulk`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/admission/agentRouteClasses.ts apps/api/src/services/admission/agentRouteClasses.test.ts
git commit -m "feat(api): agent route admission classes with completeness contract (#8147)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: WS upgrade gate (token bucket and setup slots)

**Files:**
- Create: `apps/api/src/services/admission/wsUpgradeGate.ts`
- Create: `apps/api/src/services/admission/wsUpgradeGate.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces (used by Tasks 7, 8 and 9):
  ```ts
  export class TokenBucket {
    constructor(ratePerSec: number, burst: number, now?: () => number);
    tryTake(scale: number): boolean;          // scale in (0, 1]: refill = rate x scale, capacity = max(1, burst x scale)
    available(scale: number): number;
  }
  export interface WsSetupSlot { release(): void }
  export class SetupSlots {
    constructor(max: number, holdLimitMs?: number);   // default 30_000
    readonly inFlight: number;
    tryAcquire(): WsSetupSlot | null;
  }
  ```

- [ ] **Step 1: Write the failing test**

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SetupSlots, TokenBucket } from './wsUpgradeGate';

describe('TokenBucket', () => {
  it('starts full, refills at rate x scale, and caps at burst x scale', () => {
    let nowMs = 0;
    const bucket = new TokenBucket(10, 20, () => nowMs);
    for (let i = 0; i < 20; i += 1) expect(bucket.tryTake(1)).toBe(true);
    expect(bucket.tryTake(1)).toBe(false);
    nowMs += 100;                                   // 10/s x 0.1 s = 1 token
    expect(bucket.tryTake(1)).toBe(true);
    expect(bucket.tryTake(1)).toBe(false);
    nowMs += 10_000;
    expect(bucket.available(1)).toBe(20);
  });

  it('clamps accumulated tokens when the level drops the scale', () => {
    let nowMs = 0;
    const bucket = new TokenBucket(10, 20, () => nowMs);
    expect(bucket.available(0.05)).toBe(1);         // 20 x 0.05 = 1: no stored burst survives a level change
    expect(bucket.tryTake(0.05)).toBe(true);
    expect(bucket.tryTake(0.05)).toBe(false);
    nowMs += 1_000;                                 // 10 x 0.05 = 0.5 tokens/s
    expect(bucket.tryTake(0.05)).toBe(false);
    nowMs += 1_000;
    expect(bucket.tryTake(0.05)).toBe(true);
  });
});

describe('SetupSlots', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('admits up to max, frees on release, and release is idempotent', () => {
    const slots = new SetupSlots(2);
    const a = slots.tryAcquire();
    const b = slots.tryAcquire();
    expect(slots.tryAcquire()).toBeNull();
    a!.release();
    a!.release();
    expect(slots.inFlight).toBe(1);
    expect(slots.tryAcquire()).not.toBeNull();
    b!.release();
  });

  it('frees a slot nobody released after the hold limit', () => {
    const slots = new SetupSlots(1, 30_000);
    slots.tryAcquire();
    expect(slots.tryAcquire()).toBeNull();
    vi.advanceTimersByTime(30_000);
    expect(slots.inFlight).toBe(0);
    expect(slots.tryAcquire()).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && npx vitest run src/services/admission/wsUpgradeGate.test.ts`
Expected: FAIL, module not found. 1 file.

- [ ] **Step 3: Implement `wsUpgradeGate.ts`**

```ts
/**
 * W08 — per-instance pacing for agent WebSocket upgrades.
 *
 * TokenBucket bounds the accept RATE; SetupSlots bounds how many upgrades are
 * between admission and the end of `onOpen` at once (auth transaction,
 * markOnline, device load, presence lease — routes/agentWs.ts). A burst of
 * rate-admitted upgrades can otherwise start more transactions than the pool
 * has slots before the level controller reacts.
 *
 * Both are process-local by design: each API instance protects its own loop
 * and pool (spec W1c "per instance").
 */
export class TokenBucket {
  private tokens: number;
  private lastMs: number;

  constructor(
    private readonly ratePerSec: number,
    private readonly burst: number,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.tokens = burst;
    this.lastMs = now();
  }

  /** Refill, clamp to the scaled capacity, then take one token if available. */
  tryTake(scale: number): boolean {
    this.refill(scale);
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  available(scale: number): number {
    this.refill(scale);
    return this.tokens;
  }

  private refill(scale: number): void {
    const nowMs = this.now();
    const capacity = Math.max(1, this.burst * scale);
    this.tokens = Math.min(capacity, this.tokens + ((nowMs - this.lastMs) / 1000) * this.ratePerSec * scale);
    this.lastMs = nowMs;
  }
}

export interface WsSetupSlot {
  release(): void;
}

export class SetupSlots {
  private count = 0;

  constructor(
    private readonly max: number,
    private readonly holdLimitMs = 30_000,
  ) {}

  get inFlight(): number {
    return this.count;
  }

  tryAcquire(): WsSetupSlot | null {
    if (this.count >= this.max) return null;
    this.count += 1;
    let released = false;
    // Backstop: a slot handed to WS handlers that never run (no upgrade
    // header, socket died before open) must not be lost forever.
    const timer = setTimeout(() => slot.release(), this.holdLimitMs);
    timer.unref?.();
    const slot: WsSetupSlot = {
      release: () => {
        if (released) return;
        released = true;
        clearTimeout(timer);
        this.count -= 1;
      },
    };
    return slot;
  }
}
```

> `performance` is a Node global. Add `import { performance } from 'node:perf_hooks';` if the repo's lint rules require explicit imports for globals.

- [ ] **Step 4: Run it to verify it passes**

Run: `cd apps/api && npx vitest run src/services/admission/wsUpgradeGate.test.ts`
Expected: PASS, 1 file.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/admission/wsUpgradeGate.ts apps/api/src/services/admission/wsUpgradeGate.test.ts
git commit -m "feat(api): per-instance agent WS upgrade bucket and setup slots (#8147)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 7: Metrics and the admission runtime

**Files:**
- Create: `apps/api/src/services/admission/admissionMetrics.ts`
- Create: `apps/api/src/services/admission/admissionRuntime.ts`
- Create: `apps/api/src/services/admission/admissionRuntime.test.ts`
- Modify: `apps/docs/src/content/docs/monitoring/stack.mdx`. Add an `### Admission Metrics` subsection after `### Event-Loop Metrics`.

**Interfaces:**
- Consumes: Task 1 `PoolSignals` (via `AdmissionSignals.pool`); Task 2 `createSignalSampler`, `AdmissionSignals`, `SignalSampler`; Task 3 config; Task 4 `AdmissionController`, `AdmissionLevel`, `ControllerStep`; Task 5 `ClassifiedRequest`, `retryAfterRange`, `WS_RETRY_AFTER_BOUNDS`; Task 6 `TokenBucket`, `SetupSlots`, `WsSetupSlot`.
- Produces (used by Tasks 8, 9 and 10):
  ```ts
  // admissionMetrics.ts
  export type ShedReason = 'level' | 'bulk_in_flight' | 'ws_bucket' | 'ws_setups';
  export function recordAdmissionDecision(cls: string, route: string, outcome: 'shed' | 'would_shed', reason: ShedReason): void;
  export function recordAdmissionTransition(from: number, to: number, trigger: string): void;
  export function recordOfflineDeferred(event: 'close' | 'error'): void;
  export function publishAdmissionTick(input: AdmissionTickSnapshot): void;
  // admissionRuntime.ts
  export type AdmissionDecision =
    | { action: 'admit'; release?: () => void; wsSlot?: WsSetupSlot }
    | { action: 'shed'; reason: ShedReason; retryAfterSec: number };
  export interface AdmissionGate { readonly mode: AdmissionMode; decide(req: ClassifiedRequest): AdmissionDecision }
  export class AdmissionRuntime implements AdmissionGate {
    constructor(config: AdmissionConfig, deps?: AdmissionRuntimeDeps);
    readonly mode: AdmissionMode; readonly level: AdmissionLevel;
    start(tickMs?: number): void; stop(): void; tick(): ControllerStep;
    decide(req: ClassifiedRequest): AdmissionDecision;
    shouldDeferOfflineTransition(): boolean;
  }
  export function getAdmissionRuntime(): AdmissionRuntime | null;
  export function startAdmissionControl(env?: NodeJS.ProcessEnv): AdmissionRuntime;
  export function stopAdmissionControl(): void;
  export function shouldDeferOfflineTransition(): boolean;
  export function __setAdmissionRuntimeForTests(next: AdmissionRuntime | null): void;
  ```

- [ ] **Step 1: Write the failing test**

`apps/api/src/services/admission/admissionRuntime.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { metricsRegistry } from '../metricsRegistry';
import { ADMISSION_DEFAULTS, type AdmissionConfig } from './admissionConfig';
import type { AdmissionSignals } from './admissionSignals';
import {
  AdmissionRuntime,
  __setAdmissionRuntimeForTests,
  shouldDeferOfflineTransition,
} from './admissionRuntime';
import { classifyAgentRequest } from './agentRouteClasses';

const AGENT = 'a'.repeat(64);
const SOFTWARE = classifyAgentRequest('PUT', `/api/v1/agents/${AGENT}/software`)!;
const STATUS = classifyAgentRequest('PUT', `/api/v1/agents/${AGENT}/security/status`)!;
const HEARTBEAT = classifyAgentRequest('POST', `/api/v1/agents/${AGENT}/heartbeat`)!;
const EVENTLOGS = classifyAgentRequest('PUT', `/api/v1/agents/${AGENT}/eventlogs`)!;
const LOGS = classifyAgentRequest('POST', `/api/v1/agents/${AGENT}/logs`)!;
const WS = classifyAgentRequest('GET', `/api/v1/agent-ws/${AGENT}/ws`)!;

const quiet: AdmissionSignals = {
  lagMs: 20, peakLagMs: 25, dbWaitMs: 2, oldestDbWaitMs: 0, msSinceLastDbTimeout: null, eluRatio: 0.3,
  pool: { available: true, inUse: 1, waiting: 0, effectivePermits: 30, oldestWaitMs: 0, grantWaitP95Ms: 2, dbTimeoutsTotal: 0 },
};

function make(over: Partial<AdmissionConfig> = {}, random: () => number = () => 0) {
  let signals = quiet;
  let nowMs = 0;
  const lines: string[] = [];
  const rt = new AdmissionRuntime({ ...ADMISSION_DEFAULTS, mode: 'enforce', ...over }, {
    sampler: { sample: () => signals },
    now: () => nowMs,
    random,
    log: (line) => lines.push(line),
  });
  const raiseTo = (level: 1 | 2 | 3) => {
    signals = { ...quiet, lagMs: [0, 150, 300, 700][level]! };
    nowMs += 1_000; rt.tick();
    nowMs += 1_000; rt.tick();
    expect(rt.level).toBe(level);
  };
  return { rt, lines, raiseTo, advance: (ms: number) => { nowMs += ms; } };
}

async function count(name: string, labels: Record<string, string>): Promise<number> {
  const metric = metricsRegistry.getSingleMetric(name);
  if (!metric) return 0;
  const { values } = await metric.get();
  return values
    .filter((v) => Object.entries(labels).every(([k, val]) => v.labels[k] === val))
    .reduce((sum, v) => sum + v.value, 0);
}

afterEach(() => __setAdmissionRuntimeForTests(null));

describe('AdmissionRuntime.decide (enforce)', () => {
  it('admits bulk at level 0 up to the in-flight cap, then refuses with a bulk Retry-After', () => {
    const { rt } = make({ bulkMaxInFlight: 2 });
    const a = rt.decide(SOFTWARE);
    const b = rt.decide(SOFTWARE);
    expect(a).toMatchObject({ action: 'admit' });
    expect(b).toMatchObject({ action: 'admit' });
    expect(rt.decide(SOFTWARE)).toEqual({ action: 'shed', reason: 'bulk_in_flight', retryAfterSec: 120 });
    (a as { release: () => void }).release();
    (a as { release: () => void }).release(); // idempotent
    expect(rt.decide(SOFTWARE)).toMatchObject({ action: 'admit' });
  });

  it('level 1 sheds bulk only; heartbeat and eventlogs are never shed, even at level 3', () => {
    const { rt, raiseTo } = make();
    raiseTo(1);
    expect(rt.decide(SOFTWARE)).toMatchObject({ action: 'shed', reason: 'level', retryAfterSec: 120 });
    expect(rt.decide(STATUS)).toMatchObject({ action: 'admit' });
    raiseTo(2);
    expect(rt.decide(STATUS)).toMatchObject({ action: 'shed', reason: 'level', retryAfterSec: 60 });
    raiseTo(3);
    expect(rt.decide(HEARTBEAT)).toEqual({ action: 'admit' });
    expect(rt.decide(EVENTLOGS)).toEqual({ action: 'admit' });
  });

  it('jitters Retry-After inside the class range and uses the logs override', () => {
    const high = make({}, () => 0.999);
    high.raiseTo(1);
    expect(high.rt.decide(SOFTWARE)).toMatchObject({ retryAfterSec: 180 });
    expect(high.rt.decide(LOGS)).toMatchObject({ retryAfterSec: 4 });
    const low = make();
    low.raiseTo(1);
    expect(low.rt.decide(LOGS)).toMatchObject({ retryAfterSec: 2 });
  });

  it('WS: setup slots cap concurrent upgrades; released slots are reusable', () => {
    const { rt } = make({ wsMaxSetups: 2, wsBurst: 100 });
    const first = rt.decide(WS);
    const second = rt.decide(WS);
    expect(first).toMatchObject({ action: 'admit' });
    expect((first as { wsSlot?: unknown }).wsSlot).toBeDefined();
    expect(rt.decide(WS)).toMatchObject({ action: 'shed', reason: 'ws_setups' });
    (first as { wsSlot: { release(): void } }).wsSlot.release();
    expect(rt.decide(WS)).toMatchObject({ action: 'admit' });
    (second as { wsSlot: { release(): void } }).wsSlot.release();
  });

  it('WS: the bucket refuses past the burst with a Retry-After inside 5..120 s', () => {
    const { rt } = make({ wsBurst: 3, wsMaxSetups: 100 });
    for (let i = 0; i < 3; i += 1) {
      const d = rt.decide(WS);
      expect(d.action).toBe('admit');
      (d as { wsSlot: { release(): void } }).wsSlot.release();
    }
    const refused = rt.decide(WS);
    expect(refused).toMatchObject({ action: 'shed', reason: 'ws_bucket' });
    const ra = (refused as { retryAfterSec: number }).retryAfterSec;
    expect(ra).toBeGreaterThanOrEqual(5);
    expect(ra).toBeLessThanOrEqual(120);
  });

  it('counts sheds per class, route template and reason', async () => {
    const { rt, raiseTo } = make();
    raiseTo(1);
    const before = await count('breeze_admission_decisions_total', { class: 'bulk', route: '/api/v1/agents/:id/software', outcome: 'shed', reason: 'level' });
    rt.decide(SOFTWARE);
    expect(await count('breeze_admission_decisions_total', { class: 'bulk', route: '/api/v1/agents/:id/software', outcome: 'shed', reason: 'level' })).toBe(before + 1);
  });
});

describe('AdmissionRuntime modes', () => {
  it('observe never refuses anything, including an empty WS bucket, and counts would_shed (Review Focus 5)', async () => {
    const { rt, raiseTo } = make({ mode: 'observe', wsBurst: 1, wsMaxSetups: 1 });
    raiseTo(3);
    const before = await count('breeze_admission_decisions_total', { outcome: 'would_shed' });
    for (const req of [SOFTWARE, STATUS, HEARTBEAT, WS, WS, WS]) {
      expect(rt.decide(req).action).toBe('admit');
    }
    expect(await count('breeze_admission_decisions_total', { outcome: 'would_shed' })).toBeGreaterThan(before);
    expect(rt.shouldDeferOfflineTransition()).toBe(false);
  });

  it('off admits everything, consumes no WS slot, and still ticks', () => {
    const { rt, raiseTo } = make({ mode: 'off', wsMaxSetups: 1 });
    raiseTo(2);
    expect(rt.decide(SOFTWARE)).toEqual({ action: 'admit' });
    expect(rt.decide(WS)).toEqual({ action: 'admit' });
    expect(rt.decide(WS)).toEqual({ action: 'admit' });
  });
});

describe('AdmissionRuntime tick and process helpers', () => {
  it('logs each transition with its trigger and the signals behind it', () => {
    const { lines, raiseTo } = make();
    raiseTo(2);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[admission\] level 0 -> 2 \(trigger=lag, mode=enforce, lag=300ms/);
  });

  it('defers offline transitions only when enforcing at level 1+', () => {
    const { rt, raiseTo } = make();
    __setAdmissionRuntimeForTests(rt);
    expect(shouldDeferOfflineTransition()).toBe(false);
    raiseTo(1);
    expect(shouldDeferOfflineTransition()).toBe(true);
    __setAdmissionRuntimeForTests(null);
    expect(shouldDeferOfflineTransition()).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && npx vitest run src/services/admission/admissionRuntime.test.ts`
Expected: FAIL, module not found. 1 file.

- [ ] **Step 3: Implement `admissionMetrics.ts`**

```ts
/**
 * W08 admission-control Prometheus series. Leaf: `prom-client` + the shared
 * registry (and type-only imports). Labels are closed sets — `route` is a
 * template from agentRouteClasses, never request data.
 *
 * No pool gauges here: W04 owns `breeze_db_pool_admission_*` (in-use, waiting,
 * abandoned, effective permits, acquire timeouts). This module publishes only
 * what the admission controller itself decided and the signal values it used.
 */
import { Counter, Gauge } from 'prom-client';
import { metricsRegistry } from '../metricsRegistry';
import type { AdmissionMode } from './admissionConfig';
import type { AdmissionSignals } from './admissionSignals';

export type ShedReason = 'level' | 'bulk_in_flight' | 'ws_bucket' | 'ws_setups';

function counter<L extends string>(name: string, help: string, labelNames: L[]): Counter<L> {
  return (metricsRegistry.getSingleMetric(name) as Counter<L> | undefined)
    ?? new Counter<L>({ name, help, labelNames, registers: [metricsRegistry] });
}

function gauge<L extends string>(name: string, help: string, labelNames: L[] = []): Gauge<L> {
  return (metricsRegistry.getSingleMetric(name) as Gauge<L> | undefined)
    ?? new Gauge<L>({ name, help, labelNames, registers: [metricsRegistry] });
}

const decisions = counter(
  'breeze_admission_decisions_total',
  'Agent requests refused by admission control (shed), or that would have been in observe mode (would_shed)',
  ['class', 'route', 'outcome', 'reason'],
);
const transitions = counter('breeze_admission_transitions_total', 'Admission level changes', ['from', 'to', 'trigger']);
const offlineDeferred = counter(
  'breeze_admission_offline_deferred_total',
  'Agent WS closes/errors whose immediate offline write was left to the offline detector because admission was at level 1+',
  ['event'],
);
const level = gauge('breeze_admission_level', 'Current admission level: 0 normal, 1 shed bulk, 2 shed standard, 3 critical');
const mode = gauge('breeze_admission_mode', '1 for the active admission mode', ['mode']);
const lagSignal = gauge('breeze_admission_signal_lag_seconds', 'Median event-loop lag the controller used (-1 = monitor not running)');
const dbSignal = gauge('breeze_admission_signal_db_wait_seconds', 'DB pool wait the controller used (max of grant-wait p95 and oldest waiter, from the W04 gate)');
const elu = gauge('breeze_nodejs_eventloop_utilization', 'Event-loop utilization over the last admission tick (0..1)');
const wsTokens = gauge('breeze_admission_ws_bucket_tokens', 'Agent WS upgrade tokens available at the current level');
const wsSetups = gauge('breeze_admission_ws_setups_in_flight', 'Agent WS upgrades between admission and the end of onOpen');
const bulkInFlight = gauge('breeze_admission_bulk_in_flight', 'Bulk-class agent requests admitted and not yet finished');

const MODES: AdmissionMode[] = ['off', 'observe', 'enforce'];
level.set(0);

export function recordAdmissionDecision(cls: string, route: string, outcome: 'shed' | 'would_shed', reason: ShedReason): void {
  decisions.labels(cls, route, outcome, reason).inc();
}

export function recordAdmissionTransition(from: number, to: number, trigger: string): void {
  transitions.labels(String(from), String(to), trigger).inc();
}

export function recordOfflineDeferred(event: 'close' | 'error'): void {
  offlineDeferred.labels(event).inc();
}

export interface AdmissionTickSnapshot {
  mode: AdmissionMode;
  level: number;
  signals: AdmissionSignals;
  wsTokens: number;
  wsSetupsInFlight: number;
  bulkInFlight: number;
}

export function publishAdmissionTick(input: AdmissionTickSnapshot): void {
  for (const m of MODES) mode.labels(m).set(m === input.mode ? 1 : 0);
  level.set(input.level);
  lagSignal.set(input.signals.lagMs === null ? -1 : input.signals.lagMs / 1000);
  dbSignal.set(input.signals.dbWaitMs / 1000);
  elu.set(input.signals.eluRatio);
  wsTokens.set(input.wsTokens);
  wsSetups.set(input.wsSetupsInFlight);
  bulkInFlight.set(input.bulkInFlight);
}
```

- [ ] **Step 4: Implement `admissionRuntime.ts`**

```ts
/**
 * W08 admission runtime: one per API process (api/all roles; never started by
 * worker.ts). A 1 s unref'd tick samples the signals, steps the controller and
 * publishes metrics; `decide()` runs per request and does no I/O.
 *
 * Mode semantics:
 *   off      — decide() admits everything without classifying cost; the tick
 *              still publishes signal gauges, so `off` is a safe kill switch
 *              that keeps the evidence.
 *   observe  — everything is computed, including WS bucket consumption, and
 *              `would_shed` is counted; nothing is ever refused.
 *   enforce  — refusals are returned to the middleware.
 */
import { performance } from 'node:perf_hooks';
import {
  ADMISSION_TICK_MS,
  ADMISSION_WS_LEVEL_SCALE,
  resolveAdmissionConfig,
  type AdmissionConfig,
  type AdmissionMode,
} from './admissionConfig';
import { AdmissionController, type AdmissionLevel, type ControllerStep } from './admissionController';
import { createSignalSampler, type AdmissionSignals, type SignalSampler } from './admissionSignals';
import { retryAfterRange, WS_RETRY_AFTER_BOUNDS, type ClassifiedRequest } from './agentRouteClasses';
import { SetupSlots, TokenBucket, type WsSetupSlot } from './wsUpgradeGate';
import {
  publishAdmissionTick,
  recordAdmissionDecision,
  recordAdmissionTransition,
  type ShedReason,
} from './admissionMetrics';

export type AdmissionDecision =
  | { action: 'admit'; release?: () => void; wsSlot?: WsSetupSlot }
  | { action: 'shed'; reason: ShedReason; retryAfterSec: number };

export interface AdmissionGate {
  readonly mode: AdmissionMode;
  decide(req: ClassifiedRequest): AdmissionDecision;
}

export interface AdmissionRuntimeDeps {
  sampler?: SignalSampler;
  now?: () => number;
  random?: () => number;
  log?: (line: string) => void;
}

const WS_REFUSAL_WINDOW_MS = 10_000;

function ms(value: number | null): string {
  return value === null ? 'unknown' : `${Math.round(value)}`;
}

export class AdmissionRuntime implements AdmissionGate {
  readonly mode: AdmissionMode;
  private readonly controller: AdmissionController;
  private readonly sampler: SignalSampler;
  private readonly bucket: TokenBucket;
  private readonly setups: SetupSlots;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly log: (line: string) => void;
  private bulkInFlight = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private wsRefusals: { windowStartMs: number; current: number; previous: number };

  constructor(readonly config: AdmissionConfig, deps: AdmissionRuntimeDeps = {}) {
    this.mode = config.mode;
    this.controller = new AdmissionController(config);
    this.sampler = deps.sampler ?? createSignalSampler();
    this.now = deps.now ?? (() => performance.now());
    this.random = deps.random ?? Math.random;
    this.log = deps.log ?? ((line) => console.warn(line));
    this.bucket = new TokenBucket(config.wsRatePerSec, config.wsBurst, this.now);
    this.setups = new SetupSlots(config.wsMaxSetups);
    this.wsRefusals = { windowStartMs: this.now(), current: 0, previous: 0 };
  }

  get level(): AdmissionLevel {
    return this.controller.level;
  }

  start(tickMs: number = ADMISSION_TICK_MS): void {
    if (this.timer) return;
    const timer = setInterval(() => {
      try {
        this.tick();
      } catch (err) {
        // A broken tick must never take the process down; the level simply stops moving.
        console.error('[admission] tick failed:', err);
      }
    }, tickMs);
    timer.unref?.();
    this.timer = timer;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  tick(): ControllerStep {
    const signals = this.sampler.sample();
    const step = this.controller.step(signals, this.now());
    if (step.changed) {
      recordAdmissionTransition(step.previous, step.level, step.trigger);
      this.log(this.describeTransition(step, signals));
    }
    publishAdmissionTick({
      mode: this.mode,
      level: step.level,
      signals,
      wsTokens: this.bucket.available(ADMISSION_WS_LEVEL_SCALE[step.level]),
      wsSetupsInFlight: this.setups.inFlight,
      bulkInFlight: this.bulkInFlight,
    });
    return step;
  }

  decide(req: ClassifiedRequest): AdmissionDecision {
    if (this.mode === 'off' || req.cls === 'protected') return { action: 'admit' };
    const level = this.controller.level;
    let reason: ShedReason | null = null;
    let release: (() => void) | undefined;
    let wsSlot: WsSetupSlot | undefined;

    if (req.cls === 'bulk') {
      if (level >= 1) reason = 'level';
      else if (this.mode === 'enforce' && this.bulkInFlight >= this.config.bulkMaxInFlight) reason = 'bulk_in_flight';
      else {
        this.bulkInFlight += 1;
        let done = false;
        release = () => {
          if (done) return;
          done = true;
          this.bulkInFlight -= 1;
        };
      }
    } else if (req.cls === 'standard') {
      if (level >= 2) reason = 'level';
    } else {
      const slot = this.setups.tryAcquire();
      if (slot === null) reason = 'ws_setups';
      else if (!this.bucket.tryTake(ADMISSION_WS_LEVEL_SCALE[level])) {
        slot.release();
        reason = 'ws_bucket';
      } else wsSlot = slot;
      if (reason !== null) this.noteWsRefusal();
    }

    if (reason === null) return { action: 'admit', release, wsSlot };
    recordAdmissionDecision(req.cls, req.label, this.mode === 'enforce' ? 'shed' : 'would_shed', reason);
    if (this.mode !== 'enforce') return { action: 'admit' };
    return { action: 'shed', reason, retryAfterSec: this.retryAfterSeconds(req) };
  }

  shouldDeferOfflineTransition(): boolean {
    return this.mode === 'enforce' && this.controller.level >= 1;
  }

  private retryAfterSeconds(req: ClassifiedRequest): number {
    if (req.cls === 'ws_upgrade') {
      const rate = Math.max(0.01, this.config.wsRatePerSec * ADMISSION_WS_LEVEL_SCALE[this.controller.level]);
      const backlog = this.wsRefusals.current + this.wsRefusals.previous;
      const lo = Math.min(WS_RETRY_AFTER_BOUNDS[1], Math.max(WS_RETRY_AFTER_BOUNDS[0], Math.ceil(backlog / rate)));
      const hi = Math.min(WS_RETRY_AFTER_BOUNDS[1], Math.ceil(lo * 1.3));
      return this.pick(lo, hi);
    }
    const [lo, hi] = retryAfterRange(req);
    return this.pick(lo, hi);
  }

  private pick(lo: number, hi: number): number {
    return lo + Math.floor(this.random() * (hi - lo + 1));
  }

  private noteWsRefusal(): void {
    const nowMs = this.now();
    const elapsed = nowMs - this.wsRefusals.windowStartMs;
    if (elapsed >= 2 * WS_REFUSAL_WINDOW_MS) this.wsRefusals = { windowStartMs: nowMs, current: 0, previous: 0 };
    else if (elapsed >= WS_REFUSAL_WINDOW_MS) {
      this.wsRefusals = { windowStartMs: nowMs, current: 0, previous: this.wsRefusals.current };
    }
    this.wsRefusals.current += 1;
  }

  private describeTransition(step: ControllerStep, s: AdmissionSignals): string {
    return `[admission] level ${step.previous} -> ${step.level} (trigger=${step.trigger}, mode=${this.mode}, `
      + `lag=${ms(s.lagMs)}ms, peakLag=${ms(s.peakLagMs)}ms, dbWait=${ms(s.dbWaitMs)}ms, `
      + `dbWaiting=${s.pool.waiting}, dbInUse=${s.pool.inUse}, elu=${s.eluRatio.toFixed(2)})`;
  }
}

// ---------------------------------------------------------------------------
// Process singleton (index.ts only — the worker role never serves agents)
// ---------------------------------------------------------------------------

let runtime: AdmissionRuntime | null = null;

export function getAdmissionRuntime(): AdmissionRuntime | null {
  return runtime;
}

export function startAdmissionControl(env: NodeJS.ProcessEnv = process.env): AdmissionRuntime {
  if (runtime) return runtime;
  const { config, warnings } = resolveAdmissionConfig(env);
  for (const warning of warnings) console.warn(`[admission] ${warning}`);
  runtime = new AdmissionRuntime(config);
  runtime.start();
  console.log(
    `[admission] mode=${config.mode} lag=${config.lagMs.join('/')}ms dbWait=${config.dbWaitMs.join('/')}ms `
      + `emergency=${config.emergencyMs}ms bulkMaxInFlight=${config.bulkMaxInFlight} `
      + `ws=${config.wsRatePerSec}/s burst=${config.wsBurst} maxSetups=${config.wsMaxSetups}`,
  );
  return runtime;
}

export function stopAdmissionControl(): void {
  runtime?.stop();
  runtime = null;
}

/** For routes/agentWs.ts: true only when enforcing at level 1+. */
export function shouldDeferOfflineTransition(): boolean {
  return runtime?.shouldDeferOfflineTransition() ?? false;
}

/** TEST ONLY. */
export function __setAdmissionRuntimeForTests(next: AdmissionRuntime | null): void {
  runtime = next;
}
```

> Note on the bulk cap in `observe`: the cap counts only in `enforce`. In `observe` a bulk request is admitted and counted in `bulkInFlight` (so the gauge is truthful), but the cap never refuses. The level rule still reports `would_shed`.

- [ ] **Step 5: Run it to verify it passes**

Run: `cd apps/api && npx vitest run src/services/admission/admissionRuntime.test.ts`
Expected: PASS, 1 file.

- [ ] **Step 6: Document the metrics**

Add to `monitoring/stack.mdx` after the Event-Loop Metrics section:

```mdx
### Admission Metrics

Agent admission control (see [Agent admission control](/deploy/environment/#agent-admission-control))
publishes its state and every refusal.

| Metric | Type | Description |
|---|---|---|
| `breeze_admission_mode{mode}` | Gauge | `1` for the active mode (`off`, `observe`, `enforce`) |
| `breeze_admission_level` | Gauge | `0` normal, `1` inventory-type uploads refused, `2` status uploads refused too, `3` critical |
| `breeze_admission_decisions_total{class,route,outcome,reason}` | Counter | Requests refused (`outcome="shed"`), or that would have been in `observe` mode (`would_shed`). `reason` is `level`, `bulk_in_flight`, `ws_bucket` or `ws_setups` |
| `breeze_admission_transitions_total{from,to,trigger}` | Counter | Level changes; `trigger` is `lag`, `db`, `db_timeout` or `emergency` |
| `breeze_admission_signal_lag_seconds` | Gauge | Median event-loop lag the controller used (`-1` when the lag monitor is off) |
| `breeze_admission_signal_db_wait_seconds` | Gauge | How long requests wait for a database connection (the pool's own series are `breeze_db_pool_admission_*`) |
| `breeze_admission_db_saturation_responses_total{error}` | Counter | Requests answered `503` because the database pool (`pool_acquire_timeout`) or the RLS prologue (`prologue_timeout`) timed out |
| `breeze_admission_ws_bucket_tokens` / `breeze_admission_ws_setups_in_flight` | Gauge | WebSocket pacing state |
| `breeze_admission_bulk_in_flight` | Gauge | Inventory-type uploads being processed |
| `breeze_admission_offline_deferred_total{event}` | Counter | WebSocket disconnects whose offline flip was left to the offline detector while under load |
| `breeze_nodejs_eventloop_utilization` | Gauge | Event-loop utilization over the last second |

Alert on `breeze_admission_level == 3` for 5 minutes: the instance is down to
protected traffic and needs capacity. In `observe` mode, compare
`would_shed` against incidents before switching to `enforce`.
```

- [ ] **Step 7: Typecheck and commit**

```bash
cd apps/api && npx tsc --noEmit -p tsconfig.json; echo "tsc exit $?"
cd ../.. && git add apps/api/src/services/admission/admissionMetrics.ts apps/api/src/services/admission/admissionRuntime.ts apps/api/src/services/admission/admissionRuntime.test.ts apps/docs/src/content/docs/monitoring/stack.mdx
git commit -m "feat(api): admission runtime, decisions and metrics (#8147)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 8: The admission middleware, route labels and the `index.ts` mount

**Files:**
- Create: `apps/api/src/middleware/agentAdmission.ts`
- Create: `apps/api/src/middleware/agentAdmission.test.ts`
- Create: `apps/api/src/index.agentAdmission.test.ts`
- Modify: `apps/api/src/services/safeRequestLabel.ts`. Add a `ContextVariableMap` key and `admissionRouteLabelOf`, and change `safeMatchedRouteLabel`.
- Modify: `apps/api/src/routes/metrics.ts`. Change `resolveRoutePattern` (~line 767) and add one import.
- Modify: `apps/api/src/index.ts`. Add imports, mount after line 450, call start before `server = serve(` (~line 1859) and stop in `shutdownRuntime` (~line 1322).

**Interfaces:**
- Consumes: Task 5 `classifyAgentRequest`, `ClassifiedRequest`; Task 7 `AdmissionGate`, `AdmissionDecision`, `getAdmissionRuntime`, `startAdmissionControl`, `stopAdmissionControl`; Task 6 `WsSetupSlot`.
- Produces (used by Task 9):
  ```ts
  export function agentAdmission(getGate?: () => AdmissionGate | null): MiddlewareHandler;
  // Hono ContextVariableMap: admissionRouteLabel: string; admissionWsSetupSlot: WsSetupSlot
  export function admissionRouteLabelOf(c: Context): string | null; // safeRequestLabel.ts
  ```

- [ ] **Step 1: Write the failing middleware test**

`apps/api/src/middleware/agentAdmission.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const { authSpy } = vi.hoisted(() => ({ authSpy: vi.fn() }));
vi.mock('./agentAuth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./agentAuth')>()),
  agentAuthMiddleware: authSpy,
}));

import { hasDbAccessContext } from '../db';
import { agentRoutes } from '../routes/agents';
import { metricsMiddleware } from '../routes/metrics';
import { metricsRegistry } from '../services/metricsRegistry';
import type { AdmissionDecision, AdmissionGate } from '../services/admission/admissionRuntime';
import type { ClassifiedRequest } from '../services/admission/agentRouteClasses';
import { agentAdmission } from './agentAdmission';
import { requestPathLogger } from './requestPathLogger';

const AGENT = 'a'.repeat(64);

function stubGate(decide: (req: ClassifiedRequest) => AdmissionDecision, mode: AdmissionGate['mode'] = 'enforce') {
  const seen: Array<{ req: ClassifiedRequest; inDbContext: boolean }> = [];
  const gate: AdmissionGate = {
    mode,
    decide: (req) => {
      seen.push({ req, inDbContext: hasDbAccessContext() });
      return decide(req);
    },
  };
  return { gate, seen };
}
const shed = (): AdmissionDecision => ({ action: 'shed', reason: 'level', retryAfterSec: 137 });

beforeEach(() => {
  authSpy.mockReset();
  authSpy.mockImplementation(async (c: { text: (body: string, status: number) => Response }) => c.text('auth reached', 200));
});

describe('agentAdmission', () => {
  it('refuses before agent auth runs — so before its DB transaction and any body read', async () => {
    const { gate, seen } = stubGate(shed);
    const app = new Hono();
    app.use('*', agentAdmission(() => gate));
    app.route('/api/v1/agents', agentRoutes);

    const res = await app.request(`/api/v1/agents/${AGENT}/software`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ software: [] }),
    });

    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('137');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ error: 'Server busy; retry later', code: 'ADMISSION_SHED', retryAfterSeconds: 137 });
    expect(authSpy).not.toHaveBeenCalled();
    expect(seen).toEqual([
      { req: { cls: 'bulk', key: 'PUT /:id/software', label: '/api/v1/agents/:id/software' }, inDbContext: false },
    ]);
  });

  it('admitted requests continue to agent auth; protected routes never consult the gate', async () => {
    const { gate, seen } = stubGate(() => ({ action: 'admit' }));
    const app = new Hono();
    app.use('*', agentAdmission(() => gate));
    app.route('/api/v1/agents', agentRoutes);

    expect((await app.request(`/api/v1/agents/${AGENT}/software`, { method: 'PUT' })).status).toBe(200);
    expect((await app.request(`/api/v1/agents/${AGENT}/heartbeat`, { method: 'POST' })).status).toBe(200);
    expect(authSpy).toHaveBeenCalledTimes(2);
    expect(seen.map((s) => s.req.key)).toEqual(['PUT /:id/software']);
  });

  it('is a pass-through with no gate, in off mode, and for unclassified paths', async () => {
    const off = stubGate(shed, 'off');
    const enforce = stubGate(shed);
    for (const [gate, path] of [
      [null, `/api/v1/agents/${AGENT}/software`],
      [off.gate, `/api/v1/agents/${AGENT}/software`],
      [enforce.gate, `/api/v1/agents/${AGENT}/software/`],
      [enforce.gate, '/api/v1/devices'],
    ] as const) {
      const app = new Hono();
      app.use('*', agentAdmission(() => gate));
      app.all('*', (c) => c.text('through', 200));
      expect((await app.request(path, { method: 'PUT' })).status, path).toBe(200);
    }
    expect(off.seen).toEqual([]);
    expect(enforce.seen).toEqual([]);
  });

  it('releases bulk accounting when the handler finishes, even when it throws', async () => {
    const release = vi.fn();
    const app = new Hono();
    app.use('*', agentAdmission(() => ({ mode: 'enforce', decide: () => ({ action: 'admit', release }) })));
    app.put('/api/v1/agents/:id/software', () => {
      throw new Error('boom');
    });
    app.onError((_err, c) => c.text('error', 500));

    expect((await app.request(`/api/v1/agents/${AGENT}/software`, { method: 'PUT' })).status).toBe(500);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('hands the WS setup slot downstream and releases it only when the upgrade was not accepted', async () => {
    const slot = { release: vi.fn() };
    let seenSlot: unknown;
    const app = new Hono();
    app.use('*', agentAdmission(() => ({ mode: 'enforce', decide: () => ({ action: 'admit', wsSlot: slot }) })));
    app.get('/api/v1/agent-ws/:id/ws', (c) => {
      seenSlot = c.get('admissionWsSetupSlot');
      // @hono/node-ws answers an accepted upgrade with a plain `new Response()` (200).
      return c.req.header('x-accept') ? new Response() : c.json({ error: 'Unauthorized' }, 401);
    });

    expect((await app.request(`/api/v1/agent-ws/${AGENT}/ws`, { headers: { 'x-accept': '1' } })).status).toBe(200);
    expect(seenSlot).toBe(slot);
    expect(slot.release).not.toHaveBeenCalled();

    expect((await app.request(`/api/v1/agent-ws/${AGENT}/ws`)).status).toBe(401);
    expect(slot.release).toHaveBeenCalledTimes(1);
  });

  it('a refused WS upgrade never reaches the upgrade handler (Review Focus 1)', async () => {
    const upgrade = vi.fn((c: { text: (b: string) => Response }) => c.text('upgraded'));
    const app = new Hono();
    app.use('*', agentAdmission(() => ({
      mode: 'enforce',
      decide: () => ({ action: 'shed', reason: 'ws_bucket', retryAfterSec: 11 }),
    })));
    app.get('/api/v1/agent-ws/:id/ws', upgrade);

    const res = await app.request(`/api/v1/agent-ws/${AGENT}/ws`);
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('11');
    expect(await res.json()).toMatchObject({ code: 'WS_UPGRADE_REFUSED', retryAfterSeconds: 11 });
    expect(upgrade).not.toHaveBeenCalled();
  });

  it('labels refused requests by route template in http_requests_total and the request log (Review Focus 4)', async () => {
    const print = vi.fn();
    const app = new Hono();
    app.use('*', metricsMiddleware);
    app.use('*', requestPathLogger(print));
    app.use('*', agentAdmission(() => stubGate(shed).gate));

    await app.request(`/api/v1/agents/${'b'.repeat(64)}/software`, { method: 'PUT' });
    await app.request(`/api/v1/agents/${'c'.repeat(64)}/software`, { method: 'PUT' });

    const metric = metricsRegistry.getSingleMetric('http_requests_total');
    const { values } = await metric!.get();
    expect(values.filter((v) => v.labels.route === '/api/v1/agents/:id/software')).toEqual([
      expect.objectContaining({ labels: { method: 'PUT', route: '/api/v1/agents/:id/software', status_class: '5xx' }, value: 2 }),
    ]);
    expect(print.mock.calls.flat().join('\n')).toContain('route=/api/v1/agents/:id/software status=503 reason=admission_shed_bulk');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && npx vitest run src/middleware/agentAdmission.test.ts`
Expected: FAIL, "Failed to load url ./agentAdmission". 1 file.

- [ ] **Step 3: Implement the middleware**

`apps/api/src/middleware/agentAdmission.ts`:

```ts
/**
 * W08 (spec W1c, #8147) — agent admission control at the front door.
 *
 * Mounted in index.ts directly after requestPathLogger: a refusal is still
 * counted and logged, and costs nothing else — no secure headers, no body-limit
 * gate, no Redis round trip (globalRateLimit), no partner guard, no agent auth
 * DB transaction, no body read. It reads the method, the path and in-process
 * counters only, and never runs inside a DB context.
 *
 * Refusals are TRUTHFUL: 503 + Retry-After. A refused agent WS upgrade is an
 * HTTP 503 BEFORE the upgrade — never an accepted socket closed with 1013:
 * shipped agents (agent/internal/websocket/client.go:395-442) back off after a
 * failed connect but reconnect immediately after an accepted socket closes.
 */
import type { MiddlewareHandler } from 'hono';
import { getAdmissionRuntime, type AdmissionGate } from '../services/admission/admissionRuntime';
import { classifyAgentRequest } from '../services/admission/agentRouteClasses';
import type { WsSetupSlot } from '../services/admission/wsUpgradeGate';

declare module 'hono' {
  interface ContextVariableMap {
    /** W08: setup slot of an admitted agent WS upgrade; routes/agentWs.ts releases it when onOpen finishes. */
    admissionWsSetupSlot: WsSetupSlot;
  }
}

export function agentAdmission(getGate: () => AdmissionGate | null = getAdmissionRuntime): MiddlewareHandler {
  return async (c, next) => {
    const gate = getGate();
    if (!gate || gate.mode === 'off') return next();
    const req = classifyAgentRequest(c.req.method, c.req.path);
    if (!req || req.cls === 'protected') return next();

    const decision = gate.decide(req);
    if (decision.action === 'shed') {
      c.set('admissionRouteLabel', req.label);
      c.set('rejectReason', req.cls === 'ws_upgrade' ? 'admission_ws_upgrade' : `admission_shed_${req.cls}`);
      c.header('Retry-After', String(decision.retryAfterSec));
      c.header('Cache-Control', 'no-store');
      return req.cls === 'ws_upgrade'
        ? c.json({ error: 'Too many agent connections right now; retry later', code: 'WS_UPGRADE_REFUSED', retryAfterSeconds: decision.retryAfterSec }, 503)
        : c.json({ error: 'Server busy; retry later', code: 'ADMISSION_SHED', retryAfterSeconds: decision.retryAfterSec }, 503);
    }

    if (decision.wsSlot) c.set('admissionWsSetupSlot', decision.wsSlot);
    try {
      await next();
    } finally {
      decision.release?.();
      // @hono/node-ws answers an accepted upgrade with a plain 200 Response;
      // anything else (401, 429, 404) never reaches onOpen, so return the slot now.
      if (decision.wsSlot && c.res.status !== 200) decision.wsSlot.release();
    }
  };
}
```

`services/safeRequestLabel.ts`. Add to the existing `declare module 'hono'` block:

```ts
    /** W08: route template of a request agent admission refused before routing (agentRouteClasses label). */
    admissionRouteLabel: string;
```

Rename the existing `safeMatchedRouteLabel` body to a private `matchedRouteLabel(c)`, then add:

```ts
// Only templates agentRouteClasses can produce: a closed set, never request data.
const ADMISSION_ROUTE_LABEL = /^\/api\/v1\/(?:agents|agent-ws)\/:id(?:\/[A-Za-z0-9:-]+)+$/;

/** W08: the route template of a request agent admission refused before routing, or null. */
export function admissionRouteLabelOf(c: Context): string | null {
  let label: unknown;
  try {
    label = c.get('admissionRouteLabel');
  } catch {
    return null;
  }
  return typeof label === 'string' && label.length <= 200 && ADMISSION_ROUTE_LABEL.test(label) ? label : null;
}

export function safeMatchedRouteLabel(c: Context): string {
  const matched = matchedRouteLabel(c);
  return matched === UNMATCHED_ROUTE_LABEL ? (admissionRouteLabelOf(c) ?? UNMATCHED_ROUTE_LABEL) : matched;
}
```

`routes/metrics.ts`. Add `import { admissionRouteLabelOf } from '../services/safeRequestLabel';` and change one line in `resolveRoutePattern`:

```ts
  if (pattern.length === 0 || pattern === '/*' || pattern === '*') return admissionRouteLabelOf(c) ?? UNMATCHED_ROUTE_LABEL;
```

- [ ] **Step 4: Run it to verify it passes, with the neighbouring suites**

Run: `cd apps/api && npx vitest run src/middleware/agentAdmission.test.ts src/middleware/requestPathLogger.test.ts src/routes/metrics.test.ts src/routes/agents/parkedRouteClassification.test.ts`
Expected: PASS, 4 files.

- [ ] **Step 5: Write the failing mount test**

`apps/api/src/index.agentAdmission.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Source-level assertions on the W08 admission mount, for the same reason as
 * index.metricsMiddleware.test.ts: the behavioural suite mounts the middleware
 * on its own Hono app, so it proves the middleware works, never that index.ts
 * installs it in front of the costly global middleware.
 */
const indexSource = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
const at = (needle: string): number => {
  const index = indexSource.indexOf(needle);
  expect(index, needle).toBeGreaterThan(-1);
  return index;
};

describe('agent admission mount (index.ts)', () => {
  it('is mounted right after the request logger and before every costly global middleware', () => {
    const admission = at("app.use('*', agentAdmission())");
    expect(admission).toBeGreaterThan(at("app.use('*', requestPathLogger())"));
    for (const later of [
      'secureHeaders({',
      'createGlobalBodyLimitMiddleware({',
      "app.use('*', globalRateLimit())",
      "app.route('/api/v1', api)",
    ]) {
      expect(admission, later).toBeLessThan(at(later));
    }
  });

  it('starts the controller before the server listens and stops it on shutdown', () => {
    expect(at('startAdmissionControl()')).toBeLessThan(at('server = serve('));
    const shutdown = indexSource.slice(at('async function shutdownRuntime'));
    expect(shutdown.slice(0, 4_000)).toContain('stopAdmissionControl();');
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `cd apps/api && npx vitest run src/index.agentAdmission.test.ts`
Expected: FAIL on `app.use('*', agentAdmission())` not found. 1 file.

- [ ] **Step 7: Wire `index.ts`**

Imports, next to the other middleware imports:

```ts
import { agentAdmission } from './middleware/agentAdmission';
import { startAdmissionControl, stopAdmissionControl } from './services/admission/admissionRuntime';
```

Directly after `app.use('*', requestPathLogger());`:

```ts
// W08 (#8147): agent admission control. Directly after the request logger so a
// refusal is still counted (metricsMiddleware) and logged with its reason, and
// before everything that costs: secure headers, the body-limit gate, the Redis
// round trip in globalRateLimit, the partner guard, agent auth's DB transaction
// and any body read. O(1), no I/O, never inside a DB context. A pass-through
// until startAdmissionControl() runs, and in BREEZE_ADMISSION_MODE=off.
app.use('*', agentAdmission());
```

Immediately before `server = serve({`:

```ts
  // W08: start sampling only after migrations and boot work, so their stalls
  // never enter the controller's history. Admission never affects /ready.
  startAdmissionControl();
```

In `shutdownRuntime`, right after `stopEventLoopMonitor();`:

```ts
  stopAdmissionControl();
```

- [ ] **Step 8: Run the mount test and every index source test**

Run: `cd apps/api && npx vitest run src/index.agentAdmission.test.ts src/index.metricsMiddleware.test.ts`
Expected: PASS, 2 files.

Run: `cd apps/api && npx vitest run src/index.`
Expected: PASS. Every `index.*.test.ts`. Read the file count; it should be about 10.

- [ ] **Step 9: Typecheck and commit**

```bash
cd apps/api && npx tsc --noEmit -p tsconfig.json; echo "tsc exit $?"
cd ../.. && git add apps/api/src/middleware/agentAdmission.ts apps/api/src/middleware/agentAdmission.test.ts apps/api/src/index.agentAdmission.test.ts apps/api/src/services/safeRequestLabel.ts apps/api/src/routes/metrics.ts apps/api/src/index.ts
git commit -m "feat(api): mount agent admission control ahead of auth and rate limiting (#8147)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 9: WS handler wiring, deferred offline writes and the `@hono/node-ws` `Retry-After` patch

**Files:**
- Modify: `apps/api/src/routes/agentWs.ts`
  - At ~line 2690, rename `export function createAgentWsHandlers` to a module-private `buildAgentWsHandlers`, and add the exported wrapper right after it.
  - `onClose` (~line 4104) and `onError` (~line 4170): defer the offline write under load.
  - `createAgentWsRoutes` (~line 4747): pass the setup slot.
  - Add imports at the top.
- Modify: `apps/api/src/routes/agentWs.test.ts`. Add two `vi.mock`s next to the existing service mocks, and one new `describe`.
- Create: `apps/api/src/middleware/agentAdmission.wsRefusal.test.ts`
- Create: `patches/@hono__node-ws@1.3.1.patch` (generated)
- Modify: root `package.json` (`pnpm.patchedDependencies`, generated) and `pnpm-lock.yaml` (generated)

**Interfaces:**
- Consumes: Task 6 `WsSetupSlot`; Task 7 `shouldDeferOfflineTransition()` and `recordOfflineDeferred(event)`; Task 8 `c.get('admissionWsSetupSlot')`.
- Produces: `createAgentWsHandlers(agentId: string, preValidatedAgent: AgentDbContext, setupSlot?: WsSetupSlot): ReturnType<typeof buildAgentWsHandlers>`. Existing callers keep working (the third parameter is optional, and the `onMessage` type is unchanged).

- [ ] **Step 1: Write the failing raw-socket test**

`apps/api/src/middleware/agentAdmission.wsRefusal.test.ts`:

```ts
/**
 * W08 — what a refused agent WS upgrade looks like ON THE WIRE.
 *
 * Shipped agents (gorilla/websocket) treat a non-101 handshake as a failed
 * connect and back off 1 -> 60 s; they reconnect immediately after an ACCEPTED
 * socket closes. So a refusal must be an HTTP status line, never an upgrade.
 * And @hono/node-ws writes refusals itself as a bare status line, dropping the
 * response headers — the patch in patches/@hono__node-ws@1.3.1.patch forwards a
 * validated Retry-After so W09 agents get the delay hint.
 */
import { connect, type Socket } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { serve, type ServerType } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';
import type { AdmissionDecision } from '../services/admission/admissionRuntime';
import { agentAdmission } from './agentAdmission';

const AGENT = 'a'.repeat(64);
let server: ServerType | null = null;

afterEach(() => {
  server?.close();
  server = null;
});

async function start(decision: AdmissionDecision, onOpen: () => void) {
  const app = new Hono();
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
  app.use('*', agentAdmission(() => ({ mode: 'enforce', decide: () => decision })));
  app.get('/api/v1/agent-ws/:id/ws', upgradeWebSocket(() => ({ onOpen })));
  const port = await new Promise<number>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => resolve(info.port));
  });
  injectWebSocket(server!);
  return port;
}

function handshake(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket: Socket = connect(port, '127.0.0.1');
    let raw = '';
    socket.on('data', (chunk) => {
      raw += chunk.toString('latin1');
      if (raw.includes('\r\n\r\n')) {
        socket.destroy();
        resolve(raw);
      }
    });
    socket.on('error', reject);
    socket.on('close', () => resolve(raw));
    socket.write([
      `GET /api/v1/agent-ws/${AGENT}/ws HTTP/1.1`,
      'Host: 127.0.0.1',
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Version: 13',
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
      '',
      '',
    ].join('\r\n'));
  });
}

describe('agent WS refusal on the wire', () => {
  it('is an HTTP 503 status line carrying Retry-After, and no socket ever opens (Review Focus 1)', async () => {
    const onOpen = vi.fn();
    const port = await start({ action: 'shed', reason: 'ws_bucket', retryAfterSec: 42 }, onOpen);
    const raw = await handshake(port);
    expect(raw).toMatch(/^HTTP\/1\.1 503 /);
    expect(raw).toMatch(/\r\nRetry-After: 42\r\n/);
    expect(raw).not.toMatch(/101 Switching Protocols/);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('an admitted upgrade still switches protocols', async () => {
    const onOpen = vi.fn();
    const port = await start({ action: 'admit' }, onOpen);
    const raw = await handshake(port);
    expect(raw).toMatch(/^HTTP\/1\.1 101 /);
    await vi.waitFor(() => expect(onOpen).toHaveBeenCalledTimes(1));
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && npx vitest run src/middleware/agentAdmission.wsRefusal.test.ts`
Expected: the first test FAILS on `/\r\nRetry-After: 42\r\n/`. The status line is `HTTP/1.1 503 Service Unavailable`, but `@hono/node-ws` drops the header. The second test passes. 1 file.

- [ ] **Step 3: Patch `@hono/node-ws`**

```bash
pnpm patch @hono/node-ws@1.3.1
# prints an edit directory, e.g. node_modules/.pnpm_patches/@hono/node-ws@1.3.1
```

In **both** `dist/index.js` and `dist/index.cjs` of that directory, replace the refusal write. In `index.js` it is around line 72 and uses `STATUS_CODES`; in `index.cjs` it is around line 98 and uses `node_http.STATUS_CODES`. Replace the whole multi-line `socket.end(`…`);` with:

```js
					// Breeze patch (W08, #8147): forward a validated Retry-After on a
					// refused upgrade so agents get the delay hint. Digits only — never
					// copy arbitrary response headers onto the raw socket.
					const retryAfter = response.headers.get("retry-after");
					const retryAfterLine = retryAfter && /^\d{1,4}$/.test(retryAfter) ? `Retry-After: ${retryAfter}\r\n` : "";
					socket.end(`HTTP/1.1 ${response.status.toString()} ${STATUS_CODES[response.status] ?? ""}\r\nConnection: close\r\n${retryAfterLine}Content-Length: 0\r\n\r\n`);
```

(In `index.cjs`, write `node_http.STATUS_CODES` instead of `STATUS_CODES`.) Then:

```bash
pnpm patch-commit <the edit directory printed above>
git diff --stat package.json pnpm-lock.yaml patches/
```

Expected: a new `patches/@hono__node-ws@1.3.1.patch`, one new `"@hono/node-ws@1.3.1"` entry under `pnpm.patchedDependencies` in the root `package.json`, and a lockfile change limited to the patch hash. The Docker images already `COPY patches ./patches` before install (`docker/Dockerfile.api:7`, `docker/Dockerfile.api.dev:12`), so no Dockerfile change is needed.

- [ ] **Step 4: Run it to verify it passes**

Run: `cd apps/api && npx vitest run src/middleware/agentAdmission.wsRefusal.test.ts`
Expected: PASS, 2 tests, 1 file.

- [ ] **Step 5: Write the failing `agentWs` tests**

In `apps/api/src/routes/agentWs.test.ts`, extend the existing `vi.hoisted` block (the one that declares `transitionDeviceOfflineMock`) with:

```ts
  shouldDeferOfflineTransitionMock: vi.fn(() => false),
  recordOfflineDeferredMock: vi.fn(),
```

Add next to the other service mocks:

```ts
vi.mock('../services/admission/admissionRuntime', () => ({
  shouldDeferOfflineTransition: shouldDeferOfflineTransitionMock,
}));
vi.mock('../services/admission/admissionMetrics', () => ({
  recordOfflineDeferred: recordOfflineDeferredMock,
}));
```

Append a `describe` that reuses the file's `wsMock`, `selectAgentDevice`, `db` and `transitionDeviceOfflineMock` helpers exactly as the "excludes decommissioned/quarantined rows" test above it does:

```ts
describe('W08 admission integration', () => {
  const preValidatedAgent = { deviceId: 'device-123', orgId: 'org-123', partnerId: 'partner-123' };

  async function openThenClose(handlers: ReturnType<typeof createAgentWsHandlers>, ws: ReturnType<typeof wsMock>) {
    vi.mocked(db.update).mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }) } as any);
    vi.mocked(db.select).mockReturnValue(selectAgentDevice([]) as any);
    await handlers.onOpen({}, ws as any);
    transitionDeviceOfflineMock.mockClear();
    vi.mocked(db.select).mockReturnValue(selectAgentDevice([
      { id: 'device-123', siteId: 'site-1', status: 'online', hostname: 'host-1' },
    ]) as any);
    await handlers.onClose({}, ws as any);
  }

  it('leaves the offline flip to the offline detector while admission is shedding', async () => {
    shouldDeferOfflineTransitionMock.mockReturnValue(true);
    try {
      await openThenClose(createAgentWsHandlers('agent-123', preValidatedAgent), wsMock());
      expect(transitionDeviceOfflineMock).not.toHaveBeenCalled();
      expect(recordOfflineDeferredMock).toHaveBeenCalledWith('close');
      expect(vi.mocked(clearAgentPresence)).toHaveBeenCalled();   // presence still cleared at once
    } finally {
      shouldDeferOfflineTransitionMock.mockReturnValue(false);
    }
  });

  it('still flips offline at once when admission is not shedding', async () => {
    await openThenClose(createAgentWsHandlers('agent-123', preValidatedAgent), wsMock());
    expect(transitionDeviceOfflineMock).toHaveBeenCalledWith('agent-123', ['online']);
  });

  it('returns the admission setup slot when onOpen finishes, and on a close that skipped onOpen', async () => {
    const opened = { release: vi.fn() };
    await openThenClose(createAgentWsHandlers('agent-123', preValidatedAgent, opened), wsMock());
    expect(opened.release).toHaveBeenCalled();
    // Released at the end of onOpen; the onClose release is a no-op on a real slot (idempotent).

    const neverOpened = { release: vi.fn() };
    await createAgentWsHandlers('agent-456', preValidatedAgent, neverOpened).onClose({}, wsMock() as any);
    expect(neverOpened.release).toHaveBeenCalledTimes(1);
  });
});
```

(If `clearAgentPresence` is not already imported into the test file, add it to the existing import from `'../services/agentPresence'` at ~line 423.)

- [ ] **Step 6: Run them to verify they fail**

Run: `cd apps/api && npx vitest run src/routes/agentWs.test.ts`
Expected: the first and third new tests FAIL (`transitionDeviceOfflineMock` called; `release` not called). Every pre-existing test still passes. 1 file.

- [ ] **Step 7: Implement in `agentWs.ts`**

Imports:

```ts
import { shouldDeferOfflineTransition } from '../services/admission/admissionRuntime';
import { recordOfflineDeferred } from '../services/admission/admissionMetrics';
import type { WsSetupSlot } from '../services/admission/wsUpgradeGate';
```

Rename `export function createAgentWsHandlers(agentId: string, preValidatedAgent: AgentDbContext) {` to `function buildAgentWsHandlers(agentId: string, preValidatedAgent: AgentDbContext) {`. After that function's closing brace, add:

```ts
/**
 * W08: the agent WS handlers, optionally holding an admission setup slot
 * (middleware/agentAdmission.ts) that bounds how many upgrades are between
 * admission and the end of onOpen at once. The slot is returned when onOpen
 * finishes — however it exits — or on close/error if onOpen never ran; release
 * is idempotent, and the slot's own 30 s backstop covers handlers that never fire.
 */
export function createAgentWsHandlers(
  agentId: string,
  preValidatedAgent: AgentDbContext,
  setupSlot?: WsSetupSlot,
): ReturnType<typeof buildAgentWsHandlers> {
  const handlers = buildAgentWsHandlers(agentId, preValidatedAgent);
  if (!setupSlot) return handlers;
  return {
    ...handlers,
    onOpen: async (event: unknown, ws: WSContext) => {
      try {
        await handlers.onOpen(event, ws);
      } finally {
        setupSlot.release();
      }
    },
    onClose: async (event: unknown, ws: WSContext) => {
      setupSlot.release();
      await handlers.onClose(event, ws);
    },
    onError: (event: unknown, ws: WSContext) => {
      setupSlot.release();
      handlers.onError(event, ws);
    },
  };
}
```

In `onClose`, the block that starts with the comment `// Update device status to offline (but preserve 'updating' — let` is followed by `if (agentDb) {`. Replace that one `if (agentDb) {` line with:

```ts
        // W08: while admission is shedding (enforce, level 1+), leave the
        // offline flip to the offline detector — lastSeenAt still ages out
        // within 5 min — instead of one transaction per socket at the moment
        // thousands drop at once. Presence was cleared above, so command
        // routing already treats the agent as gone.
        if (agentDb && shouldDeferOfflineTransition()) {
          recordOfflineDeferred('close');
        } else if (agentDb) {
```

In `onError`, the `if (agentDb) {` directly above `void runWithAgentDbAccess('agentWs.onError.markOffline'` becomes:

```ts
      if (agentDb && shouldDeferOfflineTransition()) {
        recordOfflineDeferred('error');
      } else if (agentDb) {
```

In `createAgentWsRoutes`, change the upgrade factory to:

```ts
    upgradeWebSocket((c: { req: { param: (key: string) => string }; get: (key: string) => unknown }) => {
      const agentId = c.req.param('id');
      const agentCtx = c.get('agentDb') as AgentDbContext;
      const setupSlot = c.get('admissionWsSetupSlot') as WsSetupSlot | undefined;
      return createAgentWsHandlers(agentId, agentCtx, setupSlot);
    })
```

- [ ] **Step 8: Run the WS suites**

Run: `cd apps/api && npx vitest run src/routes/agentWs src/middleware/agentAdmission`
Expected: PASS. Read the file count: it should be 7 (`agentWs.test.ts`, the four other `agentWs.*.test.ts`, and the two `agentAdmission*.test.ts`).

- [ ] **Step 9: Typecheck and commit**

```bash
cd apps/api && npx tsc --noEmit -p tsconfig.json; echo "tsc exit $?"
cd ../.. && git add apps/api/src/routes/agentWs.ts apps/api/src/routes/agentWs.test.ts apps/api/src/middleware/agentAdmission.wsRefusal.test.ts patches/@hono__node-ws@1.3.1.patch package.json pnpm-lock.yaml
git commit -m "feat(api): pace agent WS setups, defer offline writes under load, forward Retry-After on refused upgrades (#8147)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 10: Map DB saturation errors to `503` + `Retry-After`

W04 deferred this mapping to W08 (W04 plan, "Design decision" row (f)). #8243 raises a typed `DbPoolAcquireTimeoutError` when a request waits longer than `DB_POOL_ACQUIRE_TIMEOUT_MS` for a pool slot. `DbAccessContextPrologueTimeoutError` covers a stalled `BEGIN`/`set_config` after acquisition. Both reach `app.onError` today as a `500`. With either error, the caller's work never ran, so retrying is safe. A `500` makes `httputil` agents retry 4 times in about 7 s. A `503` with `Retry-After` ≥ 30 makes them try once per cycle.

**Files:**
- Create: `apps/api/src/middleware/dbSaturationResponse.ts`
- Create: `apps/api/src/middleware/dbSaturationResponse.test.ts`
- Modify: `apps/api/src/services/admission/admissionMetrics.ts` (add `recordDbSaturationResponse`)
- Modify: `apps/api/src/index.ts`. In `app.onError` (~line 1078), call the helper right after the `HTTPException` branch.
- Modify: `apps/api/src/index.agentAdmission.test.ts` (one more source assertion)

**Interfaces:**
- Consumes: `DbPoolAcquireTimeoutError` and `DbAccessContextPrologueTimeoutError`, re-exported from `apps/api/src/db/index.ts` (#8243; Task 1 Step 0 verified them).
- Produces:
  ```ts
  export type DbSaturationKind = 'pool_acquire_timeout' | 'prologue_timeout';
  export const DB_SATURATION_RETRY_AFTER_SECONDS: readonly [30, 45];
  export function findDbSaturationError(err: unknown): DbSaturationKind | null;
  export function dbSaturationResponse(err: unknown, c: Context, random?: () => number): Response | null;
  // admissionMetrics.ts
  export function recordDbSaturationResponse(kind: DbSaturationKind): void;
  ```

- [ ] **Step 1: Write the failing test**

`apps/api/src/middleware/dbSaturationResponse.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { DbAccessContextPrologueTimeoutError, DbPoolAcquireTimeoutError } from '../db';
import { dbSaturationResponse, findDbSaturationError } from './dbSaturationResponse';

// Built from the prototype so the test does not depend on either constructor's
// input shape (#8243 and W04 differ); `instanceof` is all the helper relies on.
const make = <T extends Error>(ctor: { prototype: T; name: string }, message: string): T =>
  Object.assign(Object.create(ctor.prototype) as T, { message, name: ctor.name });

function app(err: () => Error) {
  const a = new Hono();
  a.get('/x', () => {
    throw err();
  });
  a.onError((error, c) => dbSaturationResponse(error, c, () => 0) ?? c.json({ error: 'Internal Server Error' }, 500));
  return a;
}

describe('dbSaturationResponse', () => {
  it('answers a pool-acquire timeout with 503 + Retry-After 30..45 and no-store', async () => {
    const res = await app(() => make(DbPoolAcquireTimeoutError, 'pool saturated')).request('/x');
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('30');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ error: 'Server busy; retry later', code: 'DB_POOL_SATURATED', retryAfterSeconds: 30 });
  });

  it('answers a prologue timeout the same way', async () => {
    expect((await app(() => make(DbAccessContextPrologueTimeoutError, 'prologue')).request('/x')).status).toBe(503);
  });

  it('finds the error through a cause chain, and nothing else', () => {
    const wrapped = new Error('route failed', { cause: new Error('mid', { cause: make(DbPoolAcquireTimeoutError, 'x') }) });
    expect(findDbSaturationError(wrapped)).toBe('pool_acquire_timeout');
    expect(findDbSaturationError(new Error('boom'))).toBeNull();
    expect(findDbSaturationError('not an error')).toBeNull();
  });

  it('leaves every other error to the existing 500 path', async () => {
    expect((await app(() => new Error('boom')).request('/x')).status).toBe(500);
  });

  it('keeps Retry-After inside 30..45', async () => {
    const a = new Hono();
    a.get('/x', () => { throw make(DbPoolAcquireTimeoutError, 'x'); });
    a.onError((error, c) => dbSaturationResponse(error, c, () => 0.999)!);
    expect((await a.request('/x')).headers.get('retry-after')).toBe('45');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && npx vitest run src/middleware/dbSaturationResponse.test.ts`
Expected: FAIL, "Failed to load url ./dbSaturationResponse". 1 file.

- [ ] **Step 3: Implement**

`apps/api/src/middleware/dbSaturationResponse.ts`:

```ts
/**
 * W08 (#8147) — DB saturation answered as "busy, retry later", not as a crash.
 *
 * A pool-acquire timeout (#8229/#8243: no slot within DB_POOL_ACQUIRE_TIMEOUT_MS)
 * or an RLS prologue timeout means the caller's work never ran. Answering 503 +
 * Retry-After (30-45 s, jittered) lets every agent since v0.64.3 make ONE
 * attempt per cycle, where a 500 earned four in ~7 s. Retry safety is unchanged
 * from today: agents already retry a 500.
 *
 * Not reported to Sentry: saturation fails many requests at once and would
 * flood it. #8243's throttled `[db-pool-acquire]` line and
 * `breeze_admission_db_saturation_responses_total` carry the signal.
 */
import type { Context } from 'hono';
import { DbAccessContextPrologueTimeoutError, DbPoolAcquireTimeoutError } from '../db';
import { recordDbSaturationResponse } from '../services/admission/admissionMetrics';

export type DbSaturationKind = 'pool_acquire_timeout' | 'prologue_timeout';
export const DB_SATURATION_RETRY_AFTER_SECONDS = [30, 45] as const;
const MAX_CAUSE_DEPTH = 3;

export function findDbSaturationError(err: unknown): DbSaturationKind | null {
  let current: unknown = err;
  for (let depth = 0; depth <= MAX_CAUSE_DEPTH && current instanceof Error; depth += 1) {
    if (current instanceof DbPoolAcquireTimeoutError) return 'pool_acquire_timeout';
    if (current instanceof DbAccessContextPrologueTimeoutError) return 'prologue_timeout';
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

export function dbSaturationResponse(err: unknown, c: Context, random: () => number = Math.random): Response | null {
  const kind = findDbSaturationError(err);
  if (kind === null) return null;
  const [lo, hi] = DB_SATURATION_RETRY_AFTER_SECONDS;
  const retryAfterSeconds = lo + Math.floor(random() * (hi - lo + 1));
  recordDbSaturationResponse(kind);
  c.set('rejectReason', `db_${kind}`);
  c.header('Retry-After', String(retryAfterSeconds));
  c.header('Cache-Control', 'no-store');
  return c.json({ error: 'Server busy; retry later', code: 'DB_POOL_SATURATED', retryAfterSeconds }, 503);
}
```

In `admissionMetrics.ts`, add:

```ts
const dbSaturationResponses = counter(
  'breeze_admission_db_saturation_responses_total',
  'Requests answered 503 + Retry-After because the DB pool or the RLS prologue timed out (the caller work never ran)',
  ['error'],
);

export function recordDbSaturationResponse(kind: 'pool_acquire_timeout' | 'prologue_timeout'): void {
  dbSaturationResponses.labels(kind).inc();
}
```

In `index.ts`, add `import { dbSaturationResponse } from './middleware/dbSaturationResponse';` and, inside `app.onError`, right after the closing brace of the `if (err instanceof HTTPException) { … }` block:

```ts
  // W08 (#8147): a pool-acquire timeout (#8229/#8243) or an RLS prologue
  // timeout means the caller's work never ran — answer 503 + Retry-After so
  // agents make one attempt per cycle instead of four, and keep saturation out
  // of Sentry (see middleware/dbSaturationResponse.ts).
  const saturated = dbSaturationResponse(err, c);
  if (saturated) return saturated;
```

Append to `index.agentAdmission.test.ts`:

```ts
  it('maps DB saturation errors in onError before they reach Sentry', () => {
    const onError = indexSource.slice(at('app.onError((err, c) => {'));
    const mapping = onError.indexOf('dbSaturationResponse(err, c)');
    expect(mapping).toBeGreaterThan(-1);
    expect(mapping).toBeLessThan(onError.indexOf('captureException(err, c)'));
  });
```

- [ ] **Step 4: Run them to verify they pass**

Run: `cd apps/api && npx vitest run src/middleware/dbSaturationResponse.test.ts src/index.agentAdmission.test.ts`
Expected: PASS, 2 files.

- [ ] **Step 5: Typecheck and commit**

```bash
cd apps/api && npx tsc --noEmit -p tsconfig.json; echo "tsc exit $?"
cd ../.. && git add apps/api/src/middleware/dbSaturationResponse.ts apps/api/src/middleware/dbSaturationResponse.test.ts apps/api/src/services/admission/admissionMetrics.ts apps/api/src/index.ts apps/api/src/index.agentAdmission.test.ts
git commit -m "feat(api): answer DB pool saturation with 503 + Retry-After instead of 500 (#8147)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Integration test with real event-loop lag and a real Postgres pool

**Files:**
- Create: `apps/api/src/__tests__/integration/admissionControl.integration.test.ts`

**Interfaces:**
- Consumes: Task 7 `AdmissionRuntime`; Task 3 `ADMISSION_DEFAULTS`; Task 8 `agentAdmission`; Task 10 `dbSaturationResponse`; `startEventLoopMonitor`/`stopEventLoopMonitor`; the real `db` and `withSystemDbAccessContext`, whose openers go through W04's gate (Task 1's signal source).
- Produces: nothing.

- [ ] **Step 1: Start the stack**

Run (worktree root): `pnpm test-stack up`
Expected: Postgres and Redis are healthy, and `.env.test` records the project.

- [ ] **Step 2: Write the test**

```ts
/**
 * W08 — admission control against a REAL event loop and a REAL Postgres pool.
 *
 * Unit suites drive the controller with synthetic signals. This proves the
 * signals themselves: a genuinely blocked main thread raises the lag signal,
 * genuinely queued requests raise the DB pool-wait signal (W04's gate), refusals
 * are answered without waiting for the pool, a real pool-acquire timeout becomes
 * 503 + Retry-After, and the level recovers on its own.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { startEventLoopMonitor, stopEventLoopMonitor } from '../../services/eventLoopMonitor';
import { ADMISSION_DEFAULTS } from '../../services/admission/admissionConfig';
import { AdmissionRuntime } from '../../services/admission/admissionRuntime';
import { agentAdmission } from '../../middleware/agentAdmission';
import { dbSaturationResponse } from '../../middleware/dbSaturationResponse';

const AGENT = 'a'.repeat(64);
const POOL_MAX = Number.parseInt(process.env.DB_POOL_MAX ?? '', 10) > 0
  ? Number.parseInt(process.env.DB_POOL_MAX!, 10)
  : 30; // db/index.ts getDbPoolMax() default

let runtime: AdmissionRuntime | null = null;

function buildApp(gate: AdmissionRuntime | null) {
  const app = new Hono();
  app.use('*', agentAdmission(() => gate));
  // Stand-in for every agent route: real DB work through the real pool.
  app.all('/api/v1/agents/:id/*', async (c) => {
    await withSystemDbAccessContext(async () => {
      await db.execute(sql`select 1`);
    }, 'admissionIntegration');
    return c.json({ ok: true });
  });
  return app;
}

async function until(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

beforeAll(() => {
  startEventLoopMonitor({ sampleIntervalMs: 250 });
});
afterAll(() => {
  stopEventLoopMonitor();
});
afterEach(() => {
  runtime?.stop();
  runtime = null;
});

describe('admission control (real loop, real pool)', () => {
  it('sheds bulk while the event loop is genuinely stalled, keeps heartbeats, and recovers', async () => {
    runtime = new AdmissionRuntime({ ...ADMISSION_DEFAULTS, mode: 'enforce' }, { log: () => {} });
    runtime.start(250);
    const app = buildApp(runtime);
    const control = buildApp(null);

    // ~150 ms of synchronous work every 300 ms: a loop that is half busy in long slices.
    const stall = setInterval(() => {
      const end = Date.now() + 150;
      while (Date.now() < end) { /* block the loop */ }
    }, 300);
    try {
      await until(() => runtime!.level >= 1, 10_000, 'level >= 1 under real lag');

      const refused = await app.request(`/api/v1/agents/${AGENT}/software`, { method: 'PUT' });
      expect(refused.status).toBe(503);
      const retryAfter = Number(refused.headers.get('retry-after'));
      expect(retryAfter).toBeGreaterThanOrEqual(120);
      expect(retryAfter).toBeLessThanOrEqual(180);

      expect((await app.request(`/api/v1/agents/${AGENT}/heartbeat`, { method: 'POST' })).status).toBe(200);
      // Control: the same request without admission succeeds, so the 503 is admission's.
      expect((await control.request(`/api/v1/agents/${AGENT}/software`, { method: 'PUT' })).status).toBe(200);
    } finally {
      clearInterval(stall);
    }

    await until(() => runtime!.level === 0, 45_000, 'recovery to level 0');
    expect((await app.request(`/api/v1/agents/${AGENT}/software`, { method: 'PUT' })).status).toBe(200);
  }, 90_000);

  it('raises the level from real pool queueing and refuses without waiting for a connection', async () => {
    runtime = new AdmissionRuntime({ ...ADMISSION_DEFAULTS, mode: 'enforce' }, { log: () => {} });
    runtime.start(250);
    const app = buildApp(runtime);

    // More holders than the pool has slots: the excess queue inside postgres.js.
    const holders = Array.from({ length: POOL_MAX + 10 }, () =>
      withSystemDbAccessContext(async () => {
        await db.execute(sql`select pg_sleep(1.5)`);
      }, 'admissionIntegrationHolder'),
    );
    try {
      await until(() => runtime!.level >= 2, 10_000, 'level >= 2 under real pool queueing');

      const startedAt = Date.now();
      const refused = await app.request(`/api/v1/agents/${AGENT}/security/status`, { method: 'PUT' });
      const refusalMs = Date.now() - startedAt;
      expect(refused.status).toBe(503);
      const retryAfter = Number(refused.headers.get('retry-after'));
      expect(retryAfter).toBeGreaterThanOrEqual(60);
      expect(retryAfter).toBeLessThanOrEqual(90);
      // The pool is saturated for ~1.5 s per wave; a refusal that queued for a slot would take that long.
      expect(refusalMs).toBeLessThan(250);

      // Heartbeats are never refused: this one queues for the pool like any request and still succeeds.
      expect((await app.request(`/api/v1/agents/${AGENT}/heartbeat`, { method: 'POST' })).status).toBe(200);
    } finally {
      await Promise.allSettled(holders);
    }

    await until(() => runtime!.level === 0, 60_000, 'recovery to level 0');
  }, 120_000);

  it('a real pool-acquire timeout (#8243) is answered 503 + Retry-After, not 500', async () => {
    const previous = process.env.DB_POOL_ACQUIRE_TIMEOUT_MS;
    process.env.DB_POOL_ACQUIRE_TIMEOUT_MS = '1000'; // read per call; 1000 is the clamp floor
    const app = buildApp(null);
    app.onError((err, c) => dbSaturationResponse(err, c) ?? c.json({ error: 'Internal Server Error' }, 500));
    const holders = Array.from({ length: POOL_MAX + 5 }, () =>
      withSystemDbAccessContext(async () => {
        await db.execute(sql`select pg_sleep(3)`);
      }, 'admissionIntegrationHolder').catch(() => undefined),
    );
    try {
      const res = await app.request(`/api/v1/agents/${AGENT}/heartbeat`, { method: 'POST' });
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ code: 'DB_POOL_SATURATED' });
      const retryAfter = Number(res.headers.get('retry-after'));
      expect(retryAfter).toBeGreaterThanOrEqual(30);
      expect(retryAfter).toBeLessThanOrEqual(45);
    } finally {
      await Promise.allSettled(holders);
      if (previous === undefined) delete process.env.DB_POOL_ACQUIRE_TIMEOUT_MS;
      else process.env.DB_POOL_ACQUIRE_TIMEOUT_MS = previous;
    }
  }, 60_000);
});
```

- [ ] **Step 3: Run it**

Run: `cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/admissionControl.integration.test.ts`
Expected: PASS, 3 tests, 1 file.

- [ ] **Step 4: Prove it discriminates (mutation check)**

The code already exists when this test is written, so prove that it can fail.

1. In `admissionRuntime.ts`, change `if (level >= 1) reason = 'level';` (the bulk branch) to `if (level >= 4) reason = 'level';`. Re-run Step 3. Expected: the first test FAILS (`expected 200 to be 503`).
2. Revert that. In `services/admission/poolSignals.ts`, return `oldestWaitMs: 0, grantWaitP95Ms: 0` instead of the gate's values. Re-run Step 3. Expected: the second test FAILS (`timed out … waiting for level >= 2 under real pool queueing`).
3. Revert that. In `middleware/dbSaturationResponse.ts`, make `findDbSaturationError` return `null` unconditionally. Re-run Step 3. Expected: the third test FAILS (`expected 500 to be 503`).
4. Revert. Run `git diff --stat` and confirm all three mutations are gone. Re-run Step 3 and expect PASS.

Record all three red outputs (the first assertion line of each) in the PR body under "Verification".

- [ ] **Step 5: Tear down and commit**

```bash
pnpm test-stack down
git add apps/api/src/__tests__/integration/admissionControl.integration.test.ts
git commit -m "test(api): admission control against real event-loop lag and real pool queueing (#8147)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Acceptance tooling, the storm run, and the full pre-PR suites

**Prerequisite:** #8161 (the agent simulator) has merged to `main`, and this branch is rebased onto it (`git fetch origin && git rebase origin/main`). Check with `ls agent/tools/agentsim load-tests/agentsim`. If W06 (the W0b storm scenarios) has merged, use its scenario runner for the two storms below instead of the manual `docker` steps, and keep the same gates.

**Files:**
- Create: `load-tests/agentsim/admission-watch.sh`
- Modify: `load-tests/agentsim/README.md`. Add an `## Admission-control acceptance (W08)` section after `## Acceptance (W0a)`.

**Interfaces:**
- Consumes: the `breeze_admission_*` series (Task 7) and W04's `breeze_db_pool_admission_*` series; `.breeze-stack.json` (`pgContainer`, `project`); the simulator store's `hostnameBase`; the simulator report (`routes[].route`, `.latencyMs.p95`, `.statusTotal`, `.transportErrors`, `ws.connectFailures`).
- Produces: `load-tests/agentsim/reports/admission-<UTC>.csv` and a `summarize` verdict.

- [ ] **Step 1: Write the watcher**

`load-tests/agentsim/admission-watch.sh` (`chmod +x`):

```bash
#!/usr/bin/env bash
# load-tests/agentsim/admission-watch.sh — W08 acceptance sampler.
#   admission-watch.sh watch                      sample every $INTERVAL s (default 5) until Ctrl-C
#   admission-watch.sh summarize <csv> <poolMax>  print the W08 gates for a finished run
# Reads /metrics/scrape INSIDE the api container (needs METRICS_SCRAPE_TOKEN set
# for the stack) and pg_stat_activity / devices from the stack's Postgres.
set -euo pipefail
REPO="$(git rev-parse --show-toplevel)"
DESC="$REPO/.breeze-stack.json"
if [ -f "$REPO/load-tests/agentsim/.state/lab.env" ]; then set -a; . "$REPO/load-tests/agentsim/.state/lab.env"; set +a; fi

case "${1:-}" in
watch)
  [ -f "$DESC" ] || { echo "admission-watch: no $DESC — run pnpm wt-stack up" >&2; exit 1; }
  STORE="${AGENTSIM_STORE:-$REPO/load-tests/agentsim/.state/tokens.json}"
  PROJECT="$(jq -r .project "$DESC")"; PG="$(jq -r .pgContainer "$DESC")"
  BASE="$(jq -r .hostnameBase "$STORE")"
  API="$(docker ps --filter "label=com.docker.compose.project=$PROJECT" --filter label=com.docker.compose.service=api --format '{{.Names}}' | head -n1)"
  [ -n "$API" ] || { echo "admission-watch: no api container for $PROJECT" >&2; exit 1; }
  OUT="$REPO/load-tests/agentsim/reports/admission-$(date -u +%Y%m%dT%H%M%SZ).csv"
  mkdir -p "$(dirname "$OUT")"
  echo "ts,level,mode,shed_total,would_shed_total,db_waiting,db_in_use,db_wait_s,lag_s,ws_tokens,api_backends,stuck_backends,max_heartbeat_gap_s" >"$OUT"
  echo "admission-watch: writing $OUT" >&2
  while true; do
    SCRAPE="$(docker exec "$API" node -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||3001)+'/metrics/scrape',{headers:{authorization:'Bearer '+process.env.METRICS_SCRAPE_TOKEN}}).then(r=>r.text()).then(t=>process.stdout.write(t)).catch(()=>{})" 2>/dev/null || true)"
    m() { awk -v n="$1" '$1==n {print $2; f=1} END {if(!f) print "NaN"}' <<<"$SCRAPE"; }
    msum() { awk -v n="$1" -v want="$2" 'index($1, n"{")==1 && index($1, want)>0 {s+=$2} END {print s+0}' <<<"$SCRAPE"; }
    MODE="$(awk 'index($1,"breeze_admission_mode{")==1 && $2==1 {match($1,/mode="[a-z]+"/); print substr($1,RSTART+6,RLENGTH-7)}' <<<"$SCRAPE")"
    PGROW="$(docker exec -i "$PG" sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tA -F, -v base="$0"' "$BASE" <<'SQL'
SELECT
  (SELECT count(*) FROM pg_stat_activity WHERE application_name = 'breeze-api'),
  (SELECT count(*) FROM pg_stat_activity WHERE application_name = 'breeze-api' AND (
     (state = 'idle in transaction' AND now() - state_change > interval '5 seconds')
     OR (state = 'active' AND wait_event = 'ClientRead' AND now() - query_start > interval '15 seconds'))),
  (SELECT coalesce(round(max(extract(epoch FROM now() - last_seen_at))), -1) FROM devices
     WHERE hostname LIKE :'base' || '-%' AND status <> 'decommissioned');
SQL
)"
    echo "$(date -u +%FT%TZ),$(m breeze_admission_level),${MODE:-unknown},$(msum breeze_admission_decisions_total 'outcome="shed"'),$(msum breeze_admission_decisions_total 'outcome="would_shed"'),$(m breeze_db_pool_admission_waiting),$(m breeze_db_pool_admission_in_use),$(m breeze_admission_signal_db_wait_seconds),$(m breeze_admission_signal_lag_seconds),$(m breeze_admission_ws_bucket_tokens),$PGROW" >>"$OUT"
    sleep "${INTERVAL:-5}"
  done
  ;;
summarize)
  CSV="${2:?usage: admission-watch.sh summarize <csv> <poolMax>}"; POOL="${3:?poolMax (DB_POOL_MAX, default 30)}"
  awk -F, -v pool="$POOL" '
    NR==1 {next}
    { rows++; if ($2+0 > maxlvl) maxlvl=$2+0
      if ($6+0 > 0) { waiting++; if ($11+0 < 0.8*pool) short++ }
      if ($12+0 > 0) stuck++
      if ($13+0 > maxgap) maxgap=$13+0 }
    END {
      printf "rows=%d max_level=%d rows_with_waiters=%d\n", rows, maxlvl, waiting
      printf "%s  usable pool: rows with waiters and < 80%% of %d backends = %d\n", (short==0?"PASS":"FAIL"), pool, short
      printf "%s  no stuck backends (idle-in-tx > 5 s / ClientRead > 15 s): %d rows\n", (stuck==0?"PASS":"FAIL"), stuck
      printf "%s  max heartbeat gap %ds < 180 s (agent watchdog threshold)\n", (maxgap<180?"PASS":"FAIL"), maxgap
      exit (short>0 || stuck>0 || maxgap>=180) }' "$CSV"
  ;;
*)
  echo "usage: $0 watch | summarize <csv> <poolMax>" >&2; exit 2 ;;
esac
```

Run `bash -n load-tests/agentsim/admission-watch.sh` and `shellcheck load-tests/agentsim/admission-watch.sh` if it is installed. Expected: no errors.

- [ ] **Step 2: Document the run in the README**

Append to `load-tests/agentsim/README.md`:

````markdown
## Admission-control acceptance (W08)

Spec W1c: under a storm, p95 heartbeat ≤ 1 s and the pool never below 80 % of
max — measured as *usable* pool (whenever requests wait, at least 80 % of
`DB_POOL_MAX` backends exist and none is stuck). Heartbeat latency comes from
the simulator (client side), never from the API's own histogram.

```bash
export AGENT_ENROLL_RATE_LIMIT=5000 BREEZE_ADMISSION_MODE=enforce
export METRICS_SCRAPE_TOKEN="$(openssl rand -hex 24)"     # lab-only, shell only
pnpm wt-stack up
eval "$(load-tests/agentsim/lab-setup.sh)"; ulimit -n 16384
PROJECT="$(jq -r .project .breeze-stack.json)"
svc() { docker ps --filter "label=com.docker.compose.project=$PROJECT" --filter "label=com.docker.compose.service=$1" --format '{{.Names}}' | head -n1; }

# terminal A — 400 agents, cold start, 25-minute window
load-tests/agentsim/run.sh --agents 400 --ramp 20 --warmup 2m --duration 25m --start cold
# terminal B — sampler
load-tests/agentsim/admission-watch.sh watch
# terminal C — the storm schedule (minutes from the window opening)
sleep 300; docker update --cpus 0.75 "$(svc api)"     # t+5: overload (one slow core)
sleep 180; docker restart "$(svc caddy)"              # t+8: drop every agent socket at once
sleep 240; docker restart "$(svc api)"                # t+12: kill the API (cold start, all agents redial)
sleep 360; docker update --cpus 0 "$(svc api)"        # t+18: lift the throttle (0 = unlimited)
```

Gates (both runs below):

| Gate | How |
|---|---|
| heartbeat p95 ≤ 1 s | `jq '.routes[] | select(.route=="POST /agents/:id/heartbeat") | .latencyMs.p95' reports/<run>.json` |
| heartbeats never refused or lost | same object: `.statusTotal` has no 503 and `.transportErrors == 0` |
| usable pool, no stuck backends, gap < 180 s | `admission-watch.sh summarize reports/admission-<UTC>.csv 30` exits 0 |
| WS pacing | `.ws.connectFailures > 0` during the storms, and the CSV `ws_tokens` column never stuck at 0 after t+20 |
| recovery | CSV `level` back to 0, and `db_wait_s` < 0.075, within 2 min of t+18 |

Run it twice: once as above, and once with `BREEZE_ADMISSION_MODE=observe` as
the control. The observe run is expected to FAIL at least one gate. If it
does not, the storm was too gentle to prove anything; raise `--agents` or
lower `--cpus` and repeat both.
````

- [ ] **Step 3: Run the acceptance, enforce then observe**

Follow the README block. For each run, keep: the simulator report path, the CSV path, the `summarize` output, the heartbeat `jq` output, and the `[admission] level …` transition lines (`docker logs "$(svc api)" 2>&1 | grep '\[admission\]'`).
Expected: the **enforce** run passes every gate, and the **observe** run fails at least one. If enforce fails a gate, do not loosen the gate. Read the transition log and the CSV. A threshold may be too high, for example a level that never left 0 while `db_waiting` climbed. If so, change the default in Task 3 together with its tests, and record why in the PR.

Tear down: `pnpm wt-stack down`. Then run `docker compose ls -a --format json | jq -r '.[] | select(.ConfigFiles|test("breeze")) | "\(.Name)\t\(.Status)"'` and confirm nothing of yours is left.

- [ ] **Step 4: Full pre-PR suites (tenancy is untouched, but `db/index.ts` is not)**

```bash
cd apps/api && npx tsc --noEmit -p tsconfig.json; echo "tsc exit $?"
cd apps/api && npx vitest run 2>&1 | tail -15          # full unit suite; read the file and test counts, not just the last line
pnpm test-stack up
cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/admissionControl.integration.test.ts src/__tests__/integration/accessContextGucs.integration.test.ts src/__tests__/integration/wedgedBackendPredicate.integration.test.ts
pnpm test-stack down
pnpm --filter @breeze/docs build                         # the two .mdx edits
```

Expected: tsc exit 0. The unit suite shows 0 failed files. The three integration files pass. The docs build succeeds.

- [ ] **Step 5: Commit**

```bash
git add load-tests/agentsim/admission-watch.sh load-tests/agentsim/README.md
git commit -m "test(load): W08 admission acceptance sampler and storm recipe (#8147)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
## PR, rollout and the edge-rule removal (ops; nothing in this section touches infra from the repo)

**PR.**
- Title: `feat(api): agent admission control — priority shedding, WS upgrade pacing, DB saturation as 503 (#8147)`.
- The body carries:
  - `Closes #8147`.
  - The "Design decision" table, condensed.
  - The two spec deviations (no heartbeat shedding; pre-upgrade 503 instead of 1013), with the owner sign-off request.
  - The Task 11 mutation reds.
  - The Task 12 gate outputs (both the enforce run and the observe control run).
  - The legacy-agent share from the rollout gate below.
- The review round is `/pr-review-toolkit:review-pr`, with one round only. This is a high-rigor change, so include `silent-failure-hunter` (the `onError` mapping and the deferred offline write).
- Merge through the queue with `gh pr merge <N>`. Never use `--admin`.

**Rollout (hosted, region by region, starting with the incident region):**

1. **Deploy at the default `observe`.** Nothing changes for agents. Over at least 24 h, including the daily peak, watch:
   - `breeze_admission_level` and `breeze_admission_transitions_total`;
   - `breeze_admission_decisions_total{outcome="would_shed"}`;
   - W04's `breeze_db_pool_admission_*` series.
   Expected: level 0 at normal load. `would_shed` is non-zero only during real pressure.
2. **Rollout gate:** run `SELECT agent_version, count(*) FROM devices WHERE status = 'online' GROUP BY 1 ORDER BY 2 DESC;` on the region and record the share of agents below v0.64.3. If it is above 20 %, run the W06 storm with that mix before step 3.
3. **Switch on enforcement.** Set `BREEZE_ADMISSION_MODE=enforce` in the region's `/opt/breeze/.env`, then redeploy `api` with the standard deploy line and run the version-parity check from CLAUDE.md. `x-api-env` maps the variable; Task 3 made sure of that. **Keep the Caddy edge rules in place for this step.** While they are in place, the three edge-shed routes never reach the API, so their `breeze_admission_decisions_total` series stay at 0. Every other route is now protected by the API.
4. **Remove the edge rules** (checklist below), once step 3 has run through at least one daily peak with no level-3 period lasting more than 5 min.
5. **Rollback:** set `BREEZE_ADMISSION_MODE=off` (the kill switch, no redeploy of code) and restart `api`. If the edge rules were already removed and the region is in distress, re-add them. Removing them is reversible on purpose.

**Caddy edge-rule removal checklist.** The rules live only in the hosted region's Caddyfile, never in the repo. This is an operator step after deploy; the PR does not touch infra.

- [ ] Confirm the API version on the region includes this wave. Run `curl -sf https://<region-host>/health` and check the `version` field.
- [ ] Confirm `breeze_admission_mode{mode="enforce"} 1` on the region's `/metrics/scrape`.
- [ ] Back up the live Caddyfile next to itself, with a dated suffix.
- [ ] Remove exactly these three edge responses. Each answered success while dropping the data:
  - `POST /api/v1/agents/<id>/logs` → `200 {"received":0}`
  - `POST /api/v1/agents/<id>/process-sample` → `201 {"success":true}`
  - `GET /api/v1/agents/<id>/unifi-collectors` → `{"collectors":[]}`
- [ ] Validate and reload Caddy. Validate first; a failed reload must not take the edge down: `caddy validate` in the container, then `caddy reload`.
- [ ] Within 10 min, confirm the routes now reach the API:
  - `http_requests_total{route="/api/v1/agents/:id/logs"}` and the other two routes increase on `/metrics/scrape`.
  - `breeze_admission_decisions_total{route=~".*(logs|process-sample|unifi-collectors)"}` moves only while the level is 1 or higher.
- [ ] Watch for 1 h, and again through the next daily peak:
  - Heartbeat p95 (`http_request_duration_seconds{route="/api/v1/agents/:id/heartbeat"}`) stays at or under 1 s.
  - `breeze_admission_level` holds no sustained level 3.
  - `breeze_db_pool_admission_waiting` does not climb without the level rising.
- [ ] Record the removal (date, region, who) in the release-sweep memory or the deploy note. Never record hostnames or IPs in the repo.

## Follow-ups to file at merge (not in this wave)

1. W04 gate: reserve permits per admission class for heartbeat and protected contexts (D10). This belongs on `PoolAdmission.acquire` options, next to `nested`.
2. `/api/v1/agent-ws/` gets its own isolated per-IP bucket in `globalRateLimit`, instead of sharing operators' 300/min (D11).
3. `POST /:id/logs` holds a request-long DB context through `arrayBuffer` + gunzip + `JSON.parse` (S2). Add `logs` to `SELF_MANAGED_DB_CONTEXT_ACTIONS` and open a short context around the insert only (#1105).
4. Classify the ee/workspace `crawl-config` poll, which is about 1 request per agent-minute, once that module ships enabled by default.
5. The server-side pong timeout (`agentWs.ts:542-543`, 40 s) is lag-sensitive. Under multi-second lag it can close healthy sockets. Revisit it with W09/W1e data.
6. Re-calibrate the default thresholds from W06/W07 data. Then propose flipping the default mode to `enforce` for self-host as well. That is an owner decision.

## Self-review

**1. Spec coverage (W1c).**

| Spec requirement | Where |
|---|---|
| Shed by priority on event-loop lag | Tasks 2, 4, 7 and 8 |
| Shed by priority on pool wait | Tasks 1, 2, 4, 7 and 8 |
| Inventory and collector PUTs first (bulk at level 1) | Task 5 table, Task 7 `decide` |
| Heartbeats last (protected; never shed, D1 deviation flagged) | Task 5 table and contract test, Task 7 test |
| `503` + `Retry-After` | Tasks 5, 7, 8 and 10 |
| WS token bucket per instance | Tasks 6–9 |
| Refuse with a delay hint (pre-upgrade 503 + `Retry-After` via the node-ws patch; D2 deviation flagged) | Task 9 |
| Remove the edge load-shedding | Rollout step 4 and the checklist |
| Acceptance: p95 heartbeat ≤ 1 s and pool ≥ 80 % (usable) under a storm | Task 12 (enforce, plus the observe control) |
| Spec Q3: shed before auth and body read, never in a DB context | Task 8 (behavioural test and mount test) |
| Spec Q4: WS bucket before DB work, old-agent reaction, presence and markOffline | Tasks 8, 9 and D13 |
| Spec Q5: heartbeat last resort defined | D1 |
| Spec Q6: env, safe defaults, kill switch, self-host identical | Task 3; `observe` default |
| Spec Q7: metrics | Task 7, plus the Task 10 counter |
| Spec Q8: unit, integration and acceptance | Tasks 1–12 |
| Spec Q9: ops removal | Checklist above |
| Coordinator ask: #8243 → W04 → W08 order | Header, Task 1 Step 0 |
| Coordinator ask: own the `DbPoolAcquireTimeoutError` → `503` mapping | Task 10 |
| Coordinator ask: no parallel pool measure | Task 1 adapter over W04's gate |

**2. Placeholder scan.** There is no TBD, TODO or "similar to Task N". Every code step carries its code.

Three places say "verify, then adapt":
- Task 1 Step 0, for W04 names that its #8243 amendment may rename;
- Task 2 Step 1, which reuses `eventLoopMonitor.test.ts`'s own harness;
- Task 9 Step 5, which reuses `agentWs.test.ts` helpers that already exist.

Each names the exact symbol to find and what to do if it differs.

**3. Type consistency.** These names match across tasks:
- `PoolSignals` (Task 1) → `AdmissionSignals.pool` (Task 2) → test fixtures (Tasks 4 and 7);
- `dbWaitMs`, `oldestDbWaitMs`, `msSinceLastDbTimeout`, `peakLagMs`, `lagMs` (Tasks 2, 4 and 7);
- `AdmissionConfig.dbWaitMs` and `BREEZE_ADMISSION_DB_WAIT_MS` (Task 3);
- `ADMISSION_DB_TIMEOUT_FLOOR_MS` (Tasks 3 and 4);
- `AdmissionTrigger` = `none | lag | db | db_timeout | emergency` (Task 4, Task 7 docs);
- `ClassifiedRequest { cls, key, label }` (Tasks 5, 7 and 8);
- `AdmissionGate` and `AdmissionDecision` (Tasks 7 and 8);
- `WsSetupSlot` (Tasks 6, 8 and 9);
- `ShedReason` (Task 7);
- `DbSaturationKind` and `recordDbSaturationResponse` (Tasks 7 and 10).

**4. Review Focus.** Each of the five has its test in its owning task: Tasks 9/8, 4, 1, 5/8, and 7. One further risk is covered by tests: a `Retry-After` on `/logs` long enough to block agent shutdown (Task 5 test, ≤ 4 s).

**Owner decisions requested (also in the PR body):**
1. Accept the D1 deviation: heartbeats are never shed in W08.
2. Accept the D2 deviation, and amend the W1c wording to "refuse before the upgrade with HTTP 503 + `Retry-After`".
3. Accept `observe` as the shipped default, with hosted enforcement switched on per region via env (rollout step 3).
4. Accept the monitoring-results gap at level 2 (D8).
5. Accept the D13 deferral of `onClose` offline writes under load, which the quorum did not review.
