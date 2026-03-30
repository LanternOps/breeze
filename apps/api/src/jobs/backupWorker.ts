/**
 * Backup Worker
 *
 * BullMQ worker that orchestrates backup jobs:
 * - check-schedules: Polls config policy backup assignments, creates jobs when due
 * - dispatch-backup: Sends backup_run command to agent via WebSocket
 * - process-results: Updates job/snapshot rows from agent result payload
 * - dispatch-restore: Sends backup_restore command to agent
 */

import { Worker, Job } from 'bullmq';
import * as dbModule from '../db';
import {
  backupJobs,
  backupSnapshots,
  backupConfigs,
  restoreJobs,
  devices,
  configurationPolicies,
  configPolicyFeatureLinks,
  configPolicyBackupSettings,
  hypervVms,
  sqlInstances,
} from '../db/schema';
import { eq, and, sql } from 'drizzle-orm';
import { resolveAllBackupAssignedDevices } from '../services/featureConfigResolver';
import { getRedisConnection } from '../services/redis';
import {
  sendCommandToAgent,
  isAgentConnected,
  type AgentCommand,
} from '../routes/agentWs';
import {
  applyGfsTagsToSnapshot,
  computeExpiresAt,
  resolveGfsConfigForJob,
} from './backupRetention';
import * as backupEnqueue from './backupEnqueue';

// Re-export enqueue functions for backward compatibility
export const getBackupQueue = backupEnqueue.getBackupQueue;
export const enqueueBackupDispatch = backupEnqueue.enqueueBackupDispatch;
export const enqueueBackupResults = backupEnqueue.enqueueBackupResults;
export const enqueueRestoreDispatch = backupEnqueue.enqueueRestoreDispatch;

const { db } = dbModule;
const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  return typeof withSystem === 'function' ? withSystem(fn) : fn();
};
const BACKUP_QUEUE = 'backup';

// ── Job data types ────────────────────────────────────────────────────────────

interface CheckSchedulesJobData { type: 'check-schedules' }
interface DispatchBackupJobData { type: 'dispatch-backup'; jobId: string; configId: string; orgId: string; deviceId: string }
interface ProcessResultsJobData {
  type: 'process-results'; jobId: string; orgId: string; deviceId: string;
  result: { status: string; jobId?: string; snapshotId?: string; filesBackedUp?: number; bytesBackedUp?: number; warning?: string; error?: string };
}
interface DispatchRestoreJobData {
  type: 'dispatch-restore'; restoreJobId: string; snapshotId: string;
  deviceId: string; orgId: string; targetPath?: string; selectedPaths?: string[];
}
type BackupJobData = CheckSchedulesJobData | DispatchBackupJobData | ProcessResultsJobData | DispatchRestoreJobData;

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
      lockDuration: 300_000,
      stalledInterval: 60_000,
      maxStalledCount: 2,
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

async function processCheckSchedules(): Promise<{ enqueued: number }> {
  const now = new Date();

  // 1. Find all org IDs with active backup config policies
  const orgRows = await db
    .selectDistinct({ orgId: configurationPolicies.orgId })
    .from(configurationPolicies)
    .innerJoin(
      configPolicyFeatureLinks,
      and(
        eq(configPolicyFeatureLinks.configPolicyId, configurationPolicies.id),
        eq(configPolicyFeatureLinks.featureType, 'backup')
      )
    )
    .where(eq(configurationPolicies.status, 'active'));

  if (orgRows.length === 0) return { enqueued: 0 };

  let enqueued = 0;

  // 2. For each org, resolve all backup-assigned devices via config policy hierarchy
  for (const { orgId } of orgRows) {
    try {
      const entries = await resolveAllBackupAssignedDevices(orgId);

      for (const entry of entries) {
        // configId (featurePolicyId → backupConfigs.id) is required for dispatch
        if (!entry.configId) {
          console.warn(`[BackupWorker] Skipping device ${entry.deviceId}: feature link ${entry.featureLinkId} has no configId`);
          continue;
        }

        const schedule = entry.settings?.schedule as PolicySchedule | null;
        if (!schedule?.frequency || !schedule.time) continue;

        // Check if due now (simple: compare hour:minute in UTC)
        const [schedHour, schedMin] = (schedule.time ?? '02:00')
          .split(':')
          .map(Number);
        const currentHour = now.getUTCHours();
        const currentMin = now.getUTCMinutes();

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

        // 4. Deduplicate: check for existing jobs this minute using featureLinkId + deviceId
        const minuteStart = new Date(now);
        minuteStart.setSeconds(0, 0);
        const minuteEnd = new Date(minuteStart.getTime() + 60_000);

        const [existing] = await db
          .select({ id: backupJobs.id })
          .from(backupJobs)
          .where(
            and(
              eq(backupJobs.featureLinkId, entry.featureLinkId),
              eq(backupJobs.deviceId, entry.deviceId),
              sql`${backupJobs.createdAt} >= ${minuteStart.toISOString()}::timestamptz`,
              sql`${backupJobs.createdAt} < ${minuteEnd.toISOString()}::timestamptz`
            )
          )
          .limit(1);

        if (existing) continue;

        // 5. Create job with featureLinkId and configId from resolver
        const [job] = await db
          .insert(backupJobs)
          .values({
            orgId,
            configId: entry.configId,
            featureLinkId: entry.featureLinkId,
            deviceId: entry.deviceId,
            status: 'pending',
            type: 'scheduled',
            createdAt: now,
            updatedAt: now,
          })
          .returning();

        if (job) {
          // 6. Enqueue dispatch
          await enqueueBackupDispatch(
            job.id,
            job.configId,
            orgId,
            entry.deviceId
          );
          enqueued++;
        }
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[BackupWorker] Failed to process scheduled backups for org ${orgId}: ${errMsg}`);
      if (err instanceof Error && err.stack) {
        console.error(err.stack);
      }
      continue;
    }
  }

  if (enqueued > 0) {
    console.log(
      `[BackupWorker] Scheduled ${enqueued} backup job(s) from config policies`
    );
  }

  return { enqueued };
}

// ── Backup target resolution ─────────────────────────────────────────────────

export interface BackupTarget {
  commandType: string;
  payload: Record<string, unknown>;
}

/**
 * Resolves backup mode + targets into one or more typed commands.
 *
 * For file/system_image, returns a single backup_run command.
 * For hyperv, queries discovered VMs and returns one hyperv_backup per VM (minus excludes).
 * For mssql, queries discovered SQL instances and returns one mssql_backup per database (minus excludes).
 */
export async function resolveBackupTargets(
  backupMode: string,
  targets: Record<string, unknown>,
  deviceId: string
): Promise<BackupTarget[]> {
  switch (backupMode) {
    case 'file': {
      const t = targets as { paths?: string[] };
      return [{ commandType: 'backup_run', payload: { paths: t.paths ?? [] } }];
    }

    case 'system_image':
      return [{ commandType: 'backup_run', payload: { systemImage: true } }];

    case 'hyperv': {
      const t = targets as {
        consistencyType?: string;
        excludeVms?: string[];
      };
      const vms = await db
        .select({ vmName: hypervVms.vmName })
        .from(hypervVms)
        .where(eq(hypervVms.deviceId, deviceId));

      const excludeSet = new Set(t.excludeVms ?? []);
      return vms
        .filter((vm) => !excludeSet.has(vm.vmName))
        .map((vm) => ({
          commandType: 'hyperv_backup',
          payload: {
            vmName: vm.vmName,
            consistencyType: t.consistencyType ?? 'application',
          },
        }));
    }

    case 'mssql': {
      const t = targets as {
        backupType?: string;
        excludeDatabases?: string[];
      };
      const instances = await db
        .select({
          instanceName: sqlInstances.instanceName,
          databases: sqlInstances.databases,
        })
        .from(sqlInstances)
        .where(eq(sqlInstances.deviceId, deviceId));

      const excludeSet = new Set(t.excludeDatabases ?? []);
      const results: BackupTarget[] = [];
      for (const inst of instances) {
        const dbs = (inst.databases as string[]) ?? [];
        for (const database of dbs) {
          if (!excludeSet.has(database)) {
            results.push({
              commandType: 'mssql_backup',
              payload: {
                instance: inst.instanceName,
                database,
                backupType: t.backupType ?? 'full',
              },
            });
          }
        }
      }
      return results;
    }

    default:
      return [{ commandType: 'backup_run', payload: {} }];
  }
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

  // Resolve backup mode from config policy backup settings (if feature link exists)
  const [job] = await db
    .select({ featureLinkId: backupJobs.featureLinkId })
    .from(backupJobs)
    .where(eq(backupJobs.id, data.jobId))
    .limit(1);

  let backupMode = 'file';
  let modeTargets: Record<string, unknown> = {};

  if (job?.featureLinkId) {
    const [settings] = await db
      .select({
        backupMode: configPolicyBackupSettings.backupMode,
        targets: configPolicyBackupSettings.targets,
      })
      .from(configPolicyBackupSettings)
      .where(eq(configPolicyBackupSettings.featureLinkId, job.featureLinkId))
      .limit(1);

    if (settings) {
      backupMode = settings.backupMode;
      modeTargets = (settings.targets as Record<string, unknown>) ?? {};
    }
  }

  // Resolve targets into typed commands based on backup mode
  const targets = await resolveBackupTargets(backupMode, modeTargets, data.deviceId);

  if (targets.length === 0) {
    console.log(`[BackupWorker] No targets resolved for job ${data.jobId} (mode=${backupMode}), marking completed`);
    await db
      .update(backupJobs)
      .set({ status: 'completed', completedAt: new Date(), updatedAt: new Date() })
      .where(eq(backupJobs.id, data.jobId));
    return { dispatched: false };
  }

  const providerConfig = config.providerConfig as Record<string, unknown>;
  let dispatched = false;

  for (const target of targets) {
    const command: AgentCommand = {
      id: data.jobId,
      type: target.commandType,
      payload: {
        jobId: data.jobId,
        configId: data.configId,
        provider: config.provider,
        providerConfig,
        ...target.payload,
      },
    };

    const sent = sendCommandToAgent(agentId, command);
    if (sent) {
      dispatched = true;
    } else {
      console.warn(`[BackupWorker] Failed to send ${target.commandType} command for job ${data.jobId}`);
    }
  }

  if (!dispatched) {
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
    `[BackupWorker] Dispatched ${targets.length} ${backupMode} command(s) to agent ${agentId} for job ${data.jobId}`
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

  // Create snapshot row if successful, then apply GFS tags
  if (result.status === 'completed' && result.snapshotId) {
    // Look up configId from the job
    const [job] = await db
      .select({ configId: backupJobs.configId })
      .from(backupJobs)
      .where(eq(backupJobs.id, data.jobId))
      .limit(1);

    const completedAt = new Date();

    const [snapshot] = await db
      .insert(backupSnapshots)
      .values({
        orgId: data.orgId,
        jobId: data.jobId,
        deviceId: data.deviceId,
        configId: job?.configId ?? null,
        snapshotId: result.snapshotId,
        label: `Backup ${completedAt.toISOString().slice(0, 10)}`,
        size: result.bytesBackedUp ?? null,
        fileCount: result.filesBackedUp ?? null,
        timestamp: completedAt,
      })
      .returning();

    // Apply GFS retention tags
    if (snapshot) {
      try {
        const tags = await applyGfsTagsToSnapshot(
          snapshot.id,
          completedAt,
          data.jobId
        );

        // Set expiration based on GFS config + tags
        const gfsConfig = await resolveGfsConfigForJob(data.jobId);
        const expiresAt = computeExpiresAt(completedAt, tags, gfsConfig);
        if (expiresAt) {
          await db
            .update(backupSnapshots)
            .set({ expiresAt })
            .where(eq(backupSnapshots.id, snapshot.id));
        }
      } catch (err) {
        console.error(
          `[BackupWorker] Failed to apply GFS tags to snapshot ${snapshot.id}:`,
          err instanceof Error ? err.message : err
        );
      }
    }
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
  const [device] = await db
    .select({ agentId: devices.agentId })
    .from(devices)
    .where(eq(devices.id, data.deviceId))
    .limit(1);

  const agentId = device?.agentId;
  if (!agentId || !isAgentConnected(agentId)) {
    await markRestoreFailed(data.restoreJobId);
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

  if (!sendCommandToAgent(agentId, command)) {
    await markRestoreFailed(data.restoreJobId);
    return { dispatched: false };
  }

  await db
    .update(restoreJobs)
    .set({ status: 'running', startedAt: new Date(), updatedAt: new Date() })
    .where(eq(restoreJobs.id, data.restoreJobId));

  console.log(`[BackupWorker] Restore dispatched to agent ${agentId} for job ${data.restoreJobId}`);
  return { dispatched: true };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function markJobFailed(jobId: string, error: string): Promise<void> {
  await db
    .update(backupJobs)
    .set({ status: 'failed', completedAt: new Date(), errorLog: error, updatedAt: new Date() })
    .where(eq(backupJobs.id, jobId));
}

async function markRestoreFailed(restoreJobId: string): Promise<void> {
  await db
    .update(restoreJobs)
    .set({ status: 'failed', completedAt: new Date(), updatedAt: new Date() })
    .where(eq(restoreJobs.id, restoreJobId));
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

  await backupEnqueue.closeBackupQueue();

  console.log('[BackupWorker] Backup worker shut down');
}
