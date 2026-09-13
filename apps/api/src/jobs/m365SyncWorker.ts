import { Job, UnrecoverableError, Worker } from 'bullmq';
import {
  isM365TenantSyncEnabled, m365SyncConcurrency, m365SyncMaxBacklog, m365SyncTickBatch,
} from '../config/env';
import { getBullMQConnection } from '../services/redis';
import {
  claimDueDomains, countDueDomains, reconcileEligibleConnections,
} from '../services/m365Sync/claim';
import {
  recordM365SyncTickerSkipped, setM365SyncDueBacklog, setM365SyncQueueDepth,
  setM365SyncTickerUtilisation,
} from '../services/m365Sync/metrics';
import { logSync, runSyncDomain } from '../services/m365Sync/run';
import { m365SyncJobDataSchema } from '../services/m365Sync/types';
import {
  closeM365SyncQueue, enqueueSyncDomain, getM365SyncQueue, m365SyncBackoff,
  M365_SYNC_QUEUE, M365_SYNC_TICK_JOB_ID,
  type M365SyncQueueJobData,
} from './m365SyncQueue';
import { attachWorkerObservability, type WorkerFailureClassification } from './workerObservability';

export const M365_SYNC_WORKER_NAME = 'm365SyncWorker';

/**
 * Thrown so BullMQ applies the 30 s / 2 min / 8 min backoff. Every condition
 * that raises it is EXPECTED and self-healing, which is why the classifier
 * below holds the report until the attempts are exhausted — and, because the
 * final attempt records `throttled` and RETURNS instead of throwing, a pure
 * throttle never reaches Sentry at all.
 */
export class M365SyncRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'M365SyncRetryableError';
  }
}

export interface M365SyncTickResult {
  claimed: number;
  depth: number;
  seeded: number;
  due: number;
  skipped?: 'flag_off' | 'backpressure';
}

/**
 * One tick (spec §5.2). Three deliberately separated stages:
 *
 *   1. REDIS, no DB context — queue depth for backpressure.
 *   2. DB, short system transactions — reconcile, due gauge, claim.
 *   3. REDIS, no DB context — enqueue.
 *
 * Issuing Redis commands with a pooled connection held open is the #1105
 * anti-pattern, and enqueuing before the claim has committed would let a worker
 * read a stale generation and fence itself.
 */
export async function runM365SyncTick(now: Date = new Date()): Promise<M365SyncTickResult> {
  if (!isM365TenantSyncEnabled()) {
    return { claimed: 0, depth: 0, seeded: 0, due: 0, skipped: 'flag_off' };
  }

  const queue = getM365SyncQueue();
  const counts = await queue.getJobCounts('waiting', 'prioritized', 'delayed', 'active');
  // `prioritized` and `delayed` are counted on purpose: the priority-1 lane
  // parks jobs in `prioritized` and the backoff ladder parks them in `delayed`,
  // so a waiting+active-only depth would read near zero while the queue was
  // 500 deep (the advisor-quorum finding on draft v1).
  const depth = (counts.waiting ?? 0) + (counts.prioritized ?? 0)
    + (counts.delayed ?? 0) + (counts.active ?? 0);
  setM365SyncQueueDepth(depth);

  if (depth > m365SyncMaxBacklog()) {
    recordM365SyncTickerSkipped();
    logSync('tick-skipped', { reason: 'backpressure', depth, maxBacklog: m365SyncMaxBacklog() });
    // Due rows keep their past next_sync_at, so nothing is lost — the next tick
    // picks them up (spec §5.2 step 1).
    return { claimed: 0, depth, seeded: 0, due: 0, skipped: 'backpressure' };
  }

  const seeded = await reconcileEligibleConnections(now);
  const due = await countDueDomains(now);
  setM365SyncDueBacklog(due);

  const batch = m365SyncTickBatch();
  const claimed = await claimDueDomains({ limit: batch });
  setM365SyncTickerUtilisation(claimed.length / batch);

  for (const job of claimed) {
    try {
      await enqueueSyncDomain(job);
    } catch (error) {
      // One failed enqueue must not abandon the rest of the batch. The row is
      // already claimed with a lease; when the lease expires the next tick
      // reclaims it with a fresh generation (spec §5.2 "Recovery").
      logSync('enqueue-failed', {
        orgId: job.orgId, domain: job.domain, generation: job.generation,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { claimed: claimed.length, depth, seeded, due };
}

/** Exported for m365SyncWorker.processSyncDomain.test.ts — the BullMQ processor never calls this directly with a hand-built job. */
export async function processSyncDomain(job: Job<M365SyncQueueJobData>): Promise<string> {
  if (!isM365TenantSyncEnabled()) return 'noop';

  const parsed = m365SyncJobDataSchema.safeParse(job.data);
  if (!parsed.success) {
    // A payload that cannot be parsed will not parse on attempt two or three
    // either, and it IS worth a Sentry report — unlike the expected conditions
    // below, this one means something wrote a job we do not understand.
    throw new UnrecoverableError(
      `[M365Sync] malformed sync-domain payload: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`,
    );
  }

  // 1-based inside the processor (BullMQ increments attemptsMade on
  // move-to-active) — same convention as huntressSync/ticketNotify.
  const isFinalAttempt = job.attemptsMade >= (job.opts.attempts ?? 1);
  const outcome = await runSyncDomain(parsed.data, { isFinalAttempt });

  if (outcome === 'throttled' && !isFinalAttempt) {
    // runSyncDomain wrote no terminal state; ask BullMQ for the backoff.
    throw new M365SyncRetryableError(
      `[M365Sync] throttled or at executor capacity for org=${parsed.data.orgId} domain=${parsed.data.domain}`,
    );
  }
  // Everything else — including a dead credential — returns normally. It is
  // already recorded terminally on m365_sync_state, and capturing it once per
  // scheduled run is exactly what flooded the Sentry quota for Huntress
  // (BREEZE-1). Spec §6: "Run stops; not sent to Sentry".
  return outcome;
}

export function classifyM365SyncFailure(
  _job: Job | undefined,
  err: Error,
): WorkerFailureClassification | null {
  const isRetryable = err instanceof M365SyncRetryableError
    // The class may not survive BullMQ's error round-trip into the 'failed'
    // event, so match by name too (same defence as isHuntressAuthFailure).
    || err.name === 'M365SyncRetryableError';
  if (!isRetryable) return null;
  return { reason: 'm365_sync_throttled', level: 'warning', reportOnlyWhenExhausted: true };
}

let worker: Worker<M365SyncQueueJobData> | null = null;

/**
 * Registers the 60 s repeat tick. Any pre-existing `tick` repeatable is removed
 * FIRST, unconditionally, so turning the flag off and restarting actually stops
 * the scheduler rather than leaving an orphaned repeat entry in Redis.
 *
 * No scheduleRegistry slot: that registry allocates coarse (>= hourly)
 * schedules, and a 60 s tick is explicitly exempt.
 *
 * The `every` value below is a LITERAL, not the `M365_SYNC_TICK_INTERVAL_MS`
 * constant exported from `./m365SyncQueue` (deviation from the plan's Step 3
 * text, which imports it here): `scheduleRegistry.contract.test.ts` ASTs every
 * `repeat: { every }` site across `apps/api/src` and only resolves same-file
 * `const` declarations — a cross-file import resolves to UNRESOLVED and fails
 * the suite. Every other ticker in this directory (e.g. `SWEEP_INTERVAL_MS` /
 * `SCAN_INTERVAL_MS` style constants) satisfies this by declaring its interval
 * in the same file; this file has no local declaration to point at, so the
 * literal is inlined directly. Keep it equal to `M365_SYNC_TICK_INTERVAL_MS`.
 */
async function scheduleTick(): Promise<void> {
  const queue = getM365SyncQueue();
  for (const repeatable of await queue.getRepeatableJobs()) {
    if (repeatable.name === 'tick') await queue.removeRepeatableByKey(repeatable.key);
  }
  if (!isM365TenantSyncEnabled()) {
    logSync('tick-not-registered', { reason: 'M365_TENANT_SYNC_ENABLED is off' });
    return;
  }
  await queue.add('tick', {}, {
    jobId: M365_SYNC_TICK_JOB_ID,
    repeat: { every: 60_000 }, // keep equal to M365_SYNC_TICK_INTERVAL_MS in ./m365SyncQueue
    removeOnComplete: true,
    removeOnFail: { count: 20 },
  });
}

export async function initializeM365SyncWorker(): Promise<void> {
  // The Worker is constructed UNCONDITIONALLY, flag or not: the readiness
  // manifest requires exactly one attach per construction site, and a
  // flag-gated construction would leave the process permanently not-ready on
  // the default configuration. Both the tick registration above and the
  // processor itself check the flag instead.
  worker = new Worker<M365SyncQueueJobData>(
    M365_SYNC_QUEUE,
    async (job: Job<M365SyncQueueJobData>) => {
      // No blanket system-context wrap: runSyncDomain manages its own short
      // contexts so the Graph fetch runs with none held.
      if (job.name === 'tick') return runM365SyncTick();
      return processSyncDomain(job);
    },
    {
      connection: getBullMQConnection(),
      concurrency: m365SyncConcurrency(),
      lockDuration: 300_000,
      stalledInterval: 60_000,
      maxStalledCount: 2,
      settings: { backoffStrategy: (attemptsMade: number) => m365SyncBackoff(attemptsMade) },
    },
  );
  attachWorkerObservability(worker, M365_SYNC_WORKER_NAME, { classifyFailure: classifyM365SyncFailure });

  await scheduleTick();
  logSync('worker-initialized', { concurrency: m365SyncConcurrency() });
}

export async function shutdownM365SyncWorker(): Promise<void> {
  if (worker) { await worker.close(); worker = null; }
  await closeM365SyncQueue();
  logSync('worker-shut-down', {});
}
