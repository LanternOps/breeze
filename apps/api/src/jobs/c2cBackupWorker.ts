/**
 * C2C Backup Worker
 *
 * BullMQ worker that orchestrates Cloud-to-Cloud backup jobs:
 * - check-schedules: Polls c2c_backup_configs for due syncs (every 5 min)
 * - run-sync: Executes a C2C sync job (scaffold — actual API calls are separate)
 * - process-restore: Handles C2C restore requests
 */

import { Worker, Job } from 'bullmq';
import * as dbModule from '../db';
import {
  c2cBackupConfigs,
} from '../db/schema';
import { eq } from 'drizzle-orm';
import { getBullMQConnection } from '../services/redis';
import { attachWorkerObservability } from './workerObservability';
import {
  closeC2cQueue,
  enqueueC2cSync,
  getC2cQueue,
  type ProcessRestoreData,
  type RunSyncData,
} from './c2cEnqueue';
import { createC2cSyncJobIfIdle } from '../services/c2cJobCreation';
import {
  authorizeAndFinalizeC2cQueuedWork,
  type C2cQueuedAuthorizationDependencies,
  type C2cQueuedWorkData,
} from '../services/c2cQueuedAuthorization';

const { db } = dbModule;
const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  return typeof withSystem === 'function' ? withSystem(fn) : fn();
};

const C2C_QUEUE = 'c2c-backup';

// ── Job data types ───────────────────────────────────────────────────────────

interface CheckSchedulesData {
  type: 'check-schedules';
}

type C2cJobData = CheckSchedulesData | RunSyncData | ProcessRestoreData;

// ── Worker ───────────────────────────────────────────────────────────────────

export function createC2cWorker(): Worker<C2cJobData> {
  return new Worker<C2cJobData>(
    C2C_QUEUE,
    async (job: Job<C2cJobData>) => {
      return runWithSystemDbAccess(async () => {
        switch (job.data.type) {
          case 'check-schedules':
            return await processCheckSchedules();
          case 'run-sync':
            return await processC2cQueuedJob(job.data);
          case 'process-restore':
            return await processC2cQueuedJob(job.data);
          default:
            throw new Error(
              `Unknown C2C job type: ${(job.data as { type: string }).type}`
            );
        }
      });
    },
    {
      connection: getBullMQConnection(),
      concurrency: 3,
      lockDuration: 300_000,
      stalledInterval: 60_000,
      maxStalledCount: 2,
    }
  );
}

// ── check-schedules ──────────────────────────────────────────────────────────

type C2cSchedule = {
  frequency?: 'hourly' | 'daily' | 'weekly';
  time?: string;
  dayOfWeek?: number;
};

async function processCheckSchedules(): Promise<{ enqueued: number }> {
  const now = new Date();

  // Find active configs with schedules
  const configs = await db
    .select()
    .from(c2cBackupConfigs)
    .where(eq(c2cBackupConfigs.isActive, true));

  let enqueued = 0;

  for (const config of configs) {
    const schedule = config.schedule as C2cSchedule | null;
    if (!schedule?.frequency) continue;

    const isDue = isScheduleDue(schedule, now);
    if (!isDue) continue;

    const created = await createC2cSyncJobIfIdle({
      orgId: config.orgId,
      configId: config.id,
      createdAt: now,
      auth: {
        principal: { kind: 'system', reason: 'c2c-sync-scheduler' },
        user: { id: 'system', email: 'system@localhost', name: 'System', isPlatformAdmin: true },
        token: null,
        partnerId: null,
        orgId: config.orgId,
        scope: 'system',
        accessibleOrgIds: null,
        orgCondition: () => undefined,
        canAccessOrg: () => true,
      },
    });
    const c2cJob = created?.job;
    if (!c2cJob || !created.created) continue;

    await enqueueC2cSync(c2cJob.id, config.id, config.orgId);
    enqueued++;
  }

  if (enqueued > 0) {
    console.log(`[C2CBackupWorker] Scheduled ${enqueued} C2C sync job(s)`);
  }

  return { enqueued };
}

function isScheduleDue(schedule: C2cSchedule, now: Date): boolean {
  const hour = now.getUTCHours();
  const minute = now.getUTCMinutes();

  if (schedule.frequency === 'hourly') {
    // Run at the top of every hour (within the 5-minute check window)
    return minute < 5;
  }

  if (schedule.time) {
    const [schedHour, schedMin] = schedule.time.split(':').map(Number);
    // Match within a 5-minute window (scheduler runs every 5 min)
    if (hour !== schedHour || Math.abs(minute - (schedMin ?? 0)) > 4) return false;
  }

  if (
    schedule.frequency === 'weekly' &&
    typeof schedule.dayOfWeek === 'number' &&
    now.getUTCDay() !== schedule.dayOfWeek
  ) {
    return false;
  }

  return true;
}

// ── queued operation boundary ───────────────────────────────────────────────

export function processC2cQueuedJob(
  data: C2cQueuedWorkData,
  dependencies?: C2cQueuedAuthorizationDependencies,
) {
  return authorizeAndFinalizeC2cQueuedWork(data, dependencies);
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

let c2cWorkerInstance: Worker<C2cJobData> | null = null;

export async function initializeC2cBackupWorker(): Promise<void> {
  try {
    c2cWorkerInstance = createC2cWorker();
    attachWorkerObservability(c2cWorkerInstance, 'c2cBackupWorker');

    c2cWorkerInstance.on('error', (error) => {
      console.error('[C2CBackupWorker] Worker error:', error);
    });

    c2cWorkerInstance.on('failed', (job, error) => {
      console.error(`[C2CBackupWorker] Job ${job?.id} failed:`, error);
    });

    // Schedule recurring check-schedules job (every 5 min)
    const queue = getC2cQueue();
    const newJob = await queue.add(
      'check-schedules',
      { type: 'check-schedules' as const },
      {
        repeat: { every: 300_000 },
        removeOnComplete: { count: 10 },
        removeOnFail: { count: 20 },
      }
    );

    // Clean up stale repeatable jobs
    const repeatable = await queue.getRepeatableJobs();
    for (const job of repeatable) {
      if (job.name === 'check-schedules' && job.key !== newJob.repeatJobKey) {
        await queue.removeRepeatableByKey(job.key);
      }
    }

    console.log('[C2CBackupWorker] C2C backup worker initialized');
  } catch (error) {
    console.error('[C2CBackupWorker] Failed to initialize:', error);
    throw error;
  }
}

export async function shutdownC2cBackupWorker(): Promise<void> {
  if (c2cWorkerInstance) {
    await c2cWorkerInstance.close();
    c2cWorkerInstance = null;
  }

  await closeC2cQueue();
  console.log('[C2CBackupWorker] C2C backup worker shut down');
}
