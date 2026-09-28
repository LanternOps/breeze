// BullMQ worker that runs verifySnapshotAttestation
// (services/backupAttestationVerify.ts) out of band. Enqueued when an agent
// result records a server-fetched attestation (services/backupAttestation.ts);
// a periodic sweep re-enqueues rows still `pending` once they are due: a row
// never attempted is due STALE_PENDING_AFTER_MS after creation (a lost
// enqueue); a row whose storage could not be read is due at its
// next_attempt_at, which the verifier backs off exponentially. Rows that
// used up MAX_VERIFY_ATTEMPTS stay pending but are not swept again. jobId is snapshot-scoped so
// concurrent enqueues collapse into one job. Pattern mirrors
// jobs/backupSnapshotFileIndexWorker.ts.
import { Job, Queue, Worker } from 'bullmq';
import { and, asc, eq, isNull, lt, lte, or, sql } from 'drizzle-orm';
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

export async function enqueueSnapshotAttestationVerification(snapshotDbId: string): Promise<string> {
  const q = getQueue();
  const jobId = attestationJobId(snapshotDbId);
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

/**
 * Snapshot ids of server-fetched attestations due for another verification
 * attempt, earliest due first: never attempted and older than `olderThanMs`,
 * or past their scheduled retry. Parked rows are excluded.
 */
export async function findStalePendingAttestations(now: Date, olderThanMs = STALE_PENDING_AFTER_MS): Promise<string[]> {
  const cutoff = new Date(now.getTime() - olderThanMs);
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
              lte(backupSnapshotAttestations.nextAttemptAt, now),
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
