/**
 * Ticket migration window sweep (#8313; spec
 * docs/superpowers/specs/api-platform/2026-10-10-ticket-migration-windows-design.md
 * §3.4–§3.5).
 *
 * Every minute:
 *   - closes `expired` windows (`ends_at <= now()`);
 *   - closes `principal_inactive` windows (principal disabled, expired, or
 *     without tickets:write) and `opener_inactive` windows (opener no longer
 *     an active partner-wide admin of the partner, their partner role no
 *     longer grants organizations.write and tickets.write, or either of the
 *     opener's epochs moved since the window opened);
 *   - publishes `migration.window_closed` once per org for every closed
 *     window whose summary is not out yet, and retries it until it is.
 *
 * Each close is its own system transaction holding the window FOR UPDATE.
 * A write that arrives between a closing condition and the sweep is refused
 * by the write-time check (wave 1b), so the sweep's delay never extends a
 * window. There is no enable flag: closing is what bounds a window.
 */

import { Queue, Worker, Job } from 'bullmq';
import { captureException } from '../services/sentry';
import { getBullMQConnection } from '../services/redis';
import { sweepMigrationWindows } from '../services/migrationWindows';
import { attachWorkerObservability } from './workerObservability';

const QUEUE_NAME = 'migration-window-sweep';
const JOB_NAME = 'migration-window-sweep';
const REPEAT_JOB_ID = 'migration-window-sweep';
// A sub-hourly tick: unmanaged by scheduleRegistry, which allocates only
// coarse (>= hourly) schedules.
const EVERY_MS = 60_000;

let sweepQueue: Queue | null = null;
let sweepWorker: Worker | null = null;

export function getMigrationWindowSweepQueue(): Queue {
  if (!sweepQueue) {
    sweepQueue = new Queue(QUEUE_NAME, { connection: getBullMQConnection() });
  }
  return sweepQueue;
}

export function createMigrationWindowSweepWorker(): Worker {
  return new Worker(
    QUEUE_NAME,
    async (job: Job) => {
      if (job.name !== JOB_NAME) {
        console.warn(`[MigrationWindowSweep] Ignoring unknown job name: ${job.name}`);
        return { closed: 0, published: 0, skipped: true };
      }
      const startedAt = Date.now();
      const result = await sweepMigrationWindows(new Date());
      if (result.closed > 0 || result.published > 0) {
        console.log(
          `[MigrationWindowSweep] Closed ${result.closed} window(s), published ${result.published} summary(ies) `
          + `in ${Date.now() - startedAt}ms`,
        );
      }
      return result;
    },
    {
      connection: getBullMQConnection(),
      concurrency: 1,
    },
  );
}

export async function scheduleMigrationWindowSweep(
  queue: Queue = getMigrationWindowSweepQueue(),
): Promise<void> {
  // Clear any previously-registered repeatable so a changed cron pattern
  // takes effect on redeploy.
  const existingJobs = await queue.getRepeatableJobs();
  for (const job of existingJobs) {
    if (job.name === JOB_NAME) {
      await queue.removeRepeatableByKey(job.key);
    }
  }
  await queue.add(
    JOB_NAME,
    {},
    {
      jobId: REPEAT_JOB_ID,
      repeat: { every: EVERY_MS },
      removeOnComplete: { count: 10 },
      removeOnFail: { count: 25 },
    },
  );
  console.log(`[MigrationWindowSweep] Scheduled (every ${EVERY_MS} ms, jobId=${REPEAT_JOB_ID})`);
}

export async function initializeMigrationWindowSweepWorker(): Promise<void> {
  try {
    sweepWorker = createMigrationWindowSweepWorker();
    attachWorkerObservability(sweepWorker, 'migrationWindowSweep');

    sweepWorker.on('error', (error) => {
      console.error('[MigrationWindowSweep] Worker error:', error);
      captureException(error);
    });

    sweepWorker.on('failed', (job, error) => {
      console.error(`[MigrationWindowSweep] Job ${job?.id} failed:`, error);
      captureException(error);
    });

    await scheduleMigrationWindowSweep();
    console.log('[MigrationWindowSweep] Worker initialized');
  } catch (error) {
    console.error('[MigrationWindowSweep] Failed to initialize:', error);
    throw error;
  }
}

export async function shutdownMigrationWindowSweepWorker(): Promise<void> {
  if (sweepWorker) {
    await sweepWorker.close();
    sweepWorker = null;
  }
  if (sweepQueue) {
    await sweepQueue.close();
    sweepQueue = null;
  }
}

// Exported for test introspection.
export const __testOnly = { QUEUE_NAME, JOB_NAME, REPEAT_JOB_ID, EVERY_MS };
