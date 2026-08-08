import { eq } from 'drizzle-orm';
import { Job, Queue, Worker } from 'bullmq';

import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { fleetRemediationRuns } from '../db/schema/fleetFindings';
import {
  dispatchRunChunk,
  isTerminalRunStatus,
  pollRunProgress,
  REMEDIATION_CHUNK_SIZE,
} from '../services/fleetFindings/dispatch';
import { getBullMQConnection } from '../services/redis';
import { attachWorkerObservability } from './workerObservability';

const FLEET_REMEDIATION_DISPATCH_QUEUE = 'fleet-remediation-dispatch';
const POLL_INTERVAL_MS = 30_000;

type DispatchChunkJobData = { type: 'dispatch-chunk'; runId: string; chunkIndex: number };
type PollRunJobData = { type: 'poll-run'; runId: string };

export type FleetRemediationDispatchJobData = DispatchChunkJobData | PollRunJobData;

let fleetRemediationDispatchQueue: Queue<FleetRemediationDispatchJobData> | null = null;
let fleetRemediationDispatchWorker: Worker<FleetRemediationDispatchJobData> | null = null;

export function getFleetRemediationDispatchQueue(): Queue<FleetRemediationDispatchJobData> {
  if (!fleetRemediationDispatchQueue) {
    fleetRemediationDispatchQueue = new Queue<FleetRemediationDispatchJobData>(FLEET_REMEDIATION_DISPATCH_QUEUE, {
      connection: getBullMQConnection(),
    });
  }
  return fleetRemediationDispatchQueue;
}

export function buildDispatchChunkJobId(runId: string, chunkIndex: number): string {
  return `fleet-run-dispatch-${runId}-${chunkIndex}`;
}

export function buildPollRunJobId(runId: string): string {
  return `fleet-run-poll-${runId}`;
}

/**
 * Enqueues `ceil(targetCount / REMEDIATION_CHUNK_SIZE)` one-shot dispatch
 * jobs plus a single repeatable (every 30s) poll job for the run. Called by
 * the route right after `createRemediationRun` succeeds.
 *
 * `targetCount` counts ALL of the run's candidate rows — dispatchable ones AND
 * the ones `createRemediationRun` already wrote as `skipped`. So an all-skipped
 * run still enqueues here: its chunk jobs find nothing `pending` and no-op, and
 * the first poll tick recomputes the run to terminal and removes its own
 * scheduler. `targetCount` is 0 only when the request produced no candidate
 * devices at all (empty membership, or a `deviceIds` list that matched
 * nothing), and that is the sole case this short-circuits.
 */
export async function enqueueRemediationDispatch(runId: string, targetCount: number): Promise<void> {
  if (targetCount <= 0) return;

  const queue = getFleetRemediationDispatchQueue();
  const chunkCount = Math.ceil(targetCount / REMEDIATION_CHUNK_SIZE);

  // Scheduler FIRST, chunks second. Reversed, a scheduler-creation failure
  // (Redis blip on the second call) throws out of here with the chunk jobs
  // already enqueued and executing: the route catches, marks the run
  // `dispatch_enqueue_failed` and returns a 502, while real commands go out to
  // real devices behind a run the operator has been told failed. In this order
  // the worst case is a poll scheduler with no chunks — harmless, since the
  // first tick sees a terminal/timed-out run and removes itself.
  //
  // Job Schedulers (not the legacy `queue.add(..., {repeat})` +
  // `getRepeatableJobs()`/`removeRepeatableByKey()` API used by
  // jobs/fleetFindings.ts's singleton `scan-orgs` cron) — deliberately, for
  // this per-RUN dynamic repeatable: a scheduler is addressed by a caller-
  // chosen id (`buildPollRunJobId(runId)`) and removed by that same id via
  // `removeJobScheduler`. The legacy API's `getRepeatableJobs()` returns
  // `RepeatableJob.id` as `undefined` for jobs whose repeat metadata still
  // exists in Redis (see bullmq's `Repeat.getRepeatableData`, which never
  // populates `id` off the live hash) — matching on `.id` there always
  // fails, silently leaking one repeatable poll job per run forever.
  await queue.upsertJobScheduler(
    buildPollRunJobId(runId),
    { every: POLL_INTERVAL_MS },
    {
      name: 'poll-run',
      data: { type: 'poll-run', runId },
      opts: { removeOnComplete: { count: 20 }, removeOnFail: { count: 50 } },
    }
  );

  await queue.addBulk(
    Array.from({ length: chunkCount }, (_, chunkIndex) => ({
      name: 'dispatch-chunk',
      data: { type: 'dispatch-chunk' as const, runId, chunkIndex },
      opts: {
        jobId: buildDispatchChunkJobId(runId, chunkIndex),
        // A chunk that dies on a transient fault (DB blip, Redis hiccup) would
        // otherwise strand its whole page of targets as `pending` until the
        // 30-minute poll timeout rewrote them as failures. `dispatchRunChunk`
        // is idempotent by construction — it claims each target with a
        // conditional UPDATE and skips already-claimed rows — so a retry
        // re-dispatches nothing it already sent.
        attempts: 3,
        backoff: { type: 'exponential' as const, delay: 5000 },
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 200 },
      },
    }))
  );
}

async function removePollScheduler(runId: string): Promise<void> {
  const queue = getFleetRemediationDispatchQueue();
  await queue.removeJobScheduler(buildPollRunJobId(runId));
}

export function createFleetRemediationDispatchWorker(): Worker<FleetRemediationDispatchJobData> {
  return new Worker<FleetRemediationDispatchJobData>(
    FLEET_REMEDIATION_DISPATCH_QUEUE,
    async (job: Job<FleetRemediationDispatchJobData>) => {
      if (job.data.type === 'dispatch-chunk') {
        const { runId, chunkIndex } = job.data;
        return runOutsideDbContext(() => withSystemDbAccessContext(() => dispatchRunChunk(runId, chunkIndex)));
      }

      const { runId } = job.data;
      await runOutsideDbContext(() => withSystemDbAccessContext(() => pollRunProgress(runId)));

      const [row] = await runOutsideDbContext(() =>
        withSystemDbAccessContext(() =>
          db.select({ status: fleetRemediationRuns.status }).from(fleetRemediationRuns).where(eq(fleetRemediationRuns.id, runId)).limit(1)
        )
      );

      // No row means the run is gone (deleted, org erasure) — there is nothing
      // left to poll, and leaving the scheduler in place leaks a repeatable job
      // that re-fires every 30s forever. Remove it for BOTH terminal outcomes:
      // "run finished" and "run no longer exists".
      if (!row) {
        console.warn(
          `[FleetRemediationDispatchWorker] Run ${runId} not found while polling — removing its poll scheduler`
        );
      }
      if (!row || isTerminalRunStatus(row.status)) {
        await removePollScheduler(runId);
      }
    },
    {
      connection: getBullMQConnection(),
      concurrency: 4,
      lockDuration: 300_000,
      stalledInterval: 60_000,
      maxStalledCount: 2,
    }
  );
}

export async function scheduleFleetRemediationDispatchJobs(): Promise<void> {
  fleetRemediationDispatchWorker = createFleetRemediationDispatchWorker();
  attachWorkerObservability(fleetRemediationDispatchWorker, 'fleetRemediationDispatchWorker');
  fleetRemediationDispatchWorker.on('error', (error) => {
    console.error('[FleetRemediationDispatchWorker] Worker error:', error);
  });
  fleetRemediationDispatchWorker.on('failed', (job, error) => {
    console.error(`[FleetRemediationDispatchWorker] Job ${job?.id} (${job?.data?.type}) failed:`, error);
  });
  console.log('[FleetRemediationDispatchWorker] Fleet remediation dispatch worker initialized');
}

export async function shutdownFleetRemediationDispatchJobs(): Promise<void> {
  if (fleetRemediationDispatchWorker) {
    await fleetRemediationDispatchWorker.close();
    fleetRemediationDispatchWorker = null;
  }
  if (fleetRemediationDispatchQueue) {
    await fleetRemediationDispatchQueue.close();
    fleetRemediationDispatchQueue = null;
  }
}
