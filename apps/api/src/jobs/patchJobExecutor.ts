/**
 * Patch Job Executor
 *
 * Two BullMQ queues:
 *   - patch-jobs:        orchestration (pick up job, fan out to devices)
 *   - patch-job-devices: per-device execution (resolve patches, install, reboot)
 */

import { Queue, Worker, Job } from 'bullmq';
import { z } from 'zod';
import { policyAppRuleSchema } from '@breeze/shared/validators';
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
import { getBullMQConnection } from '../services/redis';
import { isReusableState } from '../services/bullmqUtils';
import {
  resolveApprovedPatchesForDevice,
  type PolicyAppRule,
  type PolicyAutoApproveConfig,
  type RingConfig,
} from '../services/patchApprovalEvaluator';
import { evaluateRebootPolicy, executeReboot } from '../services/patchRebootHandler';
import { queueCommandForExecution } from '../services/commandQueue';
import { captureException } from '../services/sentry';

// Strict shape for patches.policyAutoApprove as stored in the job JSONB.
// deferralDays must be a valid non-negative integer when present — a malformed
// value must NOT be coerced to 0, because that silently removes the deferral
// safety window. Absent deferralDays is fine and defaults to 0.
const jobPolicyAutoApproveSchema = z.object({
  enabled: z.boolean(),
  severities: z.array(z.string()),
  deferralDays: z.number().int().min(0).optional(),
});

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
const PATCH_JOB_RETENTION = {
  removeOnComplete: { count: 100 },
  removeOnFail: { count: 200 },
} as const;
const PATCH_JOB_COMPLETION_RETENTION = {
  removeOnComplete: { count: 50 },
  removeOnFail: { count: 100 },
} as const;

// ============================================
// Singleton queues
// ============================================

let patchJobQueue: Queue | null = null;
let patchJobDeviceQueue: Queue | null = null;

// NOTE: BullMQ rejects a custom jobId containing ':' (it reserves that for the
// legacy 3-part repeatable-job form), so these ids use '-' as the separator.
// A ':' here silently breaks queue.add() — see #1101 (SNMP) for the same bug.
// patchJobId/deviceId are UUID-shaped (no ':'), so ids stay stable and unique.
function getPatchJobExecutionId(patchJobId: string): string {
  return `patch-job-${patchJobId}`;
}

function getPatchJobDeviceExecutionId(
  patchJobId: string,
  deviceId: string
): string {
  return `patch-job-device-${patchJobId}-${deviceId}`;
}

function getPatchJobCompletionId(patchJobId: string): string {
  return `patch-job-completion-${patchJobId}`;
}

async function resolveActiveQueueJob(queue: Queue, candidateIds: string[]) {
  for (const candidateId of candidateIds) {
    const existing = await queue.getJob(candidateId);
    if (!existing) continue;
    const state = await existing.getState();
    if (isReusableState(state)) {
      return existing;
    }
    if (state === 'completed' || state === 'failed') {
      await existing.remove().catch((error) => {
        console.error(`[PatchJobExecutor] Failed to remove stale job ${candidateId}:`, error);
      });
    }
  }

  return null;
}

export function getPatchJobQueue(): Queue {
  if (!patchJobQueue) {
    patchJobQueue = new Queue(PATCH_JOB_QUEUE, {
      connection: getBullMQConnection(),
    });
  }
  return patchJobQueue;
}

export function getPatchJobDeviceQueue(): Queue {
  if (!patchJobDeviceQueue) {
    patchJobDeviceQueue = new Queue(PATCH_JOB_DEVICE_QUEUE, {
      connection: getBullMQConnection(),
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
  const stableJobId = getPatchJobExecutionId(patchJobId);
  const existing = await resolveActiveQueueJob(queue, [stableJobId]);
  if (existing) {
    return;
  }
  await queue.add(
    'execute-patch-job',
    { type: 'execute-patch-job', patchJobId } satisfies ExecutePatchJobData,
    delayMs
      ? { ...PATCH_JOB_RETENTION, delay: delayMs, jobId: stableJobId }
      : { ...PATCH_JOB_RETENTION, jobId: stableJobId }
  );
}

// ============================================
// Orphan reconcile sweep (#1733)
// ============================================

// Grace period after a job's intended run time (scheduledAt) before the
// reconcile sweep will re-enqueue it. The scheduler enqueues the Redis job
// immediately after the DB commit, so a row whose run time only just passed is
// almost certainly mid-enqueue (or its execute-patch-job worker is about to
// claim it). Waiting a couple of minutes avoids racing the happy path and only
// acts on jobs that genuinely missed their enqueue (process restart /
// Redis-connection churn in the create->enqueue gap — the #1733 failure
// window).
const RECONCILE_MIN_AGE_MS = 2 * 60 * 1000;

// Upper bound on how far back the sweep looks (relative to scheduledAt). Matches
// the scheduler's occurrence-idempotency lookback (45 days): a `scheduled` row
// whose run time is older than this is well past any window we would still want
// to run, and re-enqueuing it would fire a long-stale patch run. Such rows are
// stuck for a different reason and should be surfaced/cleaned up rather than
// silently executed.
const RECONCILE_MAX_AGE_MS = 45 * 24 * 60 * 60 * 1000;

export interface StaleScheduledJob {
  id: string;
  scheduledAt: Date | null;
}

/**
 * Recover `patch_jobs` rows that committed with `status='scheduled'` but whose
 * Redis enqueue was lost (issue #1733). The scheduler inserts the row inside
 * its DB transaction and enqueues to BullMQ *after* the transaction commits and
 * outside the DB access context (deliberately, to avoid holding a pooled
 * connection idle-in-transaction across Redis round-trips — #1105). That gap is
 * not atomic: a process restart or Redis-connection failure between commit and
 * enqueue leaves the row with no queue job, and the occurrence-idempotency
 * guard then prevents the next scan from ever re-creating it.
 *
 * This sweep finds `scheduled` rows whose intended run time has passed (plus a
 * grace window) that have no active execute-patch-job queue entry and
 * re-enqueues them, preserving any remaining delay. `enqueuePatchJob` is
 * idempotent on the stable jobId, and `processExecutePatchJob` re-checks
 * `status='scheduled'` under a conditional UPDATE, so re-enqueuing a job that is
 * actually fine (or already running) is a safe no-op.
 *
 * The window is keyed off `scheduledAt`, NOT `createdAt`: the POST creation
 * route (`configurationPolicies/patchJobs.ts`) lets an operator schedule a job
 * for a future `scheduledAt` and enqueues it with a matching BullMQ delay. If we
 * gated on `createdAt`, a future-scheduled row whose delayed enqueue was lost
 * would become "stale" 2 minutes after creation and the sweep would re-enqueue
 * it with no delay — firing the patch run up to 45 days early. `scheduledAt` is
 * nullable; scheduler rows always set it to the run time, and we COALESCE to
 * `createdAt` for any legacy/null row so it stays recoverable.
 *
 * Split into two phases so the caller can keep the DB read inside its system DB
 * access context and the Redis round-trips outside it (#1105):
 *   1. selectStaleScheduledJobIds — DB-only; the scheduled rows past the grace
 *      window. Runs inside the DB context.
 *   2. filterOrphanedJobIds — Redis-only; drops ids that already have an active
 *      queue job. Runs outside the DB context, alongside the enqueue.
 */
export async function selectStaleScheduledJobIds(now: Date = new Date()): Promise<StaleScheduledJob[]> {
  const minAge = new Date(now.getTime() - RECONCILE_MIN_AGE_MS);
  const maxAge = new Date(now.getTime() - RECONCILE_MAX_AGE_MS);

  // Effective run time = scheduledAt when set, else createdAt (non-null). The
  // [maxAge, minAge) window over that value only re-enqueues rows whose run time
  // has actually passed (so we never fire early) but not so long ago that firing
  // them would run a long-stale patch window. Dates are bound as ISO strings —
  // postgres.js can't serialize a raw Date param inside a sql template (it must
  // be a string/Buffer); the repo's other windowed sweeps do the same (see
  // staleCommandReaper.ts).
  const effectiveRunTime = sql`COALESCE(${patchJobs.scheduledAt}, ${patchJobs.createdAt})`;

  const candidates = await db
    .select({ id: patchJobs.id, scheduledAt: patchJobs.scheduledAt })
    .from(patchJobs)
    .where(
      and(
        eq(patchJobs.status, 'scheduled'),
        sql`${effectiveRunTime} < ${minAge.toISOString()}`,
        sql`${effectiveRunTime} >= ${maxAge.toISOString()}`
      )
    );

  return candidates.map((row) => ({ id: row.id, scheduledAt: row.scheduledAt }));
}

/**
 * Of the given `scheduled` jobs, return those with no active execute-patch-job
 * queue entry — i.e. the rows whose enqueue was lost (#1733). Pure Redis reads;
 * run this outside the DB access context. Carries `scheduledAt` through so the
 * caller can re-enqueue with the correct remaining delay.
 */
export async function filterOrphanedJobIds(jobs: StaleScheduledJob[]): Promise<StaleScheduledJob[]> {
  if (jobs.length === 0) return [];
  const queue = getPatchJobQueue();
  const orphaned: StaleScheduledJob[] = [];
  for (const job of jobs) {
    const stableJobId = getPatchJobExecutionId(job.id);
    const existing = await resolveActiveQueueJob(queue, [stableJobId]);
    if (!existing) {
      orphaned.push(job);
    }
  }
  return orphaned;
}

// ============================================
// Job orchestration worker
// ============================================

export function createPatchJobWorker(): Worker<PatchJobData> {
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
      connection: getBullMQConnection(),
      concurrency: 5,
      lockDuration: 300_000,
      stalledInterval: 60_000,
      maxStalledCount: 2,
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
  const claimed = await db
    .update(patchJobs)
    .set({ status: 'running', startedAt: new Date() })
    .where(and(eq(patchJobs.id, patchJobId), eq(patchJobs.status, 'scheduled')))
    .returning({ id: patchJobs.id });

  if (claimed.length === 0) {
    return { skipped: true, reason: 'Job was already claimed' };
  }

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
    const stableJobId = getPatchJobDeviceExecutionId(patchJobId, deviceId);
    const existing = await resolveActiveQueueJob(deviceQueue, [stableJobId]);
    if (!existing) {
      await deviceQueue.add(
        'execute-patch-job-device',
        {
          type: 'execute-patch-job-device',
          patchJobId,
          deviceId,
          orgId: patchJob.orgId,
        } satisfies ExecutePatchJobDeviceData,
        {
          ...PATCH_JOB_RETENTION,
          jobId: stableJobId,
        }
      );
    }
  }

  // Enqueue completion checker (35 min delay)
  const queue = getPatchJobQueue();
  const completionJobId = getPatchJobCompletionId(patchJobId);
  const existingCompletion = await resolveActiveQueueJob(queue, [completionJobId]);
  if (!existingCompletion) {
    await queue.add(
      'check-completion',
      { type: 'check-completion', patchJobId } satisfies CheckCompletionData,
      { ...PATCH_JOB_COMPLETION_RETENTION, delay: 35 * 60 * 1000, jobId: completionJobId }
    );
  }

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

export function createPatchJobDeviceWorker(): Worker<PatchJobDeviceData> {
  return new Worker<PatchJobDeviceData>(
    PATCH_JOB_DEVICE_QUEUE,
    async (job: Job<PatchJobDeviceData>) => {
      // NOT wrapped in one runWithSystemDbAccess: processExecuteDevice manages its
      // own short contexts so the up-to-30-min completion poll never holds a
      // pooled connection in an open transaction (#1105 conn-hold that starved
      // the DB pool under concurrency 10 → user-facing 503s).
      return processExecuteDevice(job.data);
    },
    {
      connection: getBullMQConnection(),
      concurrency: 10,
      lockDuration: 300_000,
      stalledInterval: 60_000,
      maxStalledCount: 2,
    }
  );
}

type PreparedDeviceExecution = {
  commandId: string;
  approvedPatches: Awaited<ReturnType<typeof resolveApprovedPatchesForDevice>>;
  targets: { deployment?: { rebootPolicy?: string } };
};

async function processExecuteDevice(data: ExecutePatchJobDeviceData): Promise<unknown> {
  // Phased so the up-to-30-min completion poll never holds a pooled connection
  // in an open transaction (#1105 conn-hold). Setup and record each run in their
  // own SHORT system context; the poll runs OUTSIDE any context.
  const prep = await runWithSystemDbAccess(() => prepareDeviceExecution(data));
  if (!('commandId' in prep)) return prep; // early skip/error result — return as-is
  const finalCommand = await pollForPatchCommandResult(prep.commandId);
  return runWithSystemDbAccess(() => recordDeviceExecution(data, prep, finalCommand));
}

async function prepareDeviceExecution(
  data: ExecutePatchJobDeviceData,
): Promise<PreparedDeviceExecution | { skipped: true; reason: string } | { error: string }> {
  const { patchJobId, deviceId, orgId } = data;

  // Load job to get ring config
  const [patchJob] = await db
    .select()
    .from(patchJobs)
    .where(eq(patchJobs.id, patchJobId))
    .limit(1);

  if (!patchJob || patchJob.status !== 'running') {
    return { skipped: true, reason: 'Job not running' };
  }

  if (orgId !== patchJob.orgId) {
    console.warn(
      `[PatchJobExecutor] Rejected device job ${patchJobId}/${deviceId}: queue org ${orgId} does not match patch job org ${patchJob.orgId}`
    );
    return { skipped: true, reason: 'Queued org does not match patch job org' };
  }

  const targetDeviceIds = Array.isArray((patchJob.targets as { deviceIds?: unknown })?.deviceIds)
    ? ((patchJob.targets as { deviceIds?: string[] }).deviceIds ?? [])
    : [];
  if (!targetDeviceIds.includes(deviceId)) {
    console.warn(
      `[PatchJobExecutor] Rejected device job ${patchJobId}/${deviceId}: device is not a target`
    );
    return { skipped: true, reason: 'Device is not targeted by patch job' };
  }

  const [device] = await db
    .select({ id: devices.id })
    .from(devices)
    .where(and(eq(devices.id, deviceId), eq(devices.orgId, patchJob.orgId)))
    .limit(1);

  if (!device) {
    console.warn(
      `[PatchJobExecutor] Rejected device job ${patchJobId}/${deviceId}: device is not in patch job org`
    );
    return { skipped: true, reason: 'Device not found in patch job org' };
  }

  // Extract ring config from job's patches JSONB
  const patchesConfig = patchJob.patches as {
    ringId?: string | null;
    categoryRules?: unknown[];
    autoApprove?: unknown;
    sources?: unknown;
    policyAutoApprove?: unknown;
    apps?: unknown;
  };
  const targets = patchJob.targets as {
    deployment?: { rebootPolicy?: string };
  };

  // Distinguish absent sources (legacy job → no filtering) from
  // present-but-malformed (shape drift / bad write). Present malformed sources
  // skip execution rather than widening to no filter.
  let jobSources: string[] | undefined;
  let malformedSources = false;
  if (patchesConfig?.sources !== undefined) {
    const raw = patchesConfig.sources;
    const strings = Array.isArray(raw) ? raw.filter((s): s is string => typeof s === 'string') : [];
    if (!Array.isArray(raw) || strings.length !== raw.length || strings.length === 0) {
      malformedSources = true;
      const message = `[PatchJobExecutor] Job ${patchJobId} has malformed patches.sources; skipping device to avoid widening install scope`;
      console.warn(`${message}:`, JSON.stringify(raw));
      captureException(new Error(message));
    } else {
      jobSources = strings;
    }
  }

  if (malformedSources) {
    await markDeviceSkipped(patchJobId, deviceId, 'invalid_patch_sources');
    return { skipped: true, reason: 'Invalid patch source filter' };
  }

  // Malformed auto-approve config degrades to disabled because silently
  // ENABLING auto-approval is the dangerous direction.
  let policyAutoApprove: PolicyAutoApproveConfig | undefined;
  if (patchesConfig?.policyAutoApprove !== undefined) {
    const parsed = jobPolicyAutoApproveSchema.safeParse(patchesConfig.policyAutoApprove);
    if (parsed.success) {
      policyAutoApprove = {
        enabled: parsed.data.enabled,
        severities: parsed.data.severities,
        deferralDays: parsed.data.deferralDays ?? 0,
      };
    } else {
      const message = `[PatchJobExecutor] Job ${patchJobId} has malformed patches.policyAutoApprove; treating as disabled`;
      console.warn(`${message}:`, JSON.stringify(patchesConfig.policyAutoApprove));
      captureException(new Error(message));
    }
  }

  // Malformed-but-identifiable rules coerce to 'block' rather than being
  // dropped — dropping a block rule would silently widen install scope; only
  // rules whose identity (source + packageId) is unusable are dropped, loudly.
  let jobApps: PolicyAppRule[] | undefined;
  if (patchesConfig?.apps !== undefined) {
    if (!Array.isArray(patchesConfig.apps)) {
      const message = `[PatchJobExecutor] Job ${patchJobId} has malformed patches.apps; ignoring app rules`;
      console.warn(`${message}:`, JSON.stringify(patchesConfig.apps));
      captureException(new Error(message));
    } else {
      const valid: PolicyAppRule[] = [];
      for (const entry of patchesConfig.apps) {
        const parsed = policyAppRuleSchema.safeParse(entry);
        if (parsed.success) {
          // Strip displayName and any other extra fields before handing to the evaluator.
          const { source, packageId, action, pinnedVersion } = parsed.data;
          if (action === 'pin' && pinnedVersion) {
            valid.push({ source, packageId, action: 'pin', pinnedVersion });
          } else {
            // action === 'block' (pin without pinnedVersion is rejected by the schema).
            valid.push({ source, packageId, action: 'block' });
          }
          continue;
        }

        const e = entry as { source?: unknown; packageId?: unknown } | null;
        const identifiable =
          e !== null &&
          typeof e === 'object' &&
          typeof e.source === 'string' &&
          e.source.length > 0 &&
          typeof e.packageId === 'string' &&
          e.packageId.length > 0;

        if (identifiable) {
          // Fail closed: the admin intended to restrict this app; a malformed
          // restriction (e.g. pin without a version) becomes an outright block.
          console.warn(
            `[PatchJobExecutor] Job ${patchJobId} coercing malformed app rule to block (fail-closed):`,
            JSON.stringify(entry)
          );
          valid.push({
            source: e.source as string,
            packageId: e.packageId as string,
            action: 'block',
          });
        } else {
          const message = `[PatchJobExecutor] Job ${patchJobId} dropping malformed app rule with unusable identity`;
          console.warn(`${message}:`, JSON.stringify(entry));
          captureException(new Error(message));
        }
      }
      jobApps = valid;
    }
  }

  const ringConfig: RingConfig = {
    ringId: patchesConfig?.ringId ?? null,
    categoryRules: (Array.isArray(patchesConfig?.categoryRules)
      ? patchesConfig.categoryRules
      : []) as RingConfig['categoryRules'],
    autoApprove: patchesConfig?.autoApprove ?? {},
    deferralDays: 0,
    sources: jobSources,
    policyAutoApprove,
    apps: jobApps,
  };

  // If we have a ringId, load deferralDays and partnerId from the ring.
  // partnerId is threaded into ringConfig so the evaluator can guard against
  // cross-partner ring links (a config policy featurePolicyId is unconstrained).
  if (ringConfig.ringId) {
    const [ring] = await db
      .select({ deferralDays: patchPolicies.deferralDays, partnerId: patchPolicies.partnerId })
      .from(patchPolicies)
      .where(and(eq(patchPolicies.id, ringConfig.ringId), eq(patchPolicies.kind, 'ring')))
      .limit(1);
    if (ring) {
      ringConfig.deferralDays = ring.deferralDays;
      ringConfig.ringPartnerId = ring.partnerId;
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

  return { commandId, approvedPatches, targets };
}

async function pollForPatchCommandResult(commandId: string) {
  // Poll for the agent's result OUTSIDE any held transaction: each status check
  // is its own short system context, and the 5s sleeps hold NO pooled connection.
  // Previously this ran inside ONE open transaction for up to 30 min, starving
  // the DB pool under worker concurrency 10 (#1105 conn-hold → user 503s).
  const timeoutMs = 30 * 60 * 1000;
  const pollInterval = 5000;
  let elapsed = 0;
  while (elapsed < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
    elapsed += pollInterval;

    const [updated] = await runWithSystemDbAccess(() =>
      db
        .select()
        .from(deviceCommands)
        .where(eq(deviceCommands.id, commandId))
        .limit(1),
    );

    if (!updated) return null;
    if (updated.status === 'completed' || updated.status === 'failed') {
      return updated;
    }
  }
  return null;
}

async function recordDeviceExecution(
  data: ExecutePatchJobDeviceData,
  prep: PreparedDeviceExecution,
  finalCommand: Awaited<ReturnType<typeof pollForPatchCommandResult>>,
): Promise<unknown> {
  const { patchJobId, deviceId } = data;
  const { approvedPatches, targets } = prep;

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
