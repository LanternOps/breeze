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
  type FinishedRunForWatch,
  type FixWatchOutcomeInput,
} from '../services/aiAgents/fixWatch';
import { fixWatchQueueJobDataSchema, type FixWatchQueueJobData } from './queueSchemas';

export const FIX_WATCH_QUEUE = 'fix-watch';
export const FIX_WATCH_JOB_NAME = 'check-fix-watch';

const PHASE1_RECHECK_DELAY_MS = 5 * 60_000;
const PHASE2_DELAY_MS = FIX_HOLD_MINUTES * 60_000;

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
): Promise<void> {
  try {
    const watchId = await createFixWatchRow(run, outcome);
    if (!watchId) return;
    await enqueueFixWatchCheck('phase1', watchId, PHASE1_RECHECK_DELAY_MS);
  } catch (error) {
    console.error('[fixWatchWorker] failed to schedule a fix-held watch (non-fatal)', {
      runId: run.id, error,
    });
    captureException(error instanceof Error ? error : new Error(String(error)));
  }
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

export function initializeFixWatchWorker(): void {
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

  console.log('[fixWatchWorker] initialized');
}

export async function shutdownFixWatchWorker(): Promise<void> {
  if (fixWatchWorker) {
    await fixWatchWorker.close();
    fixWatchWorker = null;
  }
  if (fixWatchQueue) {
    await fixWatchQueue.close();
    fixWatchQueue = null;
  }
}
