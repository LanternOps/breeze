---
tracking_issue: https://github.com/LanternOps/breeze/issues/4060
---

# S0 Track C Current-Main Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge current `main` into `fix/s0-readiness-offline-scaling` with the deliberate per-file resolutions and contract-closing commits the spec defines, so PR #4007 becomes mergeable without weakening Track C's continuous consumer-readiness invariants or main's role-aware lazy worker registry.

**Architecture:** One rerere-disabled merge commit carrying all 10 conflict resolutions (six import unions, the FX-allowlist hand-merge, the webhook outer-catch union plus the attach relocation, the compose anchor re-insert, and the `index.ts` hand-merge onto `startRegisteredWorkers`), followed by five contract-closing commits: manifest rekeyed to `WORKER_REGISTRY` + 6 hooks; role-scoped `declareExpectedConsumers` with the D3a declare-time flag rules and optional marker; the `worker.ts` evaluator/redaction port and `computeWorkersHealthy` deletion; compose/env/docs; webhook lifecycle tests. Then the PR-head battery and push.

**Tech Stack:** git, TypeScript/Vitest (`apps/api`), Docker Compose (`docker compose config`), js-yaml (already a test dependency), per-worktree ephemeral Postgres/Redis via `pnpm test-stack`.

**Spec:** `docs/superpowers/specs/2026-09-01-s0-track-c-current-main-port-design.md` — read it first; every resolution below argues from it. The two analyst reports it was derived from carry the file:line evidence (`scratchpad/trackc/conflict-hunk-contracts.md`, `scratchpad/trackc/silent-obligations.md`); they are not in the repo.

## Global Constraints

- Work ONLY in `/Users/toddhebebrand/breeze/.worktrees/s0-track-c-readiness` on branch `fix/s0-readiness-offline-scaling`. Base before Task 1 is the design commit on top of `ece39ca5c` (record its SHA in Task 1 Step 1; `ece39ca5c` stays the reviewed evidence anchor).
- The merge commit is the ONLY `--no-verify` commit. Every other commit runs the hooks (`.githooks/pre-commit` runs only `scan-confidential.sh --staged` and `check-migration-naming.sh --staged`; it does not typecheck, so the deliberate typecheck-RED tree between Task 1 and Task 4 commits normally).
- rerere MUST be disabled for the merge: `git -c rerere.enabled=false merge …`. The repo has a 359-entry `rr-cache`; any "using previous resolution" line means abort and retry.
- Never add or reorder `WORKER_REGISTRY` entries (`workerRegistry.test.ts` pins 115 names in order; `workerEntrypointClosure.contract.test.ts` parses the file's text and expects exactly 115 `name:` hits).
- Never touch a migration. Track C adds none; main's incoming migrations are taken as-is by the merge.
- Do not bulk-prefer either side of any conflict. No file in this port is a pure whole-file checkout; every resolution is a hand union specified per hunk in Task 1.
- API typecheck: `NODE_OPTIONS=--max-old-space-size=8192 pnpm --filter @breeze/api exec tsc --noEmit` (run from the worktree root).
- Unit tests: `pnpm --filter @breeze/api exec vitest run <paths relative to apps/api>` (e.g. `src/jobs/workerReadinessManifest.test.ts`).
- Integration stack: `pnpm test-stack up` / `pnpm test-stack down` from the worktree root — NOT `pnpm --filter @breeze/api test:docker:up`, which uses the fixed container names `breeze-postgres-test` / `breeze-redis-test`. Those containers are RUNNING and belong to ANOTHER worktree's stack (verified at plan time: `breeze-postgres-test`, `breeze-redis-test`, `breeze-wt-fix-s0-pam-actuation-lifecycle-api-1`); colliding with them corrupts another track's evidence. `pnpm test-stack up` writes a worktree-local `.env.test` that `vitest.integration.config.ts` reads.
- Dependencies: the merge changes `pnpm-lock.yaml` by ~2.5k lines (`git diff --stat ece39ca5c..origin/main -- pnpm-lock.yaml` → 1454+/1082−). This worktree's `node_modules` (root and `apps/api`) are real directories from Aug 24, not symlinks, so `pnpm install --frozen-lockfile` from the worktree root is safe for other worktrees and is REQUIRED immediately after the merge commit (Task 1 Step 11) before any test runs on the merged tree.
- Compose validation: `docker compose -f docker-compose.yml config --quiet`, `docker compose -f docker-compose.yml -f docker-compose.override.yml.dev config --quiet`, `docker compose -f deploy/docker-compose.prod.yml config --quiet`, `docker compose -f docker-compose.yml --profile worker-split config --quiet`.
- Evidence discipline: every RED step records the failing test names and the load-bearing failure line (not just the exit code) in the task report; count expectations in tests are computed from the rules and the registry, never carried as bare literals; the resolved numbers (117 declared, 113 required on a default `all` box) are recorded in commit messages, not asserted as literals.

## File map

| File | Role in this port |
| --- | --- |
| `apps/api/src/index.ts` | Task 1 hand-merge (spec §3, incl. the loop in both out-of-registry blocks); Task 3 adds role + flags |
| `apps/api/src/jobs/{changeLogRetention,ipHistoryRetention,reliabilityRetention,staleCommandReaper,tenantErasure,ticketNotifyWorker}.ts` | Task 1 import unions |
| `apps/api/src/services/exchangeRateBoundary.test.ts` | Task 1 allowlist hand-merge |
| `apps/api/src/workers/webhookDelivery.ts` | Task 1 outer-catch union + attach relocation + constructor error listener (spec §2 C2); Task 6 tests it |
| `docker-compose.yml` | Task 1 anchor re-insert; Task 5 `OFFLINE_DETECTOR_WORKER_CONCURRENCY` |
| `apps/api/src/jobs/workerReadinessManifest.ts` + `.test.ts` | Task 2 rekey + 15 names, delete `initializeDeclaredWorkerGroup`; Task 3 role, flag rules, optional marker |
| `apps/api/src/jobs/{authBrowserTransitionCleanup,orgMerge,pamActuationWorker,metricAnomalyIncidentPublisher,ticketAttachmentReaper,ticketOutboxPublisher}.ts` | Task 2 two-line hooks |
| `apps/api/src/config/productionReadinessWiring.test.ts` | Task 2 `consumersForInitializer` pin; Task 5 worker-service rule |
| `apps/api/src/worker.ts` + `worker.boot.test.ts` | Task 4 evaluator port, redaction, fail-closed tests |
| `apps/api/src/services/readiness.ts` + `.test.ts` | Task 4 delete `computeWorkersHealthy`, `WorkersHealthyInput`, and the test block |
| `deploy/docker-compose.prod.yml`, `deploy/.env.example`, `.env.example` | Task 5 env parity |
| `docs/operations/health-probes.md`, `docs/deploy/worker-split.md`, `apps/docs/src/content/docs/monitoring/health.mdx` | Task 5 docs |
| `apps/api/src/workers/webhookDelivery.lifecycle.test.ts` (new) | Task 6 |
| NOT modified by this port | `services/workerReadinessRegistry.ts` (+ its test: the "fails closed for required disabled consumers" invariant stays), `jobs/eventDispatchWorker.ts`, `services/workerRegistry.ts`, any migration, `scripts/prod/deploy.sh`, `docker-compose.override.yml.dev` |

---

### Task 1: The merge commit

**Files:**
- Modify (conflict resolutions, all hand-edited in place): `apps/api/src/index.ts`, `apps/api/src/jobs/changeLogRetention.ts`, `apps/api/src/jobs/ipHistoryRetention.ts`, `apps/api/src/jobs/reliabilityRetention.ts`, `apps/api/src/jobs/staleCommandReaper.ts`, `apps/api/src/jobs/tenantErasure.ts`, `apps/api/src/jobs/ticketNotifyWorker.ts`, `apps/api/src/services/exchangeRateBoundary.test.ts`, `apps/api/src/workers/webhookDelivery.ts`, `docker-compose.yml`.
- No new files. No `git checkout --ours/--theirs` on ANY file: every one of the 10 has auto-merged regions from the other side that a whole-file checkout would destroy (e.g. `docker-compose.yml` carries C's auto-merged LIVENESS comment above the api healthcheck; the six jobs files carry C's auto-merged `attachWorkerObservability(...)` call inside main's rewritten initializers).

**Interfaces:**
- Consumes: `origin/main` pinned at execution time (analysis at `6f496f4d0`); `startRegisteredWorkers(role, { onResult(name, ok, err) })` and `breezeRole()` from main; `consumersForInitializer(name): readonly string[]`, `declareExpectedConsumers({ redisAvailable, abuseSignalsEnabled, registry })`, `workerReadinessRegistry.attach(name, worker)` / `.recordInitializationFailure(name, error)` from Track C.
- Produces: a merged tree whose deliberate REDs (typecheck on `worker.ts`; `workerReadinessManifest.test.ts`; `workerReadinessCoverage.test.ts`; `worker.boot.test.ts`) are the checkpoints Tasks 2–4 discharge; `webhookDelivery.ts` with the attach inside `initializeWebhookDelivery()` and a constructor-installed `error` listener (Task 6 pins both). Every later task references the merge commit SHA.

- [x] **Step 1: Preconditions**

```bash
cd /Users/toddhebebrand/breeze/.worktrees/s0-track-c-readiness
git status --porcelain                 # expect EMPTY (the spec and this plan must already be committed — Open items #1)
git rev-parse --abbrev-ref HEAD        # fix/s0-readiness-offline-scaling
git log --oneline -2                   # HEAD = design commit; HEAD~1 = ece39ca5c "docs: track Track C implementation status"
git rev-parse HEAD                     # RECORD as <design-sha>
git fetch origin main
git rev-parse origin/main              # RECORD; compare with 6f496f4d095e9686f4696d45a1341d38ffdd0de9
git config --get rerere.enabled; ls /Users/toddhebebrand/breeze/.git/rr-cache | wc -l   # informational: the cache is populated
```

If `origin/main` != `6f496f4d0`, run the overlap check and STOP AND REPORT on any non-empty output (do not improvise a resolution the spec did not analyze):

```bash
git diff --stat 6f496f4d0..origin/main -- \
  apps/api/src/index.ts apps/api/src/jobs/changeLogRetention.ts apps/api/src/jobs/ipHistoryRetention.ts \
  apps/api/src/jobs/reliabilityRetention.ts apps/api/src/jobs/staleCommandReaper.ts apps/api/src/jobs/tenantErasure.ts \
  apps/api/src/jobs/ticketNotifyWorker.ts apps/api/src/services/exchangeRateBoundary.test.ts \
  apps/api/src/workers/webhookDelivery.ts docker-compose.yml docker-compose.override.yml.dev deploy/docker-compose.prod.yml \
  apps/api/src/worker.ts apps/api/src/services/workerRegistry.ts apps/api/src/jobs/workerObservability.ts scripts/prod/deploy.sh \
  apps/api/src/jobs/aiAgentRunner.ts apps/api/src/jobs/eventDispatchWorker.ts apps/api/src/config/env.ts
git diff 6f496f4d0..origin/main -- apps/api/src/jobs apps/api/src/services apps/api/src/workers | grep -n '^+.*new Worker'
```

- [x] **Step 2: Start the merge with rerere DISABLED**

```bash
git -c rerere.enabled=false merge --no-ff --no-commit origin/main 2>&1 | tee /private/tmp/claude-501/-Users-toddhebebrand-breeze-rmm-qa/096c7d0d-b990-4dcd-8885-640bde845261/scratchpad/trackc-merge.log
git diff --name-only --diff-filter=U | sort
```

Expected: exactly these 10 paths, sorted:

```
apps/api/src/index.ts
apps/api/src/jobs/changeLogRetention.ts
apps/api/src/jobs/ipHistoryRetention.ts
apps/api/src/jobs/reliabilityRetention.ts
apps/api/src/jobs/staleCommandReaper.ts
apps/api/src/jobs/tenantErasure.ts
apps/api/src/jobs/ticketNotifyWorker.ts
apps/api/src/services/exchangeRateBoundary.test.ts
apps/api/src/workers/webhookDelivery.ts
docker-compose.yml
```

CRITICAL: `grep -c "using previous resolution" …/trackc-merge.log` must be 0, and `grep -c '^<<<<<<<' apps/api/src/index.ts` must be 1 (`changeLogRetention.ts` → 2, every other file → 1). If any of these is off, `git merge --abort` and retry with the `-c rerere.enabled=false` flag actually applied. A different conflict list means `origin/main` moved (Step 1) — abort and report.

- [x] **Step 3: The six jobs files — import unions (keep BOTH sides of the import hunk, delete the markers)**

In each file the single import hunk has C's `import { attachWorkerObservability } from './workerObservability';` on the HEAD side and main's new imports on the other side. Keep both, in this order (C's line first, then main's block), and delete the three marker lines:

1. `apps/api/src/jobs/changeLogRetention.ts` — hunk 1: C's line + main's `import { parsePositiveIntEnv, pruneInCtidBatches, resolveRetentionDays, warnOnRetentionBacklog } from './retentionBatch';`. **Hunk 2 (end of file): take MAIN** — keep `export const __testOnly = { QUEUE_NAME, DEFAULT_RETENTION_DAYS, BATCH_SIZE, MAX_BATCHES };` (C's side is only a deleted trailing blank line). Make sure the file still ends with a single newline.
2. `apps/api/src/jobs/ipHistoryRetention.ts` — C's line + main's four-symbol `./retentionBatch` import.
3. `apps/api/src/jobs/reliabilityRetention.ts` — C's line + main's `import { warnOnRetentionBacklog } from './retentionBatch';`.
4. `apps/api/src/jobs/staleCommandReaper.ts` — C's line + main's `import { applyAutomationActionTerminal } from '../services/automationActionResults';`. This file has no blank line between the imports and `const QUEUE_NAME` — keep both imports above it.
5. `apps/api/src/jobs/tenantErasure.ts` — C's line + main's four imports (`enqueueOrReplaceStale` from `../services/bullmqUtils`; `db, runOutsideDbContext, withSystemDbAccessContext` from `../db`; `organizations, users` from `../db/schema`; `eq` from `drizzle-orm`).
6. `apps/api/src/jobs/ticketNotifyWorker.ts` — C's line + main's `createNotification` (`../services/userNotifications`), `buildTicketPush, dispatchPushToTokens` (`../services/expoPush`), and the multi-symbol `../services/ticketPush` import.

Then verify C's auto-merged call survived in each (one import + one call per file):

```bash
for f in changeLogRetention ipHistoryRetention reliabilityRetention staleCommandReaper tenantErasure ticketNotifyWorker; do
  printf '%s import=%s call=%s\n' "$f" \
    "$(grep -c "from './workerObservability'" apps/api/src/jobs/$f.ts)" \
    "$(grep -c 'attachWorkerObservability(' apps/api/src/jobs/$f.ts)"
done
```

Expected: `import=1 call=2` for every file (`grep -c` counts lines: the import line plus the one call). Trap: "take MAIN" compiles the import block but leaves the call referencing an undeclared identifier; "take C" drops main's used imports. Only the union compiles.

- [x] **Step 4: `apps/api/src/services/exchangeRateBoundary.test.ts` — allowlist hand-merge (NOT union-all-three)**

In `FX_IMPORT_ALLOWLIST`, resolve the hunk to exactly two entries — main's `'apps/api/src/services/workerRegistry.ts'` (reason text verbatim from main's side of the hunk) and C's `'apps/api/src/jobs/workerReadinessManifest.ts'` (reason text verbatim from C's side) — and DROP C's stale `'apps/api/src/index.ts'` entry (main's `index.ts` no longer contains any FX token). Verify:

```bash
grep -n "workerRegistry.ts'\|workerReadinessManifest.ts'\|src/index.ts'" apps/api/src/services/exchangeRateBoundary.test.ts
```

Expected: one hit each for the two surviving entries, zero for `src/index.ts'`.

- [x] **Step 5: `apps/api/src/workers/webhookDelivery.ts` — outer-catch union, attach relocation, constructor error listener (spec §2, C2)**

5a. The single conflict hunk is inside `processNextJob()`'s outer `catch (err)`. Resolve it to exactly this order (C's lifecycle mapping first, then main's comment + Sentry capture; the `console.error` + 1 s backoff are the shared tail git already placed after the hunk — do not duplicate them):

```ts
    } catch (err) {
      if (this.blockingRedis?.status === 'ready') {
        // Delivery/callback failures are job-level failures; the loop remains
        // runnable and will take the next item.
        this.emit('failed', undefined, err);
      } else {
        this.emit('error', err);
      }
      // <main's comment lines, verbatim from the other side of the hunk>
      captureException(err instanceof Error ? err : new Error(String(err)));
      console.error('[WebhookWorker] Error processing job:', err);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
```

5b. Relocate the attach (this is NOT in a conflict hunk — it is an amendment the merge commit carries). In `getWebhookWorker()` (auto-merged from C) delete the `workerReadinessRegistry.attach('webhookDeliveryWorker', workerInstance as unknown as Worker);` call so the getter is again only:

```ts
export function getWebhookWorker(): WebhookDeliveryWorker {
  if (!workerInstance) {
    workerInstance = new WebhookDeliveryWorker();
  }
  return workerInstance;
}
```

and in `initializeWebhookDelivery()` (main's parameterless version, auto-merged) insert the attach between `const worker = getWebhookWorker();` and `void worker.start()…`:

```ts
export async function initializeWebhookDelivery(): Promise<void> {
  const worker = getWebhookWorker();

  // Readiness attach lives HERE, not in getWebhookWorker(): the getter is
  // reached in every role (the durable fan-out subscriber, routes/webhooks.ts,
  // services/aiToolsIntegrations.ts, index.ts's shutdown preamble), but only
  // the `webhookDelivery` registry entry — placement `global`, never started
  // under BREEZE_ROLE=api — reaches this start path. Attaching at construction
  // would auto-expect a REQUIRED consumer an api-role process never runs and
  // pin it not-ready from the first webhook event (spec section 2, C2).
  workerReadinessRegistry.attach('webhookDeliveryWorker', worker as unknown as Worker);

  void worker.start().catch((err) => {
    console.error('[WebhookDelivery] Worker failed:', err);
  });

  console.log('[WebhookDelivery] Initialized webhook delivery worker');
}
```

5c. Give the class its own no-op error listener so `emit('error')` can never throw regardless of attach state. `class WebhookDeliveryWorker extends EventEmitter` has no explicit constructor on C; add one directly after the field declarations (`private blockingRedis: Redis | null = null;`):

```ts
  constructor() {
    super();
    // An EventEmitter with no `error` listener THROWS on emit('error'). The
    // readiness registry installs its own listener only once this worker is
    // started through initializeWebhookDelivery(); every other role reaches
    // this instance via getWebhookWorker() without ever attaching, so the
    // instance must be safe to emit on regardless of attach state.
    this.on('error', () => {});
  }
```

5d. Verify the merged shape:

```bash
grep -n "class WebhookDeliveryWorker extends EventEmitter\|constructor()\|this.on('error', () => {})\|private running = false\|get client(): Promise<Redis>\|isRunning(): boolean\|this.emit('ready')\|this.emit('closing')\|this.emit('closed')\|this.emit('failed', undefined, err)\|this.emit('error', err)\|workerReadinessRegistry.attach(\|export function getWebhookWorker\|export async function initializeWebhookDelivery" apps/api/src/workers/webhookDelivery.ts
```

Expected: every pattern present; `this.emit('ready')` twice (in `start()` and after the successful `brpop`); `workerReadinessRegistry.attach(` exactly once, and its line number is greater than `export async function initializeWebhookDelivery`'s and NOT between `export function getWebhookWorker`'s line and the next `}`; `new WebhookDeliveryWorker()` exactly once (in the getter) so the coverage test's per-file constructor/attach count still balances at 1/1.

- [x] **Step 6: `docker-compose.yml` — take MAIN's hunk, then re-insert C's six lines inside the `x-api-env` anchor**

The hunk's HEAD side is the entire old inline `api.environment` block (≈367 lines) with C's two `READINESS_*` keys; main's side is the 6-line `<<: *api-env` + `BREEZE_ROLE: ${BREEZE_API_ROLE:-all}` indirection. In the hunk, delete the whole HEAD side and keep main's lines. Then locate the anchor line `  FRANKFURTER_BASE_URL: ${FRANKFURTER_BASE_URL:-}` (top-level `x-api-env: &api-env` block, ~line 387, two-space indent) and insert immediately after it, BEFORE the `  # Startup + agent-fleet behaviour` comment that precedes `  AUTO_MIGRATE:`, with the anchor's two-space indent:

```yaml
  # Readiness cache + dependency-probe bounds. Empty === unset, so the
  # `${VAR:-}` form keeps the clamped code defaults (5000 / 3000 ms). Both
  # MUST be listed here: compose only interpolates vars named in this block,
  # so a value set in .env alone is a silent no-op.
  READINESS_CACHE_TTL_MS: ${READINESS_CACHE_TTL_MS:-}
  READINESS_PROBE_TIMEOUT_MS: ${READINESS_PROBE_TIMEOUT_MS:-}
```

Placing them in the anchor (not in the `api:` service block) is load-bearing: the `worker` service inherits the anchor and `worker.ts` reads the same names. Verify:

```bash
grep -n "READINESS_CACHE_TTL_MS\|READINESS_PROBE_TIMEOUT_MS\|^x-api-env\|^services:\|# Startup + agent-fleet behaviour\|AUTO_MIGRATE:" docker-compose.yml
grep -n "LIVENESS, deliberately not /ready" docker-compose.yml     # C's auto-merged comment above the api healthcheck: 1 hit
grep -n "^  worker:\|dist/worker.cjs\|/health/ready" docker-compose.yml   # main's worker service intact
docker compose -f docker-compose.yml config --quiet
```

Expected: both `READINESS_*` line numbers fall between `x-api-env` and `services:`, and before the `# Startup + agent-fleet behaviour` line; compose config succeeds.

- [x] **Step 7: `apps/api/src/index.ts` — the hand-merge (neither side compiles alone)**

Resolve the single hunk inside `initializeWorkers()` and the imports outside it to exactly this shape. The auto-merged parts above the hunk (C's `declareExpectedConsumers` call, the `if (!redisAvailable)` guard) stay as git placed them.

7a. Imports. Replace the auto-merged manifest import with

```ts
import {
  consumersForInitializer,
  declareExpectedConsumers,
} from './jobs/workerReadinessManifest';
```

(`initializeDeclaredWorkerGroup` must not remain imported — it loses its only caller here and is deleted in Task 2.) Merge C's separate `import { abuseSignalsEnabled } from './config/env';` (auto-merged near line ~195) into main's existing line (~226) so there is ONE line: `import { abuseSignalsEnabled, breezeRole } from './config/env';` — delete C's separate line.

7b. Restore the declaration C deleted, immediately above `let server: ReturnType<typeof serve> | null = null;` (main had it at ~line 1126; keep `getWorkerStatus` DELETED — zero callers on main):

```ts
// Initialize background workers (only if Redis is available)
const workerStatus: Record<string, boolean> = {};
```

7c. The hunk body: drop C's `const workers: Array<[string, () => Promise<void>]> = [ … ]` array and its `Promise.allSettled(... initializeDeclaredWorkerGroup ...)` block entirely; take main's `startRegisteredWorkers` call and add the per-consumer failure loop AFTER `captureException` (the loop throws on an undeclared name, and an exception inside `onResult` is swallowed by `Promise.allSettled` in `runEntries`, so loop-first could lose the Sentry capture):

```ts
  // wave 3.5d-b (#4086): the 104-entry static array used to live here. It is
  // now the declarative, lazily-loaded `WORKER_REGISTRY` (services/workerRegistry.ts),
  // filtered by role. `startRegisteredWorkers` preserves today's
  // `Promise.allSettled` semantics — one entry's failure never blocks
  // another's, and every outcome (success or failure) is reported here via
  // `onResult`, exactly like the old inline try/catch per entry.
  await startRegisteredWorkers(breezeRole(), {
    onResult: (name, ok, error) => {
      workerStatus[name] = ok;
      if (!ok) {
        console.error(`[CRITICAL] Failed to initialize ${name}:`, error);
        // A failed worker now pins /ready to not-ready for the process
        // lifetime (previously the boot race often hid it), so the reason has
        // to reach Sentry — a stdout line can't explain a permanent 503.
        captureException(
          error instanceof Error ? error : new Error(String(error))
        );
        // Track C: every queue consumer this entry owns is now permanently
        // failed for readiness (what initializeDeclaredWorkerGroup did before
        // the registry became the initializer seam). AFTER captureException:
        // this loop throws on an undeclared name and allSettled would swallow it.
        for (const consumer of consumersForInitializer(name)) {
          workerReadinessRegistry.recordInitializationFailure(consumer, error);
        }
      }
    },
  });

  const failed = Object.entries(workerStatus).filter(([, ok]) => !ok).map(([n]) => n);
  workerInitPhase = 'started';
  // Drop any snapshot taken during the boot race so the next probe sees the
  // real outcome immediately instead of waiting out the TTL.
  readiness.invalidate();
```

Trap: git absorbed the shared trailing `} }, });` + `workerInitPhase = 'started'` lines into the common tail — count braces so `onResult` and the `startRegisteredWorkers({ … })` call close exactly once.

7d. The two post-hunk role-gated blocks are main's and stay, EXCEPT that each `catch` gains the same loop after its `captureException` (spec §3.4 — otherwise a throwing out-of-registry initializer leaves its consumers `expected` instead of `failed`):

```ts
  if (breezeRole() !== 'api') {
    try {
      await initializeEventDispatchWorker();
      workerStatus['eventDispatch'] = true;
    } catch (error) {
      workerStatus['eventDispatch'] = false;
      console.error('[CRITICAL] Failed to initialize eventDispatch:', error);
      captureException(error instanceof Error ? error : new Error(String(error)));
      for (const consumer of consumersForInitializer('eventDispatch')) {
        workerReadinessRegistry.recordInitializationFailure(consumer, error);
      }
    }
  }
  // (main's comment block, verbatim)
  if (breezeRole() !== 'worker') {
    try {
      await initializeAgentCommandRelayWorker();
      workerStatus['agentCommandRelay'] = true;
    } catch (error) {
      workerStatus['agentCommandRelay'] = false;
      console.error('[CRITICAL] Failed to initialize agentCommandRelay:', error);
      captureException(error instanceof Error ? error : new Error(String(error)));
      for (const consumer of consumersForInitializer('agentCommandRelay')) {
        workerReadinessRegistry.recordInitializationFailure(consumer, error);
      }
    }
  }
  readiness.invalidate();
```

(At the merge commit the manifest has no `eventDispatch`/`agentCommandRelay` rows, so `consumersForInitializer` returns `[]` for both and the loops are inert until Task 2 — that is fine; the code shape is what this commit fixes.) The final `readiness.invalidate()` and `failed.length` log are main's and stay.

7e. Verify C's auto-merged readiness wiring and main's shutdown list both survived:

```bash
grep -n "from './services/workerReadinessRegistry'\|resolveReadinessTiming(\|workerRegistry: workerReadinessRegistry\|workersInitialized:\|setWorkerReadinessTransitionHandler(() => readiness.invalidate())\|const readinessHandler = createReadinessHandler\|app.get('/ready', readinessHandler)\|app.get('/health/ready', readinessHandler)\|declareExpectedConsumers({" apps/api/src/index.ts
grep -n "from './config/env'\|const workerStatus\|getWorkerStatus\|initializeDeclaredWorkerGroup\|consumersForInitializer\|computeWorkersHealthy\|const allOk\|READINESS_CACHE_TTL_MAX_MS" apps/api/src/index.ts
grep -n "getWebhookWorker().stop()\|{ name: 'workers', tasks: workerShutdownTasks }\|{ name: 'redis', tasks: \[closeRedis\] }" apps/api/src/index.ts
```

Expected, first grep: every pattern present exactly once (`declareExpectedConsumers({` once, at the top of `initializeWorkers`). Second grep: `from './config/env'` exactly once; `const workerStatus` once; `consumersForInitializer` four times (import + three loops); `getWorkerStatus`, `initializeDeclaredWorkerGroup`, `computeWorkersHealthy`, `const allOk`, `READINESS_CACHE_TTL_MAX_MS` → zero hits (if `computeWorkersHealthy` is still imported, the auto-merge kept main's import line inside C's readiness-wiring region — remove it; it is unused and Task 4 deletes the function). Third grep: all three present; `workers` phase line number < `redis` phase line number (`index.pam-actuation-worker.test.ts` pins that order).

- [x] **Step 8: No markers anywhere; whitespace clean**

```bash
for f in $(git diff --name-only --diff-filter=U); do printf '%s %s\n' "$f" "$(grep -c '^<<<<<<<\|^=======$\|^>>>>>>>' "$f")"; done   # all 0
git add -A
git diff --cached --check
```

- [x] **Step 9: Tripwire greps on the staged tree (spec §10.1 subset; cheap, before any test)**

```bash
grep -n "workersHealthy:" apps/api/src/worker.ts                                     # EXPECTED 1 hit — the deliberate typecheck RED Task 4 fixes
grep -c "^    name: '" apps/api/src/services/workerRegistry.ts                        # 115
grep -n "READINESS_CACHE_TTL_MS=\|READINESS_PROBE_TIMEOUT_MS=" .env.example           # 2 hits (C's, auto-merged)
grep -rn "checks.database\|status: 'not_ready'\|'not_ready'" apps/api/src --include='*.ts' | grep -v '\.test\.ts'   # expect EMPTY (spec §7 response-shape re-run); non-empty → STOP and report
```

- [x] **Step 10: Commit the merge (the only --no-verify commit)**

```bash
git commit --no-verify -m "merge: port Track C onto current main

Deliberate per-file resolutions per
docs/superpowers/specs/2026-09-01-s0-track-c-current-main-port-design.md
(spec sections 2-3). rerere disabled; no recorded resolution replayed.
index.ts: main's startRegisteredWorkers seam + Track C's per-consumer
recordInitializationFailure loop via consumersForInitializer after
captureException (also in the eventDispatch/agentCommandRelay blocks);
workerStatus restored; getWorkerStatus stays deleted.
webhookDelivery.ts: outer-catch union; the webhookDeliveryWorker attach
moved from getWebhookWorker() into initializeWebhookDelivery() (the getter
runs in every role, the registry entry is global) and the class installs
its own no-op error listener (C2). docker-compose.yml: READINESS_*
re-inserted inside the x-api-env anchor (worker service inherits them).
Known deliberate REDs at this commit: API typecheck (worker.ts evaluator
options, section 6), workerReadinessManifest.test.ts and
workerReadinessCoverage.test.ts (manifest vs registry, section 4),
worker.boot.test.ts (section 6). Closed by the follow-up commits."
git rev-parse HEAD   # RECORD as <merge-sha>
```

- [x] **Step 11: Install the merged dependency set (REQUIRED before any test on the merged tree)**

```bash
cd /Users/toddhebebrand/breeze/.worktrees/s0-track-c-readiness
git diff --stat ece39ca5c..HEAD -- pnpm-lock.yaml      # non-empty: the lockfile moved with main
ls -la node_modules | head -2; ls -la apps/api/node_modules | head -2   # real directories, not symlinks (verified at plan time)
pnpm install --frozen-lockfile
git status --porcelain                                  # expect EMPTY (frozen lockfile; the `prepare` hook only sets core.hooksPath)
```

If `pnpm install --frozen-lockfile` fails, STOP and report — do not run a non-frozen install.

- [x] **Step 12: Typecheck — expected RED confined to `worker.ts`**

```bash
NODE_OPTIONS=--max-old-space-size=8192 pnpm --filter @breeze/api exec tsc --noEmit 2>&1 | tee /private/tmp/claude-501/-Users-toddhebebrand-breeze-rmm-qa/096c7d0d-b990-4dcd-8885-640bde845261/scratchpad/trackc-tsc-merge.log | grep -E "error TS" | sed 's/(.*//' | sort | uniq -c
```

Expected: errors ONLY in `src/worker.ts` (the `workersHealthy` option is not in `ReadinessEvaluatorOptions`, and `workerRegistry`/`workersInitialized` are missing — TS2353/TS2345-class). Record the exact lines. Any error in another file is a resolution mistake: fix it and `git commit --amend --no-verify` (amending keeps both merge parents).

- [x] **Step 13: Focused suites — GREEN set, then the recorded REDs**

```bash
pnpm --filter @breeze/api exec vitest run \
  src/jobs/changeLogRetention.test.ts src/jobs/ipHistoryRetention.test.ts src/jobs/reliabilityRetention.test.ts src/db/rowCount.test.ts \
  src/jobs/staleCommandReaper.test.ts src/jobs/tenantErasure.test.ts \
  src/jobs/ticketNotifyWorker.test.ts src/jobs/ticketNotifyWorker.leak.test.ts src/jobs/ticketNotifyWorker.graphFork.test.ts src/services/ticketPush.test.ts \
  src/services/exchangeRateBoundary.test.ts \
  src/workers/webhookDelivery.test.ts src/workers/webhookDelivery.claim.test.ts src/workers/webhookDelivery.dedupe.test.ts src/services/webhookDeliveryInit.test.ts \
  src/config/productionReadinessWiring.test.ts src/config/envComposeParity.test.ts \
  src/db/dbPoolHealthWiring.test.ts src/services/eventLoopMonitorWiring.test.ts src/index.pam-actuation-worker.test.ts \
  src/services/workerRegistry.test.ts src/services/workerEntrypointClosure.contract.test.ts \
  src/services/workerReadinessRegistry.test.ts src/jobs/workerObservability.test.ts src/config/readinessConfig.test.ts \
  src/services/readiness.test.ts src/routes/readiness.test.ts \
  src/jobs/scheduleRegistry.contract.test.ts src/middleware/security.test.ts src/jobs/eventDispatchWorker.test.ts
pnpm --filter @breeze/api exec vitest run src/jobs/offlineDetector
```

Expected: ALL PASS. If `envComposeParity` fails on `READINESS_*` the anchor re-insert (Step 6) is wrong; if `productionReadinessWiring`/`dbPoolHealthWiring`/`eventLoopMonitorWiring` fail, the `index.ts` readiness aliasing (Step 7e) is wrong; if a `webhookDelivery*` suite fails, Step 5 is wrong — fix and amend.

Then record the deliberate REDs verbatim (they are Tasks 2 and 4's checkpoints):

```bash
pnpm --filter @breeze/api exec vitest run src/jobs/workerReadinessManifest.test.ts src/jobs/workerReadinessCoverage.test.ts 2>&1 | tail -60
pnpm --filter @breeze/api exec vitest run src/worker.boot.test.ts 2>&1 | tail -40
```

Expected: manifest — `classifies every initializeWorkers group exactly once` FAILS (declared 105 initializers vs `[]` parsed from `index.ts`); every other manifest test PASSES. Coverage — `attaches observability exactly once for every Worker construction site` FAILS listing exactly six files (`jobs/authBrowserTransitionCleanup.ts`, `jobs/metricAnomalyIncidentPublisher.ts`, `jobs/orgMerge.ts`, `jobs/pamActuationWorker.ts`, `jobs/ticketAttachmentReaper.ts`, `jobs/ticketOutboxPublisher.ts`, each `constructors: 1, attachments: 0`; `workers/webhookDelivery.ts` must NOT be listed — its 1/1 balance is what Step 5d checked); `matches every attached stable name to the manifest exactly once` FAILS with nine attached-but-undeclared names (`agentCommandRelay`, `agentNotifyRetry`, `aiAgentSweepScheduler`, `aiUnattendedExposureRetention`, `alertVerdictScheduler`, `eventDispatch`, `eventDispatchMaintenance`, `fixWatchWorker`, `webhookDeliveryRecovery`). `worker.boot.test.ts` — FAILS (the evaluator is built with an option shape Track C's `createReadinessEvaluator` no longer understands; at minimum `readiness flips to ready only after every worker init result is recorded` fails). A DIFFERENT failure set means the resolution is wrong — fix and amend before moving on. Save both outputs to the scratchpad; Task 2/4 reports cite them.

---

### Task 2: Manifest rekeyed to the registry; hooks for main's six unhooked workers; delete `initializeDeclaredWorkerGroup`

**Files:**
- Modify: `apps/api/src/jobs/workerReadinessManifest.ts` (type union, rows, delete `initializeDeclaredWorkerGroup`)
- Modify: `apps/api/src/jobs/workerReadinessManifest.test.ts` (re-point `initializerKeys()`, `NON_CONSUMERS`, computed counts, drop the two `initializeDeclaredWorkerGroup` tests)
- Modify: `apps/api/src/jobs/authBrowserTransitionCleanup.ts`, `apps/api/src/jobs/orgMerge.ts`, `apps/api/src/jobs/pamActuationWorker.ts`, `apps/api/src/jobs/metricAnomalyIncidentPublisher.ts`, `apps/api/src/jobs/ticketAttachmentReaper.ts`, `apps/api/src/jobs/ticketOutboxPublisher.ts` (2-line hook each)
- Modify: `apps/api/src/config/productionReadinessWiring.test.ts` (pin the `consumersForInitializer` loops in `index.ts`, spec §9)
- Test (unchanged, is the gate): `apps/api/src/jobs/workerReadinessCoverage.test.ts` — never loosen its AST scan.

**Interfaces:**
- Consumes: `WORKER_REGISTRY: readonly WorkerRegistration[]` (`name`, `placement: 'global' | 'socket-owner'`, `load`) from `services/workerRegistry`; `attachWorkerObservability(worker: Worker, name: string): void` from `jobs/workerObservability` (Track C made it also call `workerReadinessRegistry.attach(name, worker)`).
- Produces: `WORKER_READINESS_MANIFEST` keyed by the 115 registry names ∪ `{ eventDispatch, agentCommandRelay }` (117 initializers, 117 consumer names — computed, see Step 5); `consumersForInitializer(name)` unchanged in signature; `initializeDeclaredWorkerGroup` GONE; `aiAgentRunner` still a plain `redis` row here (Task 3 flips it — D3a). Task 3 extends the same `declareExpectedConsumers` with `role` and the flag inputs.

- [x] **Step 1: RED — re-point `initializerKeys()` at the registry and drop the two subscriber non-consumers**

In `apps/api/src/jobs/workerReadinessManifest.test.ts`:

1. Replace the `ts`/`readFileSync`/`path` based `initializerKeys()` with:

```ts
import { WORKER_REGISTRY } from '../services/workerRegistry';

// The two consumers main starts OUTSIDE the registry, role-gated in
// index.ts (eventDispatch when role !== 'api'; agentCommandRelay when
// role !== 'worker') and worker.ts (eventDispatch only).
const OUT_OF_REGISTRY_INITIALIZERS = ['eventDispatch', 'agentCommandRelay'] as const;

function initializerKeys(): string[] {
  return [...WORKER_REGISTRY.map((entry) => entry.name), ...OUT_OF_REGISTRY_INITIALIZERS];
}
```

Remove the now-unused `readFileSync`, `path`, and `ts` imports.

2. `NON_CONSUMERS` becomes exactly `['desktopSessionOrphanRecovery', 'oauthRevocationRetryWorker', 'incidentCorrelationWorker', 'incidentTimelineEnricher', 'incidentSlaMonitor']` (drop `policyAlertBridge` and `dnsThreatAlertSubscriber`: on main they are durable event subscribers in `services/eventSubscribers.ts`, not registry entries).

3. Delete the two `initializeDeclaredWorkerGroup` tests (`records initialization failure for every consumer in a multi-consumer group`, `does not manufacture failures when an initializer succeeds`) and its import. Their behavior is pinned in Step 6 (index.ts source pin) and Task 4 (worker.ts failure-path test).

4. Replace the three bare count literals with computed expectations (spec §4: "computed from the rules and the registry, never a bare literal"):

```ts
/** Consumer names the manifest declares, in manifest order. */
function declaredConsumerNames(): string[] {
  return WORKER_READINESS_MANIFEST.flatMap((e) => (e.kind === 'consumers' ? [...e.consumers] : []));
}

/**
 * Cross-check against the REGISTRY, not the manifest: every initializer is a
 * registry entry or one of the two out-of-registry starters; non-consumers
 * declare nothing; multi-Worker initializers add (consumers.length - 1) extras.
 */
function expectedDeclaredCount(): number {
  const extras = WORKER_READINESS_MANIFEST.reduce(
    (sum, e) => sum + (e.kind === 'consumers' ? e.consumers.length - 1 : 0), 0);
  return WORKER_REGISTRY.length + OUT_OF_REGISTRY_INITIALIZERS.length - NON_CONSUMERS.length + extras;
}

/**
 * Mirror of the declare-time rules. Task 3 extends this with the role and the
 * event-dispatch / ai-agents flags; keep it the single place the rules live in
 * this file so the count tests cannot drift from the semantics tests.
 */
function expectedRequiredNames(flags: { abuseSignalsEnabled: boolean }): string[] {
  return WORKER_READINESS_MANIFEST.flatMap((e) => {
    if (e.kind !== 'consumers') return [];
    const required = e.requiredWhen === 'redis' || flags.abuseSignalsEnabled;
    return required ? [...e.consumers] : [];
  }).sort();
}
```

and rewrite the three count assertions as:

```ts
  it('declares every stable consumer name exactly once', () => {
    const names = declaredConsumerNames();
    expect(names).toHaveLength(expectedDeclaredCount());
    expect(new Set(names).size).toBe(names.length);
  });

  it('declares Redis consumers required and abuse signals optional-disabled when configured off', () => {
    const registry = fakeRegistry();
    declareExpectedConsumers({ redisAvailable: true, abuseSignalsEnabled: false, registry });
    expect(registry.expect.mock.calls.filter(([name]) => name === 'abuseSignalsWorker')).toEqual([['abuseSignalsWorker', false]]);
    expect(registry.disable).toHaveBeenCalledWith('abuseSignalsWorker', 'feature_disabled');
    const required = registry.expect.mock.calls.filter(([, r]) => r).map(([n]) => n as string).sort();
    expect(required).toEqual(expectedRequiredNames({ abuseSignalsEnabled: false }));
    // Named, not numbered: exactly these consumers are optional on a box with every flag off.
    const optional = declaredConsumerNames().filter((n) => !required.includes(n)).sort();
    expect(optional).toEqual(['abuseSignalsWorker']);
  });

  it('makes abuse signals required when configured on', () => {
    const registry = fakeRegistry();
    declareExpectedConsumers({ redisAvailable: true, abuseSignalsEnabled: true, registry });
    expect(registry.expect).toHaveBeenCalledWith('abuseSignalsWorker', true);
    expect(registry.disable).not.toHaveBeenCalled();
    expect(registry.expect).toHaveBeenCalledTimes(declaredConsumerNames().length);
    expect(registry.expect.mock.calls.filter(([, r]) => r)).toHaveLength(expectedRequiredNames({ abuseSignalsEnabled: true }).length);
  });
```

- [x] **Step 2: Run RED and retain the output**

```bash
pnpm --filter @breeze/api exec vitest run src/jobs/workerReadinessManifest.test.ts src/jobs/workerReadinessCoverage.test.ts 2>&1 | tee /private/tmp/claude-501/-Users-toddhebebrand-breeze-rmm-qa/096c7d0d-b990-4dcd-8885-640bde845261/scratchpad/trackc-task2-red.log | tail -80
```

Expected FAIL set (record each name): manifest `classifies every initializeWorkers group exactly once` (missing the 12 registry names + `eventDispatch` + `agentCommandRelay`; extra `policyAlertBridge`, `dnsThreatAlertSubscriber`); manifest `classifies only verified timer/subscriber initializers as non-consumers` (actual still lists the two); manifest `declares every stable consumer name exactly once` (102 declared vs the registry-derived expectation — its "expected" number is the derived `N`; record it); coverage test 1 (six files) and test 2 (nine names) exactly as recorded in Task 1 Step 13.

- [x] **Step 3: Manifest — rekey, add the 15 names, delete the dead helper**

In `apps/api/src/jobs/workerReadinessManifest.ts`:

1. Narrow the `non_consumer` initializer union to `'desktopSessionOrphanRecovery' | 'oauthRevocationRetryWorker' | 'incidentCorrelationWorker' | 'incidentTimelineEnricher' | 'incidentSlaMonitor'` and delete the two rows `{ kind: 'non_consumer', initializer: 'policyAlertBridge' }` and `{ kind: 'non_consumer', initializer: 'dnsThreatAlertSubscriber' }`.
2. Append these rows before the closing `] as const;` (order is not asserted — the tests sort; keep registry order for readability):

```ts
  // Registry entries main added after Track C's merge base (wave 3.5d-b names).
  // The first six already attach under exactly these names on main; the next
  // six receive their attach in this commit (registry entry name == consumer name).
  consumers('webhookDeliveryRecovery'),
  consumers('agentNotifyRetry'),
  consumers('fixWatchWorker'),
  consumers('authBrowserTransitionCleanup'),
  consumers('orgMerge'),
  consumers('pamActuationWorker'),
  consumers('ticketAttachmentReaper'),
  consumers('ticketOutboxPublisher'),
  consumers('metricAnomalyIncidentPublisher'),
  consumers('aiUnattendedExposureRetention'),
  consumers('alertVerdictScheduler'),
  consumers('aiAgentSweepScheduler'),
  // Started outside WORKER_REGISTRY, role-gated in index.ts / worker.ts.
  consumers('eventDispatch', ['eventDispatch', 'eventDispatchMaintenance']),
  consumers('agentCommandRelay'),
```

The attach names for the six already-attached modules are taken from the coverage test's Task 1 RED output (the authority), not from this document; if any attached name differs from the registry entry name, keep the registry name as the `initializer` and put the attached name in the consumers array.

3. Delete `export async function initializeDeclaredWorkerGroup(…)` entirely. `consumersForInitializer` and `declareExpectedConsumers` stay as they are (Task 3 adds the role and flags).

- [x] **Step 4: The six hooks (import + call, nothing else)**

Add `import { attachWorkerObservability } from './workerObservability';` to each file's import block and the call immediately after the assignment that creates the Worker (before the module's own `.on('error', …)` handlers — the module-local Sentry capture stays; the resulting double report is ratified by spec §4):

| File | Insert after | Call |
| --- | --- | --- |
| `authBrowserTransitionCleanup.ts` (~line 56) | `cleanupWorker = createAuthBrowserTransitionCleanupWorker();` | `attachWorkerObservability(cleanupWorker, 'authBrowserTransitionCleanup');` |
| `orgMerge.ts` (~line 199, inside the `try`) | `mergeWorker = createOrgMergeWorker();` | `attachWorkerObservability(mergeWorker, 'orgMerge');` |
| `pamActuationWorker.ts` (~line 129–133) | the closing `);` of `pamWorker = new Worker<PamActuationJobData>( … );` | `attachWorkerObservability(pamWorker, 'pamActuationWorker');` |
| `metricAnomalyIncidentPublisher.ts` (~line 295) | `reaperWorker = createWorker();` | `attachWorkerObservability(reaperWorker, 'metricAnomalyIncidentPublisher');` |
| `ticketAttachmentReaper.ts` (~line 186) | `reaperWorker = createWorker();` | `attachWorkerObservability(reaperWorker, 'ticketAttachmentReaper');` |
| `ticketOutboxPublisher.ts` (~line 314) | `reaperWorker = createWorker();` | `attachWorkerObservability(reaperWorker, 'ticketOutboxPublisher');` |

Verify one import + one call per file:

```bash
for f in authBrowserTransitionCleanup orgMerge pamActuationWorker metricAnomalyIncidentPublisher ticketAttachmentReaper ticketOutboxPublisher; do
  printf '%s import=%s calls=%s ctors=%s\n' "$f" "$(grep -c "from './workerObservability'" apps/api/src/jobs/$f.ts)" "$(grep -c 'attachWorkerObservability(' apps/api/src/jobs/$f.ts)" "$(grep -c 'new Worker' apps/api/src/jobs/$f.ts)"
done
```

Expected: `import=1 calls=2 ctors=1` for each (`calls` counts the import line plus the one call).

- [x] **Step 5: GREEN and record the resolved numbers**

```bash
pnpm --filter @breeze/api exec vitest run src/jobs/workerReadinessManifest.test.ts src/jobs/workerReadinessCoverage.test.ts 2>&1 | tail -20
```

Expected: ALL PASS. Record `declaredConsumerNames().length` (formula: `115 + 2 − 5 + extras`, where `extras` = 5 multi-consumer rows × 1 = 5 → expected 117; equivalently `102 + 12 + 3`) and the Task-2 required count with abuse off (`117 − 1 = 116`) in the commit message. Take the numbers from the test's own output (temporarily `console.log` them if needed and remove the log before committing), not from this document.

- [x] **Step 6: Pin the `index.ts` failure loops (spec §9) in `productionReadinessWiring.test.ts`**

Append inside the top-level `describe('production readiness wiring', …)`:

```ts
  // Track C's initializeDeclaredWorkerGroup was deleted when index.ts moved
  // onto the worker registry's onResult seam; this is where its behavior
  // lives now (registry entries via onResult, plus the two out-of-registry
  // starters). A source pin, because no test on either side exercises
  // initializeWorkers()' body.
  it('records initialization failure for every consumer of a failed initializer', () => {
    const index = read('apps/api/src/index.ts');
    expect(index).toContain('for (const consumer of consumersForInitializer(name))');
    expect(index).toContain("for (const consumer of consumersForInitializer('eventDispatch'))");
    expect(index).toContain("for (const consumer of consumersForInitializer('agentCommandRelay'))");
    expect(index.match(/workerReadinessRegistry\.recordInitializationFailure\(consumer, error\)/g)).toHaveLength(3);
    expect(index).not.toContain('initializeDeclaredWorkerGroup');
  });
```

This pin is GREEN on first run (Task 1 wrote the loops). Prove it discriminates without mutating production code: `grep -c 'recordInitializationFailure(consumer, error)' apps/api/src/index.ts` → exactly 3, and `grep -rn initializeDeclaredWorkerGroup apps/api/src` → empty.

- [x] **Step 7: GREEN + neighborhood**

```bash
pnpm --filter @breeze/api exec vitest run \
  src/jobs/workerReadinessManifest.test.ts src/jobs/workerReadinessCoverage.test.ts src/jobs/workerObservability.test.ts \
  src/config/productionReadinessWiring.test.ts src/services/workerRegistry.test.ts src/services/workerEntrypointClosure.contract.test.ts
pnpm --filter @breeze/api exec vitest run \
  src/jobs/authBrowserTransitionCleanup src/jobs/orgMerge src/jobs/pamActuationWorker \
  src/jobs/metricAnomalyIncidentPublisher src/jobs/ticketAttachmentReaper src/jobs/ticketOutboxPublisher \
  src/index.pam-actuation-worker.test.ts
pnpm --filter @breeze/api exec eslint \
  src/jobs/workerReadinessManifest.ts src/jobs/workerReadinessManifest.test.ts \
  src/jobs/authBrowserTransitionCleanup.ts src/jobs/orgMerge.ts src/jobs/pamActuationWorker.ts \
  src/jobs/metricAnomalyIncidentPublisher.ts src/jobs/ticketAttachmentReaper.ts src/jobs/ticketOutboxPublisher.ts \
  src/config/productionReadinessWiring.test.ts
```

Expected: ALL PASS; lint clean. If one of the six modules' own suites mocks `bullmq`'s `Worker` with an object lacking `.on`, `attachWorkerObservability` will throw inside the test — extend that suite's mock (test-only: add `on: vi.fn()` or an `EventEmitter`-based fake) rather than guarding the hook; note it in the commit message.

- [x] **Step 8: Commit (hooks ON)**

```bash
git add apps/api/src/jobs/workerReadinessManifest.ts apps/api/src/jobs/workerReadinessManifest.test.ts \
  apps/api/src/jobs/authBrowserTransitionCleanup.ts apps/api/src/jobs/orgMerge.ts apps/api/src/jobs/pamActuationWorker.ts \
  apps/api/src/jobs/metricAnomalyIncidentPublisher.ts apps/api/src/jobs/ticketAttachmentReaper.ts apps/api/src/jobs/ticketOutboxPublisher.ts \
  apps/api/src/config/productionReadinessWiring.test.ts
git commit -m "fix(api): key the readiness manifest by the worker registry

Manifest completeness is now asserted against WORKER_REGISTRY names plus
the two out-of-registry consumers (eventDispatch, agentCommandRelay)
instead of the static index.ts array main removed. Adds the 12 registry
entries main landed since the merge base (6 already attached; 6 get the
attachWorkerObservability hook here), drops policyAlertBridge and
dnsThreatAlertSubscriber (durable event subscribers on main, not
initializers), deletes initializeDeclaredWorkerGroup (behavior lives in
the onResult handlers, pinned by source). Count expectations are computed
from the registry and the rules; resolved values: <N> declared
(115 + 2 - 5 + 5), <N-1> required with abuse signals off (spec section 4).
Sentry double-report on the hooked modules ratified as-is (spec section 4)."
```

(Replace `<N>`/`<N-1>` with the recorded values.)

---

### Task 3: Role-scoped `declareExpectedConsumers` + D3a declare-time flag rules and optional marker

**Files:**
- Modify: `apps/api/src/jobs/workerReadinessManifest.ts` (`role` + flag inputs, two new `requiredWhen` rules, `optionalConsumers` marker, `aiAgentRunner` and `eventDispatch` rows)
- Modify: `apps/api/src/jobs/workerReadinessManifest.test.ts` (role tests, flag tests, per-consumer required flag, extended rule mirror; `role: 'all'` + flags on the existing tests)
- Modify: `apps/api/src/index.ts` (`role: breezeRole()`, `eventDispatchEnabled`, `aiAgentsEnabled`; `./config/env` import line)
- NOT modified: `services/workerReadinessRegistry.ts` and its test (the "fails closed for required disabled consumers" invariant stays), `jobs/eventDispatchWorker.ts` and its test (nothing calls `disable()` from a job module — its test runs mode-off inits against the real singleton with nothing declared, so an in-module `disable()` would throw there).

**Interfaces:**
- Consumes: `selectWorkers(role: BreezeRole): readonly WorkerRegistration[]` and `WORKER_REGISTRY` from `services/workerRegistry`; from `config/env`: `type BreezeRole = 'all' | 'api' | 'worker'`, `breezeRole()`, `abuseSignalsEnabled()`, `eventDispatchMode(): 'off' | 'shadow' | 'enforce'` (~line 230), `AI_AGENTS_ENABLED: boolean` (~line 100, `BREEZE_AI_AGENTS_ENABLED`, default `false`).
- Produces:

```ts
export type ConsumerRequirementRule =
  | 'redis'                   // required whenever Redis is available
  | 'abuse_signals_enabled'   // Track C: abuseSignalsWorker
  | 'event_dispatch_enabled'  // D3a: eventDispatch (EVENT_DISPATCH_MODE !== 'off')
  | 'ai_agents_enabled';      // D3a: aiAgentRunner (AI_AGENTS_ENABLED)

export type WorkerInitializerClassification =
  | {
      kind: 'consumers';
      initializer: string;
      consumers: readonly string[];
      requiredWhen: ConsumerRequirementRule;
      /** D3a: declared (expect(name, false)) and attached, never required, never disabled. Subset of `consumers`. */
      optionalConsumers?: readonly string[];
    }
  | { kind: 'non_consumer'; initializer: /* the five Task 2 names */ };

export function declareExpectedConsumers(input: {
  role: BreezeRole;
  redisAvailable: boolean;
  abuseSignalsEnabled: boolean;
  eventDispatchEnabled: boolean;
  aiAgentsEnabled: boolean;
  registry: WorkerReadinessRegistry;
}): void;
```

  Semantics: only entries whose initializer is in `selectWorkers(role)` ∪ role-gated out-of-registry starters are declared at all. For a declared entry whose rule is ON: `expect(name, true)` for each consumer not in `optionalConsumers`, `expect(name, false)` for each that is. For a declared entry whose rule is OFF (identical shape to Track C's abuse rule): `expect(name, false)` for every consumer, then `disable(name, 'feature_disabled')` for every consumer NOT in `optionalConsumers` (optional-marker consumers are never disabled — they construct and attach regardless of the flag, e.g. the maintenance worker, and land in `optionalRunning`). Task 4 calls this with `role: 'worker'`.

- [x] **Step 1: RED — manifest role, flag, and per-consumer-required tests**

In `apps/api/src/jobs/workerReadinessManifest.test.ts`, extend the rule mirror from Task 2 and add the tests. Expectations are computed from `WORKER_REGISTRY` placements and the rules — NOT from `selectWorkers` — so they are independent of the implementation helper:

```ts
type Role = 'all' | 'api' | 'worker';
interface Flags { abuseSignalsEnabled: boolean; eventDispatchEnabled: boolean; aiAgentsEnabled: boolean }
const ALL_ON: Flags = { abuseSignalsEnabled: true, eventDispatchEnabled: true, aiAgentsEnabled: true };
const ALL_OFF: Flags = { abuseSignalsEnabled: false, eventDispatchEnabled: false, aiAgentsEnabled: false };

function selectedInitializers(role: Role): Set<string> {
  const placement = role === 'api' ? 'socket-owner' : role === 'worker' ? 'global' : null;
  const names = new Set(WORKER_REGISTRY.filter((e) => placement === null || e.placement === placement).map((e) => e.name));
  if (role !== 'api') names.add('eventDispatch');
  if (role !== 'worker') names.add('agentCommandRelay');
  return names;
}

function ruleIsOn(rule: string, flags: Flags): boolean {
  switch (rule) {
    case 'redis': return true;
    case 'abuse_signals_enabled': return flags.abuseSignalsEnabled;
    case 'event_dispatch_enabled': return flags.eventDispatchEnabled;
    case 'ai_agents_enabled': return flags.aiAgentsEnabled;
    default: throw new Error(`unknown rule ${rule}`);
  }
}

/** { name -> required } for everything a process of `role` declares under `flags`. */
function expectedDeclarations(role: Role, flags: Flags): Map<string, boolean> {
  const selected = selectedInitializers(role);
  const out = new Map<string, boolean>();
  for (const e of WORKER_READINESS_MANIFEST) {
    if (e.kind !== 'consumers' || !selected.has(e.initializer)) continue;
    const on = ruleIsOn(e.requiredWhen, flags);
    for (const name of e.consumers) out.set(name, on && !(e.optionalConsumers?.includes(name) ?? false));
  }
  return out;
}

function expectedDisabled(role: Role, flags: Flags): string[] {
  const selected = selectedInitializers(role);
  return WORKER_READINESS_MANIFEST.flatMap((e) =>
    e.kind === 'consumers' && selected.has(e.initializer) && !ruleIsOn(e.requiredWhen, flags)
      ? e.consumers.filter((n) => !(e.optionalConsumers?.includes(n) ?? false))
      : []).sort();
}

function declare(role: Role, flags: Flags) {
  const registry = fakeRegistry();
  declareExpectedConsumers({ role, redisAvailable: true, ...flags, registry });
  const declared = new Map(registry.expect.mock.calls.map(([n, r]) => [n as string, r as boolean]));
  const disabled = registry.disable.mock.calls.map(([n]) => n as string).sort();
  return { registry, declared, disabled };
}

describe('role-scoped, rule-resolved declarations (spec section 5, D3/D3a)', () => {
  it.each<Role>(['api', 'worker', 'all'])('role %s declares exactly the selected consumers with the required flag each rule yields', (role) => {
    for (const flags of [ALL_ON, ALL_OFF]) {
      const { declared, disabled } = declare(role, flags);
      expect([...declared.entries()].sort()).toEqual([...expectedDeclarations(role, flags).entries()].sort());
      expect(disabled).toEqual(expectedDisabled(role, flags));
    }
  });

  it('api declares agentCommandRelay and no global consumer; worker declares eventDispatch(+maintenance) and no socket-owner consumer', () => {
    const api = declare('api', ALL_ON).declared;
    expect(api.get('agentCommandRelay')).toBe(true);
    expect(api.has('offlineDetector')).toBe(false);    // a global entry
    expect(api.has('eventDispatch')).toBe(false);
    const worker = declare('worker', ALL_ON).declared;
    expect(worker.get('eventDispatch')).toBe(true);
    expect(worker.get('eventDispatchMaintenance')).toBe(false);   // optional marker, even with the flag on
    expect(worker.has('agentCommandRelay')).toBe(false);
    expect(worker.has('orgMerge')).toBe(false);          // a socket-owner entry
  });

  it('api ∪ worker == all, with no name declared in both', () => {
    const api = [...declare('api', ALL_ON).declared.keys()];
    const worker = [...declare('worker', ALL_ON).declared.keys()];
    expect([...api, ...worker].sort()).toEqual([...declare('all', ALL_ON).declared.keys()].sort());
    expect(new Set([...api, ...worker]).size).toBe(api.length + worker.length);
  });

  it.each([
    ['event_dispatch_enabled', 'eventDispatch', 'worker', { ...ALL_ON, eventDispatchEnabled: false }],
    ['ai_agents_enabled', 'aiAgentRunner', 'api', { ...ALL_ON, aiAgentsEnabled: false }],
    ['abuse_signals_enabled', 'abuseSignalsWorker', 'worker', { ...ALL_ON, abuseSignalsEnabled: false }],
  ] as const)('%s off: %s is declared optional and disabled feature_disabled; on: required', (_rule, name, role, offFlags) => {
    const off = declare(role, offFlags);
    expect(off.declared.get(name)).toBe(false);
    expect(off.registry.disable).toHaveBeenCalledWith(name, 'feature_disabled');
    const on = declare(role, ALL_ON);
    expect(on.declared.get(name)).toBe(true);
    expect(on.registry.disable).not.toHaveBeenCalledWith(name, expect.anything());
  });

  it('a flag only matters where its consumer is selected: api never declares abuseSignalsWorker or eventDispatch', () => {
    const { declared, disabled } = declare('api', ALL_OFF);
    expect(declared.has('abuseSignalsWorker')).toBe(false);
    expect(declared.has('eventDispatch')).toBe(false);
    expect(disabled).not.toContain('abuseSignalsWorker');
  });

  it('the maintenance consumer is optional but never disabled, whatever the dispatch flag', () => {
    const { declared, disabled } = declare('worker', { ...ALL_ON, eventDispatchEnabled: false });
    expect(declared.get('eventDispatchMaintenance')).toBe(false);
    expect(disabled).toEqual(['eventDispatch']);
  });

  it('on a default all box exactly four consumers are optional (names, not a number)', () => {
    const { declared } = declare('all', ALL_OFF);
    const optional = [...declared.entries()].filter(([, r]) => !r).map(([n]) => n).sort();
    expect(optional).toEqual(['abuseSignalsWorker', 'aiAgentRunner', 'eventDispatch', 'eventDispatchMaintenance']);
    expect([...declared.values()].filter(Boolean)).toHaveLength(declared.size - optional.length);
  });

  it('every optionalConsumers entry is a subset of its own consumers', () => {
    for (const e of WORKER_READINESS_MANIFEST) {
      if (e.kind !== 'consumers') continue;
      for (const n of e.optionalConsumers ?? []) expect(e.consumers).toContain(n);
    }
  });
});
```

Also update the three existing `declareExpectedConsumers` tests from Task 2 to pass `role: 'all', eventDispatchEnabled: false, aiAgentsEnabled: false` (the "abuse off" one) / `…: true` (the "abuse on" one) / any values (the "Redis unavailable" one), and extend Task 2's `expectedRequiredNames(flags)` to take the full `Flags` and the optional marker (or replace its uses with `expectedDeclarations('all', flags)`); the "named optional set on an all-flags-off box" assertion in the abuse-off test becomes the four names above. Run:

```bash
pnpm --filter @breeze/api exec vitest run src/jobs/workerReadinessManifest.test.ts 2>&1 | tail -50
```

Expected FAIL (record the names): every role test (the implementation ignores `role` and declares everything), the three flag cases for `event_dispatch_enabled`/`ai_agents_enabled` (rules do not exist yet), the maintenance/optional tests, and the "four optional names" test (currently only `abuseSignalsWorker`). TypeScript-level: the test passes unknown properties to `declareExpectedConsumers` — vitest transpiles without typechecking, so the RED is runtime; that is expected.

- [x] **Step 2: GREEN — manifest implementation**

In `apps/api/src/jobs/workerReadinessManifest.ts`:

```ts
import type { BreezeRole } from '../config/env';
import type { WorkerReadinessRegistry } from '../services/workerReadinessRegistry';
import { selectWorkers } from '../services/workerRegistry';
```

Add the `ConsumerRequirementRule` type and `optionalConsumers?` field exactly as in Interfaces (with the doc comments), widen the `consumers()` helper's third parameter to `ConsumerRequirementRule`, and change two rows:

```ts
  // D3a (spec section 4, C1): main's initializeAiAgentRunner returns before
  // constructing/attaching when BREEZE_AI_AGENTS_ENABLED is off (default).
  // socket-owner placement — a plain-required row would pin every api/all
  // process not-ready on the default configuration.
  consumers('aiAgentRunner', ['aiAgentRunner'], 'ai_agents_enabled'),
```

```ts
  // D3a: the dispatch consumer is constructed only when EVENT_DISPATCH_MODE is
  // on (or an off-mode backlog remains — that drain then attaches as
  // optional-running, no readiness effect). Maintenance registration is an
  // isolated failure domain on main (a Redis blip during boot must not pin
  // /ready for a housekeeping job), so it is declared, attached, and never
  // required — and never disabled, since it constructs regardless of the flag.
  {
    kind: 'consumers',
    initializer: 'eventDispatch',
    consumers: ['eventDispatch', 'eventDispatchMaintenance'],
    requiredWhen: 'event_dispatch_enabled',
    optionalConsumers: ['eventDispatchMaintenance'],
  },
```

Replace `declareExpectedConsumers` with:

```ts
function ruleEnabled(rule: ConsumerRequirementRule, input: {
  abuseSignalsEnabled: boolean; eventDispatchEnabled: boolean; aiAgentsEnabled: boolean;
}): boolean {
  switch (rule) {
    case 'redis': return true;
    case 'abuse_signals_enabled': return input.abuseSignalsEnabled;
    case 'event_dispatch_enabled': return input.eventDispatchEnabled;
    case 'ai_agents_enabled': return input.aiAgentsEnabled;
  }
}

export function declareExpectedConsumers(input: {
  role: BreezeRole;
  redisAvailable: boolean;
  abuseSignalsEnabled: boolean;
  eventDispatchEnabled: boolean;
  aiAgentsEnabled: boolean;
  registry: WorkerReadinessRegistry;
}): void {
  if (!input.redisAvailable) return;

  // Only consumers this process will actually start exist for readiness.
  // Entries not selected for the role are not declared at all (not optional,
  // not disabled) — the public aggregate must not count them.
  const selected = new Set(selectWorkers(input.role).map((entry) => entry.name));
  if (input.role !== 'api') selected.add('eventDispatch');
  if (input.role !== 'worker') selected.add('agentCommandRelay');

  for (const entry of WORKER_READINESS_MANIFEST) {
    if (entry.kind === 'non_consumer') continue;
    if (!selected.has(entry.initializer)) continue;
    const enabled = ruleEnabled(entry.requiredWhen, input);
    const isOptional = (name: string): boolean => entry.optionalConsumers?.includes(name) ?? false;
    for (const name of entry.consumers) input.registry.expect(name, enabled && !isOptional(name));
    if (!enabled) {
      for (const name of entry.consumers) {
        if (!isOptional(name)) input.registry.disable(name, 'feature_disabled');
      }
    }
  }
}
```

Re-run the manifest file: ALL PASS. Record the resolved required count on a default `all` box from the "four optional names" test (`declared.size − 4`, expected `117 − 4 = 113`) for the commit message.

- [x] **Step 3: `index.ts` passes the role and the flags**

Change the `./config/env` import line to `import { AI_AGENTS_ENABLED, abuseSignalsEnabled, breezeRole, eventDispatchMode } from './config/env';` and the call at the top of `initializeWorkers` to:

```ts
  declareExpectedConsumers({
    role: breezeRole(),
    redisAvailable,
    abuseSignalsEnabled: abuseSignalsEnabled(),
    eventDispatchEnabled: eventDispatchMode() !== 'off',
    aiAgentsEnabled: AI_AGENTS_ENABLED,
    registry: workerReadinessRegistry,
  });
```

- [x] **Step 4: Gate**

```bash
pnpm --filter @breeze/api exec vitest run \
  src/jobs/workerReadinessManifest.test.ts src/jobs/workerReadinessCoverage.test.ts src/services/workerReadinessRegistry.test.ts \
  src/jobs/eventDispatchWorker.test.ts src/jobs/aiAgentRunner src/services/readiness.test.ts src/routes/readiness.test.ts \
  src/services/workerRegistry.test.ts src/services/workerEntrypointClosure.contract.test.ts src/config/productionReadinessWiring.test.ts \
  src/db/dbPoolHealthWiring.test.ts src/services/eventLoopMonitorWiring.test.ts
pnpm --filter @breeze/api exec eslint src/jobs/workerReadinessManifest.ts src/jobs/workerReadinessManifest.test.ts src/index.ts
git diff --stat -- apps/api/src/services/workerReadinessRegistry.ts apps/api/src/services/workerReadinessRegistry.test.ts apps/api/src/jobs/eventDispatchWorker.ts   # EMPTY: untouched by design
```

Expected: ALL PASS; the registry and `eventDispatchWorker.ts` diffs are empty. (Typecheck is still RED on `worker.ts` only — do not run it as a gate here; Task 4 closes it. If you want confirmation the signature change did not break `index.ts`, run it and confirm the error list is unchanged from Task 1 Step 12.)

- [x] **Step 5: Commit**

```bash
git add apps/api/src/jobs/workerReadinessManifest.ts apps/api/src/jobs/workerReadinessManifest.test.ts apps/api/src/index.ts
git commit -m "fix(api): scope required consumers to the process role and resolve flag-gated consumers at declare time

declareExpectedConsumers takes BREEZE_ROLE and derives the declared set
from selectWorkers(role) plus the role-gated out-of-registry starters
(spec section 5, D3): an api-role process no longer waits forever on the
global consumers it never starts. D3a: two new declare-time rules beside
abuse_signals_enabled — event_dispatch_enabled (eventDispatch, from
EVENT_DISPATCH_MODE) and ai_agents_enabled (aiAgentRunner, from
BREEZE_AI_AGENTS_ENABLED; main's initializer returns before attaching
when off) — resolved as expect(name,false) + disable(name,
'feature_disabled'); eventDispatchMaintenance is declared optional via a
per-consumer marker (main isolates its failure from readiness by design).
Registry semantics untouched. Resolved: <N> declared, <N-4> required on a
default all box (abuse, eventDispatch, aiAgentRunner, maintenance optional)."
```

---

### Task 4: Worker entrypoint port (evaluator options, role-scoped declaration, failure loops, redacted `/health/ready`) + delete `computeWorkersHealthy`

**Files:**
- Modify: `apps/api/src/worker.ts` (imports, readiness timing, evaluator, `handleReadyRequest`, dynamic-import block, `startRegisteredWorkers` + eventDispatch blocks)
- Modify: `apps/api/src/worker.boot.test.ts` (new mocks, updated readiness + boot-order tests, three new tests)
- Modify: `apps/api/src/services/readiness.ts` (delete `computeWorkersHealthy` + `WorkersHealthyInput`)
- Modify: `apps/api/src/services/readiness.test.ts` (delete the `describe('computeWorkersHealthy')` block, ~lines 426–497, and its import)

**Interfaces:**
- Consumes: `createReadinessEvaluator({ checkDb, checkRedis, workerRegistry, workersInitialized, isShuttingDown, requireRedis, ttlMs, probeTimeoutMs, onProbeFailure })` (Track C); `resolveReadinessTiming(process.env, onClamp): { ttlMs, probeTimeoutMs, transitionVisibilityThresholdMs }` from `config/readinessConfig`; `workerReadinessRegistry`, `setWorkerReadinessTransitionHandler(handler)`, `summarizeConsumerReadiness(consumers)` from `services/workerReadinessRegistry`; `declareExpectedConsumers({ role: 'worker', redisAvailable, abuseSignalsEnabled, eventDispatchEnabled, aiAgentsEnabled, registry })` and `consumersForInitializer(name)` from Task 3; `abuseSignalsEnabled()`, `eventDispatchMode()`, `AI_AGENTS_ENABLED` from `config/env`.
- Produces: the worker container's `/health/ready` body — `{ role: 'worker', ready, db, redis, workers, checkedAt, consumerSummary }` on 200 and the same plus `reason: 'db' | 'redis' | 'workers-pending'` on 503 (pre-parity and shutting-down bodies unchanged: `{ ready: false, reason: 'migrations-pending' | 'shutting-down' }`). API typecheck GREEN for the first time since the merge. No worker-side `/ready` alias (spec §6).

- [x] **Step 1: RED — update `worker.boot.test.ts`**

1. Mocks (`vi.hoisted` block): add

```ts
    abuseSignalsEnabled: vi.fn(() => false),
    eventDispatchMode: vi.fn(() => 'off' as const),
    declareExpectedConsumers: vi.fn(),
    consumersForInitializer: vi.fn((_name: string): readonly string[] => []),
```

2. Module mocks: change `vi.mock('./config/env', …)` to

```ts
vi.mock('./config/env', () => ({
  breezeRole: mocks.breezeRole,
  abuseSignalsEnabled: mocks.abuseSignalsEnabled,
  eventDispatchMode: mocks.eventDispatchMode,
  AI_AGENTS_ENABLED: false,
}));
```

and add a wholesale manifest mock (the spec allows either this or adding `selectWorkers`/`WORKER_REGISTRY` to the registry mock; wholesale is chosen so the tests control the declared set directly):

```ts
vi.mock('./jobs/workerReadinessManifest', () => ({
  declareExpectedConsumers: mocks.declareExpectedConsumers,
  consumersForInitializer: mocks.consumersForInitializer,
}));
```

Do NOT mock `./services/workerReadinessRegistry` — the real (leaf, side-effect-free) registry is what makes the fail-closed assertions real.

3. Helpers (top level, after `getJson`):

```ts
import { EventEmitter } from 'node:events';
import type { Worker } from 'bullmq';

/** Minimal Worker-shaped double the registry accepts: events + isRunning() + a ready client. */
function fakeBullmqWorker() {
  return Object.assign(new EventEmitter(), {
    isRunning: () => true,
    client: Promise.resolve({ status: 'ready' }),
  });
}
/** The registry instance worker.ts is using in THIS test's module generation (after vi.resetModules). */
async function liveRegistry() {
  return (await import('./services/workerReadinessRegistry')).workerReadinessRegistry;
}
function getText(port: number, path: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: data }));
    }).on('error', reject);
  });
}
```

4. `beforeEach` defaults (after the existing `startRegisteredWorkers` default):

```ts
  mocks.abuseSignalsEnabled.mockReturnValue(false);
  mocks.eventDispatchMode.mockReturnValue('off');
  mocks.declareExpectedConsumers.mockImplementation(({ registry }: { registry: { expect: (n: string, r: boolean) => void } }) => {
    registry.expect('fakeGlobalWorker', true);
  });
  mocks.consumersForInitializer.mockImplementation((name: string) => (name === 'fakeGlobalWorker' ? ['fakeGlobalWorker'] : []));
  mocks.startRegisteredWorkers.mockImplementation(
    async (_role: string, hooks: { onResult: (n: string, ok: boolean, e?: unknown) => void }) => {
      (await liveRegistry()).attach('fakeGlobalWorker', fakeBullmqWorker() as unknown as Worker);
      hooks.onResult('fakeGlobalWorker', true);
    },
  );
```

5. Existing test `boots in order: migration parity -> role verification -> enqueuer/subscribers -> workers` (~line 221): add `mocks.declareExpectedConsumers.mockImplementation(({ registry }) => { order.push('declareExpectedConsumers'); registry.expect('fakeGlobalWorker', true); });`, make its `startRegisteredWorkers` override also attach (`(await liveRegistry()).attach('fakeGlobalWorker', fakeBullmqWorker() as unknown as Worker);` before `hooks.onResult`), and insert `'declareExpectedConsumers'` into the expected `order` between `'registerAllEventSubscribers'` and `'startRegisteredWorkers'`.

6. Existing test `readiness flips to ready only after every worker init result is recorded`: its override must also attach before reporting:

```ts
      async (_role, hooks) => {
        await startGate;
        (await liveRegistry()).attach('fakeGlobalWorker', fakeBullmqWorker() as unknown as Worker);
        hooks.onResult('fakeGlobalWorker', true);
      },
```

Keep both assertions (`midSnapshot.ready === false` before the gate; `finalSnapshot.ready === true && workers === true` after). Add one: `expect(mocks.declareExpectedConsumers).toHaveBeenCalledWith(expect.objectContaining({ role: 'worker', redisAvailable: true, abuseSignalsEnabled: false, eventDispatchEnabled: false, aiAgentsEnabled: false }));`.

7. New tests:

```ts
  it('stays not-ready when a declared consumer never attaches (fail-closed half of D4)', async () => {
    mocks.declareExpectedConsumers.mockImplementation(({ registry }) => {
      registry.expect('fakeGlobalWorker', true);
      registry.expect('neverAttached', true);
    });
    const worker = await importFreshWorker();
    const port = await waitForListening(worker);
    await waitFor(() => worker._getWorkerInitPhaseForTest() === 'started');

    const snapshot = await worker._getReadinessForTest().get();
    expect(snapshot).toMatchObject({ ready: false, db: true, redis: true, workers: false });
    const response = await getJson(port, '/health/ready');
    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ ready: false, reason: 'workers-pending', role: 'worker' });
  });

  it('records initialization failure for every consumer of a failed registry entry AND of a failed eventDispatch', async () => {
    mocks.declareExpectedConsumers.mockImplementation(({ registry }) => {
      for (const n of ['fakeGlobalWorker', 'brokenA', 'brokenB', 'eventDispatch', 'eventDispatchMaintenance']) registry.expect(n, n !== 'eventDispatchMaintenance');
    });
    mocks.consumersForInitializer.mockImplementation((name: string) =>
      name === 'brokenEntry' ? ['brokenA', 'brokenB']
        : name === 'eventDispatch' ? ['eventDispatch', 'eventDispatchMaintenance']
        : name === 'fakeGlobalWorker' ? ['fakeGlobalWorker'] : []);
    mocks.startRegisteredWorkers.mockImplementation(async (_role, hooks) => {
      (await liveRegistry()).attach('fakeGlobalWorker', fakeBullmqWorker() as unknown as Worker);
      hooks.onResult('fakeGlobalWorker', true);
      hooks.onResult('brokenEntry', false, new TypeError('boom'));
    });
    mocks.initializeEventDispatchWorker.mockRejectedValue(new RangeError('dispatch boom'));
    const worker = await importFreshWorker();
    await waitFor(() => worker._getWorkerInitPhaseForTest() === 'started');

    const consumers = (await liveRegistry()).snapshot();
    expect(consumers.brokenA).toMatchObject({ state: 'failed', lastErrorCode: 'TypeError' });
    expect(consumers.brokenB).toMatchObject({ state: 'failed', lastErrorCode: 'TypeError' });
    expect(consumers.eventDispatch).toMatchObject({ state: 'failed', lastErrorCode: 'RangeError' });
    expect((await worker._getReadinessForTest().get()).ready).toBe(false);
    expect(mocks.captureException).toHaveBeenCalledTimes(2);
  });

  it('never serializes consumer names, timestamps, or error codes on /health/ready (mirror of routes/readiness.test.ts)', async () => {
    const leaky = fakeBullmqWorker();
    mocks.declareExpectedConsumers.mockImplementation(({ registry }) => {
      registry.expect('leaky-postgres-primary.internal', true);
    });
    mocks.startRegisteredWorkers.mockImplementation(async (_role, hooks) => {
      (await liveRegistry()).attach('leaky-postgres-primary.internal', leaky as unknown as Worker);
      hooks.onResult('leaky-postgres-primary.internal', true);
    });
    const worker = await importFreshWorker();
    const port = await waitForListening(worker);
    await waitFor(() => worker._getWorkerInitPhaseForTest() === 'started');

    const ok = await getJson(port, '/health/ready');
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({
      role: 'worker', ready: true, db: true, redis: true, workers: true, checkedAt: expect.any(String),
      consumerSummary: { required: 1, runnable: 1, unavailable: 0, optionalRunning: 0, optionalDisabled: 0 },
    });

    leaky.emit('error', Object.assign(new Error('redis://secret.internal:6379'), { name: 'RedisSecretError' }));
    const degraded = await getText(port, '/health/ready');
    expect(degraded.status).toBe(503);
    expect(JSON.parse(degraded.text)).toEqual({
      reason: 'workers-pending', role: 'worker', ready: false, db: true, redis: true, workers: false, checkedAt: expect.any(String),
      consumerSummary: { required: 1, runnable: 0, unavailable: 1, optionalRunning: 0, optionalDisabled: 0 },
    });
    // The three redaction assertions the API-side test carries: name, timestamp, error code.
    expect(degraded.text).not.toContain('leaky-postgres-primary');                       // registry name
    expect(degraded.text).not.toContain('"transitionedAt"');                             // per-consumer timestamp field
    expect(degraded.text).not.toContain('RedisSecretError');                             // error code
    expect(degraded.text).not.toContain('secret.internal');                              // error message / endpoint
    expect(degraded.text).not.toContain('"consumers"');                                  // the snapshot map itself
  });
```

Run:

```bash
pnpm --filter @breeze/api exec vitest run src/worker.boot.test.ts 2>&1 | tail -60
```

Expected: FAIL — the evaluator is still built with `workersHealthy`, so every readiness-dependent test fails (`readiness.get()` cannot consult a registry it was never given), and the new tests fail. Record the failing names.

- [x] **Step 2: Port `worker.ts`**

1. Imports. Replace the `./services/readiness` import with `import { createReadinessEvaluator, type WorkerInitPhase } from './services/readiness';`; change the `./config/env` import to `import { AI_AGENTS_ENABLED, abuseSignalsEnabled, breezeRole, eventDispatchMode } from './config/env';`; add STATIC imports (spec §6 — the evaluator is built at module scope; both modules are leaves: `readinessConfig.ts` imports nothing, `workerReadinessRegistry.ts` imports only `import type { Worker } from 'bullmq'`):

```ts
import { resolveReadinessTiming } from './config/readinessConfig';
import {
  setWorkerReadinessTransitionHandler,
  summarizeConsumerReadiness,
  workerReadinessRegistry,
} from './services/workerReadinessRegistry';
```

Keep `envInt` (still used for `API_PORT`). Add both new modules to the header comment's list of "genuinely leaf modules [that] stay as static top-of-file imports".

2. Replace the `READINESS_CACHE_TTL_MAX_MS` / `readinessTtlRaw` / `READINESS_CACHE_TTL_MS` / `READINESS_PROBE_TIMEOUT_MS` block and its comment with:

```ts
/**
 * Same clamp as index.ts (config/readinessConfig.ts): ttl + probe timeout
 * never exceed the published 10 s transition-visibility threshold.
 */
const readinessTiming = resolveReadinessTiming(process.env, (name, requested, effective) => {
  console.warn(`[worker][ready] ${name}=${requested} clamped to ${effective}ms`);
});
```

3. Evaluator:

```ts
const readiness = createReadinessEvaluator({
  checkDb: () => probeDb(),
  checkRedis: () => probeRedis(),
  workerRegistry: workerReadinessRegistry,
  workersInitialized: () => workerInitPhase === 'started',
  isShuttingDown: () => shuttingDown,
  // ALWAYS true for a worker: (keep main's existing comment)
  requireRedis: true,
  ttlMs: readinessTiming.ttlMs,
  probeTimeoutMs: readinessTiming.probeTimeoutMs,
  onProbeFailure: (probeName, error) => {
    console.error(`[worker][ready] ${probeName} probe failed:`, error);
    captureException(error instanceof Error ? error : new Error(String(error)));
  },
});
setWorkerReadinessTransitionHandler(() => readiness.invalidate());
```

Update the "Module-level boot state" comment (it mentions `computeWorkersHealthy`) to say `workerStatus` now feeds only the boot log's failed-list; readiness reads the consumer registry.

4. `handleReadyRequest`: replace the two `writeJson(res, …, { …snapshot })` calls with an explicit body (never spread the snapshot):

```ts
    const snapshot = await readiness.get();
    const body = {
      role: 'worker' as const,
      ready: snapshot.ready,
      db: snapshot.db,
      redis: snapshot.redis,
      workers: snapshot.workers,
      checkedAt: snapshot.checkedAt,
      // Aggregate counts only — consumer names, timestamps and error codes
      // are internal (same rule as routes/readiness.ts).
      consumerSummary: summarizeConsumerReadiness(snapshot.consumers),
    };
    if (snapshot.ready) {
      writeJson(res, 200, body);
      return;
    }
    const reason = !snapshot.db ? 'db' : !snapshot.redis ? 'redis' : 'workers-pending';
    writeJson(res, 503, { reason, ...body });
```

5. Dynamic-import block: add `const { declareExpectedConsumers, consumersForInitializer } = await import('./jobs/workerReadinessManifest');` directly after the `./services/workerRegistry` line (same block; the manifest value-imports `selectWorkers` from `services/workerRegistry`, whose only static import is `import type { BreezeRole }` — the seeded walk tolerates that edge).

6. Before `await startRegisteredWorkers('worker', …)`:

```ts
  // Redis is mandatory here (step 5 exited otherwise), so every consumer the
  // worker role starts is declared up front — fail-closed until each attaches
  // (spec D3/D4); flag-gated consumers resolve at declare time (D3a).
  declareExpectedConsumers({
    role: 'worker',
    redisAvailable: true,
    abuseSignalsEnabled: abuseSignalsEnabled(),
    eventDispatchEnabled: eventDispatchMode() !== 'off',
    aiAgentsEnabled: AI_AGENTS_ENABLED,
    registry: workerReadinessRegistry,
  });
```

Inside `onResult`'s `if (!ok)` AFTER `captureException(...)`:

```ts
        for (const consumer of consumersForInitializer(name)) {
          workerReadinessRegistry.recordInitializationFailure(consumer, error);
        }
```

and in the eventDispatch block's `catch`, after its `captureException(...)`:

```ts
    for (const consumer of consumersForInitializer('eventDispatch')) {
      workerReadinessRegistry.recordInitializationFailure(consumer, error);
    }
```

- [x] **Step 3: Delete `computeWorkersHealthy` (spec §6/§9)**

```bash
grep -rn "computeWorkersHealthy\|WorkersHealthyInput" apps/api/src   # expect: only services/readiness.ts and services/readiness.test.ts
```

In `apps/api/src/services/readiness.ts` delete `export interface WorkersHealthyInput { … }` and `export function computeWorkersHealthy(…) { … }` with their doc comments (keep `WorkerInitPhase` — both entrypoints use it). In `apps/api/src/services/readiness.test.ts` delete the whole `describe('computeWorkersHealthy', …)` block (from `describe('computeWorkersHealthy'` to the end of file) and remove `computeWorkersHealthy` from the import. Re-run the grep: expect empty.

- [x] **Step 4: GREEN — boot suite, closure contract, typecheck (first GREEN since the merge)**

```bash
pnpm --filter @breeze/api exec vitest run src/worker.boot.test.ts src/services/workerEntrypointClosure.contract.test.ts \
  src/services/readiness.test.ts src/routes/readiness.test.ts src/config/readinessConfig.test.ts src/services/workerReadinessRegistry.test.ts
NODE_OPTIONS=--max-old-space-size=8192 pnpm --filter @breeze/api exec tsc --noEmit
grep -n "workersHealthy:\|computeWorkersHealthy\|\.\.\.snapshot\|app.get\|'/ready'" apps/api/src/worker.ts    # expect EMPTY (no legacy option, no spread, no /ready alias)
pnpm --filter @breeze/api exec eslint src/worker.ts src/worker.boot.test.ts src/services/readiness.ts src/services/readiness.test.ts
```

Expected: ALL PASS; typecheck exits 0; greps empty. If the closure test's seeded walk reports a new `routes/` file under the `./jobs/workerReadinessManifest` seed, STOP — the manifest's static closure grew beyond the two leaf modules; do not add an allowlist entry.

- [x] **Step 5: Commit**

```bash
git add apps/api/src/worker.ts apps/api/src/worker.boot.test.ts apps/api/src/services/readiness.ts apps/api/src/services/readiness.test.ts
git commit -m "fix(api): port the worker entrypoint onto continuous consumer readiness

worker.ts builds its evaluator on the consumer registry (D4) instead of
the boot-time workerStatus snapshot, declares the worker-role consumer
set (role + abuse/dispatch/ai-agents flags) before startRegisteredWorkers,
records per-consumer initialization failure from onResult and from the
eventDispatch block, clamps READINESS_* via resolveReadinessTiming like
index.ts, and serializes /health/ready as an explicit { role, ready, db,
redis, workers, checkedAt, consumerSummary } body — never the snapshot
spread, which would have leaked consumer names, timestamps and error
codes on the one container whose compose healthcheck probes readiness.
computeWorkersHealthy, WorkersHealthyInput and their test block deleted
(zero callers). No worker-side /ready alias."
```

---

### Task 5: Compose, env, deploy, and docs

**Files:**
- Modify: `apps/api/src/config/productionReadinessWiring.test.ts` (worker-service rule, D5)
- Modify: `deploy/docker-compose.prod.yml` (`x-api-env` anchor: `READINESS_*` + `OFFLINE_DETECTOR_WORKER_CONCURRENCY`)
- Modify: `docker-compose.yml` (`x-api-env` anchor: `OFFLINE_DETECTOR_WORKER_CONCURRENCY`)
- Modify: `deploy/.env.example`, `.env.example`
- Modify: `docs/operations/health-probes.md`, `docs/deploy/worker-split.md`, `apps/docs/src/content/docs/monitoring/health.mdx`
- Conditionally modify: `docs/superpowers/plans/2026-08-24-s0-track-c-readiness-offline-scaling.md` (spec §9 name correction — see Step 8)
- Not modified: `scripts/prod/deploy.sh` (Track C's `readiness_ok` applies cleanly; verify only), `docker-compose.override.yml.dev`.

**Interfaces:**
- Consumes: `envComposeParity.test.ts`'s two pairs (root `.env.example` ↔ `docker-compose.yml`; `deploy/.env.example` ↔ `deploy/docker-compose.prod.yml`) — every documented var (a `NAME=` or `# NAME=` line; prose does not count) must be referenced in its compose file; `resolveOfflineWorkerConcurrency` (1–20, default 5) in `jobs/offlineDetector.ts`; `PublicReadinessResponse` from `routes/readiness.ts`.
- Produces: both stacks expose `READINESS_CACHE_TTL_MS`, `READINESS_PROBE_TIMEOUT_MS`, `OFFLINE_DETECTOR_WORKER_CONCURRENCY` to api and worker containers; docs describe the merged reality.

- [x] **Step 1: Pin the worker-service healthcheck rule (D5) — expected GREEN on first run; it is a pin**

Append to `apps/api/src/config/productionReadinessWiring.test.ts`:

```ts
  // D5: the worker container (profile worker-split) DOES healthcheck
  // readiness, and that is safe only because nothing depends_on it: an
  // unhealthy worker only shows `unhealthy` in `docker compose ps` (Compose
  // does not restart on unhealthy), gates no other service's startup, and
  // deploy.sh runs `compose up -d` without --wait. The zero-dependents
  // assertion is what makes the api rule above and this one consistent.
  it.each([
    ['docker-compose.yml'],
    ['deploy/docker-compose.prod.yml'],
  ])('%s healthchecks the worker service on READINESS because no service depends on it', (path) => {
    const document = load(read(path)) as {
      services: Record<string, { healthcheck?: { test: string[] }; depends_on?: Record<string, unknown> }>;
    };
    const probe = document.services.worker?.healthcheck?.test.join(' ') ?? '';
    expect(probe).toContain('http://127.0.0.1:3001/health/ready');
    const dependents = Object.entries(document.services)
      .filter(([, service]) => service.depends_on !== undefined && 'worker' in service.depends_on)
      .map(([name]) => name);
    expect(dependents).toEqual([]);
  });

  it('deploy.sh never waits on container health (so an unhealthy worker cannot block a deploy)', () => {
    const deploy = read('scripts/prod/deploy.sh');
    expect(deploy).not.toMatch(/compose[^\n]*\bup\b[^\n]*--wait\b/);
  });
```

Run `pnpm --filter @breeze/api exec vitest run src/config/productionReadinessWiring.test.ts` → PASS. Prove the assertions are load-bearing without editing compose: `grep -n "^      worker:" docker-compose.yml deploy/docker-compose.prod.yml` → empty (no `depends_on: worker:` stanza anywhere); `grep -n "/health/ready" docker-compose.yml deploy/docker-compose.prod.yml` → exactly the two worker healthchecks; `grep -n -- "--wait" scripts/prod/deploy.sh` → empty.

- [x] **Step 2: RED — document the knobs before mapping them (as `# NAME=` lines)**

Root `.env.example`, directly after the existing `READINESS_PROBE_TIMEOUT_MS=3000` line (~line 63):

```
# BullMQ concurrency of the offline-detector mark worker (integer 1-20; code
# default 5). Raise only on exact-candidate evidence — the product default
# does not change with this knob.
# OFFLINE_DETECTOR_WORKER_CONCURRENCY=5
```

`deploy/.env.example`, a new section after the `# ── Reporting FX …` block (before `# ── Observability`):

```
# ── Readiness probes + offline sweep ────────────────────────────────
# Readiness verdicts are cached and dependency probes are bounded; values are
# clamped so cache TTL + probe timeout never exceed the supported 10 s
# failure/recovery visibility threshold (docs/operations/health-probes.md).
# READINESS_CACHE_TTL_MS=5000
# READINESS_PROBE_TIMEOUT_MS=3000
# BullMQ concurrency of the offline-detector mark worker (integer 1-20; code
# default 5). Raise only on exact-candidate evidence.
# OFFLINE_DETECTOR_WORKER_CONCURRENCY=5
```

Run:

```bash
pnpm --filter @breeze/api exec vitest run src/config/envComposeParity.test.ts 2>&1 | tail -30
```

Expected RED (record verbatim): self-host pair lists `OFFLINE_DETECTOR_WORKER_CONCURRENCY` as unwired; droplet pair lists `OFFLINE_DETECTOR_WORKER_CONCURRENCY`, `READINESS_CACHE_TTL_MS`, `READINESS_PROBE_TIMEOUT_MS`. If the droplet pair does NOT go red, the lines were written as prose rather than `# NAME=` — fix the lines, not the test.

- [x] **Step 3: GREEN — map them in both `x-api-env` anchors**

`docker-compose.yml`: directly after `  READINESS_PROBE_TIMEOUT_MS: ${READINESS_PROBE_TIMEOUT_MS:-}` in the anchor (still before the `# Startup + agent-fleet behaviour` comment) add

```yaml
  # Offline-detector mark-worker concurrency (1-20, code default 5). Empty === unset.
  OFFLINE_DETECTOR_WORKER_CONCURRENCY: ${OFFLINE_DETECTOR_WORKER_CONCURRENCY:-}
```

`deploy/docker-compose.prod.yml`: the prod anchor's LAST key is `  FRANKFURTER_BASE_URL: ${FRANKFURTER_BASE_URL:-}` (~line 276; there is no `AUTO_MIGRATE` in the prod anchor). Append directly after it, before the blank line and `services:`:

```yaml
  # Readiness cache + dependency-probe bounds. Empty === unset, so the
  # `${VAR:-}` form keeps the clamped code defaults (5000 / 3000 ms). Both
  # MUST be listed here: compose only interpolates vars named in this block,
  # so a value set in .env alone is a silent no-op.
  READINESS_CACHE_TTL_MS: ${READINESS_CACHE_TTL_MS:-}
  READINESS_PROBE_TIMEOUT_MS: ${READINESS_PROBE_TIMEOUT_MS:-}
  # Offline-detector mark-worker concurrency (1-20, code default 5). Empty === unset.
  OFFLINE_DETECTOR_WORKER_CONCURRENCY: ${OFFLINE_DETECTOR_WORKER_CONCURRENCY:-}
```

Then:

```bash
pnpm --filter @breeze/api exec vitest run src/config/envComposeParity.test.ts src/config/productionReadinessWiring.test.ts
docker compose -f docker-compose.yml config --quiet
docker compose -f docker-compose.yml -f docker-compose.override.yml.dev config --quiet
docker compose -f deploy/docker-compose.prod.yml config --quiet
docker compose -f docker-compose.yml --profile worker-split config --quiet
for f in docker-compose.yml deploy/docker-compose.prod.yml; do
  awk '/^x-api-env:/{a=1} /^services:/{a=0} a && /READINESS_CACHE_TTL_MS:|READINESS_PROBE_TIMEOUT_MS:|OFFLINE_DETECTOR_WORKER_CONCURRENCY:/{n++} END{print FILENAME, n}' "$f"
done   # 3 each
```

Expected: ALL PASS; both anchors report 3. (`deploy/docker-compose.prod.yml` `config` may need placeholder env values for `:?` required vars — if it does, reuse whatever invocation the Track C branch's own plan Task 3 gate used and record it in the report.)

- [x] **Step 4: `docs/operations/health-probes.md` — "Which probe goes where"**

Change the sentence `**Container healthchecks use \`/health\`, not \`/ready\`.**` to `**The \`api\` container healthchecks \`/health\`, not \`/ready\`.**` (rest of that paragraph unchanged) and append, after the paragraph about the unredirected 200 check, this new paragraph:

```markdown
**The optional `worker` container (Compose profile `worker-split`) healthchecks
`/health/ready` — its own, served by `dist/worker.cjs` on the container's
`API_PORT`.** That is safe only because nothing declares `depends_on: worker`:
an unhealthy worker container only shows `unhealthy` in `docker compose ps`
(Compose does not restart a container for failing its healthcheck), gates no
other service's startup, and `scripts/prod/deploy.sh` runs `compose up -d`
without `--wait`, so the deploy gate is unaffected.
`productionReadinessWiring.test.ts` asserts all three halves — the probe path,
the zero-dependents condition, and the absence of `--wait`. The worker's
verdict is the same continuous consumer-readiness rule as the API's, scoped to
the consumers the `worker` role starts (`BREEZE_ROLE`) with flag-gated
consumers (`EVENT_DISPATCH_MODE`, `BREEZE_AI_AGENTS_ENABLED`,
abuse signals) declared optional when off; see `docs/deploy/worker-split.md`
for the rollout runbook that reads it. The deploy admission gate probes the
public API hostname only — it proves the `api` container's readiness for its
configured role, not the worker's.
```

Also add one sentence to the final "Public readiness responses" paragraph: `The worker container's \`/health/ready\` follows the same rule and additionally carries \`role: "worker"\` and, on 503, a single \`reason\` of \`db\`, \`redis\`, \`workers-pending\`, \`migrations-pending\`, or \`shutting-down\`.`

- [x] **Step 5: `docs/deploy/worker-split.md` — the runbook step that waits on the worker's `/health/ready`**

In "Rollout" step 3, after `Confirm \`/health/ready\` returns 200 with \`{"ready": true, ...}\` before proceeding; a \`migrations-pending\` or \`redis\`/\`db\` reason means do not proceed.` add:

```markdown
   Since the readiness port (#4007) this verdict is **true consumer
   readiness**, not a boot snapshot: `200` means every queue consumer the
   `worker` role starts is attached with a connected Redis client, and the
   body's `consumerSummary` carries aggregate counts (`required`, `runnable`,
   `unavailable`, `optionalRunning`, `optionalDisabled`). A `workers-pending`
   reason that persists past the worker's `start_period` (60 s) means a
   required consumer failed to initialize or lost Redis — check
   `docker logs breeze-worker` for `[CRITICAL][worker] Failed to initialize
   <name>` before proceeding. Feature-gated consumers (`EVENT_DISPATCH_MODE`,
   `BREEZE_AI_AGENTS_ENABLED`, abuse signals) are declared optional when their
   flag is off, so a default box converges to `ready: true` on its own.
```

And in "Soak" (step 6), replace `Watch both containers' logs and \`/health/ready\`` with `Watch both containers' logs and \`/health/ready\` (the worker's body's \`consumerSummary.unavailable\` must stay 0)`.

- [x] **Step 6: `apps/docs/src/content/docs/monitoring/health.mdx` — the public docs page (spec §7)**

Make exactly these edits (leave the load-balancer, Kubernetes, metrics and unrelated troubleshooting sections as they are):

1. "Available Endpoints" table: change the `/health/ready` row's purpose to `Full readiness -- database, Redis, and every required queue consumer runnable (alias: \`GET /ready\`)`, and add a row `| \`GET /ready\` | Alias of \`/health/ready\` (same evaluator, same body) | No |`.
2. Replace the whole "### GET /health/ready" subsection (both JSON examples and the field table, up to but excluding the `<Aside>`) with:

````markdown
### GET /health/ready (alias: GET /ready)

Returns `200 OK` only when the database and Redis are reachable **and every
queue consumer this process is required to run is attached and connected**.
Returns `503 Service Unavailable` otherwise. Both paths are served by the same
cached evaluator (default 5 s cache, 3 s per-probe timeout; the two are clamped
so a failure or recovery is visible within 10 s).

**Healthy response (200):**

```json
{
  "ready": true,
  "db": true,
  "redis": true,
  "workers": true,
  "checkedAt": "2026-09-01T12:00:00.000Z",
  "consumerSummary": {
    "required": 113,
    "runnable": 113,
    "unavailable": 0,
    "optionalRunning": 1,
    "optionalDisabled": 3
  }
}
```

**Degraded response (503):**

```json
{
  "ready": false,
  "db": true,
  "redis": true,
  "workers": false,
  "checkedAt": "2026-09-01T12:00:05.000Z",
  "consumerSummary": {
    "required": 113,
    "runnable": 112,
    "unavailable": 1,
    "optionalRunning": 1,
    "optionalDisabled": 3
  }
}
```

If the evaluator itself fails, the body is `{ "ready": false, "db": null, "redis": null, "workers": null, "checkedAt": "...", "consumerSummary": null, "error": "readiness evaluation failed" }` with status 503 — `null`, not `false`, because the backends may be healthy.

| Field | Description |
|---|---|
| `ready` | Overall admission verdict; the status code follows it |
| `db` / `redis` | Live dependency probes (bounded by the probe timeout) |
| `workers` | `true` when worker initialization has completed and every required queue consumer is running with a connected Redis client |
| `checkedAt` | When this verdict was computed (it may be cached for up to the cache TTL) |
| `consumerSummary` | Aggregate counts only: `required`, `runnable`, `unavailable` (= required − runnable), `optionalRunning`, `optionalDisabled` |

Only aggregate counts are ever exposed. Consumer names, queue names, Redis
endpoints, transition timestamps, and error messages are internal and never
appear in this body. The counts depend on the process role (`BREEZE_ROLE`)
and on feature flags: an `api`-role process counts only the socket-owner
consumers it starts, a `worker`-role process only the global ones, and
consumers behind an off feature flag (`EVENT_DISPATCH_MODE`,
`BREEZE_AI_AGENTS_ENABLED`, abuse signals) are counted as `optionalDisabled`
rather than blocking readiness. The numbers above are illustrative.

The optional `worker` container (Compose profile `worker-split`) serves its
own `/health/ready` on its `API_PORT` with the same fields plus
`"role": "worker"` and, when not ready, a single `reason`
(`db`, `redis`, `workers-pending`, `migrations-pending`, or `shutting-down`).
````

3. In the `<Aside>` right below it, keep the sentence and append: `Do not put \`/health/ready\` in a Docker Compose \`healthcheck:\` for a service other containers \`depends_on\` — Compose turns it into a startup gate. The \`worker\` container is the one exception, because nothing depends on it. See \`docs/operations/health-probes.md\` in the repository.`
4. "Docker Health Checks" table: add a row `| Worker (profile \`worker-split\`) | \`wget http://localhost:3001/health/ready\` | 30s | 60s |` after the API row.
5. "### /health/ready returns 503" troubleshooting step 1: replace `Check which dependency failed by reading the \`checks\` object in the response body.` with `Read the \`db\`, \`redis\`, and \`workers\` booleans in the response body. If only \`workers\` is \`false\`, \`consumerSummary.unavailable\` tells you how many required queue consumers are not running; check the API container logs for \`[CRITICAL] Failed to initialize <worker>\` lines and for Redis disconnects.` and add a step 4: `If \`workers\` is failing: verify Redis is healthy (a consumer that lost its Redis client reports not-ready until it reconnects), then restart the container if a \`[CRITICAL] Failed to initialize\` line names a worker — initialization failures are permanent for the process lifetime.`
6. Replace the final `<Aside type="caution">` text with: `If Redis becomes unreachable, \`/health\` stays 200 (the process is alive) but \`/health/ready\` and \`/ready\` return 503 for as long as Redis is down — no queue consumer can run without it, so the process is deliberately withheld from admission rather than admitted with degraded background work. Features that depend on Redis -- rate limiting, BullMQ job queues, and real-time pub/sub -- recover automatically when Redis returns.`

Then build the docs to catch MDX errors:

```bash
pnpm --filter @breeze/docs build 2>&1 | tail -15
```

Expected: build succeeds. If `@breeze/docs` has no installed dependencies in this worktree (the merged `pnpm install` should have covered it), report the exact error rather than skipping.

- [x] **Step 7: `deploy.sh` and tripwires**

```bash
bash -n scripts/prod/deploy.sh
grep -n "readiness_ok\|https://\${BREEZE_DOMAIN}/ready\|https://\${BREEZE_DOMAIN}/health" scripts/prod/deploy.sh
git diff --check
```

Expected: syntax OK; `readiness_ok` defined once and called twice; no `curl … /health` smoke line remains (`productionReadinessWiring.test.ts` already asserts this).

- [x] **Step 8: The plan-text name correction (spec §9) — conditional**

```bash
grep -rn "OFFLINE_WORKER_CONCURRENCY" docs/superpowers/plans/2026-08-24-s0-track-c-readiness-offline-scaling.md docs/ apps/api/src scripts/ .env.example deploy/.env.example
```

At plan-writing time the ONLY hit in the tree is the spec's own §9 sentence — the original plan already uses `OFFLINE_DETECTOR_WORKER_CONCURRENCY` (lines 39, 522). If the grep still finds no hit outside the spec, make no plan-text edit and state "no `OFFLINE_WORKER_CONCURRENCY` wording found in the plan; the code name is already used" in the commit message (see Open items #2). If a hit exists in the plan, replace it with `OFFLINE_DETECTOR_WORKER_CONCURRENCY`.

- [x] **Step 9: Commit**

```bash
git add apps/api/src/config/productionReadinessWiring.test.ts docker-compose.yml deploy/docker-compose.prod.yml .env.example deploy/.env.example \
  docs/operations/health-probes.md docs/deploy/worker-split.md apps/docs/src/content/docs/monitoring/health.mdx
# plus docs/superpowers/plans/2026-08-24-s0-track-c-readiness-offline-scaling.md only if Step 8 edited it
git commit -m "fix(ops): thread readiness and offline-sweep knobs through both stacks; document the worker probe

READINESS_CACHE_TTL_MS / READINESS_PROBE_TIMEOUT_MS added to the prod
x-api-env anchor and deploy/.env.example (they were inert on the
droplet); OFFLINE_DETECTOR_WORKER_CONCURRENCY documented and mapped in
both anchors (envComposeParity RED -> GREEN). D5: the worker service's
/health/ready healthcheck is pinned together with its zero-dependents
condition and deploy.sh's no---wait; health-probes.md, the worker-split
runbook, and the public health.mdx page describe the
PublicReadinessResponse body, the /ready alias, the worker container's
own probe, flag-gated optional consumers, and aggregate-only counts."
```

---

### Task 6: Webhook worker lifecycle tests (spec §8, five cases)

**Files:**
- Create: `apps/api/src/workers/webhookDelivery.lifecycle.test.ts`
- Not modified: `apps/api/src/workers/webhookDelivery.ts` (a temporary, reverted mutation is used as the RED control).

**Interfaces:**
- Consumes: `getWebhookWorker()` (singleton; NO attach at construction after Task 1), `initializeWebhookDelivery()` (attaches `'webhookDeliveryWorker'` then `start()`s), `configureWebhookFanout({ getWebhooksForEvent, createDeliveryRecord? })` + `handleWebhookFanoutEvent(event)`, the private `processNextJob()` reached the same way `webhookDelivery.claim.test.ts` does, `workerReadinessRegistry.snapshot()`.
- Produces: pins for (a) job-level failure → `failed` + consumer stays `running`; (b) connection failure → `error` + `redis_disconnected`; (c) `emit('error')` never throws on a bare instance (constructor listener); (d) attach happens in `initializeWebhookDelivery()` and an api-role fan-out declares/attaches nothing; (e) main's three suites unchanged.

- [x] **Step 1: Write the test file**

Each test gets a fresh module graph (`vi.resetModules()` + dynamic imports) because the singleton and the registry are module-level and `attach()` throws on a second attach of the same name.

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Track C's lifecycle mapping in processNextJob()'s outer catch, plus the
 * attach relocation the port made (spec section 2, C2), pinned:
 *  (a) a job-level failure on a healthy blocking connection is `failed` — the
 *      loop keeps running;
 *  (b) anything else is `error` — the registry treats it as a Redis disconnect
 *      until the next successful BRPOP re-emits `ready`;
 *  (c) emit('error') never throws on a bare instance: the constructor installs
 *      its own listener, so attach state is irrelevant;
 *  (d) the registry attach happens in initializeWebhookDelivery() — the only
 *      start path, reached only through the global registry entry — and an
 *      api-role fan-out that reaches getWebhookWorker() declares/attaches
 *      nothing.
 */
const brpopMock = vi.hoisted(() => vi.fn());
// Mutable so a test can flip the blocking connection's status. Never 'end':
// getBlockingRedis() would then create a fresh connection and the branch
// under test would see status 'ready' again.
const blockingConnection = vi.hoisted(() => ({
  brpop: (...args: unknown[]) => brpopMock(...args),
  status: 'ready' as string,
}));
const lpushMock = vi.hoisted(() => vi.fn(async () => 1));

vi.mock('../services/eventBus', () => ({ getEventBus: () => ({ subscribe: vi.fn() }), EVENT_TYPES: {} }));
vi.mock('../db', () => ({
  db: {},
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
  runOutsideDbContext: (fn: () => unknown) => fn(),
}));
vi.mock('../services/redis', () => ({
  createBlockingRedisConnection: () => blockingConnection,
  getRedisConnection: () => ({ lpush: lpushMock, lindex: vi.fn(), lrem: vi.fn(async () => 1) }),
}));
vi.mock('../services/urlSafety', () => ({ safeFetch: vi.fn(), SsrfBlockedError: class SsrfBlockedError extends Error {} }));
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));

const NAME = 'webhookDeliveryWorker';

async function load() {
  vi.resetModules();
  const mod = await import('./webhookDelivery');
  const { workerReadinessRegistry } = await import('../services/workerReadinessRegistry');
  return { ...mod, registry: workerReadinessRegistry };
}

/** One pump iteration; the outer catch sleeps 1 s, so fake timers drive it. */
async function processOnce(worker: unknown): Promise<void> {
  const pending = (worker as { processNextJob: () => Promise<void> }).processNextJob();
  await vi.advanceTimersByTimeAsync(1_000);
  await pending;
}

const EVENT = {
  id: 'event-1', type: 'device.created', orgId: 'org-1', source: 'test', priority: 'normal',
  payload: {}, metadata: { timestamp: '2026-09-01T12:00:00.000Z' },
};
const WEBHOOK = { id: 'webhook-1', orgId: 'org-1', name: 'hook', url: 'https://example.test/hook', events: ['*'] };

describe('webhook delivery worker lifecycle -> readiness registry', () => {
  let current: Awaited<ReturnType<typeof load>> | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    brpopMock.mockReset();
    // Default: a BRPOP that never returns, so a started loop parks instead of
    // spinning the microtask queue. Tests that pump directly override it.
    brpopMock.mockImplementation(() => new Promise(() => {}));
    blockingConnection.status = 'ready';
    lpushMock.mockClear();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    current?.getWebhookWorker().stop();
    current = null;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('(c) a bare instance has its own error listener, so emit(error) never throws and nothing is declared', async () => {
    current = await load();
    const worker = current.getWebhookWorker();
    expect(worker.listenerCount('error')).toBeGreaterThanOrEqual(1);
    expect(() => worker.emit('error', new Error('unattached'))).not.toThrow();
    expect(current.registry.snapshot()[NAME]).toBeUndefined();
  });

  it('(d) an api-role fan-out reaches getWebhookWorker() but declares and attaches nothing', async () => {
    current = await load();
    current.configureWebhookFanout({
      getWebhooksForEvent: async () => [WEBHOOK] as never,
      createDeliveryRecord: (async () => ({ created: true, deliveryId: 'delivery-1' })) as never,
    });
    await current.handleWebhookFanoutEvent(EVENT as never);
    expect(lpushMock).toHaveBeenCalledTimes(1);                  // the delivery was queued …
    expect(current.registry.snapshot()[NAME]).toBeUndefined();  // … without touching readiness
    expect(brpopMock).not.toHaveBeenCalled();                    // and without starting a drain loop
  });

  it('(d) initializeWebhookDelivery() is where the attach happens, and start() marks it running', async () => {
    current = await load();
    await current.initializeWebhookDelivery();
    expect(current.registry.snapshot()[NAME]).toMatchObject({ required: true, state: 'running', running: true, redisConnected: true });
    expect(brpopMock).toHaveBeenCalled();                        // the loop is parked on the never-resolving BRPOP
  });

  it('(a) a job-level failure on a ready connection emits failed and leaves the consumer running', async () => {
    current = await load();
    current.registry.expect(NAME, true);
    current.registry.attach(NAME, current.getWebhookWorker() as never);
    const worker = current.getWebhookWorker();
    brpopMock.mockResolvedValueOnce(null);               // timeout -> emit('ready') -> running
    await processOnce(worker);
    const failed = vi.fn();
    worker.once('failed', failed);
    brpopMock.mockResolvedValueOnce(['queue', '{not json']);   // JSON.parse throws inside the try
    await processOnce(worker);
    expect(failed).toHaveBeenCalledTimes(1);
    expect(current.registry.snapshot()[NAME]).toMatchObject({ state: 'running', running: true, lastErrorCode: 'SyntaxError' });
  });

  it('(b) a connection failure emits error, moves the consumer to redis_disconnected without throwing, and recovers on the next BRPOP', async () => {
    current = await load();
    current.registry.expect(NAME, true);
    current.registry.attach(NAME, current.getWebhookWorker() as never);
    const worker = current.getWebhookWorker();
    brpopMock.mockResolvedValueOnce(null);
    await processOnce(worker);                            // running
    const errored = vi.fn();
    worker.once('error', errored);
    blockingConnection.status = 'reconnecting';
    brpopMock.mockRejectedValueOnce(Object.assign(new Error('read ECONNRESET'), { name: 'RedisConnectionError' }));
    await expect(processOnce(worker)).resolves.toBeUndefined();
    expect(errored).toHaveBeenCalledTimes(1);
    expect(current.registry.snapshot()[NAME]).toMatchObject({ state: 'redis_disconnected', running: false, redisConnected: false, lastErrorCode: 'RedisConnectionError' });
    blockingConnection.status = 'ready';
    brpopMock.mockResolvedValueOnce(null);
    await processOnce(worker);
    expect(current.registry.snapshot()[NAME]).toMatchObject({ state: 'running', running: true });
  });
});
```

If `configureWebhookFanout`'s deps type or the fan-out's `createDeliveryRecord` outcome shape differs from the dedupe suite's usage (`webhookDelivery.dedupe.test.ts` lines ~85–130 are the template), copy that suite's exact shapes; never change production code to fit the test.

- [x] **Step 2: Run — expected GREEN — then prove (a)/(b)/(c)/(d) discriminate with reverted control mutations**

```bash
pnpm --filter @breeze/api exec vitest run src/workers/webhookDelivery.lifecycle.test.ts
```

Expected: ALL PASS (the behavior exists after Task 1; these tests are additive). Two control runs, each restored byte-for-byte before the next:

Control 1 — swap the two emits (breaks (a) and (b)):

```bash
sed -i.bak -e "s/this.emit('failed', undefined, err);/this.emit('error', err); \/\/ CONTROL/" -e "0,/^        this.emit('error', err);$/s//        this.emit('failed', undefined, err); \/\/ CONTROL/" apps/api/src/workers/webhookDelivery.ts
grep -c "CONTROL" apps/api/src/workers/webhookDelivery.ts        # exactly 2
pnpm --filter @breeze/api exec vitest run src/workers/webhookDelivery.lifecycle.test.ts 2>&1 | tail -20   # EXPECT: (a) and (b) FAIL
git checkout -- apps/api/src/workers/webhookDelivery.ts && rm -f apps/api/src/workers/webhookDelivery.ts.bak
```

Control 2 — move the attach back into the getter and drop the constructor listener (breaks (c) and both (d) tests): by hand, delete the `this.on('error', () => {});` line and move the `workerReadinessRegistry.attach(...)` call from `initializeWebhookDelivery()` into `getWebhookWorker()`'s `if (!workerInstance)` block; run the suite → EXPECT (c) and both (d) tests FAIL (the fan-out test sees a declared `required` consumer; the bare-instance test throws or finds a listener count of 1 only via the registry); then `git checkout -- apps/api/src/workers/webhookDelivery.ts`. If the sed in Control 1 does not produce exactly two `CONTROL` hits, do that swap by hand too.

```bash
git status --porcelain apps/api/src/workers/webhookDelivery.ts   # EMPTY after both controls
pnpm --filter @breeze/api exec vitest run src/workers/webhookDelivery.lifecycle.test.ts   # GREEN again
```

Record both control runs (failing test names) in the commit message.

- [x] **Step 3: (e) main's three suites + init suite unchanged**

```bash
pnpm --filter @breeze/api exec vitest run src/workers/webhookDelivery.test.ts src/workers/webhookDelivery.claim.test.ts src/workers/webhookDelivery.dedupe.test.ts src/services/webhookDeliveryInit.test.ts src/jobs/workerReadinessCoverage.test.ts
pnpm --filter @breeze/api exec eslint src/workers/webhookDelivery.lifecycle.test.ts
```

Expected: ALL PASS with no edits to those files.

- [x] **Step 4: Commit**

```bash
git add apps/api/src/workers/webhookDelivery.lifecycle.test.ts
git commit -m "test(api): pin the webhook delivery worker's readiness lifecycle and attach site

(a) job-level failure on a ready blocking connection -> failed, consumer
stays running; (b) connection failure -> error -> redis_disconnected,
recovering on the next successful BRPOP; (c) a bare instance never throws
on emit('error') and declares nothing; (d) the registry attach lives in
initializeWebhookDelivery() and an api-role fan-out through
getWebhookWorker() attaches nothing; (e) main's three suites unchanged.
Controls: swapping the emits failed (a)+(b); moving the attach back into
the getter failed (c)+(d); both restored -> GREEN."
```

---

### Task 7: PR-head battery, push, CI, PR body, handoff

**Files:** none modified in-repo except as required by battery findings (fix in the task that owns the file, as a follow-up commit). GitHub state: PR #4007 body, #4060 comment.

**Interfaces:**
- Consumes: everything above; `gh` CLI authenticated.
- Produces: a pushed head with `CI Success` green on the exact SHA and an updated PR body; hands off to the controller for the independent review and the merge (the merge itself is NOT a step of this plan).

- [ ] **Step 1: Tripwire greps (spec §10.1)**

```bash
cd /Users/toddhebebrand/breeze/.worktrees/s0-track-c-readiness
grep -n "workersHealthy:\|computeWorkersHealthy" apps/api/src/worker.ts apps/api/src/index.ts          # EMPTY
grep -c "const workerStatus" apps/api/src/index.ts                                                       # 1
grep -rn "initializeDeclaredWorkerGroup\|computeWorkersHealthy\|WorkersHealthyInput" apps/api/src        # EMPTY
for f in docker-compose.yml deploy/docker-compose.prod.yml; do
  awk '/^x-api-env:/{a=1} /^services:/{a=0} a && /READINESS_CACHE_TTL_MS:|READINESS_PROBE_TIMEOUT_MS:|OFFLINE_DETECTOR_WORKER_CONCURRENCY:/{n++} END{print FILENAME, n}' "$f"
done                                                                                                     # 3 each
grep -n "workerRegistry.ts'\|workerReadinessManifest.ts'\|src/index.ts'" apps/api/src/services/exchangeRateBoundary.test.ts   # 1, 1, 0
for f in changeLogRetention ipHistoryRetention reliabilityRetention staleCommandReaper tenantErasure ticketNotifyWorker \
         authBrowserTransitionCleanup orgMerge pamActuationWorker metricAnomalyIncidentPublisher ticketAttachmentReaper ticketOutboxPublisher; do
  printf '%s %s %s\n' "$f" "$(grep -c "from './workerObservability'" apps/api/src/jobs/$f.ts)" "$(grep -c 'attachWorkerObservability(' apps/api/src/jobs/$f.ts)"
done                                                                                                     # "1 2" for all twelve
grep -c "workerReadinessRegistry.attach(" apps/api/src/workers/webhookDelivery.ts                        # 1
awk '/^export function getWebhookWorker/{g=1} g&&/^}/{g=0} g&&/workerReadinessRegistry.attach/{print "ATTACH IN GETTER"} /^export async function initializeWebhookDelivery/{i=1} i&&/^}/{i=0} i&&/workerReadinessRegistry.attach/{print "attach in initializeWebhookDelivery: ok"}' apps/api/src/workers/webhookDelivery.ts   # only the "ok" line
grep -c "^    name: '" apps/api/src/services/workerRegistry.ts                                          # 115
git diff --stat <merge-sha>..HEAD -- apps/api/src/services/workerReadinessRegistry.ts apps/api/src/jobs/eventDispatchWorker.ts apps/api/src/services/workerRegistry.ts apps/api/migrations   # EMPTY
```

- [ ] **Step 2: Focused unit battery (spec §10.2)**

```bash
pnpm --filter @breeze/api exec vitest run \
  src/services/workerReadinessRegistry.test.ts src/jobs/workerReadinessManifest.test.ts src/jobs/workerReadinessCoverage.test.ts \
  src/jobs/workerObservability.test.ts src/config/readinessConfig.test.ts src/services/readiness.test.ts src/routes/readiness.test.ts \
  src/config/productionReadinessWiring.test.ts src/config/envComposeParity.test.ts src/services/exchangeRateBoundary.test.ts \
  src/services/workerRegistry.test.ts src/services/workerEntrypointClosure.contract.test.ts src/worker.boot.test.ts \
  src/index.pam-actuation-worker.test.ts src/db/dbPoolHealthWiring.test.ts src/services/eventLoopMonitorWiring.test.ts \
  src/workers/webhookDelivery.test.ts src/workers/webhookDelivery.claim.test.ts src/workers/webhookDelivery.dedupe.test.ts \
  src/workers/webhookDelivery.lifecycle.test.ts src/services/webhookDeliveryInit.test.ts \
  src/jobs/scheduleRegistry.contract.test.ts src/middleware/security.test.ts src/jobs/eventDispatchWorker.test.ts \
  src/jobs/changeLogRetention.test.ts src/jobs/ipHistoryRetention.test.ts src/jobs/reliabilityRetention.test.ts src/db/rowCount.test.ts \
  src/jobs/staleCommandReaper.test.ts src/jobs/tenantErasure.test.ts \
  src/jobs/ticketNotifyWorker.test.ts src/jobs/ticketNotifyWorker.leak.test.ts src/jobs/ticketNotifyWorker.graphFork.test.ts src/services/ticketPush.test.ts
pnpm --filter @breeze/api exec vitest run src/jobs/offlineDetector src/jobs/aiAgentRunner
```

Expected: ALL PASS.

- [ ] **Step 3: Typecheck, lint, full unit suite, compose, shell, whitespace (spec §10.3–§10.4)**

```bash
NODE_OPTIONS=--max-old-space-size=8192 pnpm --filter @breeze/api exec tsc --noEmit
pnpm --filter @breeze/api lint
pnpm --filter @breeze/api test 2>&1 | tail -15
docker compose -f docker-compose.yml config --quiet
docker compose -f docker-compose.yml -f docker-compose.override.yml.dev config --quiet
docker compose -f deploy/docker-compose.prod.yml config --quiet
docker compose -f docker-compose.yml --profile worker-split config --quiet
bash -n scripts/prod/deploy.sh
git diff --check <merge-sha>~1..HEAD
```

Expected: typecheck 0 errors; lint clean; full unit suite green (record the summary line); all compose configs valid; no whitespace errors. A lint finding in a file this port did not touch is reported, not fixed.

- [ ] **Step 4: Integration sanity (spec §10.5) — per-worktree stack ONLY**

```bash
docker ps --format '{{.Names}}' | grep -E 'breeze-(postgres|redis)-test$'   # informational: another worktree's stack — do NOT touch it
pnpm test-stack up
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/orgMergeRegistry.integration.test.ts \
  src/__tests__/integration/site-scope-coverage.integration.test.ts
pnpm test-stack down
```

Expected: both PASS (no schema/RLS/cascade surface changed; this is a regression sanity check against the merged tree). `pnpm test-stack down` also removes the generated `.env.test`; confirm `git status --porcelain` is empty afterwards.

- [ ] **Step 5: Push and confirm CI attached to the exact head**

```bash
git log --oneline <design-sha>..HEAD          # expect: merge + 5 follow-ups (+ any battery fix-ups)
git push origin fix/s0-readiness-offline-scaling
HEAD_SHA=$(git rev-parse HEAD); echo "$HEAD_SHA"
sleep 45; gh run list --branch fix/s0-readiness-offline-scaling --limit 6 --json headSha,name,status,conclusion,url | jq ".[] | select(.headSha==\"$HEAD_SHA\")"
```

Expected: at least one workflow run for `$HEAD_SHA`. A push can silently spawn zero runs; if so: `gh workflow run ci.yml --ref fix/s0-readiness-offline-scaling` and re-check. Then poll until `CI Success` is green on exactly `$HEAD_SHA`:

```bash
gh pr checks 4007 --watch
gh api repos/LanternOps/breeze/commits/$HEAD_SHA/check-runs --jq '.check_runs[] | select(.name=="CI Success") | {status, conclusion}'
```

- [ ] **Step 6: PR body and tracker**

Update #4007's body (`gh pr edit 4007 --body-file …`, preserving every existing evidence-boundary statement) with a "Current-main port" section citing: the spec path; `<merge-sha>` and the five follow-up SHAs; decisions D1–D5 (incl. D3a and D3b, and the C1/C2 review findings) in one line each; the recorded RED→GREEN checkpoints (manifest/coverage, role + flag tests, `worker.boot` fail-closed + redaction, envComposeParity, webhook lifecycle controls); the resolved counts (117 declared, 113 required on a default `all` box); and these three intentional compatibility notes verbatim: (1) `deploy.sh`'s admission gate now requires every consumer selected for the api container's role to attach (flag-gated consumers excluded) — stricter than the old `/health` smoke (spec §7); (2) `/health/ready` and `/ready` return `PublicReadinessResponse` (`ready/db/redis/workers/checkedAt/consumerSummary`), replacing the old `{ status, checks }` body — external parsers of the old body must update (spec §7); (3) a deployment running without Redis is no longer admitted (Track C's fail-closed rule, D3b). State the evidence non-claim: code-integration on `main` only; Task 5 exact-candidate evidence (RMM-QA-020/038) remains open.

Comment on #4060 (do not edit its table yet): port pushed at `$HEAD_SHA`, gates run, CI status, spec/plan paths.

- [ ] **Step 7: Handoff**

Hand back to the controller for the independent whole-branch review scoped to `<design-sha>..HEAD` (superpowers:requesting-code-review). Do NOT run `gh pr ready`, `gh pr merge`, or dispatch `drift-detector.yml` — the controller does those after the review.

---

## Self-review notes (spec coverage)

- §1 → Task 1 Steps 1–2, 10–11. §2 (incl. C2 attach relocation + constructor listener) → Task 1 Steps 3–6. §3 (loop after `captureException`, both out-of-registry blocks, env import merge) → Task 1 Step 7. §4 + §9 (`initializeDeclaredWorkerGroup`, computed counts, C1 noted) → Task 2 (C1's rule lands in Task 3 per §5). §5 (D3, D3a declare-time rules + optional marker, D3b) → Task 3 (+ PR note in Task 7). §6 (D4, static registry/config imports, dynamic manifest, mocks incl. `eventDispatchMode`/`AI_AGENTS_ENABLED`, redaction with three `not.toContain`, eventDispatch loop, `computeWorkersHealthy` + `WorkersHealthyInput` deletion, no `/ready` alias) → Task 4. §7 (D5 wording incl. no `--wait`, prod anchor append, `# NAME=` lines, root insert before the startup comment, `worker-split.md`, `health.mdx`) → Task 5. §8 (five cases) → Task 6. §10 (incl. the webhook attach tripwire) → Task 7.
- Names used across tasks: `consumersForInitializer`, `declareExpectedConsumers({ role, redisAvailable, abuseSignalsEnabled, eventDispatchEnabled, aiAgentsEnabled, registry })`, `ConsumerRequirementRule`, `optionalConsumers`, `summarizeConsumerReadiness`, `resolveReadinessTiming`, `fakeBullmqWorker`/`liveRegistry`/`getText` (test-local) — consistent between Tasks 2–6.

## Open items for the controller

1. **Base commit does not exist yet.** At plan time the worktree HEAD is `ece39ca5c` and the spec is untracked (`?? docs/superpowers/specs/2026-09-01-…`). Task 1 Step 1 assumes the "design commit on top of `ece39ca5c`" (spec + this plan) has been made. Commit both before dispatching Task 1, or tell the implementer to do so as Step 0.
2. **Spec §9's "plan's `OFFLINE_WORKER_CONCURRENCY` wording" does not exist in the plan.** The original Track C plan already uses `OFFLINE_DETECTOR_WORKER_CONCURRENCY` (lines 39, 522); the only occurrence of the wrong name in the tree is the spec's own §9 sentence. Task 5 Step 8 is therefore conditional (no plan edit expected). The spec sentence itself may deserve a one-word correction — this plan does not touch the spec.
3. **Counts are computed, resolved numbers recorded.** The tests derive the declared count from the registry (`115 + 2 − 5 + extras`) and the required set from the rules; the implementer records the resolved values (expected 117 declared; 116 required after Task 2 with abuse off; 113 on a default `all` box after Task 3) in commit messages and the PR body.
4. **Attach names of the six already-attached main modules** are assumed equal to their registry names (spec §4 says verified). The coverage test's RED output is the authority; the plan tells the implementer to prefer the attached name if they differ.
5. **Optional-marker semantics when the entry's rule is OFF** (spec silent): the plan declares `eventDispatchMaintenance` with `expect(name, false)` and never `disable()`s it (it constructs and attaches regardless of `EVENT_DISPATCH_MODE`, landing in `optionalRunning`), while `eventDispatch` itself gets `expect(false)` + `disable('feature_disabled')`. Confirm.
6. **`worker.boot.test.ts` mocks the manifest wholesale** (the spec allows either that or adding `selectWorkers`/`WORKER_REGISTRY` to the registry mock) and uses the real registry singleton; `AI_AGENTS_ENABLED` is mocked as the constant `false`. The boot-order test gains a `declareExpectedConsumers` entry between `registerAllEventSubscribers` and `startRegisteredWorkers`.
7. **Two "pin" tests pass on first run** (the `consumersForInitializer` source pin in Task 2 Step 6 and the worker-service/no-`--wait` rules in Task 5 Step 1). Discrimination is proved by grep, not by mutating production code. Task 6's additive tests use two reverted control mutations instead.
8. **Test (d) drives the fan-out with the dedupe suite's shapes** (`configureWebhookFanout({ getWebhooksForEvent, createDeliveryRecord })`, `createDeliveryRecord` → `{ created: true, deliveryId }`); if main's `handleWebhookFanoutEvent` needs more of the deps than the dedupe suite supplies, the implementer copies that suite's exact usage.
9. **The relocated attach throws on a second `initializeWebhookDelivery()` call in one process** (registry duplicate-attach rule). Production calls it once via the registry entry; `webhookDeliveryInit.test.ts` mocks the whole worker module, so it is unaffected. A future double-init would surface as `onResult(false)` → `failed`, which is the correct fail-closed outcome. Noted, not guarded.
10. **Six hooked modules' own suites** may mock `bullmq.Worker` without `.on`; the plan says extend the mock (test-only) rather than guard the hook. Confirm that is acceptable.
11. **`health.mdx` example counts** (113/112, `optionalDisabled: 3`) are illustrative and labelled so; the page's pre-existing "API start period 10s" row is stale vs compose's 40s but is not this port's obligation and is left alone.
12. **`deploy/docker-compose.prod.yml config --quiet`** may need placeholder values for `:?`-required vars; the plan says to reuse whatever invocation the Track C branch used for its own Task 3 gate and to record it.
13. **`pnpm --filter @breeze/docs build`** is the MDX gate in Task 5; if the docs package's dependencies are not present after the frozen install, the implementer reports the error rather than skipping. There is no in-repo test on `health.mdx`.
14. **Typecheck stays RED from the merge commit through Task 3** by design; the pre-commit hook does not typecheck (verified: only confidential scan + migration naming), so hooks-on commits land. Task 4's gate is the first green typecheck.
15. **Task 1 inert loops:** at the merge commit `consumersForInitializer('eventDispatch'|'agentCommandRelay')` returns `[]` (no manifest rows yet), so the two out-of-registry loops are no-ops until Task 2 adds the rows. The code shape is what the merge commit fixes; the behavior is pinned by Task 2's source pin and Task 4's eventDispatch failure test.
