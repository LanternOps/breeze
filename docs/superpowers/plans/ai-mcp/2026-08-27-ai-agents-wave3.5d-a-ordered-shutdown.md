---
tracking_issue: LanternOps/breeze#3821
wave: W10 (#4086) — Part A (prerequisite PR)
---

# Wave 3.5d Part A — Ordered Shutdown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make graceful shutdown actually ordered — sequential phases with bounded time, concurrency only WITHIN a phase — and stop `EventBus.close()` from quitting the shared Redis singleton mid-drain. Prerequisite PR for the BREEZE_ROLE split (#4086): the worker container makes clean SIGTERM handling load-bearing (every deploy restarts it).

**Architecture:** Extract a small, unit-testable phase runner (`runShutdownPhases`) that executes named phases sequentially, runs each phase's tasks via `Promise.allSettled` with a per-phase bounded timeout, and reports failures without aborting later phases (Redis/DB must still close after a stuck worker). `index.ts` partitions its existing ~95 `shutdownTasks` function refs into phases matching the array's already-written comment ordering. `EventBus.close()` stops calling `.quit()` on the borrowed `getRedisConnection()` singleton — `closeRedis()` is the sole owner of that quit. The three workers that leak BullMQ handles on shutdown (ticketMailboxPoll, unifi, unifiTelemetry) gain standard `shutdown*` exports. A second signal after shutdown has begun force-exits deterministically instead of falling to Node's default kill.

**Tech Stack:** TypeScript, Vitest (unit only — no integration/migration surface). **No migrations, no env vars, no compose changes.**

**Design authority:** #4086 + advisor quorum 2026-08-27 (both advisors: ship this as its own PR before the split). Verified defects this fixes: `Promise.allSettled(shutdownTasks.map(t => t()))` at `index.ts:1778` runs ALL tasks concurrently — the array's careful ordering is an illusion; `EventBus.close()` (`eventBus.ts:209-214`) quits the shared module-singleton BullMQ connection (`getRedisConnection()`) that every Worker/Queue shares, while their own closes are mid-drain, and `closeRedis()` then quits it again; `process.once` handlers mean a second SIGTERM hits Node's default handler; three workers have initializers but no shutdown exports. **Do not relitigate:** no global BullMQ `pause()` (would pause the other process's consumption too — `Worker.close()` is the local stop+drain); phase timeout continues to later phases, never aborts them.

## Global Constraints

- Run single test files as `cd apps/api && npx vitest run <path>` (never `pnpm --filter ... test -- --run <path>`).
- Repo shutdown convention (mirror exactly): `await handle.close()` with no `force` arg, null-check before, null out after — see `shutdownEventDispatchWorker` (`jobs/eventDispatchWorker.ts:919-932`).
- `shutdownRuntime` and `installSignalHandlers` are module-private closures in `index.ts` (NOT exported, zero existing tests). The phase runner is extracted precisely so ordering logic is testable without booting `index.ts`.
- Behavior contracts that must survive: exit code 0 on clean shutdown, 1 when any task failed (`index.ts:1778-1789`); the HTTP-close-before-teardown ordering and its comment (`index.ts:1755-1777` — heartbeat-mid-shutdown wedge); `closeRedis()`'s swallow-EPIPE semantics (`redis.ts:157-187`) unchanged.
- Commit after every task with the trailers:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_012o7QB15EFjEvetDAXMxmae`

## File Structure

| File | Responsibility |
|---|---|
| `apps/api/src/services/shutdownPhases.ts` (new) | `runShutdownPhases()` — sequential named phases, allSettled + bounded timeout within each, failure report. |
| `apps/api/src/services/shutdownPhases.test.ts` (new) | Order, phase barrier, failure isolation, timeout-continues, empty-phase tolerance. |
| `apps/api/src/services/eventBus.ts` (modify) | `close()` releases its reference without quitting the shared connection. |
| `apps/api/src/jobs/ticketMailboxPollWorker.ts`, `jobs/unifiWorker.ts`, `jobs/unifiTelemetryWorker.ts` (modify) | Standard `shutdown*` exports. |
| `apps/api/src/index.ts` (modify) | shutdownTasks → named phases via the runner; second-signal force-exit. |

---

### Task 1: Shutdown exports for the three orphan workers

**Files:**
- Modify: `apps/api/src/jobs/ticketMailboxPollWorker.ts` (module handles `queue`/`worker`, init at :98-128), `apps/api/src/jobs/unifiWorker.ts` (handle `unifiWorker`, init :195-207; queue via `getUnifiSyncQueue()` :35), `apps/api/src/jobs/unifiTelemetryWorker.ts` (handle `workerInstance`, init :80-90; queue via `getUnifiTelemetryQueue()` :11)
- Modify: `apps/api/src/index.ts` — add the three new functions to the shutdownTasks list next to their subsystem neighbors (same comment style)
- Test: co-located `*.test.ts` for each (extend existing files if present, else create)

**Interfaces:**
- Produces: `shutdownTicketMailboxPollWorker(): Promise<void>`, `shutdownUnifiWorker(): Promise<void>`, `shutdownUnifiTelemetryWorker(): Promise<void>`.

- [x] **Step 1: Write the failing tests** — for each module, mock `bullmq` (Worker/Queue classes with `close: vi.fn()`) and `../services/redis`; assert: after `initialize*()` then `shutdown*()`, every created Worker/Queue handle got exactly one `close()` call; a second `shutdown*()` call is a no-op (handles nulled); `shutdown*()` before `initialize*()` resolves without throwing. For `unifiWorker`, the queue is created lazily via `getUnifiSyncQueue()` — shutdown must close it only if it was created (peek the module's lazy handle by calling the getter in the test's arrange step for the created-case).
- [x] **Step 2: Run to verify failure** (functions don't exist).
- [x] **Step 3: Implement** — mirror `shutdownEventDispatchWorker` exactly:

```ts
// ticketMailboxPollWorker.ts
export async function shutdownTicketMailboxPollWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
  if (queue) {
    await queue.close();
    queue = null;
  }
}
```

`unifiWorker.ts`: close `unifiWorker` (null-check/null-out) and the lazy sync queue — add a module-level `let syncQueue` capture inside `getUnifiSyncQueue()` if the current implementation constructs it inline, so shutdown can reach it. `unifiTelemetryWorker.ts`: close `workerInstance` and the lazy telemetry queue the same way.

- [x] **Step 4: Wire into `index.ts` shutdownTasks** (three bare function refs, placed with their subsystems), run the three test files → PASS, typecheck. Commit: `fix(api): shutdown exports for ticket-mailbox, unifi, unifi-telemetry workers (#4086)`

---

### Task 2: `EventBus.close()` must not quit the shared connection

**Files:**
- Modify: `apps/api/src/services/eventBus.ts:209-214`
- Test: extend the eventBus test file (find: `ls apps/api/src/services/eventBus*.test.ts`)

- [x] **Step 1: Write the failing test** — mock `./redis`'s `getRedisConnection` to return a spy client `{ quit: vi.fn(), status: 'ready', xadd: vi.fn(), publish: vi.fn() }`; drive the bus so `getOrCreateRedis()` runs (publish an event or call close after a publish); assert `close()` does NOT call `quit()` on it, and that after `close()` a subsequent publish re-acquires via `getRedisConnection()` (the nulled reference is re-fetched — `getOrCreateRedis()` at eventBus.ts:198-203 already handles this).
- [x] **Step 2: Run to verify failure** (current code quits).
- [x] **Step 3: Implement**:

```ts
  /**
   * Release this bus's reference to the shared Redis connection.
   *
   * Deliberately does NOT call `.quit()`: `getOrCreateRedis()` borrows the
   * module-singleton BullMQ connection (`getRedisConnection()`), which every
   * BullMQ Worker/Queue in the process shares. Quitting it here tore the
   * connection out from under consumers still draining in the same shutdown
   * pass — `closeRedis()` is the sole owner of that quit (wave 3.5d-a, #4086).
   */
  async close(): Promise<void> {
    this.redisClient = null;
  }
```

- [x] **Step 4: Run the eventBus tests + typecheck** → PASS. Commit: `fix(api): EventBus.close() no longer quits the shared BullMQ connection (#4086)`

---

### Task 3: The phase runner — `shutdownPhases.ts`

**Files:**
- Create: `apps/api/src/services/shutdownPhases.ts`, `apps/api/src/services/shutdownPhases.test.ts`

**Interfaces:**
- Produces:
  - `interface ShutdownPhase { name: string; tasks: Array<() => Promise<void> | void>; timeoutMs?: number }`
  - `interface ShutdownReport { failures: Array<{ phase: string; index: number; error: unknown }>; timedOutPhases: string[] }`
  - `runShutdownPhases(phases: ShutdownPhase[], opts?: { defaultTimeoutMs?: number; log?: (msg: string) => void }): Promise<ShutdownReport>`

**Semantics (the tests pin all of these):** phases run strictly sequentially; a phase's tasks all start together and the phase waits for `Promise.allSettled` of them, raced against its timeout (default `defaultTimeoutMs`, default 20_000); on timeout the runner logs, records the phase in `timedOutPhases`, and PROCEEDS to the next phase (a stuck worker must never prevent Redis/DB close — but note the straggler keeps running detached; its eventual rejection is captured, never unhandled); task rejections are recorded per task with phase + index and never abort anything; a task that throws synchronously is captured identically; empty phases are skipped silently.

- [x] **Step 1: Write the failing tests** — use fake timers where the timeout cases need them:
  1. Order: tasks push to a log; phase B's tasks never start before every phase-A task settled.
  2. Concurrency within a phase: two tasks in one phase both start before either resolves (start-log asserted before resolution).
  3. Failure isolation: task 0 rejects, task 1 resolves — report lists one failure `{phase, index: 0}`, phase B still runs.
  4. Timeout: a never-resolving task in phase A (timeoutMs 50) — phase B runs, `timedOutPhases: ['A']`; when the straggler later rejects, no unhandled rejection (attach the allSettled handler before racing).
  5. Sync throw captured.
  6. Empty phase skipped.
- [x] **Step 2: Run to verify failure.**
- [x] **Step 3: Implement** (~50 lines):

```ts
export async function runShutdownPhases(
  phases: ShutdownPhase[],
  opts: { defaultTimeoutMs?: number; log?: (msg: string) => void } = {},
): Promise<ShutdownReport> {
  const log = opts.log ?? ((msg) => console.log(msg));
  const defaultTimeoutMs = opts.defaultTimeoutMs ?? 20_000;
  const report: ShutdownReport = { failures: [], timedOutPhases: [] };

  for (const phase of phases) {
    if (phase.tasks.length === 0) continue;
    log(`[shutdown] phase ${phase.name} (${phase.tasks.length} task(s))`);
    // Start all tasks and attach the settlement handler FIRST, so a straggler
    // that rejects after a phase timeout is already handled (no unhandled
    // rejection from a detached phase).
    const settled = Promise.allSettled(
      phase.tasks.map(async (task) => task()),
    ).then((results) => {
      results.forEach((result, index) => {
        if (result.status === 'rejected') {
          report.failures.push({ phase: phase.name, index, error: result.reason });
        }
      });
    });
    const timeoutMs = phase.timeoutMs ?? defaultTimeoutMs;
    let timer: NodeJS.Timeout | undefined;
    const timedOut = await Promise.race([
      settled.then(() => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), timeoutMs);
        timer.unref?.();
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (timedOut) {
      report.timedOutPhases.push(phase.name);
      log(`[shutdown] phase ${phase.name} timed out after ${timeoutMs}ms — continuing`);
    }
  }
  return report;
}
```

- [x] **Step 4: Run tests + typecheck** → PASS. Commit: `feat(api): sequential shutdown phase runner (#4086)`

---

### Task 4: Wire `index.ts` onto phases + second-signal force-exit

**Files:**
- Modify: `apps/api/src/index.ts` — `shutdownRuntime` (:1605-1789) and `installSignalHandlers` (:1791-1799)

**Interfaces:**
- Consumes: `runShutdownPhases` (Task 3), the three Task 1 exports.

- [x] **Step 1: Partition the existing shutdownTasks array into phases**, preserving every entry and every comment, in the array's existing relative order. The preamble (webhook worker stop, monitors, audit interval clear) and the HTTP-close block (:1755-1777) stay exactly where they are, BEFORE the phases. Phase membership:

```ts
  const report = await runShutdownPhases([
    // 1. Final local drains that need DB/Redis still up.
    { name: 'drain', tasks: [boundedAuditDrainTask] },
    // 2. Every worker/consumer close — concurrent, as today, but now
    //    guaranteed to fully settle before shared infrastructure goes away.
    { name: 'workers', tasks: [/* the ~90 shutdown* refs, unchanged order */] },
    // 3. Producer queues + dispatchers (they enqueue INTO Redis; workers are gone).
    { name: 'queues', tasks: [shutdownEventDispatcher, shutdownEventDispatchWorker, shutdownEventDispatchQueue, shutdownAgentCommandRelayWorker] },
    // 4. Event bus releases its borrowed connection reference (no quit — Task 2).
    { name: 'eventbus', tasks: [async () => getEventBus().close()] },
    // 5. The ONLY owner of the Redis quits.
    { name: 'redis', tasks: [closeRedis] },
    // 6. DB pool.
    { name: 'db', tasks: [dbCloseTask] },
    // 7. Sentry flush (bounded internally at 2s).
    { name: 'sentry', tasks: [() => flushSentry()], timeoutMs: 5_000 },
  ]);
  const failed = report.failures.length > 0;
  if (failed) {
    console.error(`[shutdown] Completed with ${report.failures.length} failure(s)`);
  } else {
    console.log('[shutdown] Complete');
  }
  process.exit(failed ? 1 : 0);
```

Note: `shutdownEventDispatchWorker` currently sits with the queue/dispatcher cluster in the existing array tail (:1743-1747) — keep the cluster together in `queues`. Timed-out phases alone do NOT flip the exit code (their real failures, if any, land in `failures` when the straggler settles — usually after exit; acceptable, matches today's "failures we saw" semantics).

- [x] **Step 2: Second-signal force-exit** in `installSignalHandlers`:

```ts
function installSignalHandlers(): void {
  const onSignal = (signal: NodeJS.Signals) => {
    // Second signal while a graceful shutdown is running: operator (or
    // orchestrator) wants out NOW. Deterministic force-exit beats Node's
    // default handler ambiguity.
    process.once(signal, () => {
      console.error(`[shutdown] Second ${signal} — forcing exit`);
      process.exit(130);
    });
    void shutdownRuntime(signal);
  };
  process.once('SIGINT', () => onSignal('SIGINT'));
  process.once('SIGTERM', () => onSignal('SIGTERM'));
}
```

- [x] **Step 3: Typecheck + run the full unit suite** (`cd apps/api && npx vitest run`) — the suite must be as green as on the base commit (report exact totals). Manual smoke: `grep -c 'shutdown' src/index.ts` sanity, and verify no shutdownTasks entry was dropped — `git diff` must show every removed array entry reappearing in exactly one phase (reviewer will diff-count them: state the count in the commit body).
- [x] **Step 4: Commit** — `refactor(api): shutdown runs in ordered phases; second signal force-exits (#4086)` with the entry count in the body.

---

### Task 5: Verification + PR

- [x] Full unit suite + typecheck (heap bump if tsc OOMs: `NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit`).
- [x] Tick this plan's checkboxes, commit.
- [ ] Open PR: branch `feature/3821-ai-agents/wave-4086-shutdown` → `main`. Body: "Part A (prerequisite) of #4086 — do NOT close the issue" (no `Closes`), the two verified defects (concurrent allSettled ordering illusion; EventBus quitting the shared connection), phase semantics (sequential, bounded, continue-past-timeout), and the exit-code contract. **Stop after opening the PR.**

## Self-Review Notes

- Scope deliberately excludes: worker registry, entrypoints, readiness, compose — all Part B. No behavior change to any individual `shutdown*` function; only ordering, the eventBus quit removal, and the three new exports.
- Type consistency: `ShutdownPhase`/`ShutdownReport` defined once (Task 3), consumed in Task 4.
- Known accepted semantics: a phase timeout detaches stragglers (they keep running until exit); failures recorded after `process.exit` are lost — same as today.
