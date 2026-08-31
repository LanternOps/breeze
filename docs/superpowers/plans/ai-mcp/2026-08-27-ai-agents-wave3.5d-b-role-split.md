---
tracking_issue: LanternOps/breeze#3821
wave: W10 (#4086) — Part B (the split)
---

# Wave 3.5d Part B — BREEZE_ROLE Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `worker`-role process (same image, `node dist/worker.cjs`) that runs the global background workers with no HTTP route graph, no agent sockets, its own health surface, migration-parity gating, and ordered shutdown — while `BREEZE_ROLE=all` (the default) keeps today's single-process behavior byte-for-byte for self-hosters.

**Architecture:** A declarative, **lazily-loaded** worker registry (`load: () => import(...)`) with `placement: 'global' | 'socket-owner'` replaces the 104-entry array in `index.ts`. Role filtering happens BEFORE module evaluation, so the worker entrypoint never imports the route graph or `agentWs` (an import-closure contract test enforces this). `worker.ts` boots: config → Sentry → DB + **migration parity wait** (never applies) → Redis (mandatory) → extension tenancy registration (tenant-erasure correctness) → event subscribers → global registry entries → slim raw-HTTP health server → phased shutdown. `autoMigrate` gains a session advisory lock (defense-in-depth, mirrors the extension migrator). The report-schedule inline fallback gets a `lastGeneratedAt` CAS claim and is gated to `all`. Compose: shared `x-api-env` anchor, `worker` service behind `profiles: ["worker-split"]`, hardcoded `BREEZE_ROLE: worker`, API role driven by a separate `BREEZE_API_ROLE` var.

**Tech Stack:** TypeScript, tsup named entries (precedent: `scripts/recover-stuck-agents`), raw `node:http`, Vitest (unit + one boot smoke), YAML anchors. **No new DB migrations** (the advisory lock is code around the runner, not a migration).

**Design authority:** #4086 + advisor quorum 2026-08-27 (Claude position + codex xhigh; codex amendments adopted). **Do not relitigate:** placement is `'global' | 'socket-owner'` (not per-entry role lists); entries whose import closure or runtime reaches socket-local dispatch stay `socket-owner` THIS wave (migrating `commandQueue`/`scriptDispatch`/`softwareDeployment`/`quickSupportEnd`/`agentCommandRelay` to the relay facade is a filed follow-up — Quick Support additionally needs cross-process socket EVICTION); worker never applies migrations; no global BullMQ `pause()`; report inline fallback exists only in `all`; per-consumer `worker.waitUntilReady()` readiness is an accepted gap (no current code calls it) noted as follow-up; droplet rollout is manual and documented, NOT executed.

## Global Constraints

- **`BREEZE_ROLE=all` behavior parity is the safety story**: with role `all`, every registry entry starts exactly as today (same order guarantees: main array → event dispatch phase 2 → relay consumer), the HTTP server serves, and no new gating fires. Any observable `all`-mode change is a bug.
- Run single test files as `cd apps/api && npx vitest run <path>`. Full-suite + `NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit` for typecheck (known OOM).
- New env vars (`BREEZE_API_ROLE` is compose-side indirection only — the process still reads `BREEZE_ROLE`) follow env-parity rules: `.env.example` + both compose files in the same task (`envComposeParity.test.ts`).
- `composeBindMounts.test.ts` auto-covers new compose services — any new bind-mount source must exist on disk.
- Registry migration must be provably lossless: the contract test snapshots all 104 current names (list in Task 1) and fails on any missing/renamed entry.
- Worker-role Redis is mandatory: `worker.ts` fails boot (exit non-zero) if Redis is unreachable — never the `skipped-no-redis` limp mode (`index.ts:1354-1359` keeps that for api/all).
- Existing role groundwork (from 3.5b, do not duplicate): `breezeRole()` (`config/env.ts:236-250`), validate.ts entry + `APP_ENCRYPTION_KEY_ID` pairing (`validate.ts:613-618`, `:1742-1763`), socket-local assertions throw under worker role, relay consumer gate (`index.ts:1516-1547`).
- Commit after every task with trailers:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_012o7QB15EFjEvetDAXMxmae`

## File Structure

| File | Responsibility |
|---|---|
| `apps/api/src/services/workerRegistry.ts` (new) | Declarative lazy registry: 104 entries + placements; `startRegisteredWorkers(role, hooks)`, `buildWorkerShutdownTasks()`. |
| `apps/api/src/worker.ts` (new) | Worker entrypoint: boot pipeline, slim health server, phased shutdown. |
| `apps/api/src/services/webhookFanoutDeps.ts` (new) | `buildWebhookFanoutDeps()` extracted from index.ts (leaf). |
| `apps/api/src/services/monitorCommands.ts` (new) | `buildMonitorCommand` + pure helpers extracted from `routes/monitors.ts` (cleans monitorWorker's closure). |
| `apps/api/src/jobs/aiAgentEnqueuer.ts` (new) | The `registerAgentRunEnqueuer(enqueueAgentRunJob)` side effect, importable without the consumer. |
| `apps/api/src/db/migrationParity.ts` (new) | `waitForMigrationParity()` — read-only ledger check with timeout/jitter. |
| `apps/api/src/db/autoMigrate.ts` (modify) | Session advisory lock around the run (mirror `extensions/migrator.ts:106-114`). |
| `apps/api/src/jobs/reportScheduleWorker.ts` (modify) | Inline-path occurrence CAS; inline fallback gated to `all`. |
| `apps/api/src/index.ts` (modify) | Registry-driven init/shutdown; refuse `BREEZE_ROLE=worker`; role-filtered start. |
| `apps/api/src/services/workerEntrypointClosure.contract.test.ts` (new) | Import-closure guard + registry losslessness. |
| `apps/api/tsup.config.ts`, `docker-compose.yml`, `deploy/docker-compose.prod.yml`, `.env.example` (modify) | `worker` entry + compose worker service + anchor + `BREEZE_API_ROLE`. |
| `docs/deploy/worker-split.md` (new) | Droplet runbook: rollout order, presence check, rollback. |

---

### Task 1: The worker registry (lossless, lazy, placed)

**Files:**
- Create: `apps/api/src/services/workerRegistry.ts`, `apps/api/src/services/workerRegistry.test.ts`
- (index.ts conversion is Task 4 — this task only builds and tests the registry module.)

**Interfaces:**
- Produces:
  - `type WorkerPlacement = 'global' | 'socket-owner'`
  - `interface WorkerRegistration { name: string; placement: WorkerPlacement; load: () => Promise<{ init: () => Promise<void> | void; shutdown?: () => Promise<void> }> }`
  - `WORKER_REGISTRY: readonly WorkerRegistration[]` (104 entries, same order as today's array)
  - `selectWorkers(role: BreezeRole): readonly WorkerRegistration[]` — `all` → everything; `api` → socket-owner only; `worker` → global only
  - `startRegisteredWorkers(role, { onResult(name, ok, err) }): Promise<void>` — loads+inits the selection with today's Promise.allSettled semantics, reporting per-name outcomes
  - `buildWorkerShutdownTasks(role): Promise<Array<() => Promise<void>>>` — the loaded modules' shutdown fns, same relative order as today's `workerShutdownTasks`

Registry entry shape (every entry follows this literal pattern — the `load` thunk is what keeps worker.ts's import closure clean):

```ts
  {
    name: 'alertWorkers',
    placement: 'global',
    load: async () => {
      const m = await import('../jobs/alertWorker');
      return { init: m.initializeAlertWorkers, shutdown: m.shutdownAlertWorkers };
    },
  },
```

**Placement classification is mechanical, not judgment:** an entry is `socket-owner` iff its module's **runtime import closure** (follow relative imports transitively; ignore `import type`) reaches `routes/agentWs.ts` or `services/agentCommandAwait.ts`, OR it is `agentCommandRelay` (excluded — stays a phase-2 special in index.ts, not a registry entry, same for `eventDispatch`). Known-expected socket-owner entries from the quorum's verified sample: `quickSupportReaper` (via `services/quickSupportEnd`), `softwareDeploymentScheduler` (via `services/softwareDeployment`), `automationWorker` (via `automationRuntime → scriptDispatch`), `monitorWorker` (via `services/agentCommandRelay`, a VALUE import of `isAgentConnected`/`sendCommandToAgent` from `routes/agentWs.ts` at `agentCommandRelay.ts:25` — Task 3's extraction of `buildMonitorCommand` into `services/monitorCommands.ts` only drops `routes/monitors.ts` itself from the closure, it does NOT clear this path, so `monitorWorker` stays `socket-owner` this wave; migrating `agentCommandRelay`'s `routes/agentWs` dependency to a lazy `await import(...)` inside its `breezeRole() !== 'worker'`-guarded branches is the filed follow-up that would let it and every other relay consumer go `global`), plus every entry reaching `services/commandQueue` (it imports agentWs) — expect this to sweep in patch/maintenance/CIS/audit/peripheral/sensitive-data/stale-command families. The implementer RUNS the Task 5 closure tool to classify, does not guess; the exact resulting split is recorded in this plan doc as part of Task 5.

The 105 names, in the pre-registry order (orgMerge added in the 08-27 main merge — the registry must contain exactly these): alertWorkers, alertCorrelationWorker, metricRollupsWorker, metricRollupMaintenance, metricAnomaliesWorker, fleetFindingsWorker, fleetRemediationDispatchWorker, mlOutputRetention, offlineDetector, notificationDispatcher, webhookDelivery, webhookDeliveryRecovery, policyEvaluationWorker, softwareComplianceWorker, softwareRemediationWorker, aiAgentRunner, auditBaselineJobs, cisJobs, automationWorker, securityPostureWorker, reliabilityWorker, userRiskWorker, abuseSignalsWorker, userRiskRetention, backupVerificationJobs, eventLogRetention, logCorrelationWorker, agentLogRetention, ipHistoryRetention, reliabilityRetention, processSampleRetention, deviceMetricsRetention, serviceProcessCheckRetention, changeLogRetention, oauthCleanup, stripeAccountCacheRefresh, exchangeRateSync, oauthRevocationRetryWorker, mtlsCertificateRevocationWorker, authEmailWorker, quoteSendWorker, enrollmentKeyCleanup, quickSupportReaper, softwareUploadSessionCleanup, softwareRemediationRequestCleanup, auditRetention, auditChainVerify, auditChainAnchor, tenantErasure, orgMerge, desktopSessionFinalization, desktopSessionOrphanRecovery, playbookRetention, discoveryWorker, networkBaselineWorker, snmpWorker, monitorWorker, unifiWorker, unifiTelemetryWorker, snmpRetention, patchComplianceReportWorker, reportScheduleWorker, cveEnrichmentWorker, wingetIndexSyncWorker, vulnerabilityJobs, dnsSyncWorker, s1SyncWorker, huntressSyncWorker, pax8SyncWorker, tdSynnexSftpSyncWorker, logForwardingWorker, patchJobWorker, patchSchedulerWorker, maintenanceRebootWorker, backupWorker, sensitiveDataWorker, peripheralJobs, browserSecurityWorker, c2cBackupWorker, backupSlaWorker, drExecutionWorker, recoveryMediaWorker, recoveryBootMediaWorker, warrantyWorker, ssoDomainRecheckWorker, incidentCorrelationWorker, incidentTimelineEnricher, incidentSlaMonitor, staleCommandReaper, softwareDeploymentScheduler, pamJobs, approvalExpiryReaper, offboardingDrainReaper, intentOutboxPublisher, intentExpiryReaper, intentReleaseWorker, stripeReconcileSweep, quoteExpiryReaper, suppressionExpiryReaper, ticketNotifyWorker, ticketSlaWorker, inboundEmailWorker, ticketMailboxPollWorker, invoiceWorker, contractWorker.

Note: `webhookDelivery`'s stop is currently `getWebhookWorker().stop()` in the shutdown preamble (index.ts:1614), not a `shutdown*` in the phased list — its registry entry's `shutdown` wraps that same call; keep the preamble call in index.ts (double-stop must be a no-op — verify `stop()` is idempotent, it null-checks internally; if not, guard).

- [x] **Step 1: Write the failing tests** — registry contains exactly the 104 names above in that order (`expect(WORKER_REGISTRY.map(e => e.name)).toEqual([...])` with the literal list); `selectWorkers('all').length === 104`; `selectWorkers('api')` + `selectWorkers('worker')` partition the set with no overlap/loss; `startRegisteredWorkers` calls `load()` ONLY for selected entries (spy: a fake registry passed via test seam, or test against two known entries with vi.mock on their modules — prefer a `_startWorkersForTest(entries, role, hooks)` internal export taking an injectable registry); init failures are isolated per entry and reported via `onResult(name, false, err)`; `buildWorkerShutdownTasks` returns shutdowns only for LOADED entries, registry order.
- [x] **Step 2: Run to verify failure.**
- [x] **Step 3: Implement** — entries as the literal pattern above; module paths/export names transcribed from today's `index.ts` import block (the implementer greps each `initialize*`/`shutdown*` import specifier — do not guess names; the naming drift is real, e.g. `userRiskWorker` → `shutdownUserRiskJobs`). Placement: mark the strongly-suspected socket-owner set above; Task 5's tool is the authority and will correct any misclassification (its test fails on mismatch).
- [x] **Step 4: Run tests + typecheck → PASS. Commit:** `feat(api): declarative lazy worker registry with placement (wave 3.5d-b #4086)`

---

### Task 2: Leaf extractions — webhook fanout deps, monitor command builder, AI-agent enqueuer

**Files:**
- Create: `apps/api/src/services/webhookFanoutDeps.ts` (move `buildWebhookFanoutDeps` verbatim from `index.ts:1284-1330`; its imports — `runWithSystemDbAccess`, `db`, `webhooksTable`, drizzle ops, `toWebhookConfig`, `recordWebhookDelivery`, `captureException` — move with it)
- Create: `apps/api/src/services/monitorCommands.ts` (move `buildMonitorCommand` + any pure helpers it needs OUT of `routes/monitors.ts`; `routes/monitors.ts` re-imports from the new module so route behavior is unchanged; `jobs/monitorWorker.ts` switches its import to the new module — after this, monitorWorker's closure must NOT reach `routes/`)
- Create: `apps/api/src/jobs/aiAgentEnqueuer.ts`:

```ts
// Producer-side registration for AI agent runs (wave 3.5d-b, #4086).
// Split from aiAgentRunner.ts so a process can register the enqueuer (API
// routes need it even when the consumer worker never starts — Redis-down
// boots, api-role processes) without importing the BullMQ consumer.
import { registerAgentRunEnqueuer } from '../services/aiAgents/runService';
import { enqueueAgentRunJob } from './aiAgentRunner';

export function registerAiAgentEnqueuer(): void {
  registerAgentRunEnqueuer(enqueueAgentRunJob);
}
```

  CHECK FIRST: if `enqueueAgentRunJob` cannot be imported without pulling the consumer graph (same module), move `enqueueAgentRunJob` itself (and the queue singleton it uses) into the new file and have `aiAgentRunner.ts` import it back; delete the module-scope `registerAgentRunEnqueuer(...)` call at `aiAgentRunner.ts:140-141`; `index.ts` and `worker.ts` call `registerAiAgentEnqueuer()` explicitly during boot (before routes serve / before workers start). Preserve the header-comment rationale (:22-29) in the new module.
- Modify: `apps/api/src/index.ts` — import `buildWebhookFanoutDeps` from the new service; call `registerAiAgentEnqueuer()` right before `registerAllEventSubscribers(...)` (:2117).
- Tests: co-located tests asserting `buildWebhookFanoutDeps().getWebhooksForEvent` filters active + event-matched webhooks (port any existing coverage), `monitorCommands` builds the same command shape monitorWorker's tests expect (existing monitorWorker tests keep passing untouched), and that importing `aiAgentEnqueuer` + calling `registerAiAgentEnqueuer()` registers exactly once (idempotent on second call).

- [x] **Step 1: failing tests → Step 2: verify fail → Step 3: implement moves (git mv semantics — verbatim bodies, only import paths change) → Step 4: run monitorWorker + webhook + aiAgentRunner test files + typecheck → PASS. Commit:** `refactor(api): extract webhook fanout deps, monitor command builder, ai-agent enqueuer to leaf modules (#4086)`

---

### Task 3: Migration parity helper + advisory lock in autoMigrate

**Files:**
- Create: `apps/api/src/db/migrationParity.ts`, `apps/api/src/db/migrationParity.test.ts`
- Modify: `apps/api/src/db/autoMigrate.ts` (lock around the run), extend `autoMigrate.test.ts`

**Interfaces:**
- Produces: `waitForMigrationParity(opts?: { timeoutMs?: number; pollIntervalMs?: number; log?: (m: string) => void }): Promise<void>` — resolves when every filename from `discoverCoreMigrationFilenames()` (`autoMigrate.ts:369`) exists in `breeze_migrations` with a matching checksum (reuse/export autoMigrate's checksum function — grep how it computes the content hash and export it rather than duplicating); extra DB rows (newer binary elsewhere) log a warning and do NOT fail; on timeout (default 120_000ms, poll 3_000ms + jitter) throws with a diagnostic listing missing/mismatched filenames.

- [x] **Step 1: failing tests** — parity: mock the ledger read + filenames (inject via options or vi.mock the db client) covering: all-present-matching → resolves; missing file → keeps polling then throws with the filename in the message; checksum mismatch → throws naming the file; extra DB rows → resolves with warning. Advisory lock: assert `autoMigrate()` acquires `pg_advisory_lock(hashtextextended('breeze-core-migrations', 0))` on a reserved connection BEFORE reading the ledger and releases in `finally` (mirror `extensions/migrator.ts:106-114` + `:184-214` — reserve → lock → work → unlock → release); on a thrown migration the unlock still runs (test the finally path).
- [x] **Step 2: verify fail → Step 3: implement → Step 4: run `npx vitest run src/db/migrationParity.test.ts src/db/autoMigrate.test.ts` + typecheck → PASS. Commit:** `feat(api): migration parity wait + core migrator advisory lock (#4086)`

---

### Task 4: index.ts on the registry + role fail-closed

**Files:**
- Modify: `apps/api/src/index.ts`

- [x] **Step 1: Entrypoint role guard** at the very top of `bootstrap()` (before any side-effectful step):

```ts
  if (breezeRole() === 'worker') {
    console.error('[boot] BREEZE_ROLE=worker cannot run the API entrypoint (dist/index.cjs) — use dist/worker.cjs');
    process.exit(78); // EX_CONFIG
  }
```

- [x] **Step 2: Replace the 104-entry array** in `initializeWorkers()` with `startRegisteredWorkers(breezeRole(), { onResult: (name, ok, err) => { workerStatus[name] = ok; if (!ok) { console.error(...); captureException(...); } } })`, preserving: the Redis guard (:1354-1359), `workerInitPhase` transitions, phase-2 event dispatch (**gate it `breezeRole() !== 'api'`** — under `api` role the event-dispatch consumer moves to the worker container; under `all` it runs as today), the relay-consumer gate (unchanged), `readiness.invalidate()` calls. Delete the 104 static `initialize*` imports that the registry now lazy-loads (the `shutdown*` imports go too — next step). KEEP static imports that other parts of index.ts still use.
- [x] **Step 3: Replace `workerShutdownTasks` (:1645-1748)** with `await buildWorkerShutdownTasks(breezeRole())` — loaded-entries-only, same order (the phased structure from Part A is untouched; only the `workers` phase's task list source changes; the preamble `getWebhookWorker().stop()` stays).
- [x] **Step 4: Parity proof (all-mode)** — extend/adjust index-level tests if any exist; the real gate: full unit suite green + Task 5's losslessness test + a manual boot smoke in Task 7. Run full suite + typecheck. Commit: `refactor(api): index.ts starts workers via the placed registry; refuses worker role (#4086)`

---

### Task 5: Import-closure contract test + final placement classification

**Files:**
- Create: `apps/api/src/services/workerEntrypointClosure.contract.test.ts`

**Mechanism:** a small resolver (in the test file): parse `import ... from '<spec>'` + `await import('<spec>')` with regex; follow RELATIVE specifiers only (bare package imports are runtime-safe); skip `import type` lines; resolve `.ts`/`/index.ts`; memoize; return the transitive file set.

- [x] **Step 1: Write the test three ways:**
  1. **Worker entrypoint closure**: closure(`src/worker.ts`) must NOT contain `routes/agentWs.ts`, anything under `routes/` at all, `services/agentCommandAwait.ts`, or `index.ts`. (worker.ts imports the registry, whose `load()` thunks are dynamic — the resolver must NOT follow dynamic imports for this assertion, that's the point; assert statically-reachable set only.)
  2. **Global-placement closures**: for every `WORKER_REGISTRY` entry with `placement: 'global'`, extract its `load()` target specifier (regex the registry source for `import('<spec>')` per entry) and assert that module's closure (dynamic-follow ON here) does not contain `routes/agentWs.ts` or `services/agentCommandAwait.ts`. A global entry whose closure reaches them = placement bug → test names the entry and the offending path chain.
  3. **Losslessness**: registry names set-equals the 104-name list (duplicated literal in the test).
- [x] **Step 2: Run it — let it FAIL on every misclassified entry, then flip those entries to `socket-owner` in the registry until honest-green.** Record the final classification (counts + the socket-owner name list) in THIS plan doc under "Final placement" below, and in the PR body. Sanity-expect: monitor/snmp/backup/discovery/networkBaseline ALL socket-owner, not just monitorWorker — every one of their closures reaches `routes/agentWs.ts` via `services/agentCommandRelay.ts:25`'s `import { isAgentConnected, sendCommandToAgent } from '../routes/agentWs'` — a VALUE import, not type-only, so the closure tool correctly counts it even though the calls it guards are runtime-safe (`breezeRole() !== 'worker'`-gated; Task 3's extraction only removed `routes/monitors.ts` from monitorWorker's closure, not this relay path). Consequence: these heavy agent-I/O workers stay in the `api` container THIS wave — `worker` never runs them. The one-line lazy-import flip (moving `agentCommandRelay.ts`'s `routes/agentWs` import behind an `await import(...)` inside its `breezeRole() !== 'worker'`-guarded branches) is the immediate follow-up that would let all five go `global`. automation/quickSupport/softwareDeployment/commandQueue-reachers socket-owner.
- [x] **Step 3: Commit:** `test(api): worker entrypoint import-closure contract + final placements (#4086)`

**Final placement (filled 2026-08-27, Task 5):** global = 81, socket-owner = 24 (out of 105 total) — amended by #4141: services/agentCommandRelay.ts now lazy-imports routes/agentWs inside its role-guarded branches, and the closure contract test treats the facade as a role-safe boundary module (with self-invalidating guards: no static agentWs value-import, both call sites role-guarded), so discovery/networkBaseline/snmp/monitor/backup all flipped to global (networkBaseline+discovery additionally needed isCronDue extracted to services/cronDue.ts — their second agentWs chain ran through automationRuntime→scriptDispatch). (Historical, pre-#4141: the initial classification put all five agent-I/O workers socket-owner because of the then-static agentCommandRelay→agentWs edge; policyEvaluationWorker was also flipped from the Task 1 guess to socket-owner — its closure reaches agentWs via policyEvaluationService → automationWorker → automationRuntime → scriptDispatch.)

socket-owner (24): fleetRemediationDispatchWorker, policyEvaluationWorker, softwareComplianceWorker, softwareRemediationWorker, aiAgentRunner, auditBaselineJobs, cisJobs, automationWorker, backupVerificationJobs, eventLogRetention, quickSupportReaper, desktopSessionFinalization, orgMerge, desktopSessionOrphanRecovery, patchJobWorker, patchSchedulerWorker, maintenanceRebootWorker, sensitiveDataWorker, peripheralJobs, drExecutionWorker, staleCommandReaper, softwareDeploymentScheduler, offboardingDrainReaper, intentReleaseWorker.

global (76): everything else in `WORKER_REGISTRY` not listed above.

---

### Task 6: Worker entrypoint — `worker.ts`

**Files:**
- Create: `apps/api/src/worker.ts`; Modify: `apps/api/tsup.config.ts` (add `worker: 'src/worker.ts'` named entry)
- Test: `apps/api/src/worker.boot.test.ts` (unit-level: mock the heavy deps, assert boot order + readiness composition + role guard), plus the Task 7 live smoke

**Boot pipeline (order is the contract; each numbered step is awaited before the next):**

```ts
// apps/api/src/worker.ts — BREEZE_ROLE=worker entrypoint (wave 3.5d-b, #4086).
// Deliberately imports NO route modules: the import-closure contract test
// (workerEntrypointClosure.contract.test.ts) enforces it.
```

1. `import 'dotenv/config'` (match index.ts's env loading); `breezeRole() === 'worker'` or `console.error` + `process.exit(78)` (fail closed — this binary runs ONLY as worker).
2. `validateConfig()`; `initSentry()` (same helpers index.ts uses — verify they're importable without the route graph; if `instrument.ts`/sentry setup is route-free, reuse; otherwise extract the shared bit).
3. Start the **slim health server FIRST** (raw `node:http`, port `API_PORT` env default 3001): `/health` → 200 `{status:'ok', role:'worker', phase}` always once listening; `/health/ready` → 503 with `{reason}` until step 8 flips it, then delegates to a `createReadinessEvaluator` instance wired with: `checkDb`, `checkRedis`, `requireRedis: true` (ALWAYS true for worker — ignore `REQUIRE_REDIS_ON_STARTUP`), `workersHealthy: () => computeWorkersHealthy({ phase: workerInitPhase, workerStatus, redisOk: true, shuttingDown })`, same TTL/probe-timeout options as index.ts (:477-505 is the model). Structured 503 bodies: `{ready:false, reason:'migrations-pending'|'db'|'redis'|'workers-pending'|'shutting-down'}`.
4. DB reachability probe, then `await waitForMigrationParity({...})` — NEVER `autoMigrate()`.
5. Redis mandatory: `isRedisAvailable()`/probe or exit non-zero with a clear message.
6. Extension runtime (worker-safe): call `loadBuiltinExtensions({ registry, stateStore, mode: 'worker' })` — add the `mode` option to `extensions/builtinExtensions.ts`: `'worker'` runs per-builtin **migration parity check (reuse the extension ledger read; never applies)** → `publishTenancy` → state-store seed → registry activate, and SKIPS web-asset registration; `'full'` (default) is today's pipeline unchanged. Failure aborts boot (same as api — built-ins are required code). Unit-test the mode branch with the existing builtinExtensions test seams.
7. `registerAiAgentEnqueuer()`; `registerAllEventSubscribers(buildWebhookFanoutDeps())` (both from Task 2's leaf modules).
8. `startRegisteredWorkers('worker', hooks)` with the same onResult bookkeeping; then the phase-2 **event-dispatch worker** (`initializeEventDispatchWorker()` — global placement family, runs here); NO relay consumer (socket-owner). Set `workerInitPhase = 'started'`; audit-retry drain interval (same 30s shape as `index.ts:2126-2132`).
9. Signal handlers → phased shutdown via `runShutdownPhases` with: `drain` (bounded audit drain) → `workers` (`buildWorkerShutdownTasks('worker')`) → `queues` (`shutdownEventDispatcher`, `shutdownEventDispatchWorker`, `shutdownEventDispatchQueue` — no relay) → `eventbus` → `redis` → `db` → `sentry`; health server closed in the preamble (readiness flips not-ready first); exit codes as index.ts (Part A semantics). Second-signal force-exit identical to index.ts.

- [x] **Step 1: failing boot tests** — mock `./db/migrationParity`, `./services/workerRegistry`, redis/db probes, extension loader; assert: wrong role exits 78 before any side effect; parity failure → process exits non-zero and `/health/ready` (if queried before death) said `migrations-pending`; Redis-down → exit non-zero (no limp mode); boot order (parity before workers; subscribers before workers); ready flips only after all init results recorded; SIGTERM runs phases in order (spy on runShutdownPhases input names).
- [x] **Step 2: verify fail → Step 3: implement (including the `mode: 'worker'` extension option + its tests) → Step 4: run the new tests + full typecheck → PASS. Commit:** `feat(api): worker-role entrypoint with parity gate, slim health, phased shutdown (#4086)`

---

### Task 7: Report-schedule occurrence CAS + inline gating; boot smoke

**Files:**
- Modify: `apps/api/src/jobs/reportScheduleWorker.ts`; extend its test file

- [x] **Step 1: failing tests** — (a) inline fallback arms ONLY when `breezeRole() === 'all'` (worker/api roles: log + skip, even with Redis down); (b) the inline path claims before running: `findDueReports` already returns `{id, occurrenceKey}` — extend it to also return `lastGeneratedAt` (observed); the inline branch performs `UPDATE reports SET last_generated_at = now(), updated_at = now() WHERE id = $id AND last_generated_at IS NOT DISTINCT FROM $observed RETURNING id` (Drizzle: `.update().set(...).where(and(eq(id), observed === null ? isNull(lastGeneratedAt) : eq(lastGeneratedAt, observed))).returning(...)`) and calls `processRunScheduledReport(..., { occurrenceClaimed: true })` ONLY on a returned row — losing the CAS logs + skips; (c) with `occurrenceClaimed: true`, `processRunScheduledReport` SKIPS its own stamp at :488-491 (it already happened atomically); (d) the queued/BullMQ path is byte-identical to today (no claim — BullMQ's occurrence-keyed jobId `report-sched-run-<id>-<key>` is the dedup, and retries must not be consumed by a one-shot claim); assert compiled SQL for the CAS via the PgDialect pattern (vacuous-Drizzle-assertion memory).
- [x] **Step 2: verify fail → Step 3: implement → Step 4: run the reportScheduleWorker tests + typecheck → PASS. Commit:** `fix(api): report schedule inline fallback — occurrence CAS + all-role gate (#4086)`
- [x] **Step 5: Boot smoke (live)** — `pnpm --filter @breeze/api build` (tsup) then, against the running test stack (postgres+redis from docker-compose.test.yml; boot it if absent): `BREEZE_ROLE=worker API_PORT=3199 DATABASE_URL=<test> REDIS_URL=<test> node dist/worker.cjs` in background; poll `curl -sf localhost:3199/health/ready` until 200 (bounded 90s); assert the JSON says ready; SIGTERM it; assert exit 0 and ordered phase log lines present. Also `BREEZE_ROLE=worker node dist/index.cjs` must exit 78 immediately, and `BREEZE_ROLE=all node dist/worker.cjs` must exit 78. Record the transcript in the task report. (If the test stack cannot run migrations for parity — run `pnpm db:migrate` against it first with the repo's env.)

---

### Task 8: Compose + env plumbing

**Files:**
- Modify: `docker-compose.yml`, `deploy/docker-compose.prod.yml`, `.env.example`, `apps/api/src/config/env.ts`? (NO — the process keeps reading `BREEZE_ROLE`; `BREEZE_API_ROLE` is compose-side only)

- [x] **Step 1:** In BOTH compose files: factor the api service's environment block into a top-level `x-api-env: &api-env` anchor (pure move — `environment: *api-env` on api; diff must show zero key changes); change the api service's mapping `BREEZE_ROLE: ${BREEZE_ROLE:-all}` → `BREEZE_ROLE: ${BREEZE_API_ROLE:-all}` (a droplet flipping the API to api-role touches only `BREEZE_API_ROLE`, and can never accidentally change the worker). Add the `worker` service:

```yaml
  worker:
    image: ${BREEZE_API_IMAGE_REF:?Set BREEZE_API_IMAGE_REF to a digest-pinned image ref}
    platform: ${DOCKER_PLATFORM:-linux/amd64}
    container_name: breeze-worker
    restart: unless-stopped
    profiles: ["worker-split"]
    command: ["node", "dist/worker.cjs"]
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    tmpfs:
      - /tmp:size=64m,mode=1777
    environment:
      <<: *api-env
      BREEZE_ROLE: worker        # hardcoded — never variable-driven
    volumes:
      - api_data:/data
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
    healthcheck:
      <<: *healthcheck
      test: ['CMD', 'wget', '--no-verbose', '--tries=1', '--spider', 'http://127.0.0.1:3001/health/ready']
      start_period: 60s
    networks:
      - breeze
```

  (prod file: mirror its api service's own volumes/secrets/depends_on shape — it has no postgres dependency; copy what its api has. NO watchtower label — #603. Secrets: give the worker the same `secrets:` list as that file's api service — the shared env references them.)
- [x] **Step 2:** `.env.example`: replace/augment the `BREEZE_ROLE` comment with `BREEZE_API_ROLE` (`# BREEZE_API_ROLE=all — role for the api container (all|api); the worker container is hardcoded worker. Enable the worker with: docker compose --profile worker-split up -d`). Keep `BREEZE_ROLE` documented as the process-level var.
- [x] **Step 3:** Run `npx vitest run src/config/envComposeParity.test.ts src/config/composeBindMounts.test.ts` → PASS (fix what they flag). `docker compose -f docker-compose.yml config >/dev/null` and same for prod file with required env stubs — YAML must parse. Commit: `feat(compose): worker-split profile service + shared api env anchor (#4086)`

---

### Task 9: Runbook + docs + PR

- [x] **Step 1:** Write `docs/deploy/worker-split.md`: prerequisites (Part A + Part B deployed, `APP_ENCRYPTION_KEY_ID` set — validate.ts enforces); the region-at-a-time rollout: (1) deploy image with API still `all`; (2) `docker compose --profile worker-split up -d worker`; (3) wait for worker `/health/ready` 200 + `docker ps` presence check; (4) set `BREEZE_API_ROLE=api` in `/opt/breeze/.env`, recreate api; (5) verify relay consumption + a representative scheduled job + agent command dispatch; (6) soak; rollback = `BREEZE_API_ROLE=all`, recreate api, wait ready, THEN stop worker. Add the required-service-PRESENCE check (the version-parity loop cannot detect a never-started worker): `docker ps --format '{{.Names}}' | grep -q breeze-worker`. Explicit: hand-maintained droplet compose + the deploy service line must add `worker` (the portal-stale incident); Watchtower label forbidden.
- [x] **Step 2:** Full unit suite + typecheck + both contract tests + integration config untouched-green. Tick plan checkboxes; fill "Final placement" in Task 5.
- [ ] **Step 3:** PR: branch `feature/3821-ai-agents/wave-4086` → main, body includes `Closes #4086`, the placement split, `all`-mode parity statement, the boot-smoke transcript summary, follow-ups to file (facade migration for commandQueue/scriptDispatch/softwareDeployment/quickSupportEnd/agentCommandRelay + socket eviction relay; per-consumer waitUntilReady readiness; worker secret-set minimization), and the manual-deploy pointer to the runbook. **Stop after opening the PR.**

## Self-Review Notes

- `all`-parity: registry selection for `all` = all 104 in original order; phase-2 order preserved; report inline fallback still arms under `all`+no-Redis; index.ts HTTP/no-op changes zero.
- Requirements coverage vs #4086: role split ✓ (T1/T4/T6), separate entrypoints ✓ (T6, fail-closed both ways), compose worker service ✓ (T8), setInterval→repeatables: quorum-confirmed "placement only" for the four guarded timers (registry placement covers), reportScheduleWorker occurrence claim ✓ (T7), readiness ✓ (T6), ordered shutdown ✓ (Part A + T6), droplet deploy + parity ✓ documented-not-executed (T9, per run authorization).
- Type consistency: `WorkerRegistration`/`selectWorkers`/`startRegisteredWorkers`/`buildWorkerShutdownTasks` (T1) consumed in T4/T6; `waitForMigrationParity` (T3) in T6; leaf modules (T2) in T4/T6.
- Accepted gaps (PR-flagged): per-consumer waitUntilReady; worker gets full api env/secret set initially; socket-owner families keep api affinity until the facade follow-up.
