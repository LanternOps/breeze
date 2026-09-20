// W09 (#6464) Task 4 — BullMQ worker that runs hydrateSnapshotFileIndex
// (services/backupSnapshotFileIndex.ts) out of band. Enqueued from three
// places: a backup result with referencedFiles > 0
// (backupResultPersistence.ts), a bare-metal recovery creation preflight
// (bareMetalRecoveryService.ts, Task 5), and the exchange/authenticate
// negotiation's 'pending' branch (recoveryCapabilities.ts route glue, Task
// 5). jobId is snapshot-scoped so BullMQ's own dedupe collapses concurrent
// enqueues for the same snapshot into one job. Pattern mirrors
// jobs/recoveryMediaWorker.ts (stable jobId, UnrecoverableError for
// non-retryable failures).
import { Job, Queue, UnrecoverableError, Worker } from 'bullmq';
import { getBullMQConnection } from '../services/redis';
import { withSystemDbAccessContext } from '../db';
import { hydrateSnapshotFileIndex } from '../services/backupSnapshotFileIndex';
import { attachWorkerObservability } from './workerObservability';

const QUEUE_NAME = 'backup-snapshot-file-index';
const JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 60_000 },
  removeOnComplete: { count: 100 },
  removeOnFail: { count: 200 },
};

type HydrationJobData = {
  snapshotDbId: string;
  reason: 'result' | 'recovery_create' | 'authenticate' | 'exchange' | 'manual';
};

let queue: Queue<HydrationJobData> | null = null;
let worker: Worker<HydrationJobData> | null = null;

function getQueue(): Queue<HydrationJobData> {
  if (!queue) {
    queue = new Queue<HydrationJobData>(QUEUE_NAME, { connection: getBullMQConnection() });
  }
  return queue;
}

export async function enqueueSnapshotFileIndexHydration(
  snapshotDbId: string,
  reason: HydrationJobData['reason'],
): Promise<string> {
  const q = getQueue();
  const jobId = `hydrate:${snapshotDbId}`;
  const job = await q.add('hydrate', { snapshotDbId, reason }, { jobId, ...JOB_OPTIONS });
  return job.id!;
}

async function processHydrationJob(job: Job<HydrationJobData>): Promise<{ status: string }> {
  const outcome = await withSystemDbAccessContext(() => hydrateSnapshotFileIndex(job.data.snapshotDbId));
  if (outcome.status === 'failed' && !outcome.retryable) {
    // A non-retryable failure (bad manifest, unverifiable provenance, drifted
    // storage identity) will never succeed on retry — completing the job
    // (rather than throwing) stops BullMQ from burning three attempts on a
    // deterministic failure. The snapshot's own file_index_status/_error
    // columns are the permanent record; nothing here needs a job-level retry.
    return { status: 'failed-terminal' };
  }
  if (outcome.status === 'failed' && outcome.retryable) {
    throw new Error(`snapshot file-index hydration failed (retryable): ${outcome.failure}: ${outcome.reason}`);
  }
  return { status: outcome.status };
}

function createWorker(): Worker<HydrationJobData> {
  return new Worker<HydrationJobData>(QUEUE_NAME, processHydrationJob, {
    connection: getBullMQConnection(),
    concurrency: 2,
  });
}

export async function initializeBackupSnapshotFileIndexWorker(): Promise<void> {
  worker = createWorker();
  attachWorkerObservability(worker, 'backupSnapshotFileIndexWorker');
  worker.on('error', (error) => {
    console.error('[BackupSnapshotFileIndexWorker] Worker error:', error);
  });
  worker.on('failed', (job, error) => {
    console.error(`[BackupSnapshotFileIndexWorker] Job ${job?.id} failed:`, error);
  });
  console.log('[BackupSnapshotFileIndexWorker] Worker initialized');
}

export async function shutdownBackupSnapshotFileIndexWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
  if (queue) {
    await queue.close();
    queue = null;
  }
}
