import { Job, Queue, Worker } from 'bullmq';
import { asc, eq, lt } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { aiRunArtifacts } from '../db/schema';
import { getBullMQConnection } from '../services/redis';
import { captureException } from '../services/sentry';
import { getBlobStorage } from '../services/artifacts/blobStorage';
import { attachWorkerObservability } from './workerObservability';
import { jobSchedule } from './scheduleRegistry';

/**
 * AI artifact expiry sweep (execution-plane spec §6.1: "sweeper deletes blob
 * then row"; §8 residency).
 *
 * ORDER IS THE CONTRACT. `blob_key` carries no tenant id by design, so the row
 * is the ONLY index to the object. A row deleted before its blob strands
 * customer bytes in the bucket permanently — the exact GDPR failure the
 * erasure pre-clear in tenantCascade.ts step 1a-bis also guards. A blob delete
 * that fails therefore LEAVES its row, is counted, and the next hourly sweep
 * retries it; the sweep is rerunnable by construction.
 *
 * CROSS-ORG BY DESIGN: this is the one artifact path that legitimately runs
 * under a system context, which is why the table carries a plain
 * `(expires_at)` index alongside the tenant-scoped `(org_id, expires_at)` one.
 *
 * Batched (200) so a large backlog does not hold one pooled connection or one
 * job for minutes; each batch re-queries, so rows the previous batch left
 * behind (failed blob deletes) are naturally retried next hour rather than
 * spinning inside this run.
 */

export const AI_ARTIFACT_SWEEPER_QUEUE = 'ai-artifact-expiry-sweeper';
const JOB_NAME = 'sweep-expired-ai-artifacts';
export const AI_ARTIFACT_SWEEP_BATCH = 200;
/** Guard against an unbounded run if every blob delete is failing. */
const MAX_BATCHES_PER_RUN = 50;

let queue: Queue | null = null;
let worker: Worker | null = null;

function getQueue(): Queue {
  if (!queue) queue = new Queue(AI_ARTIFACT_SWEEPER_QUEUE, { connection: getBullMQConnection() });
  return queue;
}

export async function sweepExpiredArtifacts(): Promise<{ blobsDeleted: number; rowsDeleted: number; failed: number }> {
  const blobs = getBlobStorage();
  const stats = { blobsDeleted: 0, rowsDeleted: 0, failed: 0 };
  // Ids already tried and failed this run, so a short page does not loop on
  // the same rows (each batch re-queries from the top of the expiry order).
  const skip = new Set<string>();

  for (let batch = 0; batch < MAX_BATCHES_PER_RUN; batch += 1) {
    const rows = await runOutsideDbContext(() => withSystemDbAccessContext(
      () => db
        .select({ id: aiRunArtifacts.id, blobKey: aiRunArtifacts.blobKey })
        .from(aiRunArtifacts)
        .where(lt(aiRunArtifacts.expiresAt, new Date()))
        .orderBy(asc(aiRunArtifacts.expiresAt))
        .limit(AI_ARTIFACT_SWEEP_BATCH + skip.size),
      'aiArtifactSweeper.scan',
    ));

    const pending = rows.filter((r) => !skip.has(r.id)).slice(0, AI_ARTIFACT_SWEEP_BATCH);
    if (pending.length === 0) break;

    for (const artifact of pending) {
      try {
        // Blob FIRST — always.
        await blobs.delete(artifact.blobKey);
        stats.blobsDeleted += 1;
      } catch (err) {
        // Leave the row so the key stays findable; the next sweep retries it.
        stats.failed += 1;
        skip.add(artifact.id);
        captureException(err);
        console.error('[aiArtifactSweeper] blob delete failed; row kept for the next sweep', { artifactId: artifact.id });
        continue;
      }
      await runOutsideDbContext(() => withSystemDbAccessContext(
        () => db.delete(aiRunArtifacts).where(eq(aiRunArtifacts.id, artifact.id)),
        'aiArtifactSweeper.delete',
      ));
      stats.rowsDeleted += 1;
    }

    if (pending.length < AI_ARTIFACT_SWEEP_BATCH) break;
  }

  if (stats.rowsDeleted > 0 || stats.failed > 0) {
    console.log(`[aiArtifactSweeper] swept ${stats.rowsDeleted} expired artifact(s), ${stats.failed} deferred`);
  }
  return stats;
}

async function processJob(_job: Job): Promise<unknown> {
  // Deliberately NOT wrapped in withSystemDbAccessContext here — the sweep
  // opens its own short contexts per statement, and nesting them is the #1105
  // double-connection-hold trap the ticket reaper's handler documents.
  return sweepExpiredArtifacts();
}

async function scheduleRepeatableJob(): Promise<void> {
  const q = getQueue();
  for (const job of await q.getRepeatableJobs()) {
    if (job.name === JOB_NAME) await q.removeRepeatableByKey(job.key);
  }
  await q.add(
    JOB_NAME,
    { type: JOB_NAME, queuedAt: new Date().toISOString() },
    {
      jobId: AI_ARTIFACT_SWEEPER_QUEUE,
      // String literal, not the exported const: the schedule contract test
      // statically resolves `jobSchedule('<literal>')` only.
      repeat: { pattern: jobSchedule('ai-artifact-expiry-sweeper') },
      removeOnComplete: { count: 20 },
      removeOnFail: { count: 200 },
    },
  );
}

export async function initializeAiArtifactSweeper(): Promise<void> {
  if (worker) return;
  worker = new Worker(AI_ARTIFACT_SWEEPER_QUEUE, processJob, {
    connection: getBullMQConnection(),
    concurrency: 1,
  });
  attachWorkerObservability(worker, 'aiArtifactSweeper');
  try {
    await scheduleRepeatableJob();
  } catch (err) {
    await worker.close();
    worker = null;
    throw err;
  }
  console.log('[aiArtifactSweeper] Initialized');
}

export async function shutdownAiArtifactSweeper(): Promise<void> {
  await worker?.close();
  worker = null;
  await queue?.close();
  queue = null;
}
