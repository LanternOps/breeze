/**
 * History retention (#4342 W5): one daily worker, twelve report-first targets.
 *
 * Every target is REPORT-ONLY until its own `<NAME>_RETENTION_ENFORCE=true`
 * (see `retentionTarget.ts` for the report/enforce contract). The targets
 * live in per-domain files beside this one:
 *
 *   aiAgentRuns.ts          ai_agent_runs
 *   patchAndPosture.ts      patch_job_results, security_posture_snapshots, cis_baseline_results
 *   runHistory.ts           automation_runs, report_runs
 *   accessHistory.ts        user_notifications (read, all), remote_sessions, support_sessions, sessions
 *   networkChangeEvents.ts  network_change_events
 *
 * They run one after another through `runRetentionTargets`, so a target that
 * throws is captured and marked incomplete on its own metric while the rest
 * still run. If any failed, the job then fails naming those tables, so BullMQ
 * shows the run as failed rather than completed.
 *
 * A payload can change the batch shape and can turn enforcement OFF
 * (`forceReport`). It can never set a window or turn enforcement on: those are
 * operator env only (OD 5).
 *
 * No DB context wrapper: each batch opens its own system context
 * (`retentionBatch.ts`), so no batch holds a long transaction.
 */

import { Queue, Worker, type Job } from 'bullmq';

import { getBullMQConnection } from '../../services/redis';
import { captureException } from '../../services/sentry';
import { runRetentionTargets, type RetentionTargetResult } from '../retentionTarget';
import { jobSchedule } from '../scheduleRegistry';
import { attachWorkerObservability } from '../workerObservability';
import { AI_AGENT_RUN_TARGETS } from './aiAgentRuns';
import { ACCESS_HISTORY_TARGETS } from './accessHistory';
import { NETWORK_CHANGE_EVENT_TARGETS } from './networkChangeEvents';
import { PATCH_AND_POSTURE_TARGETS } from './patchAndPosture';
import { RUN_HISTORY_TARGETS } from './runHistory';
import { BATCH_SIZE, LOG_PREFIX, MAX_BATCHES, type HistoryRetentionEntry } from './shared';

const QUEUE_NAME = 'history-retention';

/** Fixed run order. Each target has a distinct metric name and flag. */
export const HISTORY_RETENTION_TARGETS: ReadonlyArray<HistoryRetentionEntry> = [
  ...AI_AGENT_RUN_TARGETS,
  ...PATCH_AND_POSTURE_TARGETS,
  ...RUN_HISTORY_TARGETS,
  ...ACCESS_HISTORY_TARGETS,
  ...NETWORK_CHANGE_EVENT_TARGETS,
];

export interface HistoryRetentionJobData {
  batchSize?: number;
  maxBatches?: number;
  /** The only payload switch: it can turn enforcement OFF, never on. */
  forceReport?: boolean;
}

/** Thrown after every target ran, when one or more of them failed. */
export class HistoryRetentionTargetsFailedError extends Error {
  constructor(readonly tables: readonly string[]) {
    super(`${LOG_PREFIX} ${tables.length} retention target(s) failed: ${tables.join(', ')}`);
    this.name = 'HistoryRetentionTargetsFailedError';
  }
}

let retentionQueue: Queue | null = null;
let retentionWorker: Worker<HistoryRetentionJobData> | null = null;

export function getHistoryRetentionQueue(): Queue {
  if (!retentionQueue) {
    retentionQueue = new Queue(QUEUE_NAME, { connection: getBullMQConnection() });
  }
  return retentionQueue;
}

export async function runHistoryRetention(
  job: HistoryRetentionJobData = {},
): Promise<RetentionTargetResult[]> {
  const batchSize = Math.max(1, job.batchSize ?? BATCH_SIZE);
  const maxBatches = Math.max(1, job.maxBatches ?? MAX_BATCHES);
  const results = await runRetentionTargets(
    HISTORY_RETENTION_TARGETS.map((e) => ({
      target: e.target,
      knobs: { ...e.knobs, batchSize, maxBatches, enforce: e.knobs.enforce && !job.forceReport },
      enforceVar: e.enforceVar,
    })),
    { logPrefix: LOG_PREFIX, label: 'historyRetention' },
  );

  const failed = results.filter((r): r is { table: string; error: string } => 'error' in r);
  if (failed.length > 0) {
    throw new HistoryRetentionTargetsFailedError(failed.map((r) => r.table));
  }
  return results as RetentionTargetResult[];
}

export function createHistoryRetentionWorker(): Worker<HistoryRetentionJobData> {
  return new Worker<HistoryRetentionJobData>(
    QUEUE_NAME,
    // No context wrapper: each batch opens its own (see retentionBatch.ts).
    async (job: Job<HistoryRetentionJobData>) => runHistoryRetention(job.data ?? {}),
    { connection: getBullMQConnection(), concurrency: 1 },
  );
}

export async function initializeHistoryRetention(): Promise<void> {
  try {
    retentionWorker = createHistoryRetentionWorker();
    attachWorkerObservability(retentionWorker, 'historyRetention');

    retentionWorker.on('error', (error) => {
      console.error(`${LOG_PREFIX} Worker error:`, error);
      captureException(error);
    });
    retentionWorker.on('failed', (job, error) => {
      console.error(`${LOG_PREFIX} Job ${job?.id} failed:`, error);
      // runRetentionTargets already captured each failed target, tagged with
      // its table; capturing the summary again would double-report it.
      if (!(error instanceof HistoryRetentionTargetsFailedError)) captureException(error);
    });

    // Daily cron slot from the registry — NOT `every: 24h` (epoch-anchored).
    await getHistoryRetentionQueue().upsertJobScheduler(
      QUEUE_NAME,
      { pattern: jobSchedule('history-retention') },
      {
        name: 'sweep',
        data: { batchSize: BATCH_SIZE, maxBatches: MAX_BATCHES },
        opts: { removeOnComplete: { count: 5 }, removeOnFail: { count: 10 } },
      },
    );

    const enforcing = HISTORY_RETENTION_TARGETS.filter((e) => e.knobs.enforce).map((e) => e.target.metricName);
    console.log(
      `${LOG_PREFIX} Retention worker initialized (${enforcing.length === 0 ? 'all targets report-only' : `ENFORCING: ${enforcing.join(', ')}`})`,
    );
  } catch (error) {
    console.error(`${LOG_PREFIX} Failed to initialize:`, error);
    throw error;
  }
}

export async function shutdownHistoryRetention(): Promise<void> {
  if (retentionWorker) {
    await retentionWorker.close();
    retentionWorker = null;
  }
  if (retentionQueue) {
    await retentionQueue.close();
    retentionQueue = null;
  }
}

export const __testOnly = {
  QUEUE_NAME,
  getWorker: () => retentionWorker,
};
