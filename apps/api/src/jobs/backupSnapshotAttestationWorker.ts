// BullMQ worker that runs verifySnapshotAttestation
// (services/backupAttestationVerify.ts) out of band. Enqueued when an agent
// result records a server-fetched attestation (services/backupAttestation.ts),
// and again when the cleanup job publishes a brokered snapshot that was still
// sealing (jobs/backupWriteSessionJanitor.ts); a periodic sweep re-enqueues
// rows still `pending` once they are due: a row never attempted is due
// STALE_PENDING_AFTER_MS after creation (a lost enqueue); a deferred row is
// due at its next_attempt_at (the expected publication of a sealing snapshot,
// or an exponential backoff after a storage failure). Rows that used up
// MAX_VERIFY_ATTEMPTS stay pending but are not swept again. jobId is
// snapshot-scoped so concurrent enqueues collapse into one job. Pattern
// mirrors jobs/backupSnapshotFileIndexWorker.ts.
import { Job, Queue, Worker } from 'bullmq';
import { and, asc, eq, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { backupSnapshotAttestations } from '../db/schema/backupSnapshotAttestations';
import { getBullMQConnection } from '../services/redis';
import { MAX_VERIFY_ATTEMPTS, verifySnapshotAttestation } from '../services/backupAttestationVerify';
import { attachWorkerObservability } from './workerObservability';
import { isReusableState } from '../services/bullmqUtils';

const QUEUE_NAME = 'backup-snapshot-attestation';
// One attempt per job: retries after a storage failure are scheduled in the
// row itself (next_attempt_at) and picked up by the sweep.
const VERIFY_JOB_OPTIONS = {
  attempts: 1,
  removeOnComplete: { count: 100 },
  removeOnFail: { count: 200 },
};
const SWEEP_EVERY_MS = 15 * 60_000;
export const STALE_PENDING_AFTER_MS = 30 * 60_000;
/**
 * A sweep also takes rows due within this long after it runs. A retry is
 * scheduled from the moment its attempt deferred — shortly after the sweep
 * tick that queued it — so a backoff of whole sweep periods lands just after
 * a later tick; without the lookahead it would miss that sweep and wait one
 * more period. Also absorbs clock skew between the API and the database,
 * which writes next_attempt_at.
 */
export const SWEEP_DUE_LOOKAHEAD_MS = 60_000;
const SWEEP_BATCH = 500;

type AttestationJobData =
  | { type: 'verify'; snapshotDbId: string }
  | { type: 'sweep-pending' };

let queue: Queue<AttestationJobData> | null = null;
let worker: Worker<AttestationJobData> | null = null;

function getQueue(): Queue<AttestationJobData> {
  if (!queue) {
    queue = new Queue<AttestationJobData>(QUEUE_NAME, { connection: getBullMQConnection() });
  }
  return queue;
}

/** Stable per-snapshot jobId. No ':' (bullmq rejects custom ids containing one). */
export function attestationJobId(snapshotDbId: string): string {
  return `attest-${snapshotDbId}`;
}

/**
 * The verification queued when a snapshot's reservation is published. Its own
 * id: a verification already running under attestationJobId may have read the
 * snapshot while it was still sealing, and reusing that job would lose the
 * publication. Two verifications of one snapshot may then overlap; the
 * verifier decides a row only through a row-locked compare-and-set on
 * `pending`, so the first decision stands and the other is skipped.
 */
export function publishedAttestationJobId(snapshotDbId: string): string {
  return `attest-published-${snapshotDbId}`;
}

export async function enqueueSnapshotAttestationVerification(snapshotDbId: string): Promise<string> {
  return enqueueVerification(snapshotDbId, attestationJobId(snapshotDbId));
}

async function enqueueVerification(snapshotDbId: string, jobId: string): Promise<string> {
  const q = getQueue();
  // Reuse a genuinely in-flight job; a completed/failed record under the same
  // id would otherwise swallow the add, so remove it and add again.
  const existing = await q.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (isReusableState(state)) return String(existing.id ?? jobId);
    await existing.remove().catch((error) => {
      console.error(`[BackupSnapshotAttestationWorker] Failed to remove stale job ${jobId} (state '${state}'):`, error);
    });
  }
  const job = await q.add('verify', { type: 'verify', snapshotDbId }, { jobId, ...VERIFY_JOB_OPTIONS });
  return job.id!;
}

/** The latest next_attempt_at a sweep running at `now` treats as due. */
export function sweepDueBy(now: Date): Date {
  return new Date(now.getTime() + SWEEP_DUE_LOOKAHEAD_MS);
}

/**
 * Snapshot ids of server-fetched attestations due for another verification
 * attempt, earliest due first: never attempted and older than `olderThanMs`,
 * or at their scheduled retry (within SWEEP_DUE_LOOKAHEAD_MS). Parked rows
 * are excluded.
 */
export async function findStalePendingAttestations(now: Date, olderThanMs = STALE_PENDING_AFTER_MS): Promise<string[]> {
  const cutoff = new Date(now.getTime() - olderThanMs);
  const dueBy = sweepDueBy(now);
  const dueAt = sql`coalesce(${backupSnapshotAttestations.nextAttemptAt}, ${backupSnapshotAttestations.createdAt})`;
  const rows = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db
        .select({ snapshotDbId: backupSnapshotAttestations.snapshotDbId })
        .from(backupSnapshotAttestations)
        .where(
          and(
            eq(backupSnapshotAttestations.status, 'pending'),
            eq(backupSnapshotAttestations.verificationMode, 'server_fetched'),
            lt(backupSnapshotAttestations.attemptCount, MAX_VERIFY_ATTEMPTS),
            or(
              and(isNull(backupSnapshotAttestations.nextAttemptAt), lt(backupSnapshotAttestations.createdAt, cutoff)),
              lte(backupSnapshotAttestations.nextAttemptAt, dueBy),
            ),
          ),
        )
        .orderBy(asc(dueAt), asc(backupSnapshotAttestations.createdAt))
        .limit(SWEEP_BATCH),
    ),
  );
  return rows.map((r) => r.snapshotDbId);
}

export async function requeueStalePendingAttestations(now = new Date()): Promise<number> {
  const ids = await findStalePendingAttestations(now);
  let enqueued = 0;
  for (const id of ids) {
    try {
      await enqueueSnapshotAttestationVerification(id);
      enqueued += 1;
    } catch (err) {
      console.error(`[BackupSnapshotAttestationWorker] Failed to re-enqueue verification for snapshot ${id}:`, err);
    }
  }
  return enqueued;
}

/**
 * Of the given snapshots, those whose attestation is server-fetched, still
 * pending and not parked (system scope).
 */
export async function findPendingServerFetchedAttestations(snapshotDbIds: string[]): Promise<string[]> {
  if (snapshotDbIds.length === 0) return [];
  const rows = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db
        .select({ snapshotDbId: backupSnapshotAttestations.snapshotDbId })
        .from(backupSnapshotAttestations)
        .where(
          and(
            inArray(backupSnapshotAttestations.snapshotDbId, snapshotDbIds),
            eq(backupSnapshotAttestations.status, 'pending'),
            eq(backupSnapshotAttestations.verificationMode, 'server_fetched'),
            lt(backupSnapshotAttestations.attemptCount, MAX_VERIFY_ATTEMPTS),
          ),
        ),
    ),
  );
  return rows.map((r) => r.snapshotDbId);
}

/**
 * Called by the cleanup job right after it published these snapshots' id
 * reservations: queues verification for each one with a pending
 * server-fetched attestation, instead of leaving it to the next sweep. Best
 * effort — a failed enqueue is logged, and the sweep still retries the row
 * when due. Returns how many were queued.
 */
export async function enqueueVerificationForPublishedSnapshots(snapshotDbIds: string[]): Promise<number> {
  const pending = await findPendingServerFetchedAttestations(snapshotDbIds);
  let enqueued = 0;
  for (const id of pending) {
    try {
      await enqueueVerification(id, publishedAttestationJobId(id));
      enqueued += 1;
    } catch (err) {
      console.error(`[BackupSnapshotAttestationWorker] Failed to enqueue verification for published snapshot ${id}:`, err);
    }
  }
  return enqueued;
}

async function processAttestationJob(job: Job<AttestationJobData>): Promise<{ status: string }> {
  if (job.data.type === 'sweep-pending') {
    const enqueued = await requeueStalePendingAttestations();
    return { status: `requeued:${enqueued}` };
  }
  const result = await verifySnapshotAttestation(job.data.snapshotDbId);
  if (result.outcome === 'retry') {
    // Storage or configuration not usable right now: the row stays pending
    // and carries its own next attempt time, which the sweep honours.
    console.warn(
      `[BackupSnapshotAttestationWorker] Verification of snapshot ${job.data.snapshotDbId} deferred: ${result.reason ?? 'unavailable'}`,
    );
  }
  if (result.outcome === 'mismatch') {
    console.warn(
      `[BackupSnapshotAttestationWorker] Snapshot ${job.data.snapshotDbId} does not match its attestation: ${result.reason ?? 'mismatch'}`,
    );
  }
  return { status: result.outcome };
}

export async function initializeBackupSnapshotAttestationWorker(): Promise<void> {
  worker = new Worker<AttestationJobData>(QUEUE_NAME, processAttestationJob, {
    connection: getBullMQConnection(),
    concurrency: 2,
  });
  attachWorkerObservability(worker, 'backupSnapshotAttestationWorker');
  worker.on('error', (error) => {
    console.error('[BackupSnapshotAttestationWorker] Worker error:', error);
  });
  worker.on('failed', (job, error) => {
    console.error(`[BackupSnapshotAttestationWorker] Job ${job?.id} failed:`, error);
  });

  const q = getQueue();
  const sweep = await q.add('sweep-pending', { type: 'sweep-pending' }, {
    repeat: { every: SWEEP_EVERY_MS },
    removeOnComplete: { count: 10 },
    removeOnFail: { count: 20 },
  });
  for (const repeatable of await q.getRepeatableJobs()) {
    if (repeatable.name === 'sweep-pending' && repeatable.key !== sweep.repeatJobKey) {
      await q.removeRepeatableByKey(repeatable.key);
    }
  }
  console.log('[BackupSnapshotAttestationWorker] Worker initialized');
}

export async function shutdownBackupSnapshotAttestationWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
  if (queue) {
    await queue.close();
    queue = null;
  }
}

export const __testOnly = { processAttestationJob };
