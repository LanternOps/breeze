/**
 * Backup Worker
 *
 * BullMQ worker that orchestrates backup jobs:
 * - check-schedules: Polls enabled backup policies, creates jobs when due
 * - dispatch-backup: Sends backup_run command to agent via WebSocket
 * - process-results: Updates job/snapshot rows from agent result payload
 * - dispatch-restore: Sends backup_restore command to agent
 */

import { Queue, Worker, Job } from 'bullmq';
import * as dbModule from '../db';
import {
  backupPolicies,
  backupJobs,
  backupSnapshots,
  backupConfigs,
  restoreJobs,
  devices,
} from '../db/schema';
import { eq, and, sql } from 'drizzle-orm';
import { getRedisConnection } from '../services/redis';
import {
  sendCommandToAgent,
  isAgentConnected,
  type AgentCommand,
} from '../routes/agentWs';

const { db } = dbModule;
const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  return typeof withSystem === 'function' ? withSystem(fn) : fn();
};

const BACKUP_QUEUE = 'backup';

let backupQueue: Queue | null = null;

export function getBackupQueue(): Queue {
  if (!backupQueue) {
    backupQueue = new Queue(BACKUP_QUEUE, {
      connection: getRedisConnection(),
    });
  }
  return backupQueue;
}

// ── Job data types ────────────────────────────────────────────────────────────

interface CheckSchedulesJobData {
  type: 'check-schedules';
}

interface DispatchBackupJobData {
  type: 'dispatch-backup';
  jobId: string;
  configId: string;
  orgId: string;
  deviceId: string;
}

interface ProcessResultsJobData {
  type: 'process-results';
  jobId: string;
  orgId: string;
  deviceId: string;
  result: {
    status: string;
    jobId?: string;
    snapshotId?: string;
    filesBackedUp?: number;
    bytesBackedUp?: number;
    warning?: string;
    error?: string;
  };
}

interface DispatchRestoreJobData {
  type: 'dispatch-restore';
  restoreJobId: string;
  snapshotId: string;
  deviceId: string;
  orgId: string;
  targetPath?: string;
  selectedPaths?: string[];
}

type BackupJobData =
  | CheckSchedulesJobData
  | DispatchBackupJobData
  | ProcessResultsJobData
  | DispatchRestoreJobData;

// ── Worker ────────────────────────────────────────────────────────────────────

function createBackupWorker(): Worker<BackupJobData> {
  return new Worker<BackupJobData>(
    BACKUP_QUEUE,
    async (job: Job<BackupJobData>) => {
      return runWithSystemDbAccess(async () => {
        switch (job.data.type) {
          case 'check-schedules':
            return await processCheckSchedules();
          case 'dispatch-backup':
            return await processDispatchBackup(job.data);
          case 'process-results':
            return await processResults(job.data);
          case 'dispatch-restore':
            return await processDispatchRestore(job.data);
          default:
            throw new Error(
              `Unknown job type: ${(job.data as { type: string }).type}`
            );
        }
      });
    },
    {
      connection: getRedisConnection(),
      concurrency: 5,
    }
  );
}

// ── check-schedules ───────────────────────────────────────────────────────────

type PolicySchedule = {
  frequency?: 'daily' | 'weekly' | 'monthly';
  time?: string;
  timezone?: string;
  dayOfWeek?: number;
  dayOfMonth?: number;
};

type PolicyTargets = {
  deviceIds?: string[];
  siteIds?: string[];
  groupIds?: string[];
};

async function processCheckSchedules(): Promise<{ enqueued: number }> {
  const now = new Date();

  const policies = await db
    .select()
    .from(backupPolicies)
    .where(eq(backupPolicies.enabled, true));

  if (policies.length === 0) return { enqueued: 0 };

  let enqueued = 0;

  for (const policy of policies) {
    const schedule = policy.schedule as PolicySchedule | null;
    if (!schedule?.frequency || !schedule.time) continue;

    // Check if due now (simple: compare hour:minute)
    const [schedHour, schedMin] = (schedule.time ?? '02:00')
      .split(':')
      .map(Number);
    const currentHour = now.getUTCHours();
    const currentMin = now.getUTCMinutes();

    // Only trigger within the schedule minute window
    if (currentHour !== schedHour || currentMin !== schedMin) continue;

    // Check day-of-week for weekly
    if (
      schedule.frequency === 'weekly' &&
      typeof schedule.dayOfWeek === 'number' &&
      now.getUTCDay() !== schedule.dayOfWeek
    ) {
      continue;
    }

    // Check day-of-month for monthly
    if (
      schedule.frequency === 'monthly' &&
      typeof schedule.dayOfMonth === 'number' &&
      now.getUTCDate() !== schedule.dayOfMonth
    ) {
      continue;
    }

    // Deduplicate: check if already created a job this minute
    const minuteStart = new Date(now);
    minuteStart.setSeconds(0, 0);
    const minuteEnd = new Date(minuteStart.getTime() + 60_000);

    const [existing] = await db
      .select({ id: backupJobs.id })
      .from(backupJobs)
      .where(
        and(
          eq(backupJobs.policyId, policy.id),
          sql`${backupJobs.createdAt} >= ${minuteStart.toISOString()}::timestamptz`,
          sql`${backupJobs.createdAt} < ${minuteEnd.toISOString()}::timestamptz`
        )
      )
      .limit(1);

    if (existing) continue;

    // Resolve target devices
    const targets = policy.targets as PolicyTargets;
    const deviceIds = targets?.deviceIds ?? [];

    // TODO: Resolve siteIds and groupIds to deviceIds in the future
    for (const deviceId of deviceIds) {
      const [job] = await db
        .insert(backupJobs)
        .values({
          orgId: policy.orgId,
          configId: policy.configId,
          policyId: policy.id,
          deviceId,
          status: 'pending',
          type: 'scheduled',
          createdAt: now,
          updatedAt: now,
        })
        .returning();

      if (job) {
        await enqueueBackupDispatch(
          job.id,
          job.configId,
          policy.orgId,
          deviceId
        );
        enqueued++;
      }
    }
  }

  if (enqueued > 0) {
    console.log(
      `[BackupWorker] Scheduled ${enqueued} backup job(s) from policies`
    );
  }

  return { enqueued };
}

// ── dispatch-backup ───────────────────────────────────────────────────────────

async function processDispatchBackup(
  data: DispatchBackupJobData
): Promise<{ dispatched: boolean }> {
  // Load config for command payload
  const [config] = await db
    .select()
    .from(backupConfigs)
    .where(eq(backupConfigs.id, data.configId))
    .limit(1);

  if (!config) {
    await markJobFailed(data.jobId, 'Backup config not found');
    return { dispatched: false };
  }

  // Find the agent for this device
  const [device] = await db
    .select({ agentId: devices.agentId })
    .from(devices)
    .where(eq(devices.id, data.deviceId))
    .limit(1);

  const agentId = device?.agentId;
  if (!agentId || !isAgentConnected(agentId)) {
    await markJobFailed(data.jobId, 'Agent not connected');
    return { dispatched: false };
  }

  const providerConfig = config.providerConfig as Record<string, unknown>;

  const command: AgentCommand = {
    id: data.jobId,
    type: 'backup_run',
    payload: {
      jobId: data.jobId,
      configId: data.configId,
      provider: config.provider,
      providerConfig,
      paths: providerConfig.paths ?? [],
    },
  };

  const sent = sendCommandToAgent(agentId, command);
  if (!sent) {
    await markJobFailed(data.jobId, 'Failed to send command to agent');
    return { dispatched: false };
  }

  await db
    .update(backupJobs)
    .set({
      status: 'running',
      startedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(backupJobs.id, data.jobId));

  console.log(
    `[BackupWorker] Backup dispatched to agent ${agentId} for job ${data.jobId}`
  );
  return { dispatched: true };
}

// ── process-results ───────────────────────────────────────────────────────────

async function processResults(
  data: ProcessResultsJobData
): Promise<{ processed: boolean }> {
  const result = data.result;

  const updateData: Record<string, unknown> = {
    updatedAt: new Date(),
    completedAt: new Date(),
  };

  if (result.status === 'completed') {
    updateData.status = 'completed';
    updateData.fileCount = result.filesBackedUp ?? null;
    updateData.totalSize = result.bytesBackedUp ?? null;
    if (result.warning) {
      updateData.errorLog = result.warning;
    }
  } else {
    updateData.status = 'failed';
    updateData.errorLog = result.error ?? result.warning ?? 'Unknown error';
  }

  if (result.snapshotId) {
    updateData.snapshotId = result.snapshotId;
  }

  await db
    .update(backupJobs)
    .set(updateData)
    .where(eq(backupJobs.id, data.jobId));

  // Create snapshot row if successful
  if (result.status === 'completed' && result.snapshotId) {
    // Look up configId from the job
    const [job] = await db
      .select({ configId: backupJobs.configId })
      .from(backupJobs)
      .where(eq(backupJobs.id, data.jobId))
      .limit(1);

    await db.insert(backupSnapshots).values({
      orgId: data.orgId,
      jobId: data.jobId,
      deviceId: data.deviceId,
      configId: job?.configId ?? null,
      snapshotId: result.snapshotId,
      label: `Backup ${new Date().toISOString().slice(0, 10)}`,
      size: result.bytesBackedUp ?? null,
      fileCount: result.filesBackedUp ?? null,
      timestamp: new Date(),
    });
  }

  console.log(
    `[BackupWorker] Job ${data.jobId} result processed: ${result.status}`
  );
  return { processed: true };
}

// ── dispatch-restore ──────────────────────────────────────────────────────────

async function processDispatchRestore(
  data: DispatchRestoreJobData
): Promise<{ dispatched: boolean }> {
  // Find the agent for this device
  const [device] = await db
    .select({ agentId: devices.agentId })
    .from(devices)
    .where(eq(devices.id, data.deviceId))
    .limit(1);

  const agentId = device?.agentId;
  if (!agentId || !isAgentConnected(agentId)) {
    await db
      .update(restoreJobs)
      .set({
        status: 'failed',
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(restoreJobs.id, data.restoreJobId));
    return { dispatched: false };
  }

  const command: AgentCommand = {
    id: data.restoreJobId,
    type: 'backup_restore',
    payload: {
      restoreJobId: data.restoreJobId,
      snapshotId: data.snapshotId,
      targetPath: data.targetPath ?? '',
      selectedPaths: data.selectedPaths ?? [],
    },
  };

  const sent = sendCommandToAgent(agentId, command);
  if (!sent) {
    await db
      .update(restoreJobs)
      .set({
        status: 'failed',
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(restoreJobs.id, data.restoreJobId));
    return { dispatched: false };
  }

  await db
    .update(restoreJobs)
    .set({
      status: 'running',
      startedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(restoreJobs.id, data.restoreJobId));

  console.log(
    `[BackupWorker] Restore dispatched to agent ${agentId} for job ${data.restoreJobId}`
  );
  return { dispatched: true };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function markJobFailed(jobId: string, error: string): Promise<void> {
  await db
    .update(backupJobs)
    .set({
      status: 'failed',
      completedAt: new Date(),
      errorLog: error,
      updatedAt: new Date(),
    })
    .where(eq(backupJobs.id, jobId));
}

// ── Public enqueue functions ──────────────────────────────────────────────────

export async function enqueueBackupDispatch(
  jobId: string,
  configId: string,
  orgId: string,
  deviceId: string
): Promise<string> {
  const queue = getBackupQueue();
  const job = await queue.add(
    'dispatch-backup',
    {
      type: 'dispatch-backup' as const,
      jobId,
      configId,
      orgId,
      deviceId,
    },
    {
      removeOnComplete: { count: 50 },
      removeOnFail: { count: 100 },
    }
  );
  return job.id!;
}

export async function enqueueBackupResults(
  jobId: string,
  orgId: string,
  deviceId: string,
  result: ProcessResultsJobData['result']
): Promise<string> {
  const queue = getBackupQueue();
  const job = await queue.add(
    'process-results',
    {
      type: 'process-results' as const,
      jobId,
      orgId,
      deviceId,
      result,
    },
    {
      removeOnComplete: { count: 50 },
      removeOnFail: { count: 100 },
    }
  );
  return job.id!;
}

export async function enqueueRestoreDispatch(
  restoreJobId: string,
  snapshotId: string,
  deviceId: string,
  orgId: string,
  targetPath?: string,
  selectedPaths?: string[]
): Promise<string> {
  const queue = getBackupQueue();
  const job = await queue.add(
    'dispatch-restore',
    {
      type: 'dispatch-restore' as const,
      restoreJobId,
      snapshotId,
      deviceId,
      orgId,
      targetPath,
      selectedPaths,
    },
    {
      removeOnComplete: { count: 50 },
      removeOnFail: { count: 100 },
    }
  );
  return job.id!;
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

let backupWorkerInstance: Worker<BackupJobData> | null = null;

export async function initializeBackupWorker(): Promise<void> {
  try {
    backupWorkerInstance = createBackupWorker();

    backupWorkerInstance.on('error', (error) => {
      console.error('[BackupWorker] Worker error:', error);
    });

    backupWorkerInstance.on('failed', (job, error) => {
      console.error(`[BackupWorker] Job ${job?.id} failed:`, error);
    });

    // Schedule recurring check-schedules job (every 60s)
    const queue = getBackupQueue();
    const newJob = await queue.add(
      'check-schedules',
      { type: 'check-schedules' as const },
      {
        repeat: { every: 60_000 },
        removeOnComplete: { count: 10 },
        removeOnFail: { count: 20 },
      }
    );

    // Clean up stale repeatable jobs
    const repeatable = await queue.getRepeatableJobs();
    for (const job of repeatable) {
      if (
        job.name === 'check-schedules' &&
        job.key !== newJob.repeatJobKey
      ) {
        await queue.removeRepeatableByKey(job.key);
      }
    }

    console.log('[BackupWorker] Backup worker initialized');
  } catch (error) {
    console.error('[BackupWorker] Failed to initialize:', error);
    throw error;
  }
}

export async function shutdownBackupWorker(): Promise<void> {
  if (backupWorkerInstance) {
    await backupWorkerInstance.close();
    backupWorkerInstance = null;
  }

  if (backupQueue) {
    await backupQueue.close();
    backupQueue = null;
  }

  console.log('[BackupWorker] Backup worker shut down');
}
