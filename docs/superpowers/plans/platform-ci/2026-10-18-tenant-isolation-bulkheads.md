---
title: "Tenant-isolation bulkheads for the shared API: pool lanes, tenant fair share, request-long txn cleanup, site connectivity signal"
date: 2026-10-18
tracking_issue: LanternOps/breeze#8840
related: "#8838 (closed by #8851), #8839 (closed by #8850), #8841 (closed by #9145), #8842 (merged alerts), W04 #8143, W08 #8147/#8456, W09 #8148"
rigor: HIGH (concurrency, multi-tenant fairness, agent-facing behaviour under load)
---

# Tenant-Isolation Bulkheads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When one tenant's network or workload misbehaves, that tenant degrades and the platform does not. The web console keeps working while agent ingest saturates the DB pool. No single org can hold more than its share of the agent capacity. No agent route holds a pooled transaction across Redis, BullMQ or a second connection. Partners can see "agent connectivity degraded at site X".

**Architecture:** There is still one postgres.js pool and one permit gate (`db/poolAdmission.ts`). Each permit is now charged to a **lane**: `interactive`, `agent` or `background`. A leaf AsyncLocalStorage (`db/poolLane.ts`) carries the lane, and the authenticating middleware sets it. A reserve of permits is held back for `interactive` and nested acquirers. Inside the agent lane, waiters are served **round-robin across tenants**, under a hard per-tenant ceiling. A waiter held back only by its own tenant's ceiling is kept out of W08's global pressure signals and is answered `429`, not `503`. Separate PRs move the remaining non-DB work out of the request-long agent transaction (Redis, BullMQ, nested slots). The WS close metric gets an exhaustive reason enum and a once-per-socket latch. A Redis-only site connectivity signal feeds partner and admin read routes and the UI. A per-org error-rate **breaker that throttles** is designed here, but it is gated behind evidence and not scheduled (D4).

**Tech Stack:** Hono 4.13, postgres.js 3.4.9 via Drizzle, `node:async_hooks` AsyncLocalStorage, ioredis, `prom-client` 15, Vitest 4 (unit + `vitest.integration.config.ts`), promtool (`monitoring/rules/tests`), Astro + React islands (web), the Go agent simulator `agent/tools/agentsim` + k6 `load-tests/scenarios` for lab gates.

**Spec:** Issue #8840: the body (protections A–H) and the comment "Survey of what already exists" (gap list 1–6). The inputs this builds on are `docs/superpowers/plans/platform-ci/2026-10-08-scaling-w04-prologue-pool-reclamation.md` (the gate), `2026-10-08-scaling-w08-api-admission-control.md` (admission; its D10 explicitly defers "reserve permits per class" to the W04 gate, which this plan does), `2026-10-12-scaling-w06-storm-scenarios.md` (storm harness) and `2026-10-12-scaling-w09-agent-reconnect-drain.md` (agent loop-level deferral, not implemented).

## Premise check (verified on `origin/main` d49876c54d, 2026-10-18)

| Claim | Evidence | Status |
|---|---|---|
| The pool gate has no per-class or per-tenant partitioning, only the nested reserve | `apps/api/src/db/poolAdmission.ts`: `nestedReserveFor` (1 permit at ≥3), `canGrant(nested)`; `acquire(label, {nested, signal})` called only from `runInPoolSlot` (`db/index.ts` ~625) | holds |
| W08 admission exists and defaults to observe | `services/admission/admissionConfig.ts` `ADMISSION_DEFAULTS.mode: 'observe'`; `middleware/agentAdmission.ts` mounted at `index.ts:488` | holds |
| No per-org error-rate breaker for agents | `grep -ril 'circuit.\?breaker'` matches only AI-agent (`services/aiAgents/agentCircuit.ts`), log forwarding and event bus code | holds |
| #8539, #8850, #8851, #8842 merged | `gh pr view`: merged 10-15, 10-16, 10-16, 10-16 | holds; **not re-planned** |
| #8841 done | closed by #9145 (merged 2026-10-18). `agent/internal/websocket/reconnect_backoff.go`: jittered 1–5 s after a server close, exponential for abnormal closes, `Retry-After` on a refused upgrade honoured (300 s cap, +0–30 % jitter), 250 ms floor. **Unreleased**: agents in the field still re-dial at once after an accepted socket closes, but they do back off after a failed dial | holds |
| W09 loop-level `Retry-After` deferral | `agent/internal/heartbeat/` has no `loop_deferral.go`; issue #8148 open | **not implemented**: shipped agents honour `Retry-After` only inside one `httputil.Do` call |

What the merged PRs left open, and only this, is planned below:

- #8851 kept the lease TTL at 30 s. It counts only credential closes (`breeze_agent_ws_closed_total{reason=denied|unverified_grace_expired|revoked}`). The 4002/4008/1008/`Token suspended`/`disconnectAgent` closes and abnormal peer closes are not counted.
- #8842 left `AgentWsMassClose` as a TODO (`monitoring/rules/breeze-rules.yml:172`).
- #8850 buffers bodies before the wrap, but the wrap still holds the transaction across non-DB work. See D2 for the audit.

## Global Constraints

- **Rigor: high.** Every task is red-first. One independent review round per implementation PR. Run the full suite plus the integration suites before each PR (`pnpm test` does not run them).
- **One pool, one gate.** No second postgres.js pool, and no change to the driver `max`. The gate still never admits more transactions than `DB_POOL_MAX`. Permits still return only when the underlying transaction settles (W04 invariant, `poolAdmission.ts` header).
- **Leaf-module rule.** `db/poolAdmission.ts` and the new `db/poolLane.ts` import nothing but `node:async_hooks` and `./prologueDeadline`. `db/index.ts` gains no import of `services/**`. `db/requestDatabasePool.test.ts` re-imports that graph under a hard 15 s budget.
- **#1105 / DB context rules.** Redis, BullMQ, HTTP and object-storage calls never run while a pooled transaction is held. `runOutsideDbContext` does **not** release the outer transaction (`db/index.ts:1226`). Moving work out means `runAfterDbContextCommit` / `runAfterDbContextExit`, or a self-managed route.
- **No new table, no migration.** Breaker and connectivity state live in Redis. If a task finds it needs a table, stop and re-plan. The slot to use would be `apps/api/migrations/2026-12-31-220000-<slug>.sql` (the newest committed is `2026-12-31-170000-m365-consent-sessions-v2-only.sql`; re-verify it still sorts last), with the full `docs/agents/tenancy-rls.md` registration (cascade, merge registry, export policy).
- **No agent wire change, so no `MIN_AGENT_VERSION_*` constant.** Every refusal added here is `429` or `503` with `Retry-After` on an HTTP request, or on the WS upgrade before it is accepted. Every shipped agent retries both (`agent/internal/httputil/retry.go` `isRetryableStatus`). Agents since v0.64.3 honour `Retry-After` inside the call, capped at 300 s (`retryafter.go`). Pre-#9145 agents back off after a refused upgrade through dial-failure backoff. No task may refuse by accepting a socket and then closing it (W08 constraint).
- **`Retry-After` values** come from `services/admission/agentRouteClasses.ts` `retryAfterRange(req)`, which keeps the `POST /:id/logs` 2–4 s override (the log shipper sleeps without a context and blocks `Stop()`, `agent/internal/logging/shipper.go:579,193`). No uniform 120–180 s header.
- **Revocation is never weakened.** `AGENT_CREDENTIAL_RECHECK_TTL_MS` stays 30 000. Definitive denial still closes at once. Grace stays anchored to the last DB confirmation. The Redis revocation path is unchanged (D3).
- **Prometheus cardinality.** No `org`, `site`, `partner`, `device` or `agent` label on any series. Labels are bounded enums (`lane` ∈ 3, `reason` ∈ ≤ 12, `signal` ∈ ≤ 6). Per-tenant attribution goes to throttled log lines and to the Redis-backed routes.
- **Every new env var** is added to `apps/api/src/system/connections/internalEnvVars.ts`, mapped as `${VAR:-}` in the `x-api-env` anchor of **both** `docker-compose.yml` and `deploy/docker-compose.prod.yml`, commented in `.env.example`, and documented in `apps/docs/src/content/docs/deploy/environment.mdx`. `''` means unset. An invalid value falls back to the default with a warning naming the variable, and never refuses boot. Ratchets: `system/connections/envInventory.test.ts`, `config/envComposeParity.test.ts`, `config/envReadComposeCoverage.test.ts`. This plan adds exactly three: `DB_POOL_INTERACTIVE_RESERVE`, `DB_POOL_AGENT_TENANT_MAX_SHARE`, `BREEZE_AGENT_CONNECTIVITY_SIGNALS`.
- **Contract tests that fire.** A new route module needs an entry in `services/mcpCoverage.ts`, checked by `__tests__/mcp-coverage.test.ts`. A new AI tool goes through the aiTools contract suites (they key `SAFE_WRITE_SITES` by line number, and `z.undefined()` in a schema empties the tool list). Web mutations use `runAction` (`apps/web/src/lib/__tests__/no-silent-mutations.test.ts`). Web copy goes into all 8 locales (`en de-DE es-419 fr-CA fr-FR it-IT pt-BR tr-TR`), checked by `apps/web/src/lib/i18n/localeParity.test.ts`; any API-side copy is checked by `apps/api/src/i18n/localeParity.test.ts`. **No BullMQ job or worker is added**, so `jobs/workerReadinessCoverage.test.ts`, `services/workerEntrypointClosure.contract.test.ts` and `__tests__/parkedFanout.contract.test.ts` do not fire. If a task adds one, they do.
- **Vitest:** `cd apps/api && npx vitest run <file>` (unit) and `cd apps/api && npx vitest run -c vitest.integration.config.ts <file>` (integration, per-worktree `pnpm test-stack up` first, `pnpm test-stack down` after). Never `pnpm --filter <pkg> test -- --run <path>`. Path filters are substring matches, so check the reported file count. Typecheck with `NODE_OPTIONS=--max-old-space-size=12288 pnpm exec tsc --build apps/api/tsconfig.tests.json`, and read the exit code (never pipe it to `tail`).
- **PRs target `main`, one protection per PR.** Stacked PRs get no CI (`ci.yml` triggers on PRs to main only). A PR that depends on another waits for that one to merge, then branches from fresh `main`.
- No customer names, hostnames, IPs or regions in code, tests, docs or PR text.

## Review Focus

1. **The reserve is defeated through a side door.** Expected: no agent-origin or background acquisition ever holds one of the `interactiveReserve` permits. That includes nested escalations from an agent parent, detached work started from an agent request, and an agent request whose lane store was never set. Tests: Task A Step 1 `agent-lane nested escalations borrow only the nested reserve, never the interactive reserve`, Task A Step 5 `no store means background`.
2. **Interactive privilege leaks into detached work.** Expected: fire-and-forget work started by a user request (for example `writeAuditEvent`, `void withSystemDbAccessContext(...)`) that runs after the response settles is charged as `background`. Test: Task A Step 5 `a settled interactive store is charged as background`.
3. **One capped tenant raises global admission.** Expected: while tenant A's agent waiters are held only by A's ceiling and permits are free, W08's `dbWaitMs`, `oldestDbWaitMs` and `msSinceLastDbTimeout` stay at their unloaded values, and other tenants are not shed. Tests: Task B Step 1 `waiters blocked only by their tenant ceiling do not raise waitStats`, Task B Step 5 `tenant-ceiling expiries are not counted as DB timeouts`.
4. **A self-deadlock reappears.** Expected: no lane cap ever refuses a nested acquisition that the old gate would have granted from the nested reserve, so a depth-1 escalation still always completes. Test: Task A Step 1 `a nested acquisition is granted from the nested reserve even when its lane is at cap`.
5. **A forged credential throttles a real site.** Expected: no unauthenticated input (an agent id in the URL with a bad token) moves any site connectivity counter that drives `degraded`. Test: Task G Step 2 `auth rejections are never recorded as site connectivity signals`.

---

## Design decisions

### Advisor quorum

Claude (author, Opus) wrote a position. Codex (`gpt-6.1-sol`, `xhigh`, read-only sandbox) reviewed it against the code. **Outcome: agreement on 1, 2, 5 and 6 after amendments. On 3 and 4 the position changed to Codex's view on the merits. Nothing is left unresolved.** Disagreements and their resolutions:

| # | Draft | Codex | Resolution |
|---|---|---|---|
| Q1 | Ceiling-blocked waiters behave like ordinary pool waiters | W08 reads the oldest waiter and acquire expiries as global pressure, so one capped tenant could shed every tenant | **Adopted.** Waiters held only by their own ceiling are excluded from `waitStats()` and from the DB-timeout total, and get `429` (D1.4) |
| Q2 | Tenant key = `context.orgId` of organization-scope contexts | Carry the authenticated tenant independently of RLS scope; system-context work for a known agent was unattributed | **Adopted.** `agentAuthMiddleware` sets the tenant on the lane store after the device lookup, and every later acquisition in the request carries it |
| Q3 | Lane inherited by everything under the request | Detached work inherits interactive privilege | **Adopted** via a `settled` flag, not by enumerating every fire-and-forget site (D1.2) |
| Q4 | Raise the WS lease TTL to 60 s while the revocation subscriber is healthy | A healthy subscriber cannot prove a given publish was delivered (publish is best-effort); 60 s doubles the fallback exposure | **Adopted: TTL stays 30 s** (D3) |
| Q5 | Count closes at each `ws.close` call | Counting before `close()` with no latch double-counts and misses peer closes | **Adopted:** a once-per-socket terminal latch, plus abnormal peer closes (D3) |
| Q6 | Site breaker trips on body stalls, auth failures and short-lived WS closes, observe first, then enforce | Do not enforce yet. #8850 removed the proven DB-pin mechanism, so measure the residual harm first. Never let auth failures trip it (attacker-chosen agent ids). Pong-timeout closes do not fit a <30 s window | **Adopted.** Visibility ships (Tasks G–H). Enforcement is designed but gated on evidence (D4.5, Todd decision) |
| Q7 | All alerts in one final PR | Ship each alert with the metric and protection it watches | **Adopted** |

### D1 — Pool partitioning: lanes inside one gate, tenant fair share inside the agent lane

**D1.1 Why not per-tenant bulkheads or a second pool.** Hundreds of orgs share 30–35 permits, so static per-tenant partitions cannot be sized and would leave capacity idle. A second pool adds connections without isolating Postgres CPU or locks. It would also double the abandonment and reclaim surface that W04 built (`abandonedSlotReclaim.ts`). Lanes are accounting on the existing permits. The gate's cancellation, abandonment and settle rules stay as they are.

**D1.2 The lane and how it is set.** `db/poolLane.ts` holds an `AsyncLocalStorage<PoolLaneStore>`:

```ts
export type PoolLane = 'interactive' | 'agent' | 'background';
export interface PoolLaneStore {
  readonly lane: PoolLane;
  tenantKey: string | null;     // agent lane only; set after the device lookup
  settled: boolean;              // set when the request's response is done
  lastAcquireBlockedBy?: 'capacity' | 'tenant_ceiling';
}
```

- The authenticating middleware sets the lane. **Interactive:** `authMiddleware`, `apiKeyAuthMiddleware`, `partnerApiAuthMiddleware`, `bearerTokenAuthMiddleware`, `partnerServicePrincipalMcpAuthMiddleware`, `officeAddinTechAuthMiddleware`, `clientAiAuthMiddleware`, `portalAuthMiddleware`. **Agent:** `agentAuthMiddleware` (this also covers the extension gateway's `/agent/*` paths, `extensions/gateway.ts:122`), the agent WS pre-upgrade validator, and every handler returned by `createAgentWsHandlers`. WS event callbacks do not reliably inherit the request's ALS, so each is wrapped explicitly. A path rule also marks `/api/v1/auth/*` (login, refresh, MFA) interactive, because those run before any auth middleware.
- Everything else gets no store and is charged as `background`: unauthenticated routes, inbound webhooks, timers, in-process BullMQ workers in the `all` role, and helper auth. **Fail-safe direction:** a path nobody marked can never take the reserve.
- A store with `lane: 'interactive'` and `settled: true` is charged as `background` (Q3). Work that outlives its user request has no claim on the reserve. An agent store keeps its lane and tenant after it settles, so detached work still counts against its tenant.
- A nested acquisition is charged to its **parent slot's** lane, not the current store.
- A contract test (`middleware/poolLaneCoverage.test.ts`) fails if an exported `*AuthMiddleware` in `apps/api/src/middleware/` or `routes/portal/auth.ts` has no entry in `POOL_LANE_BY_AUTH_MIDDLEWARE`, which maps each middleware to `'interactive' | 'agent' | 'background'`. It also fails if a mapped interactive or agent middleware's source does not call `runWithPoolLane`. Same mechanism as the cascade lists: grep, don't judge.

**D1.3 Capacity rules** (P = permits, N = nested reserve, R = interactive reserve, S = shared capacity = P − N − R):

| Acquirer | Granted when |
|---|---|
| top-level `interactive` | `inUse < P − N` (it may use idle shared capacity: work-conserving) |
| top-level `agent` / `background` | `inUse < P − N` **and** `sharedInUse < S` (+ tenant rule, D1.4) |
| nested, interactive parent | `inUse < P` (today's rule) |
| nested, agent/background parent | `inUse < P` **and** (`sharedInUse < S` **or** `nestedBorrowed < N`) |

`sharedInUse` counts every slot charged to agent or background, nested included. `nestedBorrowed` counts the shared-lane nested slots granted over S. So agent and background together hold at most S + N = P − R permits, and interactive always keeps R. A depth-1 escalation is still always servable from N (Review Focus 4). Drain order on every release: the first eligible nested waiter, then the interactive head, then the shared queue (FIFO in Task A, round-robin by tenant in Task B).

**Reserve size.** `interactiveReserveFor(P)`:

| P | R |
|---|---|
| ≥ 10 | `max(2, round(0.2 × P))` |
| 5–9 | 1 |
| < 5 | 0, with a boot warning like the existing nested-reserve warning |

That gives 35 → 7 (S = 27) and 30 → 6 (S = 23). Override with `DB_POOL_INTERACTIVE_RESERVE`: an integer in `[0, P − N − 1]`; anything else falls back to the default with a warning. `0` is the kill switch and restores today's single-lane behaviour exactly. There is no observe mode: the reserve only changes **who** waits when the pool is full, never whether a request is refused.

Why 20 %: in the 10-15 incident the console needed a handful of concurrent transactions. 7 of 35 covers several staff working at once, and agents keep 27 + 1. The lab gate (Task A Step 14) pins the sizing: UI p95 < 1 s while the agent lane is at 100 %.

**D1.4 Tenant fair share (agent lane).**

- Agent waiters queue per `tenantKey`, FIFO within a tenant, and are served round-robin across tenants. Background waiters and agent waiters with no tenant yet (the auth SELECT) are two more round-robin members, exempt from the ceiling.
- **Ceiling.** C = `max(1, floor(share × S))`, with `share` from `DB_POOL_AGENT_TENANT_MAX_SHARE` (a number in (0, 1], default 0.5, so 27 → 13). A tenant with `tenantInUse ≥ C` is skipped. `1` disables the ceiling and keeps round-robin. 0.5 is a starting value: the ceiling deliberately leaves capacity idle when only one tenant wants it. Tune it from `breeze_db_pool_agent_tenant_ceiling_waiting` after the soak.
- **Kept out of global signals (Q1).**
  - `waitStats()` (W08's input) skips waiters whose tenant is at its ceiling when it computes `oldestWaitMs`.
  - A grant to a waiter that was ever ceiling-blocked is recorded in that tenant's stats, not the global p95.
  - A waiter cancelled at acquire expiry while its tenant is at the ceiling counts as `tenantCeilingCancelled`. `services/admission/poolSignals.ts` subtracts that total from `dbTimeoutsTotal`.
- **Response.** The gate reports the blocker through `AcquireOptions.onCancelled(blockedBy)`, which `runInPoolSlot` points at the request's lane store. `middleware/dbSaturationResponse.ts` then answers a `tenant_ceiling` expiry with **`429`** `{ code: 'TENANT_POOL_SHARE_EXCEEDED' }` + `Retry-After` 30–45 s, not `503`.
- The interactive lane has **no tenant ceiling in v1**. This is a known limitation: `globalRateLimit` is a per-IP rate cap, not concurrency isolation. Partner-API automation fairness is a follow-up, once `breeze_db_pool_lane_*{lane="interactive"}` shows it is needed.

### D2 — Remaining request-long transactions (audit of all 33 wrapped routes)

A read-only audit covered every route that `agentAuthMiddleware` wraps (`agentAuth.ts:1147`). All per-agent, per-IP and per-org rate limiters run **before** the wrap (`agentAuth.ts:799, 882, 900–918`). Inside the wrap, this is what is left:

| Route (class) | Non-DB work inside the transaction | Cadence | Decision |
|---|---|---|---|
| `PUT /:id/software` (bulk) | `ingestSoftwareInventoryReport` opens `runOutsideDbContext(withSystemDbAccessContext(retryOnTransientLockError(db.transaction)))` (`services/softwareInventoryObservations.ts:356`): a **second permit for the whole ingest**, from the 1-permit nested reserve, with up to 3 × 5 s `lock_timeout`. Plus SHA-256 over up to 5 MB | every 15 min per device, alongside 7 other inventory PUTs (`agent/internal/heartbeat/heartbeat.go` `sendInventory`) | **Split (Task C):** self-managed, body still buffered |
| `POST /:id/logs` (bulk) | 2× Redis MULTI ingest quota (`routes/agents/logs.ts:207–228`), gunzip up to 10 MB, JSON parse/stringify | ~1/min per active device | **Split (Task D):** self-managed; quota + decode before one short context |
| `PUT /:id/changes` (standard) | 2× Redis MULTI quota (`changes.ts:178–199`), gunzip up to 10 MB | on a non-empty diff, 15 min | **Split (Task D)**, same shape as logs |
| `PUT /:id/sessions` (standard) | serial awaited `publishEvent` per login/logout (`sessions.ts:195`, Redis XADD + 2 PUBLISH) | 5 min | **Split (Task D):** events after commit. **Keep** the device share lock through the principal writes (`sessions.ts:165` `.for('share')`) |
| `PUT /:id/peripherals/events` (standard) | awaited nested `runOutsideDbContext(withSystemDbAccessContext)` (`peripherals.ts:86`), awaited `publishEvent` per blocked event (`:141`) | low | **Split (Task D):** publish after commit; the nested read joins the outer transaction |
| `POST /:id/message-events` (standard) | Redis `SET NX` (`:157`), **awaited** `writeAuditEventAsync`, a nested transaction (`:162`) | low | **Split (Task D):** both after commit |
| `POST /:id/commands/:commandId/result` (protected) | bare-pool read via `runOutsideDbContext` (`commands.ts:292`), a second connection outside the gate. Per command type: BullMQ enqueues (`commandResultHandlers.ts:148, 398, 832`, `commands.ts:843`), awaited `publishEvent` (`helpers.ts:1101, 1115, 1173`), `queueCommandForExecution` incl. a WS send (`commands.ts:779`, `helpers.ts:2048`), nested system contexts (restore points `:747`, topology `:809, 825`) | per command, fleet-wide bursts | **Split side effects (Task E).** Keep the route wrapped: dozens of handler branches rely on the ambient org context. Move enqueues, publishes and dispatch to `runAfterDbContextCommit`. The bare-pool read joins the transaction (READ COMMITTED sees rows committed before the statement) |
| `POST /:id/commands/:commandId/pam-observations` (protected) | Redis rate limit + bare-pool read (`pamObservations.ts:62, 71`) | low | **Leave.** Follow-up issue: same fix shape as Task E |
| rotate-token ×2, patches ×3, security/status, management/posture, recovery-keys | fire-and-forget `writeAuditEvent` (a brief nested slot, not awaited) | low | **Leave.** Not on the hold path. The nested slot is charged to the parent's lane (D1.3) |
| hardware (`queueWarrantySyncForDevice`), hardware-health (`requestDeviceGroupReevaluation`) | un-awaited BullMQ add | rare | **Leave.** Not on the hold path |
| `PUT /:id/workloads` | Redis settings read | no agent sender yet | **Leave** |
| the remaining 13 (uninstall-intent, winget ×2, config, yara, time-status, boot-performance, disks, network, connections, warranty-info, registry-state, config-state, process-sample) | none (DB or local CPU only) | — | **Leave**: the wrap is fine once the body is buffered (#8850) |

Zod parsing of a buffered ≤ 5 MB body still runs inside the wrap on every route. That is CPU inside the transaction. **Leave** for now: moving validation before the context means restructuring every route. Task C measures it, and the follow-up is filed only if `held a pooled connection` warnings attribute holds to it.

Two other agent-auth mounts were not audited: the extension gateway (`extensions/gateway.ts:117–124`) and `ee/workspace/src/routes/agent.ts`. Task C Step 1 audits both and records the result in the PR body.

### D3 — WS credential re-check: only metrics are left

#8851's semantics are confirmed in `routes/agentWs.ts`:

| Constant / behaviour | Value or rule | Where |
|---|---|---|
| Tri-state `authorized \| denied \| unknown` | — | — |
| `AGENT_CREDENTIAL_RECHECK_TTL_MS` | 30 000 | `:297` |
| `_TIMEOUT_MS` | 2 000 | `:298` |
| `_GRACE_MS` | 120 000, anchored to the last confirmation (incl. the upgrade's `credentialValidatedAt`) | `:305` |
| `_UNKNOWN_RETRY_MS` | 5 000 | `:320` |
| Concurrent re-check queries per socket | at most one | — |
| Late `denied` | still closes | — |
| Redis revocation path | unchanged | `:354–470` |

Decisions:

- **TTL stays 30 s (Q4).** At 300 sockets that is about 10 re-check reads/s. A 10k fleet needs about 333/s. That load runs in the agent lane (D1), so it cannot starve the console. Revisit only with a measured re-check rate at W5 scale. The trade-off is revocation exposure, not cost.
- **Close accounting (Q5).** Every server-initiated close goes through one helper, `closeAgentSocket(ws, code, reason, metricReason)`. It latches once per socket, records `breeze_agent_ws_closed_total{reason}` and then calls `ws.close`. `onClose` records peer-initiated ends exactly once through the same latch: `peer_normal` for 1000/1001, `peer_abnormal` for anything else including 1006.
  - Reason enum: `denied`, `unverified_grace_expired`, `revoked`, `token_suspended`, `superseded`, `pong_timeout`, `message_rate`, `server_disconnect`, `peer_normal`, `peer_abnormal`.
  - The existing three keep their names, so #8851's dashboards keep working.
- **Server-side storm damping:** nothing new. W08's WS token bucket and setup slots (`admissionRuntime.ts:176`) already cover it, and the remaining step is enforcing them (Task 0). Per-tenant WS fairness is deferred: upgrades are refused before auth, when no tenant is known.

### D4 — Per-tenant error-rate breaker: visibility now, enforcement gated

**D4.1 Why visibility first (Q6).** The 10-15 harm mechanism was a stalled body pinning a permit. #8850 removed it: a refused body now holds nothing (`heldMs=0`). What remains is unmeasured: sockets and memory held for up to the 15 s stall deadline, and retry amplification. A second error-driven shedding controller, stacked on W08, is not justified until observe data shows harm. The diagnostic value, telling the MSP "your site X's network is breaking agent uploads", is justified now.

**D4.2 Key: site** (`orgId` + `siteId`). Bad networks are per location, and the partner signal the issue asks for is "degraded at site X". Org is derived when needed.

**D4.3 Signals** (authenticated only; Review Focus 5):

| Signal | Source | Notes |
|---|---|---|
| `body_stalled` | `agentRequestBody.ts` 408 (its metric reason `timeout`) | |
| `body_aborted` | `agentRequestBody.ts` 400 (reason `aborted`) | |
| `body_oversize` | `agentRequestBody.ts` 413 (reason `too_large`) | counted, but not a failure for `degraded` |
| `ws_peer_abnormal` | D3 latch, sockets that lived < 60 s | **not** `pong_timeout`: that timer runs longer and has its own reason |
| `requests` | denominator: every authenticated agent request, incremented fire-and-forget after the device lookup | |

**Never recorded:** auth rejections (the agent id comes from the URL and is untrusted), pool or prologue timeouts (global pressure, which would punish the victims), and admission sheds.

**D4.4 Storage: Redis only, no table.**

| Key | Contents / ops | TTL |
|---|---|---|
| `agent_conn:{siteId}:{hourEpoch}` | hash, one field per signal; `HINCRBY` | 26 h |
| `agent_conn:dev:{siteId}:{hourEpoch}` | HyperLogLog of devices that produced a failure signal; `PFADD` | 26 h |
| `agent_conn:sites:{orgId}` | set of siteIds with any failure in the last 26 h | 26 h, refreshed |
| `agent_conn:degraded` | sorted set siteId → last-degraded-at, for the admin list; trimmed on read to 26 h | — |

- All writes are pipelined, fire-and-forget, outside any DB context, and fail open: a Redis error drops the sample and bumps `breeze_agent_conn_signal_write_failures_total`.
- **Derived state**, computed on read:
  - **degraded** in the trailing 60 min when failures (`body_stalled + body_aborted + ws_peer_abnormal`) ≥ 30, failures/`requests` ≥ 5 %, and distinct failing devices ≥ `min(3, devices that sent requests)`.
  - **recovering** when degraded in the previous hour but not now.
  - **healthy** otherwise.
- **Recovery evidence** is the denominator. A site is only **healthy** again when it keeps sending requests with a low failure ratio, never because it went quiet. A site with no requests in the window reads `no_traffic`, not healthy.
- Mode `BREEZE_AGENT_CONNECTIVITY_SIGNALS=off|on` (default `on`) is the kill switch for the writes.

**D4.5 Enforcement (designed, NOT scheduled; Todd go/no-go after the soak).** Start only if observe data from the routes shows a degraded site measurably harming others, for example aborted or stalled bodies correlating with `ApiEventLoopLagHigh` or socket exhaustion. The design, so the decision is concrete:

- **When.** On a degraded site, bulk and standard REST (never protected classes, never WS upgrades) gets `429` `{ code: 'AGENT_SITE_THROTTLED' }`, with `Retry-After` from `retryAfterRange`, jittered. The check goes after the device lookup in `agentAuthMiddleware` (`~agentAuth.ts:753`), before the rate limiters and body buffering. It reads a 5 s per-process cache and fails open.
- **State machine.** The trip, a retained backoff history (5 min × 2^(trips−1), capped at 30 min, history decays after 60 min clean) and the half-open probe are one atomic Redis Lua transition. The probe admits 10 % of requests and needs ≥ 20 probe successes at ≤ 5 % failure to close.
- **Rollout.** Mode `BREEZE_AGENT_BREAKER_MODE=off|observe|enforce`, default `observe`. It interacts with W08 by composition only: admission sheds globally per instance first, at the front door; the breaker throttles per site after auth. Enforce after ≥ 7 days of observe, with every `would_throttle` site checked against its `agent_logs`.
- **What it would add.** One env var, and contract tests at the auth layer.

**D4.6 Partner-visible signal.** Derived on read, with no persisted notifications.

- **Partner route** `GET /api/v1/agent-connectivity/orgs/:orgId/sites`. Requires `devices:read` and is narrowed to the caller's site access (the same app-layer narrowing as `services/aiToolsAgentLogs.ts:100` `buildAgentLogConditions`). The cache is keyed by org, and the site filter is applied **after** the cache.
- **Admin route** `GET /api/v1/admin/agent-connectivity` (platform admin). Reads `agent_conn:degraded` and joins org, site and partner names in a system context.
- **UI.** A card on the organization record page and an admin page (Task H; UI home is a Todd decision).
- **Read-only AI tool** `get_agent_connectivity`.
- **Deferred.** A connection-health digest or notification would need a SQL-backed `HealthSource` (`services/connectionHealth/types.ts:53` `brokenQuery`), so it is deferred.

### D5 — Backpressure to agents

| Condition | Response | Who answers |
|---|---|---|
| Global overload (event loop / pool, W08) | `503` + `Retry-After` (class range) | `agentAdmission` (exists; enforce = Task 0) |
| DB acquire/prologue timeout | `503` + `Retry-After` 30–45 s | `dbSaturationResponse` (exists) |
| Tenant pool ceiling expiry | `429` `TENANT_POOL_SHARE_EXCEEDED` + `Retry-After` 30–45 s | `dbSaturationResponse` (Task B) |
| Per-agent / per-IP / per-org rate | `429` + `Retry-After` | `agentAuth` (exists) |
| WS upgrade over budget | `503` `WS_UPGRADE_REFUSED` + `Retry-After` **before** upgrade | W08 (exists) |
| (gated) site breaker | `429` `AGENT_SITE_THROTTLED` + `Retry-After` | D4.5 |

- **What shipped agents do.**
  - They retry 429/5xx up to 4× inside one call, honouring `Retry-After` (cap 300 s, positive jitter). A value ≥ 30 s therefore means one attempt per cycle.
  - The deferral ends with the call, because the W09 loop-level deferral is not shipped. Cross-cycle deferral is W09's job, not this plan's.
  - Agents with #9145 honour `Retry-After` on a refused upgrade. Older agents back off after a failed dial (1 → 60 s ±30 %).
- **No WS `drain` message here.** W09 owns the wire contract and W5c the sender.
- **`MIN_AGENT_VERSION_*`: none.** No agent changes behaviour, and no new header or field is required.

### D6 — Observability

| Series (new) | Type / labels | Task |
|---|---|---|
| `breeze_db_pool_lane_in_use` | gauge `{lane}` | A |
| `breeze_db_pool_lane_waiting` | gauge `{lane}` | A |
| `breeze_db_pool_lane_grant_wait_p95_seconds` | gauge `{lane}`, same 3 s window as `POOL_WAIT_STATS_WINDOW_MS` | A |
| `breeze_db_pool_interactive_reserve` | gauge | A |
| `breeze_db_pool_agent_tenant_ceiling` | gauge | B |
| `breeze_db_pool_agent_top_tenant_permits` | gauge: max permits held by any one tenant (scalar, no label) | B |
| `breeze_db_pool_agent_tenant_ceiling_waiting` | gauge: waiters held only by their ceiling | B |
| `breeze_db_pool_agent_tenant_ceiling_cancelled_total` | counter | B |
| `breeze_admission_db_saturation_responses_total{kind}` | existing; `kind` gains `tenant_ceiling` | B |
| `breeze_agent_ws_closed_total{reason}` | existing; enum extended (D3) | F |
| `breeze_agent_conn_signals_total{signal}` | counter, no site label | G |
| `breeze_agent_conn_degraded_sites` | gauge, refreshed by a 30 s unref'd timer in the API process | G |
| `breeze_agent_conn_signal_write_failures_total` | counter | G |

**Alerts**, each shipped with its feature PR and a promtool case that fires plus one that stays silent:

| Alert | Expression | `for` | Severity | Task |
|---|---|---|---|---|
| `ApiDbPoolInteractiveWaiting` | `max by (job, instance) (breeze_db_pool_lane_waiting{job=~"breeze-api.*",lane="interactive"}) > 0` | 2m | warning | A |
| `ApiDbPoolTenantCeilingSustained` | `max by (job, instance) (breeze_db_pool_agent_tenant_ceiling_waiting{job=~"breeze-api.*"}) > 0` | 5m | warning | B |
| `AgentWsMassClose` (replaces the TODO) | `sum by (job, instance) (increase(breeze_agent_ws_closed_total{job=~"breeze-api.*",reason=~"denied\|unverified_grace_expired\|revoked"}[5m])) > 50` | 0m | critical | F |
| `AgentWsPeerAbnormalSpike` | `sum by (job, instance) (increase(breeze_agent_ws_closed_total{job=~"breeze-api.*",reason="peer_abnormal"}[5m])) > 200` | 5m | warning | F |
| `AgentSiteConnectivityDegraded` | `max(breeze_agent_conn_degraded_sites) > 0` | 15m | info | G |
| `AgentRequestBodyRejectionsHigh` | `sum by (job, instance) (increase(breeze_agent_request_body_rejected_total{job=~"breeze-api.*",reason=~"timeout\|aborted"}[5m])) > 50` (reasons are `timeout`, `aborted`, `too_large`: `middleware/agentRequestBody.ts:65`) | 5m | warning | G |

**Per-org agent error report** is its own wave (Task J). It aggregates `agent_logs` warn and error rows by site (joined through `devices`), component and normalized message over 24 h of **receipt time** (`created_at`, index `agent_logs_org_created_at_idx`). It is org-scoped and site-narrowed, cached for 5 min, has a 10 s statement timeout, a top-50 limit and redacted representative messages. The platform-admin cross-org view uses the Redis counters (D4.4), never a cross-org `agent_logs` scan. Edge access logging (survey item 6) is an ops change and is out of scope.

---

## PR split and file ownership

| PR | Task | Title | Owns (creates/modifies) | Depends on |
|---|---|---|---|---|
| — | 0 | Ops: admission enforce soak | none (operator runbook below) | v0.123.0 deployed (W08 + dbSaturationResponse) |
| PR-A | A | `feat(db): pool lanes + interactive reserve (#8840)` | `db/poolLane.ts`+test, `db/poolAdmission.ts`+test, `db/index.ts` (runInPoolSlot, config), `middleware/poolLane.ts`+test, `middleware/poolLaneCoverage.test.ts`, 8 auth middlewares (one wrap each), `middleware/agentAuth.ts` (entry wrap only), `routes/agentWs.ts` (`createAgentWsHandlers` + pre-upgrade validator wraps only), `index.ts` (mount), `services/metricsRuntime.ts`, `__tests__/integration/dbPoolLanes.integration.test.ts`, rules + `monitoring/rules/tests/breeze-tenant-isolation-alerts.test.yml`, `.github/workflows/perf-rules.yml`, env inventory ×5 | — |
| PR-B | B | `feat(db): agent-lane tenant fair share + ceiling (#8840)` | `db/poolAdmission.ts`+test, `db/poolLane.ts` (`setPoolLaneTenant`), `db/index.ts`, `middleware/agentAuth.ts` (one `setPoolLaneTenant` call), `services/admission/poolSignals.ts`+test, `middleware/dbSaturationResponse.ts`+test, `services/admission/admissionMetrics.ts`, `services/metricsRuntime.ts`, integration test (extend), rules + tests, env inventory ×5 | PR-A merged |
| PR-C | C | `fix(api): software inventory ingest off the request-long transaction (#8840)` | `middleware/agentAuth.ts` (self-managed + buffered-self-managed sets), `middleware/agentAuth.bodyBeforeContext.test.ts`, `routes/agents/inventory.ts` (software handler), `services/softwareInventoryObservations.ts`, tests | — |
| PR-D | D | `fix(api): telemetry side effects off the request-long transaction (#8840)` | `middleware/agentAuth.ts` (add `logs`, `changes` to both sets), `routes/agents/{logs,changes,sessions,peripherals,messageEvents}.ts` + tests | PR-C merged (same two sets) |
| PR-E | E | `fix(api): command-result side effects after commit (#8840)` | `routes/agents/commands.ts`, `services/commandResultHandlers.ts`, `routes/agents/helpers.ts` (side-effect call sites only) + tests | — |
| PR-F | F | `feat(agent-ws): exhaustive close-reason accounting + AgentWsMassClose (#8840)` | `services/agentWsCredentialMetrics.ts`, `routes/agentWs.ts` (close sites + onClose), `routes/agentWs.test.ts`, rules + tests | PR-A merged (touches `agentWs.ts`) |
| PR-G | G | `feat(api): site agent-connectivity signals + read routes (#8840)` | `services/agentConnectivity/{signals,store,derive,metrics}.ts`+tests, `middleware/agentRequestBody.ts` (signal hook), `middleware/agentAuth.ts` (denominator hook), `routes/agentWs.ts` (one call in the D3 latch), `routes/agentConnectivity.ts`+test, `routes/admin/agentConnectivity.ts`+test, `services/mcpCoverage.ts`, AI tool `services/aiToolsAgentConnectivity.ts` + registration, `index.ts` (mount + timer), rules + tests, env inventory ×5 | PR-F merged |
| PR-H | H | `feat(web): agent connectivity card + admin page (#8840)` | `apps/web/src/components/organizations/record/AgentConnectivityCard.tsx`+test, `apps/web/src/pages/admin/agent-connectivity.astro`, `apps/web/src/components/admin/AgentConnectivityAdmin.tsx`+test, 8 locale files | PR-G merged |
| PR-J | J | `feat: per-org agent error report (#8840)` | `services/agentConnectivity/errorReport.ts`+test, `routes/agentConnectivity.ts` (one route), integration EXPLAIN test, web card section + 8 locales | PR-G merged (PR-H if the card exists) |
| (gated) | — | breaker enforcement | D4.5; not scheduled | Todd go after the G soak |

All paths are relative to `apps/api/src/` unless they start with `apps/`, `monitoring/`, `.github/`, `docs/` or `load-tests/`. PRs C, D and G each touch `middleware/agentAuth.ts`, and PRs A, F and G each touch `routes/agentWs.ts`. Their merge order is fixed in the table. `monitoring/rules/breeze-rules.yml` is append-only per PR: each PR adds its alerts under a `# --- #8840 <task> ---` header in group `breeze-api-alerts`, and rebases on conflict.

---

## Task 0 (ops, Todd): soak, then enforce W08 admission

Survey gap 1. No code. v0.123.0 carries W08 and `dbSaturationResponse` in `observe`.

- [ ] **Step 1:** On each region record the agent-version share: `SELECT agent_version, count(*) FROM devices WHERE status='online' GROUP BY 1`. If more than 20 % run < v0.64.3, budget the 4× retry before enforcing (W08 rollout gate).
- [ ] **Step 2:** Soak 24–48 h in `observe`. Pass when, outside incidents:
  - `increase(breeze_admission_decisions_total{outcome="would_shed"}[1h])` is ~0;
  - `breeze_admission_level` is 0 more than 99 % of the time;
  - every `would_shed` burst lines up with a real lag or pool-wait excursion in `ApiDbPoolWaitersHigh` / `ApiEventLoopLagHigh`.
- [ ] **Step 3:** Set `BREEZE_ADMISSION_MODE=enforce` on US, then on EU 24 h later. Rollback is `observe` plus a container restart. Watch `ApiAdmissionShedding` and the heartbeat p95.
- [ ] **Step 4:** Record the readings in the #8840 thread. The orchestrator posts them, not the implementer.

---

## Task A: Pool lanes and the interactive reserve (PR-A)

**Files:**
- Create: `apps/api/src/db/poolLane.ts`, `apps/api/src/db/poolLane.test.ts`, `apps/api/src/middleware/poolLane.ts`, `apps/api/src/middleware/poolLane.test.ts`, `apps/api/src/middleware/poolLaneCoverage.test.ts`, `apps/api/src/__tests__/integration/dbPoolLanes.integration.test.ts`, `monitoring/rules/tests/breeze-tenant-isolation-alerts.test.yml`
- Modify: `apps/api/src/db/poolAdmission.ts`, `apps/api/src/db/poolAdmission.test.ts`, `apps/api/src/db/index.ts` (pool config ~line 80, `runInPoolSlot` ~607–660), `apps/api/src/index.ts` (mount after `agentAdmission`, line 488), the 8 interactive middlewares and `agentAuthMiddleware` (entry wrap), `apps/api/src/routes/agentWs.ts` (`createAgentWsHandlers` ~4478 and the pre-upgrade validator ~5030–5063), `apps/api/src/services/metricsRuntime.ts` (`updateDbPoolAdmissionMetrics` ~446), `monitoring/rules/breeze-rules.yml`, `.github/workflows/perf-rules.yml`, env inventory ×5 (`DB_POOL_INTERACTIVE_RESERVE`)

**Interfaces:**
- Produces (`db/poolLane.ts`):
  - `type PoolLane = 'interactive' | 'agent' | 'background'`
  - `interface PoolLaneStore` (D1.2)
  - `runWithPoolLane<T>(lane: PoolLane, fn: () => T): T`, which creates a fresh store
  - `getPoolLaneStore(): PoolLaneStore | undefined`
  - `markPoolLaneSettled(): void`
  - `effectivePoolLane(store: PoolLaneStore | undefined): PoolLane`, which returns `'background'` when the store is absent or an interactive store is settled
- Produces (`db/poolAdmission.ts`):
  - `interactiveReserveFor(permits: number): number`
  - `AcquireOptions` gains `lane?: PoolLane` (default `'background'`)
  - `createPoolAdmission` input gains `interactiveReserve?: number`
  - `PoolAdmissionSnapshot` gains `interactiveReserve: number`, `sharedCapacity: number`, `lanes: Record<PoolLane, { inUse: number; waiting: number }>`
  - `PoolSlot` gains `readonly lane: PoolLane`
  - `laneWaitStats(): Record<PoolLane, { grantWaitP95Ms: number; oldestWaitMs: number }>`
  - `resolvePoolLaneConfig(env: NodeJS.ProcessEnv, permits: number, nestedReserve: number): { interactiveReserve: number; warnings: string[] }`
- Produces (`middleware/poolLane.ts`):
  - `poolLane(lane: PoolLane): MiddlewareHandler`, which wraps `next()` in `runWithPoolLane` and calls `markPoolLaneSettled()` in `finally`
  - `publicAuthPoolLane(): MiddlewareHandler` (`/api/v1/auth/*` → interactive)
  - `POOL_LANE_BY_AUTH_MIDDLEWARE: Readonly<Record<string, PoolLane>>`

- [ ] **Step 1: Write the failing gate tests** in `db/poolAdmission.test.ts`:
  - `interactiveReserveFor sizes the reserve from the permit count`: `[[35,7],[30,6],[10,2],[9,1],[5,1],[4,0],[1,0]]`.
  - `agent and background acquirers never take the interactive reserve`: permits 10 (N 1, R 2, S 7). 7 `agent` grants resolve. The 8th `agent` and a `background` acquire stay pending. Then 2 `interactive` acquires resolve at once, and `snapshot().lanes.interactive.inUse === 2`.
  - `interactive can use idle shared capacity`: permits 10. 9 `interactive` grants resolve immediately and the 10th waits (N is kept).
  - `a released permit goes to a waiting interactive acquirer before a waiting agent acquirer`.
  - `agent-lane nested escalations borrow only the nested reserve, never the interactive reserve`: permits 10. 7 agent slots are held. One nested acquire from an agent parent resolves (it borrows N). A second nested acquire from an agent parent stays pending even though `inUse` is 8 < 10. An interactive acquire still resolves.
  - `a nested acquisition is granted from the nested reserve even when its lane is at cap` (Review Focus 4).
  - `interactiveReserve 0 restores today's single-lane behaviour`: rerun the existing `keeps top-level acquirers out of the nested reserve` scenario with lanes mixed. Every grant and wait is identical.
  - `rejects an interactive reserve that leaves the shared lanes no permit`: permits 10, N 1, R 9 → RangeError.
  - `resolvePoolLaneConfig: '' and garbage fall back to the default with a warning naming DB_POOL_INTERACTIVE_RESERVE; '0' is honoured`.
- [ ] **Step 2: Run them, verify they fail.** `cd apps/api && npx vitest run src/db/poolAdmission.test.ts`. Expected: FAIL (`interactiveReserveFor` is not exported; the lane assertions fail).
- [ ] **Step 3: Implement the lanes in `db/poolAdmission.ts`.**
  - The interactive waiter queue is separate. The shared queue stays FIFO in this task.
  - `canGrant(lane, nested)` follows the D1.3 table. `nestedBorrowed` is tracked on slot grant and release.
  - `drain()` takes the first eligible nested waiter (scan), then the interactive head, then the shared head.
  - `waitStats()` keeps its shape and its whole-gate semantics (W08 unchanged). `laneWaitStats()` adds the per-lane view.
  - The leaf-module header comment gains a LANES paragraph.
- [ ] **Step 4: Run, verify pass.** Same command, then the existing suite on its own: all of `poolAdmission.test.ts` passes, including the W04 cases untouched.
- [ ] **Step 5: Write the failing lane-store tests** in `db/poolLane.test.ts`:
  - `no store means background` (Review Focus 1)
  - `a settled interactive store is charged as background` (Review Focus 2)
  - `an agent store keeps its lane after it settles`
  - `runWithPoolLane gives each call a fresh store`
- [ ] **Step 6: Run** `npx vitest run src/db/poolLane.test.ts`. Expected: FAIL (module missing). **Implement** `db/poolLane.ts`. **Run** → PASS.
- [ ] **Step 7: Wire `runInPoolSlot`.**
  - Read `effectivePoolLane(getPoolLaneStore())`, or the parent slot's `lane` when nested, and pass `lane` to `acquire`.
  - In the config block, call `resolvePoolLaneConfig(process.env, requestPoolMax, nestedReserve)`, print each warning, and pass `interactiveReserve` to `createPoolAdmission`.
  - Warn at boot when R = 0, next to the existing nested-reserve warning.
- [ ] **Step 8: Write the failing middleware tests.**
  - `middleware/poolLane.test.ts`: `poolLane('interactive') exposes an interactive store to the handler and marks it settled after the response`; `publicAuthPoolLane marks /api/v1/auth/login interactive and leaves /api/v1/agents/x/heartbeat untouched`.
  - `middleware/poolLaneCoverage.test.ts`: walks `apps/api/src/middleware/*.ts` (excluding tests) plus `routes/portal/auth.ts`, and collects every exported Hono middleware whose name contains `auth`/`Auth`. The source patterns are `export (async )?function (\w*[Aa]uth\w*)\(c: Context, next: Next\)` and `export const (\w*[Aa]uth\w*): MiddlewareHandler`. The second pattern is needed because `authMiddleware` (`auth.ts:618`) has no `AuthMiddleware` suffix and `helperAuth` (`helperAuth.ts:58`) is a `const`. It asserts each name is in `POOL_LANE_BY_AUTH_MIDDLEWARE`, and that each mapped `interactive`/`agent` file contains `runWithPoolLane(`. Expected today: the 8 interactive middlewares, `agentAuthMiddleware` and `helperAuth`. `helperAuth` is mapped `background` with a comment: device-originated, like agents, but outside the tenant ceiling. A seeded fake export in a temp fixture proves the walk finds both forms.
- [ ] **Step 9: Run → FAIL. Implement.**
  - Wrap each of the 8 interactive middlewares and `agentAuthMiddleware`: `return runWithPoolLane('<lane>', async () => { try { return await <existing body> } finally { markPoolLaneSettled() } })`.
  - In `agentWs.ts`, wrap the pre-upgrade validator middleware and each handler `createAgentWsHandlers` returns (`onOpen`, `onMessage`, `onClose`, `onError`) in `runWithPoolLane('agent', …)`.
  - Mount `publicAuthPoolLane()` in `index.ts` right after `agentAdmission()`.
  - **Run → PASS.**
- [ ] **Step 10: Metrics + alert.**
  - Failing test in the existing metricsRuntime test file (create `services/metricsRuntime.lanes.test.ts` if none): after 2 interactive grants on a registered fake gate, `breeze_db_pool_lane_in_use{lane="interactive"}` reads 2 and `breeze_db_pool_interactive_reserve` reads R.
  - Implement in `updateDbPoolAdmissionMetrics`.
  - Add `ApiDbPoolInteractiveWaiting` (D6) to `breeze-rules.yml`, with promtool cases in `monitoring/rules/tests/breeze-tenant-isolation-alerts.test.yml`: fires at waiting 1 for 3 m, silent at 1 for 1 m and at 0. Add the test file to `.github/workflows/perf-rules.yml`.
  - **Run:** `promtool check rules monitoring/rules/breeze-rules.yml && promtool test rules monitoring/rules/tests/breeze-tenant-isolation-alerts.test.yml` → `SUCCESS`.
- [ ] **Step 11: Integration test (real Postgres)** in `__tests__/integration/dbPoolLanes.integration.test.ts`. Use a fresh `db` module per test, like `dbPoolRecovery.integration.test.ts`, with `DB_POOL_MAX=6` and `DB_POOL_INTERACTIVE_RESERVE=2` set explicitly, so S = 3.
  - `interactive context completes while every shared permit is held`: 3 `runWithPoolLane('agent', () => withDbAccessContext(org, () => db.execute(sql\`select pg_sleep(3)\`)))`. Then `runWithPoolLane('interactive', () => withDbAccessContext(org, select 1))` resolves in < 500 ms. A 4th agent context resolves only after a sleeper finishes.
  - `pg_stat_activity` never shows more than 6 `breeze-api` backends from the fresh module.
  - **Run:** `pnpm test-stack up`, then `cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/dbPoolLanes.integration.test.ts` → 2+ passed. Also run `dbPoolRecovery`, `admissionControl` and `agentHotPathQueryBudget` integration → unchanged pass counts.
- [ ] **Step 12: Env inventory** for `DB_POOL_INTERACTIVE_RESERVE`, all 5 places (Global Constraints). The doc row says: default `max(2, 20 % of DB_POOL_MAX)` for pools ≥ 10, 1 for 5–9; `0` disables. **Run** `npx vitest run src/system/connections/envInventory.test.ts src/config/envComposeParity.test.ts src/config/envReadComposeCoverage.test.ts` → PASS.
- [ ] **Step 13: Full verification.**
  - `npx vitest run src/db src/middleware src/services/admission src/routes/agentWs.test.ts`, in batches; `requestDatabasePool.test.ts` must stay inside its budget.
  - Typecheck (Global Constraints), exit 0.
- [ ] **Step 14: Lab gate, recorded in the PR.**
  - **Stack.** Per-worktree wt-stack with `DB_POOL_MAX=35`.
  - **Load.** Run agentsim at an agent count that drives `breeze_db_pool_lane_in_use{lane="agent"}` to S for ≥ 5 min (`load-tests/agentsim/run.sh`, cadence raised). At the same time run k6 `load-tests/scenarios/device-list.js` with a user token.
  - **Pass.** k6 `http_req_duration` p95 < 1 s, and `ApiDbPoolInteractiveWaiting` silent.
  - **Control (the same run with `DB_POOL_INTERACTIVE_RESERVE=0`).** It must show the UI p95 degrading. If it does not, the load did not saturate the pool, and the gate is not evidence.
  - Tear the stack down afterwards.
- [ ] **Step 15: Commit** `feat(db): pool lanes + interactive reserve so agent ingest cannot starve the console (#8840)`.

## Task B: Agent-lane tenant fair share and ceiling (PR-B)

**Files:**
- Modify: `apps/api/src/db/poolAdmission.ts`+test, `apps/api/src/db/poolLane.ts`+test, `apps/api/src/db/index.ts` (`runInPoolSlot` passes `tenantKey` and `onCancelled`), `apps/api/src/middleware/agentAuth.ts` (call `setPoolLaneTenant(device.orgId)` right after the device lookup, before the rate limiters), `apps/api/src/routes/agentWs.ts` (the agent store gets `tenantKey = agentCtx.orgId`), `apps/api/src/services/admission/poolSignals.ts`+test, `apps/api/src/middleware/dbSaturationResponse.ts`+test, `apps/api/src/services/admission/admissionMetrics.ts` (`kind` enum), `apps/api/src/services/metricsRuntime.ts`, the integration test, rules + the promtool file, env inventory ×5 (`DB_POOL_AGENT_TENANT_MAX_SHARE`)

**Interfaces:**
- Consumes: Task A's lanes, `PoolLaneStore`, `runInPoolSlot` wiring.
- Produces:
  - `setPoolLaneTenant(tenantKey: string): void` (no-op on non-agent stores)
  - `AcquireOptions` gains `tenantKey?: string | null` and `onCancelled?: (blockedBy: 'capacity' | 'tenant_ceiling') => void`
  - `createPoolAdmission` input gains `tenantMaxShare?: number`
  - `tenantCeilingFor(sharedCapacity: number, share: number): number`
  - `PoolAdmissionSnapshot` gains `tenantCeiling`, `topTenantInUse`, `tenantCeilingWaiting`
  - `PoolAdmissionTotals` gains `tenantCeilingCancelled`
  - `DbSaturationKind` gains `'tenant_ceiling'`
  - `resolvePoolLaneConfig` also returns `tenantMaxShare`

- [ ] **Step 1: Failing gate tests** in `db/poolAdmission.test.ts`:
  - `tenantCeilingFor`: `(27,0.5)→13`, `(23,0.5)→11`, `(27,1)→27`, `(1,0.5)→1`.
  - `agent waiters are served round-robin across tenants`: S full with tenant A. Queue A,A,A,B,C. Release 3 → grants go to A, B, C in that order.
  - `a tenant at its ceiling waits while another tenant is granted`: permits 10 (S 7, share 0.5 → C 3). A holds 3. A's 4th waits even though 4 permits are free, and B's acquire resolves.
  - `background and unattributed agent waiters are never ceiling-blocked`.
  - `waiters blocked only by their tenant ceiling do not raise waitStats` (Review Focus 3): A is at ceiling with 5 waiters aged 2 s, and free permits remain → `waitStats().oldestWaitMs === 0`.
  - `a waiter cancelled while its tenant is at ceiling reports tenant_ceiling`: `onCancelled` receives `'tenant_ceiling'` and `totals().tenantCeilingCancelled === 1`. A capacity-blocked cancel reports `'capacity'`.
  - `share 1 keeps round-robin and never blocks on the ceiling`.
- [ ] **Step 2: Run → FAIL.** **Step 3: Implement.**
  - Per-tenant FIFO queues in a `Map<string, Waiter[]>`, plus a ring of tenants with waiters. The pseudo-tenants `__background__` and `__agent_unattributed__` are exempt.
  - `tenantInUse` is counted on slot grant and release, including nested slots charged to the tenant.
  - Waiters keep an `everCeilingBlocked` flag. Their grant waits go to `laneWaitStats().agent` only, not to the `waitStats()` p95.
  - A throttled warn names the tenant at most once per minute per tenant: `[db-pool-admission] tenant <orgId> at its agent-lane ceiling (C held, n waiting) (#8840)`.
  - **Step 4: Run → PASS.**
- [ ] **Step 5: Failing signal and response tests.**
  - `services/admission/poolSignals.test.ts`: `tenant-ceiling expiries are not counted as DB timeouts`. With the deadline totals at 5 and `tenantCeilingCancelled` at 2, `dbTimeoutsTotal` is 3.
  - `middleware/dbSaturationResponse.test.ts`: `a tenant-ceiling acquire expiry answers 429 TENANT_POOL_SHARE_EXCEEDED with Retry-After 30-45`. The test sets the lane store's `lastAcquireBlockedBy = 'tenant_ceiling'` and throws a `DbPoolAcquireTimeoutError`. It asserts the status is 429, the code, a Retry-After in [30, 45], and `breeze_admission_db_saturation_responses_total{kind="tenant_ceiling"}` +1. A capacity expiry still answers 503.
  - `middleware/agentAuth.test.ts`: `tenant attribution is set from the device org before the rate limiters and the request-long context`. The lane store seen by a stubbed `withDbAccessContext` has `tenantKey === device.orgId`.
- [ ] **Step 6: Run → FAIL. Implement, run → PASS.**
- [ ] **Step 7: Integration** (extend `dbPoolLanes.integration.test.ts`). Fresh module, `DB_POOL_MAX=8`, R 2, share 0.5 → S 5, C 2.
  - `one tenant at its ceiling does not delay another tenant`: tenant A holds 2 `pg_sleep(3)` agent contexts and queues a 3rd. Tenant B's context resolves in < 500 ms.
  - `admission signals stay unloaded`: a `createSignalSampler()` reading during the hold shows `oldestDbWaitMs < 100`.
  - Run plus the A-suite integration batch → PASS.
- [ ] **Step 8: Metrics + alert.**
  - Add the 4 B series (D6) and `ApiDbPoolTenantCeilingSustained`, with promtool cases: fires at 1 for 6 m, silent at 1 for 3 m.
  - Run promtool → `SUCCESS`.
- [ ] **Step 9: Env inventory** for `DB_POOL_AGENT_TENANT_MAX_SHARE`: `(0, 1]`, default `0.5`, and `1` disables the ceiling. Run the ratchets → PASS.
- [ ] **Step 10: Full verification** as in Task A Step 13. Lab gate: run two agentsim instances with enrollment keys in two different orgs. Org A runs at 3× the cadence and org B at normal. Pass when org B's heartbeat p95 equals its solo baseline within 20 %, and `breeze_admission_level` stays 0 while `breeze_db_pool_agent_tenant_ceiling_waiting > 0`.
- [ ] **Step 11: Commit** `feat(db): agent-lane tenant fair share so one org cannot hold the pool (#8840)`.

## Task C: Software inventory ingest off the request-long transaction (PR-C)

**Files:**
- Modify: `apps/api/src/middleware/agentAuth.ts`:
  - add `'software'` to `SELF_MANAGED_DB_CONTEXT_ACTIONS` (`:371`);
  - add `BUFFERED_SELF_MANAGED_DB_CONTEXT_ACTIONS = new Set(['software'])`;
  - in the early-return branch (`:1119–1131`), call `bufferAgentRequestBody` first when the action is in that set.
- Modify: `apps/api/src/middleware/agentAuth.bodyBeforeContext.test.ts`.
- Modify: `apps/api/src/routes/agents/inventory.ts` (software handler `:106–160`): one short `withDbAccessContext(agentOrgContext)` for its device read, then `ingestSoftwareInventoryReport` with no context held.
- Modify: `apps/api/src/services/softwareInventoryObservations.ts:356`: keep `runOutsideDbContext` as defence, and add `assertOutsideHeldDbContext('software inventory ingest')` (`db/index.ts:1414`) at its entry.
- Test: `apps/api/src/routes/agents/inventory.test.ts` (software cases).

**Interfaces:**
- Produces: `BUFFERED_SELF_MANAGED_DB_CONTEXT_ACTIONS: ReadonlySet<string>` (exported for tests). PR-D extends it.

- [ ] **Step 1: Audit the two unaudited agent-auth mounts**, `extensions/gateway.ts:117–124` and `ee/workspace/src/routes/agent.ts`, against the D2 checklist (Redis, BullMQ, HTTP, nested slot inside the wrap). Put the result in the PR body. Anything found becomes a follow-up issue (the orchestrator files it), not part of this PR.
- [ ] **Step 2: Failing tests.**
  - `agentAuth.bodyBeforeContext.test.ts`:
    - `software is buffered before any context and is not wrapped`: a stalled body → 408 and `withDbAccessContext` never opened; a complete body reaches the handler with no ambient context (`hasDbAccessContext() === false` inside it).
    - `heartbeat stays unbuffered`: the existing (d) case is unchanged.
  - `inventory.test.ts`: `PUT /software holds at most one pool permit at a time`. Using a registered fake gate whose `acquire` records concurrent in-use, a full ingest never shows 2 permits held by the request. Before the change: 2.
- [ ] **Step 3: Run → FAIL. Implement. Run → PASS.**
- [ ] **Step 4:** Run the integration suites `agentHotPathQueryBudget` and any software inventory integration test (`ls src/__tests__/integration | grep -i software`) → PASS. Typecheck exit 0.
- [ ] **Step 5: Commit** `fix(api): ingest software inventory without holding a second pool permit (#8840)`.

## Task D: Telemetry side effects off the request-long transaction (PR-D)

**Files:**
- Modify: `apps/api/src/middleware/agentAuth.ts`: add `'logs'` and `'changes'` to both sets.
- Modify: `apps/api/src/routes/agents/logs.ts`, `changes.ts`: decode, parse and the Redis ingest quota first, then ONE `withDbAccessContext(agentOrgContext)` around the inserts. Response bodies are unchanged.
- Modify: `apps/api/src/routes/agents/sessions.ts`: collect events in the transaction and publish them in `runAfterDbContextCommit('agent-sessions-events', …)`. The device share lock and the principal writes stay in the same transaction.
- Modify: `apps/api/src/routes/agents/peripherals.ts`: the `:86` nested read runs on the outer transaction (drop `runOutsideDbContext`); the `:141` publishes go in `runAfterDbContextCommit`.
- Modify: `apps/api/src/routes/agents/messageEvents.ts`: the `:157` Redis `SET NX` and the `:162` audit run after commit, and the audit uses fire-and-forget `writeAuditEvent`.
- Tests: next to each route.

- [ ] **Step 1: Failing tests, one per route:**
  - `logs ingest quota and decode run before any DB context`: a recorder shows `['redis-quota', 'context-opened', 'insert']`. Before: the quota came after `context-opened`.
  - `changes ingest quota runs before any DB context`: same assertion.
  - `session events publish only after the transaction commits, and not on rollback`.
  - `session principal observation keeps the device share lock through its writes`: the share-lock statement and the principal writes appear in the same transaction id.
  - `peripheral blocked events publish after commit; the policy lookup uses the request transaction`.
  - `message-event delivery dedupe and audit run after commit`.
  - Extend `agentAuth.bodyBeforeContext.test.ts`: `logs and changes are buffered and not wrapped`.
- [ ] **Step 2: Run → FAIL. Implement. Run → PASS.** Then run the existing route suites `src/routes/agents` in batches → unchanged counts plus the new tests.
- [ ] **Step 3:** Integration `agentHotPathQueryBudget` → PASS. If the session-lock budget pin changes, the pin is updated only when the statement count is identical. Typecheck exit 0.
- [ ] **Step 4: Commit** `fix(api): run telemetry Redis/event side effects outside the agent request transaction (#8840)`.

## Task E: Command-result side effects after commit (PR-E)

**Files:**
- Modify: `apps/api/src/routes/agents/commands.ts`:
  - `:292`: the read uses the request transaction, so `runOutsideDbContext` is removed and the comment updated (READ COMMITTED: each statement sees rows committed before it starts).
  - `:779`, `:843`: dispatch and enqueue go in `runAfterDbContextCommit`.
- Modify: `apps/api/src/services/commandResultHandlers.ts:148, 398, 832`: each enqueue goes in `runAfterDbContextCommit`.
- Modify: `apps/api/src/routes/agents/helpers.ts:1101, 1115, 1173, 2048`: awaited publishes and `queueCommandForExecution` go in `runAfterDbContextCommit`.
- Leave nested system contexts that do DB work (restore points `:747`, topology `:809, 825`) as they are. They are charged to the parent's lane (D1.3) and are DB-only.
- Tests: `routes/agents/commands.test.ts` and `services/commandResultHandlers.test.ts`.

- [ ] **Step 1: Failing tests:**
  - `no BullMQ enqueue, event publish or command dispatch runs while the command-result transaction is open`: spies record `hasDbAccessContext()` at call time; every spy must see `false`.
  - `a rolled-back result enqueues nothing`.
  - `the command lookup reads through the request transaction`: no bare-pool `db.select` call outside a context.
  - One case per handler branch touched (discovery, SNMP, script verify, DR reconcile, CIS publish, re-dispatch).
- [ ] **Step 2: Run → FAIL. Implement. Run → PASS.** Then run the result-handler suites and `parkedCommandDelivery` integration → PASS. Typecheck exit 0.
- [ ] **Step 3: Commit** `fix(api): command-result side effects run after commit, off the agent transaction (#8840)`.

## Task F: Exhaustive WS close accounting and AgentWsMassClose (PR-F)

**Files:**
- Modify: `apps/api/src/services/agentWsCredentialMetrics.ts`: extend `AgentWsCredentialCloseReason` to the D3 enum (rename the type to `AgentWsCloseReason` with a re-export alias), pre-seed every reason, update the help text.
- Modify: `apps/api/src/routes/agentWs.ts`: add `closeAgentSocket(ws, code, reason, metricReason)` with a per-socket `WeakSet` latch. Use it at `:376, 2908, 2951, 3018, 3176, 3223, 4948, 5170`. `onClose` records `peer_normal` or `peer_abnormal` through the same latch, and exposes the socket lifetime and code for Task G.
- Modify: `monitoring/rules/breeze-rules.yml`: replace the `:172` TODO with `AgentWsMassClose` and add `AgentWsPeerAbnormalSpike`, plus the promtool cases.

**Interfaces:**
- Produces:
  - `type AgentWsCloseReason = 'denied' | 'unverified_grace_expired' | 'revoked' | 'token_suspended' | 'superseded' | 'pong_timeout' | 'message_rate' | 'server_disconnect' | 'peer_normal' | 'peer_abnormal'`
  - `recordAgentWsClose(reason: AgentWsCloseReason): void`
  - `onAgentSocketEnded?: (info: { orgId: string; siteId: string | null; deviceId: string; reason: AgentWsCloseReason; lifetimeMs: number }) => void`, a module-level hook (null by default) that Task G sets

- [ ] **Step 1: Failing tests** in `agentWs.test.ts`:
  - `each server close is counted once with its reason` (one case per site).
  - `a server close followed by the peer's close event counts once`.
  - `a peer close with 1006 counts peer_abnormal`.
  - `a revocation close is counted exactly once even when onClose follows`.
  - The existing #8851 suite passes unchanged (its three reasons keep their names).
- [ ] **Step 2: Run → FAIL** (`cd apps/api && npx vitest run src/routes/agentWs.test.ts`; record the passing count on main first and report baseline → new in the PR). **Implement. Run → PASS.**
- [ ] **Step 3: promtool cases.** `AgentWsMassClose` fires on 60 denied in 5 m and stays silent on 60 `peer_normal`. `AgentWsPeerAbnormalSpike` fires on 250 `peer_abnormal` sustained for 6 m. Run promtool → `SUCCESS`.
- [ ] **Step 4:** Integration `agentWsCredentialGeneration` + `parkedCommandDelivery` → PASS. Typecheck exit 0.
- [ ] **Step 5: Commit** `feat(agent-ws): count every socket close once by reason; AgentWsMassClose alert (#8840)`.

## Task G: Site agent-connectivity signals and read routes (PR-G)

**Files:**
- Create: `apps/api/src/services/agentConnectivity/signals.ts`, `store.ts`, `derive.ts`, `metrics.ts` (+ a `.test.ts` each).
- Create: `apps/api/src/routes/agentConnectivity.ts`+test, `apps/api/src/routes/admin/agentConnectivity.ts`+test, `apps/api/src/services/aiToolsAgentConnectivity.ts`+test.
- Modify:
  - `apps/api/src/middleware/agentRequestBody.ts`: one `recordAgentConnectivitySignal` call per refusal, with the authenticated identity it already has.
  - `apps/api/src/middleware/agentAuth.ts`: one fire-and-forget denominator call after the device lookup. It must **not** be on any rejection branch.
  - `apps/api/src/routes/agentWs.ts`: set `onAgentSocketEnded` (Task F).
  - `apps/api/src/index.ts`: mount both routes and start the 30 s gauge timer next to `startAdmissionControl()` (`:2001`).
  - `apps/api/src/services/mcpCoverage.ts`: `'agentConnectivity.ts': { tools: ['get_agent_connectivity'] }` and `'admin/agentConnectivity.ts': { exempt: 'platform_admin' }`.
  - AI tool registration in the aiTools hub.
  - Rules + promtool cases; env inventory ×5 (`BREEZE_AGENT_CONNECTIVITY_SIGNALS`).

**Interfaces:**
- Consumes: Task F `onAgentSocketEnded`.
- Produces:
  - `type AgentConnectivitySignal = 'requests' | 'body_stalled' | 'body_aborted' | 'body_oversize' | 'ws_peer_abnormal'`
  - `recordAgentConnectivitySignal(input: { orgId: string; siteId: string | null; deviceId: string; signal: AgentConnectivitySignal; at?: Date }): void`, which never throws and never awaits on the caller's path
  - `readSiteConnectivity(siteIds: string[], now: Date): Promise<Map<string, SiteConnectivity>>`
  - `type SiteConnectivity = { state: 'healthy' | 'degraded' | 'recovering' | 'no_traffic'; lastHour: Record<AgentConnectivitySignal, number>; last24h: Record<AgentConnectivitySignal, number>; failingDevices: number; degradedSince: Date | null }`
  - `deriveSiteState(input: { lastHour; previousHour; failingDevices; activeDevices }): SiteConnectivity['state']`: pure, D4.4 thresholds as exported constants `DEGRADED_MIN_FAILURES = 30`, `DEGRADED_MIN_RATIO = 0.05`, `DEGRADED_MIN_DEVICES = 3`
  - `GET /api/v1/agent-connectivity/orgs/:orgId/sites` → `{ sites: Array<{ siteId; siteName; state; lastHour; last24h; failingDevices; degradedSince }> }`
  - `GET /api/v1/admin/agent-connectivity` → `{ sites: Array<{ partnerId; partnerName; orgId; orgName; siteId; siteName; state; last24h }> }`

- [ ] **Step 1: Failing pure tests** (`derive.test.ts`):
  - `degraded needs failures, ratio and distinct devices together`: three cases, each meeting all but one condition, return `healthy`.
  - `a quiet site is no_traffic, never healthy`.
  - `recovering after a degraded hour with a clean current hour`.
- [ ] **Step 2: Failing store/signal tests** (`store.test.ts`, `signals.test.ts`, ioredis mock as in `agentAuth.storageSessionRateLimit.test.ts`):
  - `signals pipeline HINCRBY + PFADD + EXPIRE on the hour key and never await on the caller`.
  - `a Redis error drops the sample and counts a write failure`.
  - `BREEZE_AGENT_CONNECTIVITY_SIGNALS=off writes nothing`.
  - `auth rejections are never recorded as site connectivity signals` (Review Focus 5). Drive `agentAuthMiddleware` with a valid agent id and a wrong token, an unknown agent id, and a suspended token, and assert zero recorder calls. A successful request records exactly one `requests`.
- [ ] **Step 3: Failing route tests:**
  - `partner route requires devices:read and the org in scope`.
  - `a site-restricted caller sees only its sites, even from a warm cache`. The cache is warmed by an unrestricted caller first.
  - `admin route is platform-admin only`.
  - `AI tool returns the same rows as the route for the same caller`.
  - mcp-coverage → green with the two entries.
- [ ] **Step 4: Run → FAIL. Implement. Run → PASS.**
- [ ] **Step 5: Metrics + alerts.**
  - Add `AgentSiteConnectivityDegraded` and `AgentRequestBodyRejectionsHigh` (D6), each with a fire case and a silent case.
  - Run promtool → `SUCCESS`.
- [ ] **Step 6: Contract and ratchet runs.**
  - `npx vitest run src/__tests__/mcp-coverage.test.ts` → PASS.
  - The aiTools contract suites (`ls src/__tests__ | grep -i aitool`) → PASS.
  - Env ratchets → PASS.
  - Typecheck exit 0.
- [ ] **Step 7: Commit** `feat(api): site agent-connectivity signal (Redis) with partner/admin read routes (#8840)`.

## Task H: Agent connectivity card and admin page (PR-H)

**Files:**
- Create:
  - `apps/web/src/components/organizations/record/AgentConnectivityCard.tsx`+test, rendered on `apps/web/src/pages/organizations/[id].astro`'s record view, but only when a site is `degraded` or `recovering`, or had any failure in 24 h;
  - `apps/web/src/pages/admin/agent-connectivity.astro`;
  - `apps/web/src/components/admin/AgentConnectivityAdmin.tsx`+test;
  - locale keys under `agentConnectivity.*` in all 8 locales.
- The UI is read-only, so there are no mutations and `runAction` does not apply. If a "refresh" button is added it is a GET and stays out of `runActionAllowlist`. Tab state, if any, goes in `window.location.hash`.
- Copy (en): title "Agent connectivity". Degraded row: "Agents at {site} are failing to upload: {n} failed uploads from {d} devices in the last hour. This usually means a proxy, firewall or ISP filter at that site is interrupting HTTPS." Link: "View agent errors" (Task J).

- [ ] **Step 1: Failing component tests:**
  - `card is hidden when every site is healthy or no_traffic`.
  - `degraded site renders the counts and the site name`.
  - `admin page lists sites across partners sorted by degradedSince`.
  - `localeParity: every agentConnectivity.* key exists in all 8 locales`.
  - Tests use `data-testid` only.
- [ ] **Step 2: Run → FAIL** (`cd apps/web && npx vitest run src/components/organizations/record/AgentConnectivityCard.test.tsx src/components/admin/AgentConnectivityAdmin.test.tsx src/lib/i18n/localeParity.test.ts`). **Implement. Run → PASS.** Typecheck the web app (`pnpm --filter @breeze/web exec astro check` or the repo's web tsc), exit 0.
- [ ] **Step 3: Commit** `feat(web): agent connectivity card and admin page (#8840)`.

## Task J: Per-org agent error report (PR-J)

**Files:**
- Create: `apps/api/src/services/agentConnectivity/errorReport.ts`+test, `apps/api/src/__tests__/integration/agentErrorReport.integration.test.ts`.
- Modify: `apps/api/src/routes/agentConnectivity.ts` (add `GET /orgs/:orgId/errors?hours=24`); the web card (a "Top agent errors" section) + 8 locales.

**Interfaces:**
- Produces:
  - `buildAgentErrorReport(input: { orgId: string; auth: AuthContext; hours: 1 | 6 | 24; now: Date }): Promise<AgentErrorReport>`
  - `type AgentErrorReport = { generatedAt: string; rows: Array<{ siteId: string | null; siteName: string | null; component: string; messageKey: string; sample: string; count: number; devices: number; lastAt: string }> }`, with at most 50 rows

**Query rules:**

| Rule | Value |
|---|---|
| Filter | `agent_logs.org_id = $org AND created_at >= now() - $hours AND level IN ('warn','error')` |
| Site narrowing | via `buildAgentLogConditions` (`services/aiToolsAgentLogs.ts:108`) |
| Joins | `devices` for the site |
| `messageKey` | `regexp_replace` of digit runs, hex ≥ 8, IPv4/IPv6 and UUIDs to `#` |
| `sample` | passed through the agent-log redaction already used by `search_agent_logs` |
| Limits | `SET LOCAL statement_timeout = '10s'`, top 50 by count |
| Cache | Redis 5 min, keyed by org + hours, with the site filter applied **after** the cache |

- [ ] **Step 1: Failing tests:**
  - `groups by site, component and normalized message`.
  - `redacts the sample`.
  - `a site-restricted caller never sees another site's rows, even from cache`.
  - Integration `the report query uses agent_logs_org_created_at_idx`: run `EXPLAIN (FORMAT JSON)` on the built SQL against seeded rows and assert an Index Scan or Bitmap Index Scan on that index.
- [ ] **Step 2: Run → FAIL. Implement. Run → PASS.**
- [ ] **Step 3:** Web section tests and locale parity → PASS. mcp-coverage stays green (same module, same tool, which gains an `include: 'errors'` option). Typecheck both apps, exit 0.
- [ ] **Step 4: Commit** `feat: per-org agent error report by site (#8840)`.

---

## Rollout

| Order | What | Mode / switch | Watch | Rollback |
|---|---|---|---|---|
| 1 | Task 0 | `BREEZE_ADMISSION_MODE=enforce` after the soak | `ApiAdmissionShedding`, heartbeat p95 | `observe` |
| 2 | PR-A | always on, default R | `ApiDbPoolInteractiveWaiting`, `breeze_db_pool_lane_*` | `DB_POOL_INTERACTIVE_RESERVE=0` |
| 3 | PR-B | always on, share 0.5 | `ApiDbPoolTenantCeilingSustained`, tenant warn lines | `DB_POOL_AGENT_TENANT_MAX_SHARE=1` |
| 4 | PR-C/D/E | n/a | `held a pooled connection` warnings by label | revert |
| 5 | PR-F | n/a | `AgentWsMassClose` | revert |
| 6 | PR-G/H/J | signals `on` | degraded-site list vs `agent_logs` | `BREEZE_AGENT_CONNECTIVITY_SIGNALS=off` |
| 7 | (gated) enforcement | `observe` ≥ 7 d → `enforce` | `would_throttle` per site | `observe` |

## Exit checklist (per PR, and for the plan)

- [ ] Every task's red test was seen failing before its implementation (named in the PR body).
- [ ] Scoped unit suites, the integration suites named in the task, and the full `apps/api` suite in batches are green. Typecheck exit 0 (read the exit code).
- [ ] promtool `check rules` + every test file in `perf-rules.yml` `SUCCESS` for PRs A, B, F, G.
- [ ] Env ratchets green for PRs A, B, G. `environment.mdx` rows present.
- [ ] mcp-coverage, aiTools contracts and locale parity green for PRs G, H, J.
- [ ] No new table or migration (`git diff --stat origin/main -- apps/api/migrations` empty).
- [ ] No agent change (`git diff --stat origin/main -- agent/` empty), so no `MIN_AGENT_VERSION_*`.
- [ ] Lab gates for A and B recorded with their control runs. Test stacks torn down.
- [ ] Merge order respected: A → B, A → F → G → H → J, C → D. E is independent.

## Deferred (not in this plan)

- **Breaker enforcement** (D4.5): Todd's go/no-go after ≥ 7 days of PR-G data.
- **Interactive-lane tenant fairness** (partner-API automation): needs lane data first.
- **Connection-health digest/notification** for degraded sites: needs a SQL-backed `HealthSource`, which means a table, so it needs its own design.
- **Zod parsing before the context** on wrapped routes: only if hold warnings attribute holds to it.
- **`pam-observations`** bare-pool read + Redis inside the wrap: follow-up issue, same fix shape as Task E.
- **Extension gateway / `ee/workspace` agent routes:** whatever Task C Step 1 finds.
- **WS lease TTL > 30 s:** only with a measured re-check rate at W5 scale, and a delivery-confirmed revocation path.
- **Cross-cycle `Retry-After` deferral on the agent:** W09 (#8148).
- **Edge sampled access logging:** ops.
