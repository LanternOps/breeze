---
tracking_issue: 4060
---

# S0 Track C Readiness and Offline Scaling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the code gaps in RMM-QA-020 and RMM-QA-038 by making admission depend on continuous consumer readiness and by making a 10,000-device offline sweep durable, idempotent, and bounded.

**Architecture:** Extend the existing TTL-cached, single-flight readiness evaluator with a process-local BullMQ consumer registry; do not create a second evaluator. Keep `/health` as liveness, serve both readiness paths from the same evaluator, and expose only aggregate consumer health publicly. Keep offline continuation in BullMQ job data, derive stable transition identities from the observed device state, use a one-winner database compare-and-set, and perform queue/event/alert work outside database contexts.

**Tech Stack:** TypeScript, Hono, BullMQ/Redis, Drizzle/PostgreSQL, Vitest, Docker Compose, shell-based exact-candidate evidence tooling.

**Tracking status (2026-08-25):** Tasks 1–4 are code-complete and passed exact-head PR CI at `5e3ee6ace09d717a0620336d735ac3a7b57a8b16`. Task 5 remains fixed-unverified: no exact-SHA disposable stack, exact 10,000-stale-device fixture, or reviewed in-process consumer fault control is available, so no deployment, hosted-admission, rollout, or candidate-scale claim is made.

## Finding map

| Finding | Verified current seam | Contract this plan closes |
|---|---|---|
| RMM-QA-020 | `apps/api/src/services/readiness.ts`, `apps/api/src/routes/readiness.ts`, `apps/api/src/index.ts`, `apps/api/src/jobs/workerObservability.ts`, tracked Compose files, and `scripts/prod/deploy.sh` | A required consumer that is missing, stopped, Redis-disconnected, or failed during initialization removes the API from admission within the documented threshold while process liveness stays up. |
| RMM-QA-038 | `apps/api/src/jobs/offlineDetector.ts` and its focused suites | A capped sweep resumes durably, duplicate work is idempotent, reconnect wins over stale work, and 10,000 stale devices drain with measured database and queue headroom. |

## Global constraints and resolved controller decisions

- Preserve the existing `createReadinessEvaluator()` TTL, single-flight, bounded-probe, invalidation, and shutdown behavior. There is one evaluator and one readiness verdict.
- Publish a **10,000 ms maximum readiness transition visibility threshold** in `docs/operations/health-probes.md`. Defaults remain a 5,000 ms cache TTL and 3,000 ms per-probe timeout. Clamp configuration so `ttlMs + probeTimeoutMs <= 10_000`; never claim instantaneous failure or recovery.
- Keep Compose API healthchecks on `/health` liveness because `service_healthy` gates dependent startup. Use `/ready` for the exact-status deploy admission check and any external admission controller that can withhold traffic without preventing process startup.
- A registry lifecycle transition calls `readiness.invalidate()`, so worker transitions normally become visible earlier than the published bound. The bound still covers the next request, a cached dependency verdict, and one bounded probe.
- All BullMQ consumers started by `initializeWorkers()` are required whenever their configured initializer is enabled. This is deliberate: the API must not admit work to a queue whose in-process consumer is absent.
- `abuseSignalsWorker` is the only verified feature-gated consumer group that may be absent: it is required when `abuseSignalsEnabled()` is true and is recorded as optional `disabled` with reason code `feature_disabled` otherwise.
- `policyAlertBridge`, `dnsThreatAlertSubscriber`, and `desktopSessionOrphanRecovery` are explicitly classified as non-consumer initializers. They remain startup checks but do not create registry entries. Schedule kill switches such as audit retention, audit chain, OAuth cleanup, upload cleanup, enrollment cleanup, Stripe refresh, exchange-rate sync, and metric maintenance suppress repeat producers only; because their Worker objects still exist, those consumers remain required.
- The outer Redis startup guard is not a feature-disable path. When required Redis is unavailable, readiness stays false; no required consumer is marked safely disabled.
- Every production `new Worker(...)` construction is attached exactly once with a unique stable registry name. Initializers that construct multiple Workers declare every consumer separately.
- Registry names, individual transition timestamps, full error objects, raw error messages, queue names, Redis endpoints, and connection strings are internal only. Public readiness exposes compatibility booleans plus aggregate counts; it never exposes a consumer-name map.
- Public consumer detail is exactly `{ required, runnable, unavailable, optionalRunning, optionalDisabled }`. The handler constructs this DTO explicitly and never serializes or spreads internal registry state.
- No database table or tenant-scoped column is added by Track C. No migration, RLS, cascade, or tenant-export registration is required.
- Offline continuation state belongs in BullMQ job data. Do not add a cursor table.
- Offline worker concurrency is configurable as `OFFLINE_DETECTOR_WORKER_CONCURRENCY`, bounded to integers 1 through 20, with the current safe default of 5. The product default does not increase until exact-candidate evidence supports a separate operational change.
- The root offline repeat keeps a 30,000 ms interval with a fixed 7,000 ms non-epoch offset. Continuations enqueue immediately and do not wait for the next repeat tick.
- Database reads and compare-and-set writes use short system database contexts. Queue publication, event publication, and alert evaluation occur at context depth zero.
- All behavior changes follow strict RED/GREEN. Record the named failing assertion before changing production code, then rerun the same command green.
- Unit tests prove behavior, not scale. RMM-QA-020 and RMM-QA-038 remain **code-complete / fixed-unverified** until the exact-candidate evidence task passes against the shipping image.
- Production deployment, edits to `/opt/breeze`, hosted admission changes, and customer-device mutation are out of scope.

## Shared interfaces

Task 1 creates these internal contracts in `apps/api/src/services/workerReadinessRegistry.ts`:

```ts
import type { Worker } from 'bullmq';

export type ConsumerLifecycleState =
  | 'expected'
  | 'running'
  | 'redis_disconnected'
  | 'stopping'
  | 'stopped'
  | 'failed'
  | 'disabled';

export interface ConsumerReadinessState {
  name: string;
  required: boolean;
  state: ConsumerLifecycleState;
  running: boolean;
  redisConnected: boolean;
  transitionedAt: string;
  lastSuccessfulJobAt: string | null;
  lastErrorAt: string | null;
  lastErrorCode: string | null;
}

export interface PublicConsumerReadinessSummary {
  required: number;
  runnable: number;
  unavailable: number;
  optionalRunning: number;
  optionalDisabled: number;
}

export interface WorkerReadinessRegistry {
  expect(name: string, required: boolean): void;
  disable(name: string, reasonCode: string): void;
  attach(name: string, worker: Worker): void;
  recordInitializationFailure(name: string, error: unknown): void;
  snapshot(): Readonly<Record<string, ConsumerReadinessState>>;
  requiredConsumersRunnable(): boolean;
}

export function summarizeConsumerReadiness(
  consumers: Readonly<Record<string, ConsumerReadinessState>>,
): PublicConsumerReadinessSummary;

export function createWorkerReadinessRegistry(options?: {
  now?: () => number;
  onTransition?: () => void;
}): WorkerReadinessRegistry;

export const workerReadinessRegistry: WorkerReadinessRegistry;
```

Registry rules are exact:

- `expect()` creates a fail-closed `expected` entry before initialization. Duplicate names throw during startup.
- `attach()` installs `ready`, `error`, `completed`, `failed`, `closing`, and `closed` listeners before asynchronously checking the Worker's client status. A `ready` event or a guarded `worker.isRunning()` plus ready Redis client sets `running=true`, `redisConnected=true`.
- `completed` updates `lastSuccessfulJobAt`. A job-level `failed` event records a sanitized `Error.name`/fixed code but leaves a runnable consumer in `running`; a failed job is not proof that the loop stopped.
- A Worker `error` event records the sanitized code and pessimistically moves the entry to `redis_disconnected` until a later `ready`. `closing` and `closed` set both booleans false. Initialization failure sets `failed`.
- An internal error code is `Error.name` when it matches `^[A-Za-z][A-Za-z0-9_]{0,63}$`; otherwise use `worker_error`. Never store a raw message in the public state.
- A required entry in `expected`, `failed`, `disabled`, `redis_disconnected`, `stopping`, or `stopped`, or with either runnable boolean false, makes `requiredConsumersRunnable()` false. Optional `disabled` entries do not.
- Every material state/timestamp change invokes `onTransition`. Registry state is synchronous and process-local.

Task 4 uses these exact job contracts in `apps/api/src/jobs/offlineDetector.ts`:

```ts
export interface DetectOfflineJobData {
  type: 'detect-offline';
  thresholdMinutes?: number;
  sweepId?: string;
  cutoffAt?: string;
  cursor?: string;
}

export interface MarkOfflineJobData {
  type: 'mark-offline';
  transitionId: string;
  deviceId: string;
  orgId: string;
  observedLastSeenAt: string;
}

export function offlineTransitionId(
  orgId: string,
  deviceId: string,
  observedLastSeenAt: string,
): string;

export function offlineContinuationJobId(sweepId: string, cursor: string): string;
```

`offlineTransitionId()` returns `offline-transition-${sha256(orgId + NUL + deviceId + NUL + canonicalIsoObservedAt)}`. `offlineContinuationJobId()` returns `offline-continuation-${sha256(sweepId + NUL + cursor)}`. Invalid UUIDs or timestamps are rejected before enqueue.

---

### Task 1: Build the continuous consumer-readiness registry

**Files:**
- Create: `apps/api/src/services/workerReadinessRegistry.ts`
- Create: `apps/api/src/services/workerReadinessRegistry.test.ts`
- Modify: `apps/api/src/jobs/workerObservability.ts`
- Modify: `apps/api/src/jobs/workerObservability.test.ts`

**Interfaces:**
- Produces every registry type and function in the shared-interface section.
- Changes `attachWorkerObservability(worker: Worker, name: string): void` to preserve existing Sentry execution tagging and reporting while delegating lifecycle tracking to `workerReadinessRegistry.attach(name, worker)`.
- Task 2 consumes `expect()`, `disable()`, and `recordInitializationFailure()`; Task 3 consumes `snapshot()`, `requiredConsumersRunnable()`, and `summarizeConsumerReadiness()`.

- [x] **Step 1: Write registry RED tests**

Use an EventEmitter-based fake Worker with `isRunning()` and a controllable `client` promise. Add literal tests for: a newly expected required consumer is not runnable; `ready` makes it runnable; `completed` advances last-success time; job `failed` records a code without stopping the loop; Worker `error` makes Redis disconnected; later `ready` recovers; `closing` and `closed` fail readiness; initialization failure fails readiness; optional disabled does not; required disabled does; duplicate names throw; invalid error names become `worker_error`; every material transition invalidates exactly once; and `summarizeConsumerReadiness()` contains only the five aggregate integer fields.

- [x] **Step 2: Run RED and retain the failing output**

```bash
pnpm --filter @breeze/api exec vitest run \
  src/services/workerReadinessRegistry.test.ts \
  src/jobs/workerObservability.test.ts
```

Expected: FAIL because `workerReadinessRegistry.ts` and the lifecycle delegation do not exist. The task report records the failing test names, not merely the command exit code.

- [x] **Step 3: Implement the minimal in-memory registry**

Implement the shared contract without timers, persistence, raw-error storage, or route serialization. Attach lifecycle tracking after preserving `tagJobExecution()`. Do not remove existing Sentry tags, isolation scopes, `error` capture, or `failed` capture.

- [x] **Step 4: Run GREEN and static checks**

```bash
pnpm --filter @breeze/api exec vitest run \
  src/services/workerReadinessRegistry.test.ts \
  src/jobs/workerObservability.test.ts
pnpm --filter @breeze/api exec eslint \
  src/services/workerReadinessRegistry.ts \
  src/services/workerReadinessRegistry.test.ts \
  src/jobs/workerObservability.ts \
  src/jobs/workerObservability.test.ts
```

Expected: both files pass; lint emits no new error.

- [x] **Step 5: Commit**

```bash
git add apps/api/src/services/workerReadinessRegistry.ts apps/api/src/services/workerReadinessRegistry.test.ts apps/api/src/jobs/workerObservability.ts apps/api/src/jobs/workerObservability.test.ts
git commit -m "fix(api): track live worker readiness"
```

### Task 2: Declare and instrument every configured consumer

**Files:**
- Create: `apps/api/src/jobs/workerReadinessManifest.ts`
- Create: `apps/api/src/jobs/workerReadinessManifest.test.ts`
- Create: `apps/api/src/jobs/workerReadinessCoverage.test.ts`
- Modify: `apps/api/src/index.ts`
- Modify the currently uninstrumented Worker-construction files:
  - `apps/api/src/workers/webhookDelivery.ts`
  - `apps/api/src/jobs/playbookRetention.ts`
  - `apps/api/src/jobs/changeLogRetention.ts`
  - `apps/api/src/jobs/softwareUploadSessionCleanup.ts`
  - `apps/api/src/jobs/reliabilityWorker.ts`
  - `apps/api/src/jobs/enrollmentKeyCleanup.ts`
  - `apps/api/src/jobs/cisJobs.ts`
  - `apps/api/src/jobs/contractWorker.ts`
  - `apps/api/src/jobs/deviceMetricsRetention.ts`
  - `apps/api/src/jobs/dnsSyncJob.ts`
  - `apps/api/src/jobs/exchangeRateSync.ts`
  - `apps/api/src/jobs/huntressSync.ts`
  - `apps/api/src/jobs/intentExpiryReaper.ts`
  - `apps/api/src/jobs/intentOutboxPublisher.ts`
  - `apps/api/src/jobs/intentReleaseWorker.ts`
  - `apps/api/src/jobs/invoiceWorker.ts`
  - `apps/api/src/jobs/ipHistoryRetention.ts`
  - `apps/api/src/jobs/logCorrelation.ts`
  - `apps/api/src/jobs/mtlsCertificateRevocation.ts`
  - `apps/api/src/jobs/networkBaselineWorker.ts`
  - `apps/api/src/jobs/oauthCleanup.ts`
  - `apps/api/src/jobs/patchJobExecutor.ts`
  - `apps/api/src/jobs/pax8SyncWorker.ts`
  - `apps/api/src/jobs/processSampleRetention.ts`
  - `apps/api/src/jobs/approvalExpiryReaper.ts`
  - `apps/api/src/jobs/auditBaselineJobs.ts`
  - `apps/api/src/jobs/auditChainAnchor.ts`
  - `apps/api/src/jobs/auditChainVerify.ts`
  - `apps/api/src/jobs/auditRetention.ts`
  - `apps/api/src/jobs/authEmailWorker.ts`
  - `apps/api/src/jobs/tenantErasure.ts`
  - `apps/api/src/jobs/ticketSlaWorker.ts`
  - `apps/api/src/jobs/quickSupportReaper.ts`
  - `apps/api/src/jobs/quoteExpiryReaper.ts`
  - `apps/api/src/jobs/quoteSendQueue.ts`
  - `apps/api/src/jobs/reliabilityRetention.ts`
  - `apps/api/src/jobs/s1Sync.ts`
  - `apps/api/src/jobs/serviceProcessCheckRetention.ts`
  - `apps/api/src/jobs/softwareComplianceWorker.ts`
  - `apps/api/src/jobs/softwareDeploymentScheduler.ts`
  - `apps/api/src/jobs/softwareRemediationRequestCleanup.ts`
  - `apps/api/src/jobs/softwareRemediationWorker.ts`
  - `apps/api/src/jobs/staleCommandReaper.ts`
  - `apps/api/src/jobs/stripeAccountCacheRefresh.ts`
  - `apps/api/src/jobs/stripeReconcileSweep.ts`
  - `apps/api/src/jobs/suppressionExpiryReaper.ts`
  - `apps/api/src/jobs/tdSynnexSftpSyncWorker.ts`
  - `apps/api/src/jobs/inboundEmailWorker.ts`
  - `apps/api/src/jobs/logForwardingWorker.ts`
  - `apps/api/src/jobs/unifiTelemetryWorker.ts`
  - `apps/api/src/jobs/ticketMailboxPollWorker.ts`
  - `apps/api/src/jobs/ticketNotifyWorker.ts`
  - `apps/api/src/jobs/pamJobs.ts`

**Interfaces:**

```ts
export type WorkerInitializerClassification =
  | { kind: 'consumers'; initializer: string; consumers: readonly string[]; requiredWhen: 'redis' | 'abuse_signals_enabled' }
  | { kind: 'non_consumer'; initializer: 'policyAlertBridge' | 'dnsThreatAlertSubscriber' | 'desktopSessionOrphanRecovery' };

export const WORKER_READINESS_MANIFEST: readonly WorkerInitializerClassification[];

export function declareExpectedConsumers(input: {
  redisAvailable: boolean;
  abuseSignalsEnabled: boolean;
  registry: WorkerReadinessRegistry;
}): void;
```

- Every initializer group in the `initializeWorkers()` array appears exactly once in `WORKER_READINESS_MANIFEST`.
- Every group except the three named `non_consumer` groups and `abuseSignalsWorker` is `kind: 'consumers'` with `requiredWhen: 'redis'`.
- `abuseSignalsWorker` is `kind: 'consumers'`, consumers `['abuseSignalsWorker']`, and `requiredWhen: 'abuse_signals_enabled'`.
- Multi-consumer mappings are explicit: `peripheralJobs` declares `peripheralAnomalyWorker` and `peripheralPolicyDistributionWorker`; `vulnerabilityJobs` declares `vulnerabilityJobs` and `vulnerabilityMaintenance`; `patchJobWorker` declares `patchJobWorker` and `patchJobDeviceWorker`; `pamJobs` declares `pamExpiryEnforcerWorker` and `pamStaleRequestWorker`. Every other verified initializer group declares its one attached consumer name.
- Schedule-only disable flags do not change manifest requirements. A consumer that exists but has no repeat producer is still runnable.

- [x] **Step 1: Write manifest and coverage RED tests**

Parse production TypeScript with the repo's TypeScript compiler dependency. Assert:

1. every literal `new Worker` construction reachable from an `initializeWorkers()` group flows to `attachWorkerObservability()` exactly once;
2. every attached stable name is present exactly once in the manifest;
3. every initializer array key is classified exactly once;
4. only the three named non-consumer initializers lack consumer names;
5. the only configured-off consumer group is `abuseSignalsWorker`, which becomes optional disabled with `feature_disabled`;
6. duplicate names, silent initializer success with no attachment, and a missing required attachment fail the contract.

Add unit cases for `declareExpectedConsumers()` with Redis unavailable, Redis available/abuse disabled, and Redis available/abuse enabled. Redis unavailable must not mark required consumers disabled.

- [x] **Step 2: Run RED and retain the complete missing-site list**

```bash
pnpm --filter @breeze/api exec vitest run \
  src/jobs/workerReadinessManifest.test.ts \
  src/jobs/workerReadinessCoverage.test.ts \
  src/jobs/workerObservability.test.ts
```

Expected: FAIL and enumerate the verified uninstrumented construction files above.

- [x] **Step 3: Implement manifest-driven startup and complete instrumentation**

In `initializeWorkers()`, call `declareExpectedConsumers()` before any initializer promise starts. On catch, call `recordInitializationFailure()` for every consumer declared by that initializer group. In the explicit abuse-signals off branch call `disable('abuseSignalsWorker', 'feature_disabled')`. Attach each construction immediately after creating it, including both patch workers and both PAM workers. Remove the boot-only `workerStatus` record and unused `getWorkerStatus()` only after the coverage and manifest tests prove parity.

- [x] **Step 4: Run GREEN and regress all job suites**

```bash
pnpm --filter @breeze/api exec vitest run \
  src/jobs/workerReadinessManifest.test.ts \
  src/jobs/workerReadinessCoverage.test.ts \
  src/jobs/workerObservability.test.ts
pnpm --filter @breeze/api exec vitest run src/jobs --maxWorkers=4
NODE_OPTIONS=--max-old-space-size=8192 pnpm --filter @breeze/api exec tsc --noEmit -p tsconfig.json
pnpm --filter @breeze/api lint
```

Expected: the focused contract and existing job suite pass; typecheck/lint add no error.

- [x] **Step 5: Commit**

```bash
git add apps/api/src/index.ts apps/api/src/jobs apps/api/src/workers/webhookDelivery.ts
git commit -m "fix(api): register every required queue consumer"
```

### Task 3: Consolidate readiness verdicts and admission probes

**Files:**
- Create: `apps/api/src/config/readinessConfig.ts`
- Create: `apps/api/src/config/readinessConfig.test.ts`
- Create: `apps/api/src/config/productionReadinessWiring.test.ts`
- Modify: `apps/api/src/services/readiness.ts`
- Modify: `apps/api/src/services/readiness.test.ts`
- Modify: `apps/api/src/routes/readiness.ts`
- Modify: `apps/api/src/routes/readiness.test.ts`
- Modify: `apps/api/src/index.ts`
- Modify: `.env.example`
- Create: `docs/operations/health-probes.md`
- Modify: `docker-compose.yml`
- Modify: `docker-compose.override.yml.dev`
- Modify: `deploy/docker-compose.prod.yml`
- Modify: `scripts/prod/deploy.sh`

**Interfaces:**

```ts
export const READINESS_TRANSITION_VISIBILITY_THRESHOLD_MS = 10_000;
export const DEFAULT_READINESS_CACHE_TTL_MS = 5_000;
export const DEFAULT_READINESS_PROBE_TIMEOUT_MS = 3_000;

export function resolveReadinessTiming(
  env: NodeJS.ProcessEnv,
  onClamp?: (name: 'READINESS_CACHE_TTL_MS' | 'READINESS_PROBE_TIMEOUT_MS', requested: number, effective: number) => void,
): {
  ttlMs: number;
  probeTimeoutMs: number;
  transitionVisibilityThresholdMs: 10_000;
};

export interface ReadinessSnapshot {
  ready: boolean;
  db: boolean;
  redis: boolean;
  workers: boolean;
  checkedAt: string;
  consumers: Readonly<Record<string, ConsumerReadinessState>>;
}

export type PublicReadinessResponse =
  | {
      ready: boolean;
      db: boolean;
      redis: boolean;
      workers: boolean;
      checkedAt: string;
      consumerSummary: PublicConsumerReadinessSummary;
    }
  | {
      ready: false;
      db: null;
      redis: null;
      workers: null;
      checkedAt: string;
      consumerSummary: null;
      error: 'readiness evaluation failed';
    };
```

`resolveReadinessTiming()` parses integers, clamps `probeTimeoutMs` to 100–5,000 ms, then clamps `ttlMs` to 0–`10_000 - probeTimeoutMs`. It logs a sanitized value-only warning through a caller callback when it clamps. Default total is 8,000 ms. The operations document publishes 10 seconds as the maximum supported failure/recovery visibility threshold and explains that configured values are constrained to preserve it.

- [x] **Step 1: Write timing, evaluator, route, and wiring RED tests**

Test defaults, invalid input, each clamp boundary, and the invariant `ttlMs + probeTimeoutMs <= 10_000`. Extend evaluator tests so missing, stopped, Redis-disconnected, and initialization-failed required consumers make `workers=false`/`ready=false`, optional disabled does not, a recovered registry makes the next invalidated evaluation ready, and shutdown still wins.

Mount one fake evaluator at both `/ready` and `/health/ready`; assert identical status and compatibility fields for healthy, DB-down, Redis-down, missing-consumer, stopped-consumer, and evaluator-error cases. Assert the response contains exactly aggregate consumer counts and contains no internal name, timestamp, error code/message, hostname, URL, or connection string from the fixture.

In `productionReadinessWiring.test.ts`, parse all three Compose files and `scripts/prod/deploy.sh`. Assert API healthchecks use `http://127.0.0.1:3001/health`, never `/ready`, preserve their nonzero `start_period`, and remain the startup dependency for caddy/web/portal. Assert the deploy admission gate requests `https://${BREEZE_DOMAIN}/ready`, requires an unredirected HTTP 200 with `"ready":true`, and never follows an authentication redirect. Also assert `/health` and `/health/live` routes remain mounted as liveness.

- [x] **Step 2: Run RED and retain the divergent-path failures**

```bash
pnpm --filter @breeze/api exec vitest run \
  src/config/readinessConfig.test.ts \
  src/services/readiness.test.ts \
  src/routes/readiness.test.ts \
  src/config/productionReadinessWiring.test.ts
```

Expected: FAIL because timing is unconstrained to the published bound, `/health/ready` has a separate evaluator, consumer aggregates are absent, and the deploy admission probe still uses `/health`.

- [x] **Step 3: Implement one internal snapshot and one public serializer**

Replace `workersHealthy(redisOk)` with the Task 1 registry snapshot and a pure composition helper. Preserve `workers` as a compatibility boolean. Make `createReadinessHandler()` construct `PublicReadinessResponse` field by field from one evaluator snapshot plus `summarizeConsumerReadiness(snapshot.consumers)`; never spread `snapshot.consumers`. Mount the same handler/evaluator at `/ready` and `/health/ready`, and delete the bare DB/Redis-only `/health/ready` branch.

Move timing parsing from `index.ts` to `readinessConfig.ts`, document the two environment variables in `.env.example`, and publish the threshold in `docs/operations/health-probes.md` without internal hostnames.

- [x] **Step 4: Keep startup probes on liveness, change only admission probes, and run GREEN**

Keep the API healthcheck in the three tracked Compose configurations on `/health`, because Compose uses it as a hard startup dependency for caddy/web/portal. Switch only the post-deploy admission request to `/ready`, requiring an unredirected HTTP 200 with `"ready":true`. Preserve `/health` and `/health/live` as liveness paths. Preserve the verified `start_period` values: 40 seconds in base/production and 60 seconds in development.

```bash
pnpm --filter @breeze/api exec vitest run \
  src/config/readinessConfig.test.ts \
  src/services/readiness.test.ts \
  src/routes/readiness.test.ts \
  src/config/productionReadinessWiring.test.ts
pnpm --filter @breeze/api exec vitest run \
  src/middleware/security.test.ts \
  src/db/dbPoolHealthWiring.test.ts \
  src/services/eventLoopMonitorWiring.test.ts
docker compose -f docker-compose.yml config --quiet
docker compose -f deploy/docker-compose.prod.yml config --quiet
docker compose -f docker-compose.yml -f docker-compose.override.yml.dev config --quiet
```

Expected: all tests and Compose validations pass.

- [x] **Step 5: Commit**

```bash
git add .env.example docs/operations/health-probes.md apps/api/src/config/readinessConfig.ts apps/api/src/config/readinessConfig.test.ts apps/api/src/config/productionReadinessWiring.test.ts apps/api/src/services/readiness.ts apps/api/src/services/readiness.test.ts apps/api/src/routes/readiness.ts apps/api/src/routes/readiness.test.ts apps/api/src/index.ts docker-compose.yml docker-compose.override.yml.dev deploy/docker-compose.prod.yml scripts/prod/deploy.sh
git commit -m "fix(ops): gate admission on continuous readiness"
```

**Rollout boundary:** `/opt/breeze/docker-compose.yml` is untracked and is not edited by this task. At a separately authorized rollout, back it up, preserve the API liveness healthcheck and adequate `start_period`, validate with `docker compose config`, configure any external admission controller to use `/ready`, and execute Task 5 against the exact candidate.

### Task 4: Make offline continuation and transitions durable and idempotent

**Files:**
- Modify: `apps/api/src/jobs/offlineDetector.ts`
- Modify: `apps/api/src/jobs/offlineDetector_fanout.test.ts`
- Modify: `apps/api/src/jobs/offlineDetector.dbcontext.test.ts`
- Modify: `apps/api/src/jobs/offlineDetector.test.ts`
- Modify: `apps/api/src/jobs/offlineDetector_configPolicy.test.ts`
- Modify: `apps/api/src/jobs/offlineDetector_reeval.test.ts`

**Interfaces:**
- Produces the two job-data interfaces and deterministic ID functions in the shared-interface section.
- Produces `resolveOfflineWorkerConcurrency(raw: string | undefined): number`, returning default 5 and clamping integers to 1–20.
- `processDetectOffline(data, dependencies)` creates or reuses `sweepId` and `cutoffAt`, keyset-pages strictly after `cursor`, enqueues deterministic mark work, and enqueues one deterministic continuation before returning when the per-job cap is reached.
- `processMarkOffline(data)` returns `{ transitioned: boolean; alertCreated: boolean }` and performs exactly one compare-and-set update inside its database context.

- [x] **Step 1: Write transition identity, continuation, CAS, context, and configuration RED tests**

Add literal tests proving:

1. the same org/device/canonical observation yields the same transition ID; another org, device, or timestamp yields a different ID; bulk entries put it in both `data.transitionId` and `opts.jobId`;
2. 6,000 candidates with a 5,000 cap enqueue 5,000 mark jobs plus exactly one continuation carrying the same cutoff/sweep and last cursor, and executing only serialized continuation data reaches the final 1,000;
3. duplicate root, continuation, and mark work produces at most one successful CAS, one event, and one alert evaluation;
4. a reconnect/status/organization change before CAS returns no row and produces no event or alert;
5. the CAS executes at database-context depth 1 while queue publication, `publishEvent()`, and `triggerOfflineAlerts()` execute at depth 0;
6. the repeat configuration is `{ every: 30_000, offset: 7_000 }`, and a continuation is enqueued immediately;
7. concurrency defaults to 5, accepts 1 and 20, and clamps/rejects zero, negatives, fractions, non-numbers, and values above 20 to a safe bounded value without increasing the default.

- [x] **Step 2: Run RED and retain each behavioral failure**

```bash
pnpm --filter @breeze/api exec vitest run \
  src/jobs/offlineDetector_fanout.test.ts \
  src/jobs/offlineDetector.dbcontext.test.ts \
  src/jobs/offlineDetector.test.ts \
  src/jobs/offlineDetector_configPolicy.test.ts \
  src/jobs/offlineDetector_reeval.test.ts
```

Expected: continuation, deterministic identity, CAS, context-depth, offset, and bounded concurrency assertions fail against the current worker.

- [x] **Step 3: Implement durable continuation and deterministic enqueue identity**

A root job creates `sweepId` and `cutoffAt` once; a continuation reuses both. Canonicalize `observedLastSeenAt` with `new Date(value).toISOString()` before hashing or querying. Use bounded completed/failed retention on mark and continuation jobs. Enqueue a continuation before return whenever the cap is reached. Duplicate scans remain safe because mark job IDs and the database transition are both idempotent.

- [x] **Step 4: Replace read-then-update with a one-winner CAS and run GREEN**

Use a short system context for this shape:

```ts
const [transitioned] = await runWithSystemDbAccess(() =>
  db.update(devices)
    .set({ status: 'offline' })
    .where(and(
      eq(devices.id, data.deviceId),
      eq(devices.orgId, data.orgId),
      inArray(devices.status, ['online', 'updating']),
      eq(devices.lastSeenAt, new Date(data.observedLastSeenAt)),
    ))
    .returning()
);

if (!transitioned) return { transitioned: false, alertCreated: false };
await publishEvent(/* existing offline event built from transitioned */);
const alertCreated = transitioned.isEphemeral
  ? false
  : await triggerOfflineAlerts(transitioned);
return { transitioned: true, alertCreated };
```

The worker switch calls `processMarkOffline()` directly; it does not wrap the full job in `runWithSystemDbAccess()`. Create the worker with `resolveOfflineWorkerConcurrency(process.env.OFFLINE_DETECTOR_WORKER_CONCURRENCY)`. Keep the default at 5.

```bash
pnpm --filter @breeze/api exec vitest run \
  src/jobs/offlineDetector_fanout.test.ts \
  src/jobs/offlineDetector.dbcontext.test.ts \
  src/jobs/offlineDetector.test.ts \
  src/jobs/offlineDetector_configPolicy.test.ts \
  src/jobs/offlineDetector_reeval.test.ts
pnpm --filter @breeze/api exec vitest run \
  src/jobs/offlineDetector*.test.ts \
  src/services/alertConditions/offlineDuration.test.ts
NODE_OPTIONS=--max-old-space-size=8192 pnpm --filter @breeze/api exec tsc --noEmit -p tsconfig.json
pnpm --filter @breeze/api exec eslint src/jobs/offlineDetector.ts src/jobs/offlineDetector*.test.ts
```

Expected: all focused and adjacent regressions pass; concurrency remains bounded with default 5.

- [x] **Step 5: Commit**

```bash
git add apps/api/src/jobs/offlineDetector.ts apps/api/src/jobs/offlineDetector_fanout.test.ts apps/api/src/jobs/offlineDetector.dbcontext.test.ts apps/api/src/jobs/offlineDetector.test.ts apps/api/src/jobs/offlineDetector_configPolicy.test.ts apps/api/src/jobs/offlineDetector_reeval.test.ts
git commit -m "fix(api): durably drain offline transitions"
```

### Task 5: Produce exact-candidate readiness and 10,000-device evidence

This task is candidate-only evidence. It does not mutate production and does not add a synthetic 10,000-device test to the ordinary unit suite.

**Candidate-only files in `/Users/toddhebebrand/breeze-rmm-qa`:**
- Create: `docs/qa/run-track-c-candidate-evidence.sh`
- Create: `docs/qa/evidence/track-c-candidate-evidence-template.md`
- Use without modifying unless a verified incompatibility requires a separate reviewed QA change: `docs/qa/seed-local-scale-fleet.sql`
- Use without modifying unless a verified incompatibility requires a separate reviewed QA change: `docs/qa/cleanup-local-scale-fleet.sql`
- Generate after execution: `docs/qa/evidence/<UTC-date>-track-c-<12-char-candidate-SHA>.md`

**Evidence contract:**
- The harness refuses a dirty candidate worktree, records the full candidate SHA and shipping image digest, and verifies the running image corresponds to that candidate before recording results.
- The result packet records exact commands, UTC timestamps, readiness timing configuration, response status/body hashes, pool metrics, queue counts, latency samples, restart point, terminal counts, cleanup counts, and pass/fail for every criterion below.
- Secrets, internal hostnames, connection strings, customer data, and raw registry errors are redacted. Disposable local IDs may be included.
- A product commit does not claim closure. The evidence packet is committed to the QA repository only after the exact-candidate run and cleanup pass.

- [ ] **Step 1: Write and dry-run the guarded evidence harness**

The shell harness accepts explicit `--candidate-worktree`, `--base-url`, `--compose-project`, and `--output` arguments; it has no production defaults. It exits before seeding unless the base URL resolves to the disposable candidate stack, the candidate tree is clean, and the image/SHA attestation succeeds. A `--dry-run` prints commands without executing faults or seed/cleanup SQL.

Run:

```bash
bash docs/qa/run-track-c-candidate-evidence.sh \
  --candidate-worktree /Users/toddhebebrand/breeze/.worktrees/s0-fleet-revalidation \
  --base-url http://127.0.0.1:3001 \
  --compose-project breeze-track-c-candidate \
  --output docs/qa/evidence/track-c-dry-run.md \
  --dry-run
```

Expected: PASS with no database, Redis, container, or evidence mutation.

- [ ] **Step 2: Rehearse readiness failure and recovery against the exact candidate**

Record normal `/health`, `/ready`, and `/health/ready`. Then, one dependency at a time:

1. break candidate database reachability;
2. restore it;
3. break required Redis reachability;
4. restore it;
5. stop/disconnect one required BullMQ consumer while leaving HTTP alive;
6. restore that consumer;
7. inject a test-candidate missing expected registry attachment.

For every failure, both ready paths return 503 and candidate admission is removed within 10,000 ms while `/health` remains 200. For every restoration, both ready paths return 200 within 10,000 ms. The two ready bodies have the same verdict and public aggregate. The body contains no registry name, raw exception, credential, hostname, endpoint, or connection string.

- [ ] **Step 3: Run the 10,000-device offline drain and restart rehearsal**

Seed exactly 10,000 stale disposable devices with guarded cleanup tags. Record pool size, active/idle/waiting connections, queue waiting/active/delayed/completed/failed counts, and a representative authenticated device-list/readiness request latency baseline. Require:

- root admission to terminal CAS-transitioned or reconnect-skipped state in under 30 seconds;
- no database transaction longer than 2 seconds;
- at least 30% database-pool headroom throughout;
- at least 30% queue/worker headroom throughout;
- zero failed jobs and no starvation of the representative request stream;
- early, middle, and final cursor devices observed;
- worker restart immediately after the first 5,000-device capped segment, followed by successful continuation from serialized job data;
- representative reconnect races remain online with zero offline event/alert;
- injected duplicate root/continuation/mark jobs produce at most one state transition/event/alert set per observation.

Run with the code default concurrency of 5 first. If it misses the 30-second drain while preserving headroom, rerun with explicit candidate-only values from 6 through 20, stopping at the lowest passing value. Record the result as an operational recommendation; do not change the code default in this task.

- [ ] **Step 4: Clean up and verify zero residue**

Run the guarded cleanup SQL and remove only queue jobs carrying the candidate sweep/tag IDs. Record zero remaining tagged devices, child rows, continuations, mark jobs, events, alerts, and failed jobs. A nonzero residue fails the packet.

- [ ] **Step 5: Finalize the evidence verdict**

Generate `docs/qa/evidence/<UTC-date>-track-c-<12-char-candidate-SHA>.md`, replace every template assertion with a recorded observation, and commit the harness/template/result only in `/Users/toddhebebrand/breeze-rmm-qa`. If any readiness or scaling criterion fails, leave the corresponding finding **code-complete / fixed-unverified**, record the failed measurement, and do not weaken the threshold or headroom criteria.

## Whole-track verification gate

After Tasks 1–4 and before the program's single combined whole-branch review:

```bash
pnpm --filter @breeze/api exec vitest run \
  src/services/workerReadinessRegistry.test.ts \
  src/jobs/workerReadinessManifest.test.ts \
  src/jobs/workerReadinessCoverage.test.ts \
  src/jobs/workerObservability.test.ts \
  src/config/readinessConfig.test.ts \
  src/services/readiness.test.ts \
  src/routes/readiness.test.ts \
  src/config/productionReadinessWiring.test.ts \
  src/jobs/offlineDetector*.test.ts \
  src/middleware/security.test.ts

NODE_OPTIONS=--max-old-space-size=8192 pnpm --filter @breeze/api exec tsc --noEmit -p tsconfig.json
pnpm --filter @breeze/api lint
docker compose -f docker-compose.yml config --quiet
docker compose -f deploy/docker-compose.prod.yml config --quiet
docker compose -f docker-compose.yml -f docker-compose.override.yml.dev config --quiet
git diff --check
```

No migration, RLS, tenant-cascade, or tenant-export command is required because this track creates no database table or tenant-scoped column. Tasks 1–4 establish code-complete status; Task 5 is the closure gate for RMM-QA-020 and RMM-QA-038.
