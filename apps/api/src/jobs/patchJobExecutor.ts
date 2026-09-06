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
  type CategoryRule,
  type PolicyAppRule,
  type PolicyAutoApproveConfig,
  type RingConfig,
} from '../services/patchApprovalEvaluator';
import { evaluateRebootPolicy, executeReboot } from '../services/patchRebootHandler';
import { queueCommandForExecution } from '../services/commandQueue';
import { captureException } from '../services/sentry';
import { attachWorkerObservability } from './workerObservability';

// Strict shape for patches.policyAutoApprove as stored in the job JSONB.
// deferralDays must be a valid non-negative integer when present — a malformed
// value must NOT be coerced to 0, because that silently removes the deferral
// safety window. Absent deferralDays is fine and defaults to 0.
const jobPolicyAutoApproveSchema = z.object({
  enabled: z.boolean(),
  severities: z.array(z.string()),
  deferralDays: z.number().int().min(0).optional(),
});

// Strict shape for one patches.categoryRules entry as stored in the job JSONB.
// Matches the evaluator's CategoryRule: severityFilter is the legacy stored
// alias for autoApproveSeverities (pre-2026-08 snapshots), both read-only here.
const jobCategoryRuleSchema = z.object({
  category: z.string().min(1),
  autoApprove: z.boolean(),
  autoApproveSeverities: z.array(z.string()).optional(),
  severityFilter: z.array(z.string()).optional(),
  deferralDaysOverride: z.number().int().min(0).nullable().optional(),
});

/**
 * Parse one stored job-JSONB ring category list (`categories` / `excludeCategories`).
 * Returns:
 *  - `undefined` when the field is absent (legacy job → no category filtering),
 *  - `string[]` (blanks dropped) when the value is a valid array of strings, or
 *  - `null` when present-but-malformed (a non-array, or an array containing a
 *    non-string entry).
 *
 * A malformed value must NOT be silently coerced to "no filter": dropping a
 * `categories` allowlist would widen to "install every category" and dropping an
 * `excludeCategories` denylist would let an excluded category into the install
 * set — the same widen-past-admin-intent hazard the `sources` handler guards
 * against. Callers fail closed (skip the device) on `null`. An empty array is
 * valid and means "no filter" (the schema default), unlike `sources` where an
 * empty set means "install nothing". (#2117)
 */
export function parseJobCategoryList(value: unknown): string[] | null | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return null;
  if (value.some((v) => typeof v !== 'string')) return null;
  return (value as string[]).filter((v) => v.length > 0);
}

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

/**
 * A stale queue entry that could not be cleared, so re-adding its stable jobId
 * would be a silent no-op. Named (rather than a bare Error) so it survives
 * Sentry's scrubber — `scrubEvent` deletes the message but keeps the exception
 * type. See resolveActiveQueueJob for why this matters.
 */
export class StaleQueueJobRemovalError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'StaleQueueJobRemovalError';
  }
}

/**
 * One or more devices of an already-`running` patch job could not be handed to
 * the per-device queue. Named for the same reason as the class above: Sentry's
 * `scrubEvent` deletes the message, so the exception type is the only thing
 * that distinguishes this from every other blank event.
 */
export class PatchDeviceDispatchError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PatchDeviceDispatchError';
  }
}

/**
 * The 35-minute completion check for an already-`running` patch job could not
 * be scheduled on its stable id (fallback used) or at all (no backstop left).
 */
export class PatchCompletionCheckError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PatchCompletionCheckError';
  }
}

/**
 * Return the reusable queue job for one of `candidateIds`, clearing any
 * terminal leftover so the caller can re-add on the same stable jobId.
 *
 * The clearing is load-bearing, not housekeeping: `queue.add(..., { jobId })` is
 * a SILENT NO-OP in BullMQ when a job hash with that id already exists — it
 * returns the existing job and queues nothing. So an "absent" answer from this
 * helper is a promise that the id is free. Two holes broke that promise:
 *
 *   - a `remove()` rejection was swallowed into console.error and the helper
 *     still answered "absent", handing the caller an add that did nothing while
 *     reporting success;
 *   - `getState()` also answers `'unknown'` for a job hash that is in no list,
 *     which matched neither branch and fell through to the same no-op add.
 *
 * Either one strands a `patch_jobs` row in `status='scheduled'` with no queue
 * job forever: the #1733 reconcile sweep then "recovers" the same row on every
 * 60s scan, incrementing its counter and emitting one more identical Sentry
 * event, while nothing actually runs (BREEZE-1A). Failing loudly is the point —
 * the caller reports a lost run as page-worthy.
 */
async function resolveActiveQueueJob(queue: Queue, candidateIds: string[]) {
  for (const candidateId of candidateIds) {
    const existing = await queue.getJob(candidateId);
    if (!existing) continue;
    const state = await existing.getState();
    if (isReusableState(state)) {
      return existing;
    }
    try {
      await existing.remove();
    } catch (error) {
      // A terminal job can race back into the queue between getState() and
      // remove() (BullMQ refuses to remove a locked/active job). That outcome is
      // correct — reuse it rather than reporting a fault.
      const recheck = await existing.getState().catch(() => 'unknown');
      if (isReusableState(recheck)) {
        return existing;
      }
      throw new StaleQueueJobRemovalError(
        `[PatchJobExecutor] Could not remove stale job ${candidateId} (state=${state}); `
        + 're-enqueuing this id would be a silent no-op',
        { cause: error },
      );
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
 * Patch job ids already reported as wedged, so the report fires once per
 * episode rather than once per sweep (BREEZE-1A, second time).
 *
 * A wedged id is persistent BY DEFINITION: `resolveActiveQueueJob` threw
 * precisely because it could not clear the job hash, and nothing else clears
 * it. The scheduler sweeps every 60s and `selectStaleScheduledJobIds` keeps
 * selecting the row for RECONCILE_MAX_AGE_MS (45 days), so an undeduplicated
 * report is up to ~64,800 error-level events for ONE stuck job — all collapsing
 * into a single issue, because `scrubEvent` deletes the message. That is
 * exactly the 342-event issue this whole change set exists to stop, rebuilt at
 * two orders of magnitude.
 *
 * Cleared as soon as the id resolves cleanly again (recovered or genuinely
 * present), which both ends the episode and bounds the set: it only ever holds
 * ids that are currently wedged.
 */
const reportedWedgedJobIds = new Set<string>();

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
    let existing: Awaited<ReturnType<typeof resolveActiveQueueJob>>;
    try {
      existing = await resolveActiveQueueJob(queue, [stableJobId]);
    } catch (error) {
      // One wedged id must not cost every OTHER orphan its recovery for as long
      // as it stays wedged — a lost patch run staying lost is the hazard this
      // sweep exists to prevent. Report it and carry on; it is deliberately NOT
      // reported as orphaned, because re-adding onto an id we could not clear
      // would be the silent no-op resolveActiveQueueJob just refused to hide.
      //
      // Reported ONCE per episode (see reportedWedgedJobIds) — the condition
      // does not clear itself, so a per-sweep report is pure volume. The
      // console line still fires every sweep, so the state stays visible in
      // logs; only the Sentry event is gated.
      const detail = error instanceof Error ? error.message : error;
      if (reportedWedgedJobIds.has(job.id)) {
        console.error(
          `[PatchJobExecutor] Patch job ${job.id} still wedged (already reported):`,
          detail,
        );
        continue;
      }
      reportedWedgedJobIds.add(job.id);
      console.error(
        `[PatchJobExecutor] Skipping reconcile of patch job ${job.id}:`,
        detail,
      );
      captureException(
        error instanceof Error
          ? error
          : new StaleQueueJobRemovalError(
            `[PatchJobExecutor] Skipping reconcile of patch job ${job.id}`,
          ),
        undefined,
        { patch_reconcile_stage: 'wedged' },
      );
      continue;
    }
    // Resolved cleanly — whatever wedged it is gone, so the next wedge is a new
    // episode and reports again.
    reportedWedgedJobIds.delete(job.id);
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

  // Fan out to per-device queue.
  //
  // Every device is dispatched inside its own try/catch, and a failure costs
  // ONLY that device. This runs AFTER the claim UPDATE above has already
  // flipped the row to `running`, which makes an escaping throw unrecoverable:
  // the orchestration queue sets no `attempts` (BullMQ defaults to no retry),
  // a manual retry re-runs the claim UPDATE against `status='scheduled'` and
  // matches 0 rows, and the #1733 reconcile sweep only scans `scheduled` rows.
  // So one rejected Redis call on device 7 of 200 would strand the whole run
  // in `running` forever, with devices 8-200 never enqueued and no completion
  // checker — invisible, because the row never fails either.
  const deviceQueue = getPatchJobDeviceQueue();
  const dispatchFailures: { deviceId: string; error: unknown }[] = [];
  for (const deviceId of deviceIds) {
    const stableJobId = getPatchJobDeviceExecutionId(patchJobId, deviceId);
    try {
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
    } catch (error) {
      console.error(
        `[PatchJobExecutor] Failed to dispatch device ${deviceId} of patch job ${patchJobId}:`,
        error instanceof Error ? error.message : error,
      );
      dispatchFailures.push({ deviceId, error });
    }
  }

  // Settle the devices we could not dispatch. Without this their
  // `devicesPending` slots never drain, so the run could only ever be finished
  // by the 35-minute completion checker — and only if that checker was itself
  // enqueued. Recording them as failed keeps the counters exact and lets the
  // normal `devicesPending === 0` finalization close the job out on its own.
  for (const failure of dispatchFailures) {
    try {
      await markDeviceDispatchFailed(patchJobId, failure.deviceId, failure.error);
    } catch (error) {
      console.error(
        `[PatchJobExecutor] Failed to record dispatch failure for device ${failure.deviceId} `
        + `of patch job ${patchJobId}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  if (dispatchFailures.length > 0) {
    const message =
      `[PatchJobExecutor] Patch job ${patchJobId} could not dispatch `
      + `${dispatchFailures.length} of ${deviceIds.length} device(s); they are recorded as failed`;
    captureException(
      new PatchDeviceDispatchError(message, { cause: dispatchFailures[0]?.error }),
      undefined,
      { patch_reconcile_stage: 'device_dispatch_failed' },
    );
  }

  // Enqueue completion checker (35 min delay). This is the backstop that fails
  // a run whose devices never report, so losing it is what turns a wedged
  // dispatch into a row that sits in `running` forever. A wedged stable id
  // therefore falls back to a fresh, unique id rather than giving up:
  // processCheckCompletion re-reads the row and no-ops unless it is still
  // `running`, so a duplicate checker is harmless, while no checker is not.
  await enqueueCompletionCheck(patchJobId);

  return {
    dispatched: deviceIds.length - dispatchFailures.length,
    dispatchFailed: dispatchFailures.length,
  };
}

/**
 * Schedule the 35-minute completion check, tolerating a queue id we cannot
 * clear. Never throws: it is called after the row is already `running`, where
 * an escaping error is unrecoverable (see the fan-out comment above).
 */
async function enqueueCompletionCheck(patchJobId: string): Promise<void> {
  const queue = getPatchJobQueue();
  const completionJobId = getPatchJobCompletionId(patchJobId);
  const completionOptions = {
    ...PATCH_JOB_COMPLETION_RETENTION,
    delay: 35 * 60 * 1000,
  };

  try {
    const existingCompletion = await resolveActiveQueueJob(queue, [completionJobId]);
    if (!existingCompletion) {
      await queue.add(
        'check-completion',
        { type: 'check-completion', patchJobId } satisfies CheckCompletionData,
        { ...completionOptions, jobId: completionJobId }
      );
    }
    return;
  } catch (error) {
    console.error(
      `[PatchJobExecutor] Could not schedule the completion check for patch job ${patchJobId} `
      + 'on its stable id; retrying under a unique id:',
      error instanceof Error ? error.message : error,
    );
  }

  // Fallback: the stable id is occupied by something we could not remove, so
  // re-adding it would be a silent no-op. A unique id is not idempotent, but a
  // second checker only re-reads the row, and the alternative is a `running`
  // row that nothing will ever finalize.
  const fallbackJobId = `${completionJobId}-retry-${Date.now()}`;
  try {
    await queue.add(
      'check-completion',
      { type: 'check-completion', patchJobId } satisfies CheckCompletionData,
      { ...completionOptions, jobId: fallbackJobId }
    );
    captureException(
      new PatchCompletionCheckError(
        `[PatchJobExecutor] Completion check for patch job ${patchJobId} was scheduled under a `
        + 'fallback id because its stable queue id could not be cleared',
      ),
      undefined,
      { patch_reconcile_stage: 'completion_check_fallback' },
    );
  } catch (error) {
    // Both ids failed — the row will stay `running` with no backstop until an
    // operator intervenes. Page-worthy, and the only remaining signal.
    const message =
      `[PatchJobExecutor] Patch job ${patchJobId} is running with NO completion check scheduled; `
      + 'it cannot time out on its own';
    console.error(`${message}:`, error instanceof Error ? error.message : error);
    captureException(
      new PatchCompletionCheckError(message, { cause: error }),
      undefined,
      { patch_reconcile_stage: 'completion_check_lost' },
    );
  }
}

/**
 * Record a device we could never hand to the per-device queue as a failed
 * result, mirroring markDeviceSkipped but counting toward `devicesFailed` —
 * a device that was never dispatched did not succeed, and calling it "skipped"
 * (which counts as completed) would let the run finish green.
 */
async function markDeviceDispatchFailed(
  patchJobId: string,
  deviceId: string,
  error: unknown,
): Promise<void> {
  await db.insert(patchJobResults).values({
    jobId: patchJobId,
    deviceId,
    patchId: '00000000-0000-0000-0000-000000000000',
    status: 'failed',
    startedAt: new Date(),
    completedAt: new Date(),
    errorMessage: `dispatch_failed: ${error instanceof Error ? error.message : String(error)}`,
    rebootRequired: false,
  });

  await db
    .update(patchJobs)
    .set({
      devicesFailed: sql`${patchJobs.devicesFailed} + 1`,
      devicesPending: sql`${patchJobs.devicesPending} - 1`,
    })
    .where(eq(patchJobs.id, patchJobId));

  await checkAndFinalizeJob(patchJobId);
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
    categories?: unknown;
    excludeCategories?: unknown;
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

  // Ring category include/exclude filters (#2117). Mirror the sources posture:
  // absent = legacy job (no filtering); present-but-malformed skips the device
  // rather than silently dropping the filter, which would widen install scope
  // past the ring's category intent (an excluded category would flow in, or an
  // allowlist would collapse to "install everything").
  let jobCategories: string[] | undefined;
  let jobExcludeCategories: string[] | undefined;
  let malformedCategoryFilter = false;

  const parsedCategories = parseJobCategoryList(patchesConfig?.categories);
  if (parsedCategories === null) {
    malformedCategoryFilter = true;
    const message = `[PatchJobExecutor] Job ${patchJobId} has malformed patches.categories; skipping device to avoid widening install scope past the ring category filter`;
    console.warn(`${message}:`, JSON.stringify(patchesConfig?.categories));
    captureException(new Error(message));
  } else {
    jobCategories = parsedCategories;
  }

  const parsedExcludeCategories = parseJobCategoryList(patchesConfig?.excludeCategories);
  if (parsedExcludeCategories === null) {
    malformedCategoryFilter = true;
    const message = `[PatchJobExecutor] Job ${patchJobId} has malformed patches.excludeCategories; skipping device to avoid widening install scope past the ring category filter`;
    console.warn(`${message}:`, JSON.stringify(patchesConfig?.excludeCategories));
    captureException(new Error(message));
  } else {
    jobExcludeCategories = parsedExcludeCategories;
  }

  if (malformedCategoryFilter) {
    await markDeviceSkipped(patchJobId, deviceId, 'invalid_patch_categories');
    return { skipped: true, reason: 'Invalid patch category filter' };
  }

  // Category rules were the one snapshot field cast blind while every sibling
  // (sources, apps, policyAutoApprove, categories) is validated loudly — and a
  // matching rule is now TERMINAL in the evaluator, so a malformed entry
  // silently became a deny. Mirror the apps posture: a rule with a usable
  // category but bad shape coerces to an explicit deny (fail-closed, matching
  // what the evaluator's `!rule.autoApprove` would have done — but logged);
  // a rule with no usable category is dropped, loudly.
  const jobCategoryRules: CategoryRule[] = [];
  if (patchesConfig?.categoryRules !== undefined) {
    if (!Array.isArray(patchesConfig.categoryRules)) {
      const message = `[PatchJobExecutor] Job ${patchJobId} has malformed patches.categoryRules; ignoring category rules`;
      console.warn(`${message}:`, JSON.stringify(patchesConfig.categoryRules));
      captureException(new Error(message));
    } else {
      for (const entry of patchesConfig.categoryRules) {
        const parsed = jobCategoryRuleSchema.safeParse(entry);
        if (parsed.success) {
          jobCategoryRules.push(parsed.data);
          continue;
        }
        const e = entry as { category?: unknown } | null;
        if (e !== null && typeof e === 'object' && typeof e.category === 'string' && e.category.length > 0) {
          console.warn(
            `[PatchJobExecutor] Job ${patchJobId} coercing malformed category rule to deny (fail-closed):`,
            JSON.stringify(entry)
          );
          jobCategoryRules.push({ category: e.category, autoApprove: false });
        } else {
          const message = `[PatchJobExecutor] Job ${patchJobId} dropping malformed category rule with unusable category`;
          console.warn(`${message}:`, JSON.stringify(entry));
          captureException(new Error(message));
        }
      }
    }
  }

  const ringConfig: RingConfig = {
    ringId: patchesConfig?.ringId ?? null,
    categoryRules: jobCategoryRules,
    autoApprove: patchesConfig?.autoApprove ?? {},
    deferralDays: 0,
    categories: jobCategories,
    excludeCategories: jobExcludeCategories,
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

/**
 * Shared per-patch success predicate (#4267, factoring the #4228 gate and the
 * `patch_job_results` row status onto one rule).
 *
 * The Windows agent's `results[]` entries (`patchCommandResultFields` in
 * `agent/internal/heartbeat/heartbeat.go`) carry a
 * `status: 'installed' | 'failed' | 'rolled_back'` field and never emit a
 * boolean `success` — so keying off `entry.success` alone (as the per-patch
 * `patch_job_results` write used to) leaves it permanently `undefined` and the
 * caller's `fallback` (the *batch's* overall status) wins for every patch. One
 * failed patch in a 13-patch batch then reads as 13 failures.
 *
 * `success` is still checked first, defensively, in case a future/alternate
 * agent build reports it directly. `fallback` covers only a payload with no
 * matching per-patch entry at all (unparsable stdout, or the lookup missed).
 */
function isPatchResultSuccessful(
  entry: { success?: boolean; status?: string } | undefined,
  fallback: boolean,
): boolean {
  if (entry === undefined) return fallback;
  if (typeof entry.success === 'boolean') return entry.success;
  if (entry.status) return entry.status === 'installed' || entry.status === 'rolled_back';
  return fallback;
}

async function recordDeviceExecution(
  data: ExecutePatchJobDeviceData,
  prep: PreparedDeviceExecution,
  finalCommand: Awaited<ReturnType<typeof pollForPatchCommandResult>>,
): Promise<unknown> {
  // orgId comes off the job payload and processExecuteDevice has already
  // asserted it matches the patch job's org before we get here, so it is safe to
  // use as the cross-tenant guard for the reboot dispatch below.
  const { patchJobId, deviceId, orgId } = data;
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
      /** The agent's own patch reference (`patchCommandResultFields`), keyed
       *  off `patches.id` server-side — NOT `patchId`, which the agent never
       *  sends. Kept as a fallback in case a differently-shaped payload does. */
      id?: string;
      patchId?: string;
      externalId?: string;
      success?: boolean;
      /** Agent's per-patch outcome: 'installed' | 'failed' | 'rolled_back'. */
      status?: string;
      error?: string;
      rebootRequired?: boolean;
    }>;
    rebootRequired?: boolean;
    installedCount?: number;
    failedCount?: number;
  } | null = null;

  // A well-formed agent ALWAYS emits the install summary as JSON
  // (`executePatchInstallCommand` marshals it on both the success and the
  // failure return), so unparsable stdout is an anomaly, not a shrug. It also
  // became load-bearing with #4228: the reboot decision is now read out of this
  // payload, so a parse failure is the one way a genuine partial success can
  // still look like "nothing installed". It must leave a trail.
  let resultUnparsable = false;
  if (commandResult?.stdout) {
    try {
      parsedResult = JSON.parse(commandResult.stdout);
    } catch (err) {
      resultUnparsable = true;
      console.warn(
        `[PatchJobExecutor] unparsable patch result stdout for job ${patchJobId} device ${deviceId}: ${String(err)}`
      );
      captureException(
        new Error(
          `[PatchJobExecutor] unparsable patch install result for job ${patchJobId} device ${deviceId}`
        )
      );
    }
  }

  const overallSuccess = finalCommand?.status === 'completed' &&
    (parsedResult?.success ?? true) &&
    (typeof commandResult?.exitCode !== 'number' || commandResult.exitCode === 0);

  // Did the run actually change anything on the device? Deliberately NOT
  // `overallSuccess`: the agent returns Status "failed" / exit 1 the moment ONE
  // patch in the batch fails, while the other twelve are installed and pending a
  // reboot (#4228). `installedCount` is the agent's own count of successful
  // installs/rollbacks; the per-patch array is the fallback for a payload that
  // omits it. A total failure, or a command that never came back, leaves both
  // empty.
  const installedCount = parsedResult?.installedCount;
  const anyPatchInstalled =
    (typeof installedCount === 'number' && installedCount > 0) ||
    (parsedResult?.results?.some((r) => isPatchResultSuccessful(r, false)) ?? false);

  // The agent ORs `rebootRequired` across every SUCCESSFUL install, so a partial
  // failure still carries an accurate value — use it verbatim, including a
  // reported `false`.
  //
  // The fallback only covers a result we could not parse at all (non-JSON
  // stdout, or no stdout). Reading the static `requiresReboot` flags off the
  // approved set assumes every one of them installed, which is only sound for a
  // success-shaped run: on a failed or timed-out command we have no idea which
  // patches landed, so those flags must not manufacture a reboot.
  const anyRebootRequired = parsedResult?.rebootRequired ??
    (overallSuccess ? approvedPatches.some((p) => p.requiresReboot) : false);

  // 6. Insert patchJobResults per patch
  for (const patch of approvedPatches) {
    // The agent echoes the id back as `id` (mirroring the `patches.id` this
    // job sent it), not `patchId` — `r.patchId` matched here would always be
    // undefined and this lookup would silently degrade to the `externalId`
    // branch alone (#4267).
    const perPatchResult = parsedResult?.results?.find(
      (r) => r.id === patch.patchId || r.patchId === patch.patchId || r.externalId === patch.externalId
    );

    // Per-patch status, not the batch's aggregate status (#4267): a batch with
    // one failure among twelve successes must record twelve `completed` rows
    // and one `failed` row, not thirteen `failed` rows. `overallSuccess` is
    // only the fallback for a patch with no matching per-patch entry at all.
    const patchSuccess = isPatchResultSuccessful(perPatchResult, overallSuccess);

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
  //
  // This used to sit inside `if (overallSuccess)`. A 13-patch job with a single
  // failed patch reports `success: false` / exit 1 from the agent, so the policy
  // was never consulted at all and the reboot the other twelve installs needed
  // was dropped — silently, with not one log line to explain the
  // `Reboot Required: Yes` the UI kept showing (#4228). Whether a reboot is
  // needed is a property of what actually installed, not of the job's aggregate
  // status, so the policy is now evaluated whenever at least one patch landed.
  //
  // A run that installed NOTHING still skips: there is nothing to finalize, and
  // an `always` policy would otherwise reboot a device the job never changed.
  //
  // Every branch below logs. The pre-#4228 silence is what made this bug
  // invisible in production, so "no reboot" must be as traceable as a dispatch.
  const rebootPolicy = targets?.deployment?.rebootPolicy ?? 'if_required';
  const rebootLog = `[PatchJobExecutor] job ${patchJobId} device ${deviceId} reboot policy "${rebootPolicy}"`;

  if (!overallSuccess && !anyPatchInstalled) {
    // Say which of the two it is. "No patch installed" is a fact when the agent
    // told us so; when its output was unparsable it is an assumption, and an
    // operator chasing a device that did not reboot needs to tell them apart.
    console.log(
      `${rebootLog}: not evaluated — ${resultUnparsable
        ? 'result unparsable, cannot confirm any install (see prior warning)'
        : 'no patch installed successfully'} (rebootRequired=${anyRebootRequired})`
    );
  } else {
    const rebootEval = await evaluateRebootPolicy(deviceId, rebootPolicy, anyRebootRequired);
    if (!rebootEval.shouldReboot) {
      console.log(
        `${rebootLog}: no reboot — ${rebootEval.reason}${rebootEval.deferred ? ' (deferred)' : ''}`
      );
    } else {
      // No delay passed: executeReboot resolves it from the device's effective
      // patch policy (#3197). It used to default to 5 minutes, which reached
      // none of the agent's warning thresholds, so the user got no notice.
      const rebootResult = await executeReboot(deviceId, rebootEval.reason, {
        expectedOrgId: orgId,
        // #3207: a reboot fired inside a maintenance window may not be
        // postponed past the close of that window. Null for every other policy.
        windowEndsAt: rebootEval.windowEndsAt,
      });
      // A partially failed job that still reboots is the #4228 path — name it in
      // the log so an operator reading "the job failed but the box rebooted" can
      // tell intent from accident.
      const partialSuffix = overallSuccess
        ? ''
        : ' (job partially failed; successfully installed patches still require a reboot)';
      if (!rebootResult.success) {
        // captureException, not just a console line: this is the post-patch
        // reboot — the path #3197 is about — and a failure here leaves the device
        // patched but never restarted while the job still records success. The
        // maintenance-window path reports the structurally identical failure to
        // Sentry, so this one must too.
        console.warn(
          `[PatchJobExecutor] reboot dispatch failed for device ${deviceId}: ${rebootResult.error}`
        );
        captureException(
          new Error(
            `[PatchJobExecutor] reboot dispatch failed for device ${deviceId}: ${rebootResult.error}`
          )
        );
      } else {
        console.log(
          `${rebootLog}: scheduled reboot in ${rebootResult.delayMinutes}m — ${rebootEval.reason}${partialSuffix}`
        );
      }
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
  attachWorkerObservability(jobWorker, 'patchJobWorker');
  deviceWorker = createPatchJobDeviceWorker();
  attachWorkerObservability(deviceWorker, 'patchJobDeviceWorker');
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

/**
 * Module-level state that the reconcile dedup depends on. Exposed so suites can
 * start each case from a clean slate — the executor is a process singleton.
 */
export const __testOnly = {
  resetWedgedJobReporting(): void {
    reportedWedgedJobIds.clear();
  },
};
