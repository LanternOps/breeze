/**
 * C2C Backup Worker
 *
 * BullMQ worker that orchestrates Cloud-to-Cloud backup jobs:
 * - check-schedules: Polls c2c_backup_configs for due syncs (every 5 min)
 * - run-sync: Executes a C2C sync job (scaffold — actual API calls are separate)
 * - process-restore: Handles C2C restore requests
 */

import { Worker, Queue, Job } from 'bullmq';
import * as dbModule from '../db';
import { c2cBackupConfigs, c2cBackupJobs } from '../db/schema';
import { eq, and } from 'drizzle-orm';
import { getRedisConnection } from '../services/redis';

const { db } = dbModule;
const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  return typeof withSystem === 'function' ? withSystem(fn) : fn();
};

const C2C_QUEUE = 'c2c-backup';

// ── Queue ────────────────────────────────────────────────────────────────────

let c2cQueue: Queue | null = null;

export function getC2cQueue(): Queue {
  if (!c2cQueue) {
    c2cQueue = new Queue(C2C_QUEUE, {
      connection: getRedisConnection(),
    });
  }
  return c2cQueue;
}

async function closeC2cQueue(): Promise<void> {
  if (c2cQueue) {
    await c2cQueue.close();
    c2cQueue = null;
  }
}

// ── Job data types ───────────────────────────────────────────────────────────

interface CheckSchedulesData {
  type: 'check-schedules';
}

interface RunSyncData {
  type: 'run-sync';
  jobId: string;
  configId: string;
  orgId: string;
}

interface ProcessRestoreData {
  type: 'process-restore';
  restoreJobId: string;
  orgId: string;
  itemIds: string[];
  targetConnectionId: string | null;
}

type C2cJobData = CheckSchedulesData | RunSyncData | ProcessRestoreData;

// ── Worker ───────────────────────────────────────────────────────────────────

function createC2cWorker(): Worker<C2cJobData> {
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
      connection: getRedisConnection(),
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

    // Check for existing pending/running job for this config
    const [existing] = await db
      .select({ id: c2cBackupJobs.id })
      .from(c2cBackupJobs)
      .where(
        and(
          eq(c2cBackupJobs.configId, config.id),
          eq(c2cBackupJobs.status, 'pending')
        )
      )
      .limit(1);

    if (existing) continue;

    // Create job record and enqueue
    const [job] = await db
      .insert(c2cBackupJobs)
      .values({
        orgId: config.orgId,
        configId: config.id,
        status: 'pending',
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    if (job) {
      const queue = getC2cQueue();
      await queue.add(
        'run-sync',
        {
          type: 'run-sync' as const,
          jobId: job.id,
          configId: config.id,
          orgId: config.orgId,
        },
        {
          removeOnComplete: { count: 50 },
          removeOnFail: { count: 100 },
        }
      );
      enqueued++;
    }
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

async function processRunSync(data: RunSyncData): Promise<{ synced: boolean }> {
  // Mark job as running
  await db
    .update(c2cBackupJobs)
    .set({ status: 'running', startedAt: new Date(), updatedAt: new Date() })
    .where(eq(c2cBackupJobs.id, data.jobId));

  // TODO: In production, this would:
  // 1. Load the connection credentials from c2c_connections
  // 2. Refresh OAuth tokens if expired
  // 3. Use MS Graph API / Google APIs to fetch delta changes
  // 4. Store items in c2c_backup_items
  // 5. Upload content to the configured storage provider
  // 6. Update delta_token for incremental sync

  // Scaffold: mark as completed for now
  await db
    .update(c2cBackupJobs)
    .set({
      status: 'completed',
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(c2cBackupJobs.id, data.jobId));

  console.log(
    `[C2CBackupWorker] Sync job ${data.jobId} completed (scaffold)`
  );
  return { synced: true };
}

// ── process-restore ──────────────────────────────────────────────────────────

async function processRestore(
  data: ProcessRestoreData
): Promise<{ restored: boolean }> {
  // Mark job as running
  await db
    .update(c2cBackupJobs)
    .set({ status: 'running', startedAt: new Date(), updatedAt: new Date() })
    .where(eq(c2cBackupJobs.id, data.restoreJobId));

  // TODO: In production, this would:
  // 1. Load items from c2c_backup_items by itemIds
  // 2. Download content from storage
  // 3. Upload back to the target provider (MS Graph / Google API)
  // 4. Update item status

  // Scaffold: mark as completed
  await db
    .update(c2cBackupJobs)
    .set({
      status: 'completed',
      completedAt: new Date(),
      itemsProcessed: data.itemIds.length,
      updatedAt: new Date(),
    })
    .where(eq(c2cBackupJobs.id, data.restoreJobId));

  console.log(
    `[C2CBackupWorker] Restore job ${data.restoreJobId} completed (scaffold, ${data.itemIds.length} items)`
  );
  return { restored: true };
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
