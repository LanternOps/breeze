// BullMQ worker that runs verifySnapshotAttestation
// (services/backupAttestationVerify.ts) out of band. Enqueued when an agent
// result records a server-fetched attestation (services/backupAttestation.ts);
// a periodic sweep re-enqueues rows still `pending` after
// STALE_PENDING_AFTER_MS, which covers a lost enqueue, exhausted retries and
// storage that was unreachable for a while. jobId is snapshot-scoped so
// concurrent enqueues collapse into one job. Pattern mirrors
// jobs/backupSnapshotFileIndexWorker.ts.
import { Job, Queue, Worker } from 'bullmq';
import { and, asc, eq, lt } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { backupSnapshotAttestations } from '../db/schema/backupSnapshotAttestations';
import { getBullMQConnection } from '../services/redis';
import { verifySnapshotAttestation } from '../services/backupAttestationVerify';
import { attachWorkerObservability } from './workerObservability';
import { isReusableState } from '../services/bullmqUtils';

const QUEUE_NAME = 'backup-snapshot-attestation';
const VERIFY_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential' as const, delay: 60_000 },
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

/** Snapshot ids of server-fetched attestations still pending after `olderThanMs`. */
export async function findStalePendingAttestations(now: Date, olderThanMs = STALE_PENDING_AFTER_MS): Promise<string[]> {
  const cutoff = new Date(now.getTime() - olderThanMs);
  const rows = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db
        .select({ snapshotDbId: backupSnapshotAttestations.snapshotDbId })
        .from(backupSnapshotAttestations)
        .where(
          and(
            eq(backupSnapshotAttestations.status, 'pending'),
            eq(backupSnapshotAttestations.verificationMode, 'server_fetched'),
            lt(backupSnapshotAttestations.createdAt, cutoff),
          ),
        )
        .orderBy(asc(backupSnapshotAttestations.createdAt))
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
    // Storage or configuration not usable right now: the row stays pending.
    // Throwing lets BullMQ back off and retry; the sweep picks it up after the
    // attempts run out.
    throw new Error(`snapshot attestation verification deferred: ${result.reason ?? 'unavailable'}`);
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
