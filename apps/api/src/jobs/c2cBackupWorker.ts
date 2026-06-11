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
  c2cBackupItems,
  c2cBackupJobs,
  c2cConnections,
} from '../db/schema';
import { and, eq, sql } from 'drizzle-orm';
import { getBullMQConnection } from '../services/redis';
import {
  closeC2cQueue,
  enqueueC2cSync,
  getC2cQueue,
  type ProcessRestoreData,
  type RunSyncData,
} from './c2cEnqueue';
import { createC2cSyncJobIfIdle } from '../services/c2cJobCreation';

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
            return await processRunSync(job.data);
          case 'process-restore':
            return await processRestore(job.data);
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

// ── run-sync ─────────────────────────────────────────────────────────────────

async function processRunSync(
  data: RunSyncData
): Promise<{ synced: boolean; skipped?: boolean; reason?: string }> {
  const claimed = await db
    .update(c2cBackupJobs)
    .set({ status: 'running', startedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(c2cBackupJobs.id, data.jobId),
        eq(c2cBackupJobs.orgId, data.orgId),
        eq(c2cBackupJobs.configId, data.configId),
        eq(c2cBackupJobs.status, 'pending')
      )
    )
    .returning({ id: c2cBackupJobs.id });

  if (claimed.length === 0) {
    return {
      synced: false,
      skipped: true,
      reason: 'Job not pending for queued org/config',
    };
  }

  // TODO: In production, this would:
  // 1. Load the connection credentials from c2c_connections
  // 2. Refresh OAuth tokens if expired
  // 3. Use MS Graph API / Google APIs to fetch delta changes
  // 4. Store items in c2c_backup_items
  // 5. Upload content to the configured storage provider
  // 6. Update delta_token for incremental sync

  const errorLog = 'C2C sync not yet implemented';
  await db
    .update(c2cBackupJobs)
    .set({
      status: 'failed',
      completedAt: new Date(),
      errorLog,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(c2cBackupJobs.id, data.jobId),
        eq(c2cBackupJobs.orgId, data.orgId),
        eq(c2cBackupJobs.configId, data.configId),
        eq(c2cBackupJobs.status, 'running')
      )
    );

  console.log(
    `[C2CBackupWorker] Sync job ${data.jobId} failed: ${errorLog}`
  );
  return { synced: false };
}

// ── process-restore ──────────────────────────────────────────────────────────

async function processRestore(
  data: ProcessRestoreData
): Promise<{ restored: boolean; skipped?: boolean; reason?: string }> {
  const [pendingJob] = await db
    .select({ id: c2cBackupJobs.id, configId: c2cBackupJobs.configId })
    .from(c2cBackupJobs)
    .where(
      and(
        eq(c2cBackupJobs.id, data.restoreJobId),
        eq(c2cBackupJobs.orgId, data.orgId),
        eq(c2cBackupJobs.status, 'pending')
      )
    )
    .limit(1);

  if (!pendingJob) {
    return {
      restored: false,
      skipped: true,
      reason: 'Restore job not pending for queued org',
    };
  }

  if (data.targetConnectionId) {
    const [targetConnection] = await db
      .select({ id: c2cConnections.id })
      .from(c2cConnections)
      .where(
        and(
          eq(c2cConnections.id, data.targetConnectionId),
          eq(c2cConnections.orgId, data.orgId)
        )
      )
      .limit(1);

    if (!targetConnection) {
      return {
        restored: false,
        skipped: true,
        reason: 'Target connection is not in queued org',
      };
    }
  }

  const requestedItemIds = [...new Set(data.itemIds)];
  if (requestedItemIds.length === 0) {
    return { restored: false, skipped: true, reason: 'No restore items queued' };
  }

  const [itemMatch] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(c2cBackupItems)
    .where(
      and(
        eq(c2cBackupItems.orgId, data.orgId),
        eq(c2cBackupItems.configId, pendingJob.configId),
        sql`${c2cBackupItems.id} = ANY(${requestedItemIds}::uuid[])`
      )
    );

  if ((itemMatch?.count ?? 0) !== requestedItemIds.length) {
    return {
      restored: false,
      skipped: true,
      reason: 'Queued restore items do not match restore job org/config',
    };
  }

  const claimed = await db
    .update(c2cBackupJobs)
    .set({ status: 'running', startedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(c2cBackupJobs.id, data.restoreJobId),
        eq(c2cBackupJobs.orgId, data.orgId),
        eq(c2cBackupJobs.configId, pendingJob.configId),
        eq(c2cBackupJobs.status, 'pending')
      )
    )
    .returning({ id: c2cBackupJobs.id });

  if (claimed.length === 0) {
    return {
      restored: false,
      skipped: true,
      reason: 'Restore job was already claimed',
    };
  }

  // TODO: In production, this would:
  // 1. Load items from c2c_backup_items by itemIds
  // 2. Download content from storage
  // 3. Upload back to the target provider (MS Graph / Google API)
  // 4. Update item status

  const errorLog = 'C2C restore not yet implemented';
  await db
    .update(c2cBackupJobs)
    .set({
      status: 'failed',
      completedAt: new Date(),
      itemsProcessed: requestedItemIds.length,
      errorLog,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(c2cBackupJobs.id, data.restoreJobId),
        eq(c2cBackupJobs.orgId, data.orgId),
        eq(c2cBackupJobs.configId, pendingJob.configId),
        eq(c2cBackupJobs.status, 'running')
      )
    );

  console.log(
    `[C2CBackupWorker] Restore job ${data.restoreJobId} failed: ${errorLog}`
  );
  return { restored: false };
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

let c2cWorkerInstance: Worker<C2cJobData> | null = null;

export async function initializeC2cBackupWorker(): Promise<void> {
  try {
    c2cWorkerInstance = createC2cWorker();

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
