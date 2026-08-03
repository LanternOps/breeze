/**
 * Software Upload Session Cleanup Worker (issue #2951).
 *
 * Chunked package uploads stage bytes in a temp file under
 * join(tmpdir(), 'breeze-uploads') with one software_upload_sessions row per
 * upload. Abandoned uploads (browser closed, tab killed, network gone) leave
 * both behind. This sweep hard-deletes sessions that trip EITHER ceiling:
 *   - idle: last_activity_at older than SOFTWARE_UPLOAD_SESSION_IDLE_TTL_HOURS
 *     (default 2 — each session can pin up to 500MB of temp disk, so idle
 *     sessions must not linger for a day);
 *   - absolute lifetime: created_at older than
 *     SOFTWARE_UPLOAD_SESSION_MAX_AGE_HOURS (default 24) REGARDLESS of
 *     activity, so a client that keeps a session warm forever cannot pin
 *     disk indefinitely.
 * Each session's temp file is unlinked first (best-effort: ENOENT after a
 * restart that cleared tmp is fine).
 *
 * Only files named by the sessions' own temp_path are ever touched — the
 * legacy multipart route's `<uuid>.upload` staging files in the same
 * directory are invisible here. This job never globs or sweeps the
 * breeze-uploads directory; it only unlinks paths read from the temp_path
 * column of a row it is about to delete.
 *
 * Every /complete failure path in routes/softwareUploads.ts deliberately
 * leaves the temp file and session row in place so the client can retry
 * /complete without re-uploading hundreds of MB — and deliberately does NOT
 * bump last_activity_at on those retries, biasing toward reclamation by this
 * job. That trade is only safe because this reaper bounds the leak; do not
 * "fix" the API to keep last_activity_at warm on failure paths.
 *
 * Scheduling: hourly cron ('15 * * * *'), jobId-deduped across replicas.
 * RLS: runs inside withSystemDbAccessContext (background job, all tenants).
 * Idempotent: re-running finds zero stale rows.
 * Env: SOFTWARE_UPLOAD_SESSION_CLEANUP_ENABLED (default on),
 *      SOFTWARE_UPLOAD_SESSION_IDLE_TTL_HOURS (default 2),
 *      SOFTWARE_UPLOAD_SESSION_MAX_AGE_HOURS (default 24).
 */
import { Queue, Worker, Job } from 'bullmq';
import { inArray, lt, or } from 'drizzle-orm';
import { unlink } from 'node:fs/promises';
import { db, withSystemDbAccessContext } from '../db';
import { softwareUploadSessions } from '../db/schema';
import { captureException } from '../services/sentry';
import { getBullMQConnection } from '../services/redis';

const QUEUE_NAME = 'software-upload-session-cleanup';
const JOB_NAME = 'software-upload-session-cleanup';
const REPEAT_JOB_ID = 'software-upload-session-cleanup';
// Hourly at :15 — staggered from the 02:00/03:00/04:00 daily jobs.
const HOURLY_CRON = '15 * * * *';
const DEFAULT_IDLE_TTL_HOURS = 2;
const DEFAULT_MAX_AGE_HOURS = 24;

function isCleanupEnabled(): boolean {
  const raw = process.env.SOFTWARE_UPLOAD_SESSION_CLEANUP_ENABLED;
  if (raw === undefined || raw === '') return true;
  const v = raw.trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'no' || v === 'off');
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getIdleTtlHours(): number {
  return readPositiveIntEnv('SOFTWARE_UPLOAD_SESSION_IDLE_TTL_HOURS', DEFAULT_IDLE_TTL_HOURS);
}

function getMaxAgeHours(): number {
  return readPositiveIntEnv('SOFTWARE_UPLOAD_SESSION_MAX_AGE_HOURS', DEFAULT_MAX_AGE_HOURS);
}

let cleanupQueue: Queue | null = null;
let cleanupWorker: Worker | null = null;

export function getSoftwareUploadSessionCleanupQueue(): Queue {
  if (!cleanupQueue) {
    cleanupQueue = new Queue(QUEUE_NAME, { connection: getBullMQConnection() });
  }
  return cleanupQueue;
}

export function createSoftwareUploadSessionCleanupWorker(): Worker {
  return new Worker(
    QUEUE_NAME,
    async (job: Job) => {
      if (job.name !== JOB_NAME) {
        console.warn(`[SoftwareUploadSessionCleanup] Ignoring unknown job name: ${job.name}`);
        return { deletedCount: 0, skipped: true };
      }
      return withSystemDbAccessContext(async () => {
        const startedAt = Date.now();
        const idleTtlHours = getIdleTtlHours();
        const maxAgeHours = getMaxAgeHours();
        const idleCutoff = new Date(Date.now() - idleTtlHours * 3_600_000);
        const maxAgeCutoff = new Date(Date.now() - maxAgeHours * 3_600_000);

        // Two independent ceilings, OR'd: idle (no chunk activity) and
        // absolute lifetime (created too long ago, however warm).
        const stale = await db
          .select({
            id: softwareUploadSessions.id,
            tempPath: softwareUploadSessions.tempPath,
          })
          .from(softwareUploadSessions)
          .where(or(
            lt(softwareUploadSessions.lastActivityAt, idleCutoff),
            lt(softwareUploadSessions.createdAt, maxAgeCutoff),
          ));

        if (stale.length === 0) {
          return { deletedCount: 0, durationMs: Date.now() - startedAt };
        }

        // Unlink first: once the row is gone the path is unrecoverable, so a
        // failed unlink would strand the file forever. ENOENT is fine — the
        // file is already gone, which counts as success, not an error.
        for (const session of stale) {
          await unlink(session.tempPath).catch(() => {});
        }
        await db
          .delete(softwareUploadSessions)
          .where(inArray(softwareUploadSessions.id, stale.map((s) => s.id)));

        const durationMs = Date.now() - startedAt;
        console.log(
          `[SoftwareUploadSessionCleanup] Deleted ${stale.length} stale upload session(s) (idle>${idleTtlHours}h or age>${maxAgeHours}h) in ${durationMs}ms`,
        );
        return { deletedCount: stale.length, durationMs };
      });
    },
    { connection: getBullMQConnection(), concurrency: 1 },
  );
}

export async function scheduleSoftwareUploadSessionCleanup(
  queue: Queue = getSoftwareUploadSessionCleanupQueue(),
): Promise<void> {
  const existingJobs = await queue.getRepeatableJobs();
  for (const job of existingJobs) {
    if (job.name === JOB_NAME) {
      await queue.removeRepeatableByKey(job.key);
    }
  }
  if (!isCleanupEnabled()) {
    console.log(
      '[SoftwareUploadSessionCleanup] SOFTWARE_UPLOAD_SESSION_CLEANUP_ENABLED=false — skipping schedule registration',
    );
    return;
  }
  await queue.add(
    JOB_NAME,
    {},
    {
      jobId: REPEAT_JOB_ID,
      repeat: { pattern: HOURLY_CRON },
      removeOnComplete: { count: 10 },
      removeOnFail: { count: 25 },
    },
  );
  console.log(
    `[SoftwareUploadSessionCleanup] Scheduled hourly cleanup (cron "${HOURLY_CRON}", jobId=${REPEAT_JOB_ID})`,
  );
}

export async function initializeSoftwareUploadSessionCleanupWorker(): Promise<void> {
  try {
    cleanupWorker = createSoftwareUploadSessionCleanupWorker();
    cleanupWorker.on('error', (error) => {
      console.error('[SoftwareUploadSessionCleanup] Worker error:', error);
      captureException(error);
    });
    cleanupWorker.on('failed', (job, error) => {
      console.error(`[SoftwareUploadSessionCleanup] Job ${job?.id} failed:`, error);
      captureException(error);
    });
    await scheduleSoftwareUploadSessionCleanup();
    console.log('[SoftwareUploadSessionCleanup] Worker initialized');
  } catch (error) {
    console.error('[SoftwareUploadSessionCleanup] Failed to initialize:', error);
    throw error;
  }
}

export async function shutdownSoftwareUploadSessionCleanupWorker(): Promise<void> {
  if (cleanupWorker) {
    await cleanupWorker.close();
    cleanupWorker = null;
  }
  if (cleanupQueue) {
    await cleanupQueue.close();
    cleanupQueue = null;
  }
}

export const __testOnly = {
  QUEUE_NAME,
  JOB_NAME,
  REPEAT_JOB_ID,
  HOURLY_CRON,
  DEFAULT_IDLE_TTL_HOURS,
  DEFAULT_MAX_AGE_HOURS,
  isCleanupEnabled,
  getIdleTtlHours,
  getMaxAgeHours,
};
