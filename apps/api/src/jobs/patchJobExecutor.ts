/**
 * Patch Job Executor
 *
 * Two BullMQ queues:
 *   - patch-jobs:        orchestration (pick up job, fan out to devices)
 *   - patch-job-devices: per-device execution (resolve patches, install, reboot)
 */

import { Queue, Worker, Job } from 'bullmq';
import * as dbModule from '../db';
import {
  patchJobs,
  patchJobResults,
  patches,
  patchPolicies,
  devices,
  deviceCommands,
} from '../db/schema';
import { eq, and, sql, inArray } from 'drizzle-orm';
import { getRedisConnection } from '../services/redis';
import { resolveApprovedPatchesForDevice, type RingConfig } from '../services/patchApprovalEvaluator';
import { evaluateRebootPolicy, executeReboot } from '../services/patchRebootHandler';
import { queueCommandForExecution } from '../services/commandQueue';

const { db } = dbModule;
const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  return typeof withSystem === 'function' ? withSystem(fn) : fn();
};

// ============================================
// Queue names
// ============================================

const PATCH_JOB_QUEUE = 'patch-jobs';
const PATCH_JOB_DEVICE_QUEUE = 'patch-job-devices';

// ============================================
// Singleton queues
// ============================================

let patchJobQueue: Queue | null = null;
let patchJobDeviceQueue: Queue | null = null;

export function getPatchJobQueue(): Queue {
  if (!patchJobQueue) {
    patchJobQueue = new Queue(PATCH_JOB_QUEUE, {
      connection: getRedisConnection(),
    });
  }
  return patchJobQueue;
}

export function getPatchJobDeviceQueue(): Queue {
  if (!patchJobDeviceQueue) {
    patchJobDeviceQueue = new Queue(PATCH_JOB_DEVICE_QUEUE, {
      connection: getRedisConnection(),
    });
  }
  return patchJobDeviceQueue;
}

// ============================================
// Job data types
// ============================================

interface ExecutePatchJobData {
  type: 'execute-patch-job';
  patchJobId: string;
}

interface ExecutePatchJobDeviceData {
  type: 'execute-patch-job-device';
  patchJobId: string;
  deviceId: string;
  orgId: string;
}

interface CheckCompletionData {
  type: 'check-completion';
  patchJobId: string;
}

type PatchJobData = ExecutePatchJobData | CheckCompletionData;
type PatchJobDeviceData = ExecutePatchJobDeviceData;

// ============================================
// Enqueue helper (called from POST route and scheduler)
// ============================================

export async function enqueuePatchJob(patchJobId: string, delayMs?: number): Promise<void> {
  const queue = getPatchJobQueue();
  await queue.add(
    'execute-patch-job',
    { type: 'execute-patch-job', patchJobId } satisfies ExecutePatchJobData,
    delayMs ? { delay: delayMs } : undefined
  );
}

// ============================================
// Job orchestration worker
// ============================================

function createPatchJobWorker(): Worker<PatchJobData> {
  return new Worker<PatchJobData>(
    PATCH_JOB_QUEUE,
    async (job: Job<PatchJobData>) => {
      return runWithSystemDbAccess(async () => {
        switch (job.data.type) {
          case 'execute-patch-job':
            return processExecutePatchJob(job.data);
          case 'check-completion':
            return processCheckCompletion(job.data);
        }
      });
    },
    {
      connection: getRedisConnection(),
      concurrency: 5,
    }
  );
}

async function processExecutePatchJob(data: ExecutePatchJobData): Promise<unknown> {
  const { patchJobId } = data;

  // Load and verify job
  const [patchJob] = await db
    .select()
    .from(patchJobs)
    .where(eq(patchJobs.id, patchJobId))
    .limit(1);

  if (!patchJob) {
    console.error(`[PatchJobExecutor] Job ${patchJobId} not found`);
    return { error: 'Job not found' };
  }

  if (patchJob.status !== 'scheduled') {
    return { skipped: true, reason: `Job status is ${patchJob.status}` };
  }

  // Transition to running
  await db
    .update(patchJobs)
    .set({ status: 'running', startedAt: new Date() })
    .where(eq(patchJobs.id, patchJobId));

  // Extract target device IDs from the JSONB targets field
  const targets = patchJob.targets as { deviceIds?: string[] };
  const deviceIds = targets?.deviceIds ?? [];

  if (deviceIds.length === 0) {
    await db
      .update(patchJobs)
      .set({ status: 'completed', completedAt: new Date() })
      .where(eq(patchJobs.id, patchJobId));
    return { completed: true, reason: 'No target devices' };
  }

  // Fan out to per-device queue
  const deviceQueue = getPatchJobDeviceQueue();
  for (const deviceId of deviceIds) {
    await deviceQueue.add(
      'execute-patch-job-device',
      {
        type: 'execute-patch-job-device',
        patchJobId,
        deviceId,
        orgId: patchJob.orgId,
      } satisfies ExecutePatchJobDeviceData
    );
  }

  // Enqueue completion checker (35 min delay)
  const queue = getPatchJobQueue();
  await queue.add(
    'check-completion',
    { type: 'check-completion', patchJobId } satisfies CheckCompletionData,
    { delay: 35 * 60 * 1000 }
  );

  return { dispatched: deviceIds.length };
}

async function processCheckCompletion(data: CheckCompletionData): Promise<unknown> {
  const { patchJobId } = data;

  const [patchJob] = await db
    .select()
    .from(patchJobs)
    .where(eq(patchJobs.id, patchJobId))
    .limit(1);

  if (!patchJob || patchJob.status !== 'running') {
    return { skipped: true };
  }

  if (patchJob.devicesPending === 0) {
    const finalStatus = patchJob.devicesFailed > 0 ? 'failed' : 'completed';
    await db
      .update(patchJobs)
      .set({ status: finalStatus, completedAt: new Date() })
      .where(eq(patchJobs.id, patchJobId));
    return { finalStatus };
  }

  // Still has pending devices after timeout — mark remaining as failed
  await db
    .update(patchJobs)
    .set({
      status: 'failed',
      completedAt: new Date(),
      devicesFailed: sql`${patchJobs.devicesFailed} + ${patchJobs.devicesPending}`,
      devicesPending: 0,
    })
    .where(eq(patchJobs.id, patchJobId));

  return { timedOut: true, pendingAtTimeout: patchJob.devicesPending };
}

// ============================================
// Per-device execution worker
// ============================================

function createPatchJobDeviceWorker(): Worker<PatchJobDeviceData> {
  return new Worker<PatchJobDeviceData>(
    PATCH_JOB_DEVICE_QUEUE,
    async (job: Job<PatchJobDeviceData>) => {
      return runWithSystemDbAccess(async () => {
        return processExecuteDevice(job.data);
      });
    },
    {
      connection: getRedisConnection(),
      concurrency: 10,
    }
  );
}

async function processExecuteDevice(data: ExecutePatchJobDeviceData): Promise<unknown> {
  const { patchJobId, deviceId, orgId } = data;

  // Load job to get ring config
  const [patchJob] = await db
    .select()
    .from(patchJobs)
    .where(eq(patchJobs.id, patchJobId))
    .limit(1);

  if (!patchJob || patchJob.status === 'cancelled') {
    return { skipped: true, reason: 'Job not found or cancelled' };
  }

  // Extract ring config from job's patches JSONB
  const patchesConfig = patchJob.patches as {
    ringId?: string | null;
    categoryRules?: unknown[];
    autoApprove?: unknown;
  };
  const targets = patchJob.targets as {
    deployment?: { rebootPolicy?: string };
  };

  const ringConfig: RingConfig = {
    ringId: patchesConfig?.ringId ?? null,
    categoryRules: (Array.isArray(patchesConfig?.categoryRules)
      ? patchesConfig.categoryRules
      : []) as RingConfig['categoryRules'],
    autoApprove: patchesConfig?.autoApprove ?? {},
    deferralDays: 0,
  };

  // If we have a ringId, load deferralDays from the ring
  if (ringConfig.ringId) {
    const [ring] = await db
      .select({ deferralDays: patchPolicies.deferralDays })
      .from(patchPolicies)
      .where(eq(patchPolicies.id, ringConfig.ringId))
      .limit(1);
    if (ring) {
      ringConfig.deferralDays = ring.deferralDays;
    }
  }

  // 1. Resolve approved patches
  let approvedPatches;
  try {
    approvedPatches = await resolveApprovedPatchesForDevice(deviceId, orgId, ringConfig);
  } catch (err) {
    console.error(`[PatchJobExecutor] Failed to resolve patches for device ${deviceId}:`, err instanceof Error ? err.message : err);
    await markDeviceSkipped(patchJobId, deviceId, 'error_resolving_patches');
    return { error: 'Failed to resolve patches' };
  }

  // 2. No approved patches → skip
  if (approvedPatches.length === 0) {
    await markDeviceSkipped(patchJobId, deviceId, 'no_approved_patches');
    return { skipped: true, reason: 'No approved patches' };
  }

  // 3. Send install_patches command
  const patchIds = approvedPatches.map((p) => p.patchId);
  const patchRecords = await db
    .select({
      id: patches.id,
      source: patches.source,
      externalId: patches.externalId,
      title: patches.title,
    })
    .from(patches)
    .where(inArray(patches.id, patchIds));

  const cmdResult = await queueCommandForExecution(deviceId, 'install_patches', {
    patchIds,
    patches: patchRecords,
  });

  if (cmdResult.error) {
    // Device likely offline
    await markDeviceSkipped(patchJobId, deviceId, 'device_offline');
    return { error: cmdResult.error };
  }

  const commandId = cmdResult.command?.id;
  if (!commandId) {
    await markDeviceSkipped(patchJobId, deviceId, 'command_creation_failed');
    return { error: 'Failed to create command' };
  }

  // 4. Poll for result (5s interval, 30min timeout)
  const timeoutMs = 30 * 60 * 1000;
  const pollInterval = 5000;
  let elapsed = 0;
  let finalCommand: typeof cmdResult.command | null = null;

  while (elapsed < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
    elapsed += pollInterval;

    const [updated] = await db
      .select()
      .from(deviceCommands)
      .where(eq(deviceCommands.id, commandId))
      .limit(1);

    if (!updated) break;

    if (updated.status === 'completed' || updated.status === 'failed') {
      finalCommand = updated as typeof cmdResult.command;
      break;
    }
  }

  // 5. Parse result and record outcomes
  const commandResult = finalCommand?.result as {
    stdout?: string;
    stderr?: string;
    error?: string;
    exitCode?: number;
  } | null;

  let parsedResult: {
    success?: boolean;
    results?: Array<{
      patchId?: string;
      externalId?: string;
      success?: boolean;
      error?: string;
      rebootRequired?: boolean;
    }>;
    rebootRequired?: boolean;
    installedCount?: number;
    failedCount?: number;
  } | null = null;

  if (commandResult?.stdout) {
    try {
      parsedResult = JSON.parse(commandResult.stdout);
    } catch {
      // Non-JSON stdout
    }
  }

  const overallSuccess = finalCommand?.status === 'completed' &&
    (parsedResult?.success ?? true) &&
    (typeof commandResult?.exitCode !== 'number' || commandResult.exitCode === 0);

  const anyRebootRequired = parsedResult?.rebootRequired ??
    approvedPatches.some((p) => p.requiresReboot);

  // 6. Insert patchJobResults per patch
  for (const patch of approvedPatches) {
    const perPatchResult = parsedResult?.results?.find(
      (r) => r.patchId === patch.patchId || r.externalId === patch.externalId
    );

    const patchSuccess = perPatchResult?.success ?? overallSuccess;

    await db.insert(patchJobResults).values({
      jobId: patchJobId,
      deviceId,
      patchId: patch.patchId,
      status: !finalCommand ? 'failed' : patchSuccess ? 'completed' : 'failed',
      startedAt: new Date(),
      completedAt: finalCommand ? new Date() : null,
      exitCode: commandResult?.exitCode ?? null,
      output: perPatchResult?.error ?? commandResult?.stdout?.substring(0, 2000) ?? null,
      errorMessage: !finalCommand
        ? 'Command timed out'
        : !patchSuccess
          ? (perPatchResult?.error ?? commandResult?.error ?? commandResult?.stderr ?? null)
          : null,
      rebootRequired: perPatchResult?.rebootRequired ?? patch.requiresReboot,
    });
  }

  // 7. Evaluate reboot policy
  const rebootPolicy = targets?.deployment?.rebootPolicy ?? 'if_required';
  if (overallSuccess) {
    const rebootEval = await evaluateRebootPolicy(deviceId, rebootPolicy, anyRebootRequired);
    if (rebootEval.shouldReboot) {
      await executeReboot(deviceId, rebootEval.reason);
    }
  }

  // 8. Update job counters
  if (overallSuccess) {
    await db
      .update(patchJobs)
      .set({
        devicesCompleted: sql`${patchJobs.devicesCompleted} + 1`,
        devicesPending: sql`${patchJobs.devicesPending} - 1`,
      })
      .where(eq(patchJobs.id, patchJobId));
  } else {
    await db
      .update(patchJobs)
      .set({
        devicesFailed: sql`${patchJobs.devicesFailed} + 1`,
        devicesPending: sql`${patchJobs.devicesPending} - 1`,
      })
      .where(eq(patchJobs.id, patchJobId));
  }

  // 9. Check if this was the last device
  await checkAndFinalizeJob(patchJobId);

  return {
    deviceId,
    patchCount: approvedPatches.length,
    success: overallSuccess,
  };
}

// ============================================
// Helpers
// ============================================

async function markDeviceSkipped(
  patchJobId: string,
  deviceId: string,
  reason: string
): Promise<void> {
  // Insert a single summary result for the skipped device
  // Use a nil UUID for patchId since no specific patch was targeted
  await db.insert(patchJobResults).values({
    jobId: patchJobId,
    deviceId,
    patchId: '00000000-0000-0000-0000-000000000000',
    status: 'skipped',
    startedAt: new Date(),
    completedAt: new Date(),
    errorMessage: reason,
    rebootRequired: false,
  });

  // Update counters — skipped devices count as completed, not failed
  await db
    .update(patchJobs)
    .set({
      devicesCompleted: sql`${patchJobs.devicesCompleted} + 1`,
      devicesPending: sql`${patchJobs.devicesPending} - 1`,
    })
    .where(eq(patchJobs.id, patchJobId));

  await checkAndFinalizeJob(patchJobId);
}

async function checkAndFinalizeJob(patchJobId: string): Promise<void> {
  const [job] = await db
    .select({
      status: patchJobs.status,
      devicesPending: patchJobs.devicesPending,
      devicesFailed: patchJobs.devicesFailed,
    })
    .from(patchJobs)
    .where(eq(patchJobs.id, patchJobId))
    .limit(1);

  if (!job || job.status !== 'running') return;

  if (job.devicesPending <= 0) {
    const finalStatus = job.devicesFailed > 0 ? 'failed' : 'completed';
    await db
      .update(patchJobs)
      .set({ status: finalStatus, completedAt: new Date() })
      .where(
        and(
          eq(patchJobs.id, patchJobId),
          eq(patchJobs.status, 'running')
        )
      );
  }
}

// ============================================
// Worker lifecycle
// ============================================

let jobWorker: Worker | null = null;
let deviceWorker: Worker | null = null;

export async function initializePatchJobWorkers(): Promise<void> {
  jobWorker = createPatchJobWorker();
  deviceWorker = createPatchJobDeviceWorker();
  console.log('[PatchJobExecutor] Workers initialized');
}

export async function shutdownPatchJobWorkers(): Promise<void> {
  await Promise.all([
    jobWorker?.close(),
    deviceWorker?.close(),
    patchJobQueue?.close(),
    patchJobDeviceQueue?.close(),
  ]);
  jobWorker = null;
  deviceWorker = null;
  patchJobQueue = null;
  patchJobDeviceQueue = null;
}
