/**
 * fixWatchWorker — the `fix-watch` BullMQ queue: producer (`scheduleFixWatch`)
 * and two-phase delayed consumer (AI agents wave 6 PR 2, Task 3, #3828).
 *
 * `services/aiAgents/fixWatch.ts` owns every DB read/write (row creation,
 * both phase checks, the recurrence notify/alert) and is deliberately
 * BullMQ-free — see that module's header. This file owns the OPPOSITE half:
 * the Queue/Worker plumbing and the delay/re-enqueue decisions, calling back
 * into `fixWatch.ts`'s pure phase functions. `scheduleFixWatch` lives HERE,
 * not in `fixWatch.ts`, for the same reason `enqueueAgentNotifyRetry` lives
 * in this file's sibling `agentNotifyRetryWorker.ts` rather than in
 * `runFinishedNotify.ts`: it needs both the DB write AND the enqueue call,
 * and putting both halves in `fixWatch.ts` would force that module to import
 * this one, while this file already has to import `fixWatch.ts` for the
 * phase-check bodies — a real cycle. `runLoop.ts`'s `finishRun` imports
 * `scheduleFixWatch` straight from here, same pattern as its existing
 * `enqueueAgentNotifyRetry` import from `agentNotifyRetryWorker.ts` (see that
 * import's comment): BullMQ-touching but harmless, because the Queue is
 * constructed lazily (no eager Redis connect at import time) and this module
 * does not import `runLoop.ts` back.
 *
 * A THIRD job variant rides the same queue and job name (P2-5, #4192):
 * `{ phase: 'recover' }`, a 2-minute repeatable that re-enqueues phase 1 for
 * any watch stranded in `pending`. Two things strand one, and the sweep
 * covers both:
 *   1. a LOST ENQUEUE — a watch row commits inside a DB transaction and its
 *      job is added only AFTER that transaction closes (`bullmqQueue.ts`'s
 *      #1105 tripwire forbids enqueueing inside a held context), so a crash
 *      or a Redis blip in between leaves a durable row with no job over it;
 *   2. a phase-1 job that EXHAUSTED its `attempts` (e.g. the DB was down for
 *      the whole backoff window) and now sits terminally in the failed set.
 * Only (1) is fixed by a plain re-`add()`. For (2) the job's Redis key still
 * exists, and BullMQ's `addStandardJob` returns via `handleDuplicatedJob`
 * whenever the jobId key EXISTS (verified in bullmq 5.81.2's
 * `commands/addStandardJob-9.lua`), so a re-add would be a silent no-op that
 * the sweep would nonetheless report as a repair — hence
 * `reviveStrandedPhase1` removes a terminal job before re-adding, and counts
 * only the ids that actually produced a new one. Reusing this queue keeps
 * the sweep out of `workerRegistry.ts` entirely, and 2 minutes is far below
 * `COARSE_REPEAT_INTERVAL_MS` so it needs no `scheduleRegistry` slot.
 *
 * Two delayed phases per watch, `fix-watch-p1-<id>` / `fix-watch-p2-<id>`
 * jobIds (Global Constraints) — the `patchJobExecutor.ts` stable-jobId
 * idempotency pattern the plan calls out, so `scheduleFixWatch` (a fresh
 * `add()` call from OUTSIDE any job processor) never double-schedules a
 * watch that already has one in flight. Phase 1 self-reschedules every 5
 * minutes until the triggering alert resolves, is dismissed, or
 * `RECOVERY_TIMEOUT_HOURS` passes; phase 2 fires once, `FIX_HOLD_MINUTES`
 * after observed recovery, and is always terminal.
 *
 * The phase-1 "still pending, check again in 5 minutes" case does NOT
 * re-`add()` a fresh job under the same `fix-watch-p1-<id>` — that jobId's
 * Redis key still exists (the job is `active`, still inside THIS processor
 * call), so BullMQ's own `handleDuplicatedJob` would treat a second `add()`
 * with the identical id as a no-op and silently drop the reschedule,
 * stranding the watch in `pending` forever. Instead it calls the currently
 * active job's own `job.moveToDelayed(timestamp, token)` and throws
 * `DelayedError` — BullMQ's documented mechanism for a processor to
 * re-delay itself under the SAME jobId/lock without going through
 * `queue.add()` at all (`worker.js`'s `handleFailed` special-cases
 * `DelayedError` so it is never counted as a failed attempt).
 */
import { DelayedError, Queue, Worker, type Job } from 'bullmq';
import { createInstrumentedQueue } from '../services/bullmqQueue';
import { getBullMQConnection } from '../services/redis';
import { captureException } from '../services/sentry';
import { assertQueueJobName, parseQueueJobData } from '../services/bullmqValidation';
import { attachWorkerObservability } from './workerObservability';
import {
  checkFixWatchPhase1,
  checkFixWatchPhase2,
  createFixWatchRow,
  FIX_HOLD_MINUTES,
  listPendingWatchesForRecovery,
  STRANDED_WATCH_SWEEP_PAGE,
  type FinishedRunForWatch,
  type FixWatchOutcomeInput,
  type PendingWatchCursor,
} from '../services/aiAgents/fixWatch';
import { fixWatchQueueJobDataSchema, type FixWatchQueueJobData } from './queueSchemas';

export const FIX_WATCH_QUEUE = 'fix-watch';
export const FIX_WATCH_JOB_NAME = 'check-fix-watch';

const PHASE1_RECHECK_DELAY_MS = 5 * 60_000;
const PHASE2_DELAY_MS = FIX_HOLD_MINUTES * 60_000;

/**
 * How long a watch may sit `pending` before the recovery sweep assumes its
 * phase-1 job was lost and re-adds it (P2-5, #4192). Comfortably longer than
 * a commit-to-enqueue window and far shorter than the phase-1 recheck
 * cadence, so a re-add is only ever a no-op or a genuine repair.
 */
export const PENDING_RECOVERY_MS = 2 * 60 * 1000;

/** Stable, so re-registering the sweep on every boot replaces rather than
 *  duplicates it. '-' separator only (#1101). */
const FIX_WATCH_RECOVER_JOB_ID = 'fix-watch-recover';

/** '-' separator only (repo rule, #1101) — never ':'. */
export function getFixWatchPhase1JobId(watchId: string): string {
  return `fix-watch-p1-${watchId}`;
}
export function getFixWatchPhase2JobId(watchId: string): string {
  return `fix-watch-p2-${watchId}`;
}

let fixWatchQueue: Queue<FixWatchQueueJobData> | null = null;

function getFixWatchQueue(): Queue<FixWatchQueueJobData> {
  if (!fixWatchQueue) {
    fixWatchQueue = createInstrumentedQueue<FixWatchQueueJobData>(FIX_WATCH_QUEUE);
  }
  return fixWatchQueue;
}

/**
 * Enqueues a phase check. THROWS on failure — deliberately, unlike the rest
 * of this module's best-effort style. Callers decide whether to swallow it:
 *  - `scheduleFixWatch` (the initial phase-1 schedule) catches and logs —
 *    there is no durable retry lane for a missed watch (see its own doc).
 *  - `processFixWatchJob`'s phase-1 -> phase-2 handoff does NOT catch, so a
 *    failure here fails the BullMQ job and lets `attempts`/`backoff` below
 *    retry it (review fix, #3828) — previously this was swallowed here,
 *    which stranded the watch in `watching` forever with no sweeper over it,
 *    since a redelivered phase-1 job used to read `state !== 'pending'` and
 *    bail as `not_found`. `checkFixWatchPhase1` now treats an already-
 *    `watching` row with `recoveryObservedAt` set as idempotently
 *    `'recovered'` again, so the retry re-runs (and this time hopefully
 *    succeeds at) exactly this enqueue call, under the same stable
 *    `fix-watch-p2-<id>` jobId — never a duplicate phase-2 job.
 */
async function enqueueFixWatchCheck(
  phase: 'phase1' | 'phase2',
  watchId: string,
  delayMs: number,
): Promise<void> {
  const jobId = phase === 'phase1' ? getFixWatchPhase1JobId(watchId) : getFixWatchPhase2JobId(watchId);
  await getFixWatchQueue().add(
    FIX_WATCH_JOB_NAME,
    { phase, watchId } satisfies FixWatchQueueJobData,
    {
      jobId,
      delay: delayMs,
      // Same shape as the sibling `agentNotifyRetryWorker.ts`. Safe for
      // phase 1's own 5-minute self-re-delay too: `worker.js` special-cases
      // `DelayedError` before `moveToFailed`, and `job.moveToDelayed` passes
      // `skipAttempt: true`, so that path never consumes an attempt here.
      attempts: 5,
      backoff: { type: 'exponential', delay: 30_000 },
      removeOnComplete: { count: 500 },
      removeOnFail: { count: 500 },
    },
  );
}

/**
 * Called from `runLoop.ts`'s `finishRun`, best-effort and never affecting the
 * run's own status (the plan's Task 3 spec) — a scheduling failure here is
 * logged and swallowed, exactly like `deliverRunFinishedNotifications`'s
 * failure path does NOT apply here: unlike the notify body, there is no
 * durable retry lane for a missed watch — a run that was eligible for a
 * watch but never got one just has no watch, the same as a run that was
 * never eligible in the first place. `createFixWatchRow` itself re-checks
 * eligibility, so this is safe to call unconditionally for every finished
 * run.
 */
export async function scheduleFixWatch(
  run: FinishedRunForWatch,
  outcome: FixWatchOutcomeInput,
): Promise<string | null> {
  let watchId: string | null = null;
  try {
    watchId = await createFixWatchRow(run, outcome);
  } catch (error) {
    console.error('[fixWatchWorker] failed to create a fix-held watch row (non-fatal)', {
      runId: run.id, error,
    });
    captureException(error instanceof Error ? error : new Error(String(error)));
    return null;
  }
  if (!watchId) return null;

  try {
    await enqueueFixWatchPhase1(watchId);
  } catch (error) {
    console.error('[fixWatchWorker] failed to enqueue phase 1 — the row is committed, the sweep will recover it', {
      runId: run.id, watchId, error,
    });
    captureException(error instanceof Error ? error : new Error(String(error)));
  }
  // The id, NOT null, even when the enqueue above failed. The row is durably
  // committed and `recoverStrandedFixWatches` re-adds its job within
  // PENDING_RECOVERY_MS, so a watch WILL render a verdict on this run.
  // `finishRun` (Task 6) reads null as "no watch will ever verify this run"
  // and immediately credits every execution `verified` — an immutable ledger
  // row that a later `recurred` from the recovered watch could not retract.
  // Null therefore means exactly one thing here: no watch row exists.
  return watchId;
}

/**
 * The initial phase-1 schedule for a watch row someone else has already
 * committed — `intentReleaseWorker.ts`, which writes its intent-anchored
 * watch INSIDE the terminal CAS's transaction and so cannot enqueue until
 * that transaction closes (`bullmqQueue.ts`'s #1105 held-context tripwire).
 * Throws on failure, like `enqueueFixWatchCheck`: the release worker swallows
 * it (the row is committed; the sweep recovers it) rather than failing an
 * already-executed action.
 */
export async function enqueueFixWatchPhase1(watchId: string): Promise<void> {
  await enqueueFixWatchCheck('phase1', watchId, PHASE1_RECHECK_DELAY_MS);
}

/**
 * Job states from which a phase-1 job will still run on its own. Everything
 * else — `completed`, `failed`, or no job at all — means nothing is left to
 * move the watch out of `pending`.
 */
const LIVE_PHASE1_JOB_STATES: ReadonlySet<string> = new Set([
  'delayed', 'waiting', 'waiting-children', 'prioritized', 'active',
]);

/**
 * Reconciles ONE candidate watch against Redis, and returns whether it
 * actually needed (and got) a new phase-1 job.
 *
 * The DB cannot tell a stranded `pending` watch from a healthy one — a
 * healthy watch stays `pending` for up to `RECOVERY_TIMEOUT_HOURS` while
 * phase 1 self-re-delays every 5 minutes — so this is where the sweep
 * discriminates. One `getJobState` round trip settles the common case.
 *
 * A terminal (`failed`/`completed`) job is REMOVED before the re-add: its
 * Redis key still exists, and `add()` under an existing jobId returns via
 * BullMQ's `handleDuplicatedJob` without queueing anything, so re-adding
 * over it would silently do nothing while looking like a repair. `remove()`
 * is safe here precisely because a terminal job holds no lock — the one
 * state that does, `active`, is in the live set above and returns early.
 */
async function reviveStrandedPhase1(watchId: string): Promise<boolean> {
  const queue = getFixWatchQueue();
  const jobId = getFixWatchPhase1JobId(watchId);

  const state = await queue.getJobState(jobId);
  if (LIVE_PHASE1_JOB_STATES.has(state)) return false;

  // 'completed' / 'failed' (or an orphaned key BullMQ reports as 'unknown'):
  // clear the key so the re-add below is a real enqueue rather than a no-op.
  const existing = await queue.getJob(jobId);
  if (existing) await existing.remove();

  await enqueueFixWatchPhase1(watchId);
  return true;
}

/** DB pages one sweep tick will read before deferring the rest to the next
 *  tick. Bounds the tick's cost without EVER capping recovery at a fixed
 *  oldest-N slice: `recoveryCursor` below resumes exactly where this stopped,
 *  so a pending set larger than the budget is still walked end to end, just
 *  across several ticks. */
const STRANDED_WATCH_SWEEP_MAX_PAGES = 25;

/**
 * Where the previous tick stopped when it hit its page budget, so the next
 * tick resumes there instead of re-probing the same oldest rows forever.
 * Cleared the moment a pass reaches the end of the pending set (the common
 * case by far) and on shutdown, so a fresh process always starts oldest-first.
 * Per-process, deliberately: with several consumers on this queue a tick may
 * land on a worker holding a different cursor, which costs a repeated page,
 * never a missed one — every cursor still walks to the end and resets.
 */
let recoveryCursor: PendingWatchCursor | null = null;

/**
 * Re-enqueues phase 1 for every watch stranded in `pending` — see the module
 * header for the two ways that happens. Returns how many watches actually
 * got a NEW job, which is a repair count, not a candidate count: healthy
 * watches (the overwhelming majority of any `pending` page) are skipped by
 * `reviveStrandedPhase1`'s Redis probe and never counted or logged.
 *
 * A failure PROPAGATES: this runs as a BullMQ job, so its own
 * attempts/backoff (and the next 2-minute tick) are the retry lane — and the
 * only realistic failure, Redis being unreachable, would fail every id in the
 * batch identically.
 */
export async function recoverStrandedFixWatches(): Promise<number> {
  let cursor = recoveryCursor;
  let pages = 0;
  let scanned = 0;
  let repaired = 0;

  for (;;) {
    const page = await listPendingWatchesForRecovery(PENDING_RECOVERY_MS, cursor);
    for (const row of page) {
      scanned += 1;
      if (await reviveStrandedPhase1(row.id)) repaired += 1;
    }
    pages += 1;

    if (page.length < STRANDED_WATCH_SWEEP_PAGE) {
      // End of the pending set — start the next tick from the oldest again.
      cursor = null;
      break;
    }
    cursor = page[page.length - 1] ?? null;
    if (pages >= STRANDED_WATCH_SWEEP_MAX_PAGES) {
      console.warn('[fixWatchWorker] recovery sweep hit its page budget — resuming from the cursor next tick', {
        scanned, repaired,
      });
      break;
    }
  }

  recoveryCursor = cursor;
  if (repaired > 0) {
    console.warn('[fixWatchWorker] recovered stranded fix watches', { repaired, scanned });
  }
  return repaired;
}

/**
 * The job body, exported for unit tests — the Worker below is a thin
 * wrapper. `token` is BullMQ's own lock token for the ACTIVE job, passed by
 * the Worker as the processor's second argument — required to re-delay a
 * still-pending phase-1 check (see the module header); phase 2 and every
 * terminal phase-1 outcome never need it.
 */
export async function processFixWatchJob(job: Job<FixWatchQueueJobData>, token?: string): Promise<void> {
  assertQueueJobName(FIX_WATCH_QUEUE, job, FIX_WATCH_JOB_NAME);
  const data = parseQueueJobData(FIX_WATCH_QUEUE, job, fixWatchQueueJobDataSchema);

  if (data.phase === 'recover') {
    await recoverStrandedFixWatches();
    return;
  }

  if (data.phase === 'phase1') {
    const result = await checkFixWatchPhase1(data.watchId);
    if (result.action === 'recovered') {
      // A DIFFERENT jobId (`fix-watch-p2-<id>`) — no self-collision, a plain
      // `add()` is correct here. Deliberately UNCAUGHT: a failure here must
      // fail this phase-1 job so BullMQ's `attempts`/backoff retries it (see
      // `enqueueFixWatchCheck`'s doc) instead of stranding the watch, already
      // committed to `watching`, with no phase-2 job ever scheduled.
      await enqueueFixWatchCheck('phase2', data.watchId, PHASE2_DELAY_MS);
      return;
    }
    if (result.action === 'still_pending') {
      if (!token) {
        // The Worker below always supplies one; only a test harness calling
        // this function directly could omit it, and there is no lock to
        // re-delay without one.
        console.error('[fixWatchWorker] cannot re-delay a still-pending phase 1 check without a lock token', {
          watchId: data.watchId,
        });
        return;
      }
      await job.moveToDelayed(Date.now() + PHASE1_RECHECK_DELAY_MS, token);
      throw new DelayedError();
    }
    // 'cancelled' / 'timed_out' / 'not_found' are all terminal — nothing more
    // to enqueue; `checkFixWatchPhase1` already wrote the terminal state.
    return;
  }

  // Phase 2 is always terminal — `checkFixWatchPhase2` writes 'recurred' or
  // 'held_qualified' (or is a no-op on 'not_found') and there is no phase 3.
  await checkFixWatchPhase2(data.watchId);
}

let fixWatchWorker: Worker<FixWatchQueueJobData> | null = null;

export async function initializeFixWatchWorker(): Promise<void> {
  if (fixWatchWorker) return;

  fixWatchWorker = new Worker<FixWatchQueueJobData>(
    FIX_WATCH_QUEUE,
    processFixWatchJob,
    {
      connection: getBullMQConnection(),
      concurrency: 5,
    },
  );
  attachWorkerObservability(fixWatchWorker, 'fixWatchWorker');

  fixWatchWorker.on('error', (error) => {
    console.error('[fixWatchWorker] Worker error:', error);
  });
  fixWatchWorker.on('failed', (job, error) => {
    console.error('[fixWatchWorker] fix-watch check failed', {
      jobId: job?.id,
      phase: (job?.data as { phase?: string } | undefined)?.phase,
      watchId: (job?.data as { watchId?: string } | undefined)?.watchId,
      error,
    });
  });

  // The durable-enqueue safety net, on the SAME queue and job name (no new
  // registry entry, no scheduleRegistry slot — 2 minutes is far below
  // COARSE_REPEAT_INTERVAL_MS). Swallowed on failure: a worker that cannot
  // register its sweep must still consume the watches it CAN see, and the
  // next boot re-registers it.
  try {
    await getFixWatchQueue().add(
      FIX_WATCH_JOB_NAME,
      { phase: 'recover' } satisfies FixWatchQueueJobData,
      {
        jobId: FIX_WATCH_RECOVER_JOB_ID,
        repeat: { every: PENDING_RECOVERY_MS },
        removeOnComplete: { count: 50 },
        removeOnFail: { count: 50 },
      },
    );
  } catch (error) {
    console.error('[fixWatchWorker] failed to register the stranded-watch recovery sweep', { error });
    captureException(error instanceof Error ? error : new Error(String(error)));
  }

  console.log('[fixWatchWorker] initialized');
}

export async function shutdownFixWatchWorker(): Promise<void> {
  recoveryCursor = null;
  if (fixWatchWorker) {
    await fixWatchWorker.close();
    fixWatchWorker = null;
  }
  if (fixWatchQueue) {
    await fixWatchQueue.close();
    fixWatchQueue = null;
  }
}
