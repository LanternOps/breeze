/**
 * Backup Queue — enqueue helpers for backup job dispatch/result processing
 *
 * Extracted from backupWorker.ts to keep files under the 500-line limit.
 * Re-exported from backupWorker.ts for backward compatibility.
 */

import { Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { backupConfigs } from '../db/schema';
import { createInstrumentedQueue } from '../services/bullmqQueue';
import {
  backupQueueJobDataSchema,
  type BackupQueueJobData,
  type QueueActorMeta,
  withQueueMeta,
} from './queueSchemas';

const BACKUP_QUEUE = 'backup';

/**
 * Retrying options for the queue's IDEMPOTENT work.
 *
 * `process-results` re-applies the same agent payload to the same job row, so
 * replaying it after a transient DB/Redis blip converges on the same state —
 * retrying is a straight win there.
 *
 * NOT for `dispatch-backup`: see {@link DISPATCH_JOB_OPTIONS}.
 */
const PRIVILEGED_JOB_OPTIONS = {
  attempts: 3,
  backoff: {
    type: 'exponential' as const,
    delay: 1_000,
  },
};

/**
 * One-shot options for `dispatch-backup` (#4137).
 *
 * `processDispatchBackup` is NOT idempotent: its Phase 3
 * (`prepareBackupDispatchTargets`) INSERTs a brand-new `backup_jobs` child row
 * for every target after the first, and commits them before the Phase-4 sends.
 * A retry therefore re-runs Phase 3 and creates a SECOND set of children while
 * the first set is stranded at status='running' forever — nothing sweeps
 * children by parent id, because no parent linkage column exists. It would
 * also re-send commands the agent may already be running.
 *
 * So the dispatch gives up retries entirely: a failed dispatch leaves the job
 * row as the retry surface (the scheduler creates a fresh job on the next
 * tick, and an operator can re-run it manually), exactly the trade the other
 * non-idempotent one-shots in this repo make — `jobs/aiAgentEnqueuer.ts`,
 * `jobs/orgMerge.ts`, `jobs/tenantErasure.ts`.
 *
 * `attempts: 1` alone does not close the whole hole: BullMQ re-delivers a
 * STALLED job (worker process killed mid-run) independently of `attempts`,
 * up to the worker's `maxStalledCount`. `processDispatchBackup` therefore also
 * refuses to run a re-delivery — see the `redelivered` guard in backupWorker.ts.
 */
const DISPATCH_JOB_OPTIONS = {
  attempts: 1,
};

/**
 * How many times a dispatch is queued again while the device has not reported
 * its backup helper (backupWorker holdForHelperReport) — and so how many
 * re-queue ids a cancellation looks for.
 */
export const BACKUP_CAPABILITY_WAIT_MAX_ATTEMPTS = 40;

let backupQueue: Queue | null = null;

export function getBackupQueue(): Queue {
  if (!backupQueue) {
    backupQueue = createInstrumentedQueue(BACKUP_QUEUE);
  }
  return backupQueue;
}

export async function closeBackupQueue(): Promise<void> {
  if (backupQueue) {
    await backupQueue.close();
    backupQueue = null;
  }
}

// ── Job data sub-types (needed by enqueue callers) ───────────────────────────

export interface ProcessResultsResult {
  status: string;
  // The agent's own terminal status (`completed` | `partial` | …), distinct
  // from `status` above which is the outer completed/failed command status.
  // See backupProcessResultSchema — a `partial` run rides only this key.
  agentStatus?: string;
  jobId?: string;
  snapshotId?: string;
  filesBackedUp?: number;
  bytesBackedUp?: number;
  warning?: string;
  // Partial-success count and incremental dedup accounting. Must ride the
  // queue payload: the persistence layer only writes what arrives here, and
  // dropping them silently zeroes the job's error count and upload savings.
  errorCount?: number;
  referencedFiles?: number;
  referencedBytes?: number;
  // system_image (system-state) backups carry these; the WS handler must
  // forward them or the snapshot loses its type label + BMR restore manifest.
  // Free-form agent job metadata — see backupProcessResultSchema (#5413).
  metadata?: Record<string, unknown>;
  backupType?: 'file' | 'system_image' | 'database' | 'application';
  systemStateManifest?: Record<string, unknown> | null;
  // Bare-metal recovery (W01): disk layout + guard verdict, same forwarding
  // rationale as systemStateManifest above.
  layoutManifest?: Record<string, unknown> | null;
  bareMetal?: { restorable: boolean; reasons: string[] } | null;
  // Windows VSS diagnostics (#3027). Must ride the queue payload for the same
  // reason the manifest does: the persistence layer only writes what arrives
  // here, and dropping it leaves backup_jobs.vss_metadata permanently NULL.
  // Typed `unknown` on purpose — see backupProcessResultSchema.
  vssMetadata?: unknown;
  snapshot?: {
    id: string;
    timestamp?: string;
    size?: number;
    files?: Array<{
      sourcePath: string;
      // D12 (#5413): the stable pre-VSS path. Declared here as well as on both
      // zod schemas so a caller building this literal by hand cannot drop it.
      originalPath?: string;
      backupPath: string;
      size?: number;
      modTime?: string;
      // W02 fidelity: content-less entries (symlinks/directories) — see
      // backupSnapshotFileResultSchema / backupSnapshotFileSchema.
      kind?: 'symlink' | 'dir';
      linkTarget?: string;
    }>;
    // D18 (#5429/§3.1): must mirror backupSnapshotSummarySchema, or
    // agentWs.ts's caller can construct a ProcessResultsResult carrying these
    // fields (from the parsed WS ingress payload) that TypeScript happily
    // accepts here, then loses at the very next hop when
    // backupQueueJobDataSchema.parse(...) strict-validates it.
    baseSnapshotId?: string;
    formatVersion?: number;
    backupIdentity?: string;
  };
  // Snapshot attestation envelope, forwarded verbatim (validated where it is
  // recorded, services/backupAttestation.ts).
  attestation?: unknown;
  error?: string;
}

/**
 * The OPTIONAL free-text fields of the result. The strict queue schema declares
 * each as a non-empty string, but the ingress schema (routes/backup/
 * resultSchemas.ts) accepts any string, so a helper that reports one blank gets
 * past ingress and is then refused here, failing a run that succeeded (#7466:
 * the Hyper-V export sends `warning: ""` on every clean run).
 *
 * Blank means "not reported": {@link withBlankOptionalStringsAbsent} drops these
 * keys when they are empty or whitespace-only, just before the strict parse. The
 * queue schema stays strict for everything else. The required `status` is
 * server-derived and deliberately NOT listed: a blank one is a server bug and
 * must still be refused. backupEnqueue.test.ts derives the optional
 * non-empty-string keys from the queue schema and fails if one is missing here.
 */
const BLANK_AS_ABSENT_RESULT_KEYS = [
  'agentStatus',
  'jobId',
  'snapshotId',
  'warning',
  'error',
] as const satisfies ReadonlyArray<keyof ProcessResultsResult>;

function withBlankOptionalStringsAbsent(result: ProcessResultsResult): ProcessResultsResult {
  const normalized: ProcessResultsResult = { ...result };
  for (const key of BLANK_AS_ABSENT_RESULT_KEYS) {
    const value = normalized[key];
    if (typeof value === 'string' && value.trim() === '') {
      delete normalized[key];
    }
  }
  return normalized;
}

const SYSTEM_DISPATCH_META: QueueActorMeta = {
  actorType: 'system',
  actorId: null,
  source: 'worker:backup:dispatch',
};

const AGENT_RESULT_META: QueueActorMeta = {
  actorType: 'agent',
  actorId: null,
  source: 'route:agentWs:backup-result',
};

// ── Public enqueue functions ─────────────────────────────────────────────────

export async function enqueueBackupDispatch(
  jobId: string,
  configId: string,
  orgId: string,
  deviceId: string,
  meta: QueueActorMeta = SYSTEM_DISPATCH_META,
): Promise<string> {
  const queue = getBackupQueue();
  // Site-ceiling gate contract §3: snapshot the config's CURRENT
  // approval_generation at enqueue time. backupWorker's dispatch precheck
  // compares this against the freshly-reloaded row and fails the job closed
  // (backup_config_changed) if the config was edited after this job was
  // queued — the scheduler's next tick then re-enqueues against the new
  // generation.
  const [configRow] = await db
    .select({ approvalGeneration: backupConfigs.approvalGeneration })
    .from(backupConfigs)
    .where(eq(backupConfigs.id, configId))
    .limit(1);
  const payload = backupQueueJobDataSchema.parse(withQueueMeta({
    type: 'dispatch-backup' as const,
    jobId,
    configId,
    orgId,
    deviceId,
    configGeneration: configRow?.approvalGeneration,
  }, meta));
  const job = await queue.add(
    'dispatch-backup',
    payload,
    {
      jobId: `backup-dispatch-${jobId}`,
      ...DISPATCH_JOB_OPTIONS,
      removeOnComplete: { count: 50 },
      removeOnFail: { count: 100 },
    }
  );
  return job.id!;
}

type DispatchBackupQueueData = Extract<BackupQueueJobData, { type: 'dispatch-backup' }>;

/** BullMQ id of the `attempt`-th re-queue of a dispatch waiting for the helper report. */
function capabilityWaitQueueJobId(jobId: string, attempt: number): string {
  return `backup-dispatch-${jobId}-capability-wait-${attempt}`;
}

/**
 * Queue the same dispatch again, `delayMs` from now, because the device has
 * not reported its backup helper yet (backupWorker holdForHelperReport).
 *
 * The payload is the original one — including the config generation it was
 * first queued with, so an edit made while waiting still fails the job closed
 * — plus the wait bookkeeping. Each re-queue gets its own BullMQ id: the id of
 * the job being processed still exists (and completed ids are retained), so
 * reusing one would be silently dropped. Same one-shot options as every
 * dispatch; the worker's redelivery guard applies to each re-queue as well.
 */
export async function enqueueBackupDispatchCapabilityWait(
  data: DispatchBackupQueueData,
  wait: { attempt: number; since: string },
  delayMs: number,
): Promise<string> {
  const queue = getBackupQueue();
  const payload = backupQueueJobDataSchema.parse({
    ...data,
    capabilityWaitAttempt: wait.attempt,
    capabilityWaitSince: wait.since,
  });
  const job = await queue.add(
    'dispatch-backup',
    payload,
    {
      jobId: capabilityWaitQueueJobId(data.jobId, wait.attempt),
      delay: delayMs,
      ...DISPATCH_JOB_OPTIONS,
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
  result: ProcessResultsResult,
  meta: QueueActorMeta = AGENT_RESULT_META,
  options: { dispatchExpectationVerified?: true } = {},
): Promise<string> {
  const queue = getBackupQueue();
  const payload = backupQueueJobDataSchema.parse(withQueueMeta({
    type: 'process-results' as const,
    jobId,
    orgId,
    deviceId,
    result: withBlankOptionalStringsAbsent(result),
    ...(options.dispatchExpectationVerified ? { dispatchExpectationVerified: true as const } : {}),
  }, meta));
  const job = await queue.add(
    'process-results',
    payload,
    {
      jobId: `backup-result-${jobId}`,
      ...PRIVILEGED_JOB_OPTIONS,
      removeOnComplete: { count: 50 },
      removeOnFail: { count: 100 },
    }
  );
  return job.id!;
}

/**
 * Remove a backup's dispatch that has not started yet. A dispatch waiting for
 * the device's helper report lives under a re-queue id instead of the
 * original (enqueueBackupDispatchCapabilityWait), so every such id is looked
 * up too; at most one of them is ever still queued.
 */
export async function removeQueuedBackupDispatch(jobId: string): Promise<boolean> {
  const queue = getBackupQueue();
  const ids = [`backup-dispatch-${jobId}`];
  for (let attempt = 1; attempt <= BACKUP_CAPABILITY_WAIT_MAX_ATTEMPTS; attempt++) {
    ids.push(capabilityWaitQueueJobId(jobId, attempt));
  }
  const candidates = await Promise.all(ids.map((id) => queue.getJob(id)));

  let removed = false;
  for (const queuedJob of candidates) {
    if (!queuedJob) continue;
    const state = await queuedJob.getState();
    if (state !== 'waiting' && state !== 'delayed' && state !== ('paused' as string)) continue;
    await queuedJob.remove();
    removed = true;
  }
  return removed;
}
