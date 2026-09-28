/**
 * Cleanup for brokered backup writes (services/backupStorageWriteSessions.ts),
 * a repeatable job every 5 minutes. Makes every abort durable and finishes
 * the reservation lifecycle the database starts:
 *
 *  1. Recorded multipart uploads still creating/open/completing whose session
 *     was revoked, whose job ended, or that outlived any possible session are
 *     aborted in storage (an upload that no longer exists counts as aborted)
 *     and marked aborted.
 *  2. Once per finished prefix (sealing past its horizon, published, or
 *     abandoned — issued by the server), every multipart upload still open in
 *     storage under `snapshots/<id>/` is aborted unless it was completed
 *     through the session. This also catches an upload whose creation
 *     succeeded in storage but was never recorded.
 *  3. A sealing reservation whose sealed_until has passed, with no recorded
 *     upload still open, is published.
 *  4. A reserved id whose job has ended, whose issued URLs have all expired,
 *     and with no recorded upload still open, is abandoned (storage reclaim
 *     may then remove the prefix once it is old enough).
 *
 * The scans and the state writes run in short system contexts; no DB context
 * is held across a storage call.
 */
import { Queue, Worker } from 'bullmq';
import { and, eq, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../db';
import {
  backupJobs,
  backupSnapshotIdReservations,
  backupStorageSessionUploads,
  backupStorageSessions,
} from '../db/schema';
import { recordBackupWriteJanitor } from '../services/backupMetrics';
import { resolveBackupWriteCommandDestination } from '../services/backupProviderConfig';
import { abortMultipartUpload, listMultipartUploads } from '../services/backupStoragePresign';
import { STORAGE_WRITE_SESSION_DEADLINE_MS } from '../services/backupStorageWriteSessions';
import { getBullMQConnection } from '../services/redis';
import { captureException } from '../services/sentry';
import { attachWorkerObservability } from './workerObservability';

const QUEUE_NAME = 'backup-write-session-janitor';
const JOB_NAME = 'backup-write-session-janitor';
const REPEAT_JOB_ID = 'backup-write-session-janitor-repeat';
const RUN_EVERY_MS = 5 * 60 * 1000;
const BATCH = 200;
const OPEN_UPLOAD_STATES = ['creating', 'open', 'completing'];

export type JanitorStorage = {
  abortMultipart(cfg: Record<string, unknown>, key: string, uploadId: string): Promise<void>;
  listMultipart(cfg: Record<string, unknown>, prefix: string): Promise<Array<{ key: string; uploadId: string }>>;
};

export type JanitorDeps = { now(): Date; storage: JanitorStorage };

const defaultDeps: JanitorDeps = {
  now: () => new Date(),
  storage: {
    abortMultipart: (cfg, key, uploadId) => abortMultipartUpload(cfg, key, uploadId),
    listMultipart: (cfg, prefix) => listMultipartUploads(cfg, prefix),
  },
};

export type JanitorSummary = { abortedUploads: number; sweptPrefixes: number; published: number; abandoned: number; failures: number };

async function destinationFor(configId: string | null, orgId: string): Promise<Record<string, unknown> | null> {
  if (!configId) return null;
  const result = await withSystemDbAccessContext(() => resolveBackupWriteCommandDestination(configId, orgId));
  if (!result.ok || result.destination.provider !== 's3') return null;
  return result.destination.providerConfig;
}

/** Rule 1. */
async function abortRecordedUploads(deps: JanitorDeps, summary: JanitorSummary): Promise<void> {
  const now = deps.now();
  const tooOld = new Date(now.getTime() - STORAGE_WRITE_SESSION_DEADLINE_MS - 60 * 60 * 1000);
  const rows = await withSystemDbAccessContext(() =>
    db
      .select({
        id: backupStorageSessionUploads.id,
        orgId: backupStorageSessionUploads.orgId,
        objectKey: backupStorageSessionUploads.objectKey,
        uploadId: backupStorageSessionUploads.uploadId,
        configId: backupStorageSessions.configId,
      })
      .from(backupStorageSessionUploads)
      .innerJoin(backupStorageSessions, eq(backupStorageSessions.id, backupStorageSessionUploads.sessionId))
      .leftJoin(backupJobs, eq(backupJobs.id, backupStorageSessions.jobId))
      .where(and(
        inArray(backupStorageSessionUploads.state, OPEN_UPLOAD_STATES),
        or(
          isNotNull(backupStorageSessions.revokedAt),
          isNull(backupJobs.id),
          sql`${backupJobs.status}::text NOT IN ('pending', 'running')`,
          lt(backupStorageSessionUploads.createdAt, tooOld),
        ),
      ))
      .limit(BATCH),
  );
  for (const row of rows) {
    try {
      if (row.uploadId) {
        const cfg = await destinationFor(row.configId, row.orgId);
        if (!cfg) throw new Error('destination unavailable');
        await deps.storage.abortMultipart(cfg, row.objectKey, row.uploadId);
      }
      await withSystemDbAccessContext(() =>
        db.update(backupStorageSessionUploads)
          .set({ state: 'aborted', updatedAt: new Date() })
          .where(and(eq(backupStorageSessionUploads.id, row.id), inArray(backupStorageSessionUploads.state, OPEN_UPLOAD_STATES))),
      );
      summary.abortedUploads++;
      recordBackupWriteJanitor('abort_upload', 'ok');
    } catch (err) {
      summary.failures++;
      recordBackupWriteJanitor('abort_upload', 'failed');
      console.warn('[BackupWriteSessionJanitor] could not abort a multipart upload; will retry', {
        uploadRowId: row.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/** Rule 4: re-checked inside the updating statement. */
async function abandonEndedReservations(deps: JanitorDeps, summary: JanitorSummary): Promise<void> {
  const now = deps.now();
  const rows = await withSystemDbAccessContext(() =>
    db.execute(sql`
      UPDATE backup_snapshot_id_reservations r
         SET state = 'abandoned', updated_at = ${now.toISOString()}::timestamptz
       WHERE r.state = 'reserved'
         AND r.source = 'server_minted'
         AND NOT EXISTS (
               SELECT 1 FROM backup_jobs j
                WHERE j.id = r.current_job_id AND j.status::text IN ('pending', 'running'))
         AND NOT EXISTS (
               SELECT 1 FROM backup_storage_sessions s
                WHERE s.reservation_snapshot_id = r.snapshot_id
                  AND s.url_horizon_at IS NOT NULL
                  AND s.url_horizon_at >= ${now.toISOString()}::timestamptz)
         AND NOT EXISTS (
               SELECT 1 FROM backup_storage_session_uploads u
                WHERE u.reservation_snapshot_id = r.snapshot_id
                  AND u.state IN ('creating', 'open', 'completing'))
      RETURNING r.snapshot_id
    `),
  );
  const n = (rows as unknown as unknown[]).length;
  summary.abandoned += n;
  if (n > 0) recordBackupWriteJanitor('abandon', 'ok', n);
}

/** Rule 3. */
async function publishSealed(deps: JanitorDeps, summary: JanitorSummary): Promise<void> {
  const now = deps.now();
  const rows = await withSystemDbAccessContext(() =>
    db.execute(sql`
      UPDATE backup_snapshot_id_reservations r
         SET state = 'published', updated_at = ${now.toISOString()}::timestamptz
       WHERE r.state = 'sealing'
         AND r.sealed_until IS NOT NULL
         AND r.sealed_until < ${now.toISOString()}::timestamptz
         AND NOT EXISTS (
               SELECT 1 FROM backup_storage_session_uploads u
                WHERE u.reservation_snapshot_id = r.snapshot_id
                  AND u.state IN ('creating', 'open', 'completing'))
      RETURNING r.snapshot_id
    `),
  );
  const n = (rows as unknown as unknown[]).length;
  summary.published += n;
  if (n > 0) recordBackupWriteJanitor('publish', 'ok', n);
}

/** Rule 2. */
async function sweepFinishedPrefixes(deps: JanitorDeps, summary: JanitorSummary): Promise<void> {
  const now = deps.now();
  const candidates = await withSystemDbAccessContext(() =>
    db
      .select({
        snapshotId: backupSnapshotIdReservations.snapshotId,
        orgId: backupSnapshotIdReservations.orgId,
        configId: backupSnapshotIdReservations.configId,
      })
      .from(backupSnapshotIdReservations)
      .where(and(
        eq(backupSnapshotIdReservations.source, 'server_minted'),
        isNull(backupSnapshotIdReservations.uploadsSweptAt),
        or(
          inArray(backupSnapshotIdReservations.state, ['published', 'abandoned']),
          and(
            eq(backupSnapshotIdReservations.state, 'sealing'),
            lt(backupSnapshotIdReservations.sealedUntil, now),
          ),
        ),
      ))
      .limit(BATCH),
  );
  for (const r of candidates) {
    const prefix = `snapshots/${r.snapshotId}/`;
    try {
      const completed = await withSystemDbAccessContext(async () => {
        const rows = await db
          .select({ objectKey: backupStorageSessionUploads.objectKey, uploadId: backupStorageSessionUploads.uploadId })
          .from(backupStorageSessionUploads)
          .where(and(
            eq(backupStorageSessionUploads.reservationSnapshotId, r.snapshotId),
            eq(backupStorageSessionUploads.state, 'completed'),
          ));
        return new Set(rows.map((u) => `${u.objectKey}\u0000${u.uploadId}`));
      });
      const cfg = await destinationFor(r.configId, r.orgId);
      if (!cfg) throw new Error('destination unavailable');
      const open = await deps.storage.listMultipart(cfg, prefix);
      for (const u of open) {
        if (!u.key.startsWith(prefix) || completed.has(`${u.key}\u0000${u.uploadId}`)) continue;
        await deps.storage.abortMultipart(cfg, u.key, u.uploadId);
      }
      await withSystemDbAccessContext(() =>
        db.update(backupSnapshotIdReservations)
          .set({ uploadsSweptAt: now })
          .where(eq(backupSnapshotIdReservations.snapshotId, r.snapshotId)),
      );
      summary.sweptPrefixes++;
      recordBackupWriteJanitor('sweep_prefix', 'ok');
    } catch (err) {
      summary.failures++;
      recordBackupWriteJanitor('sweep_prefix', 'failed');
      console.warn('[BackupWriteSessionJanitor] could not sweep multipart uploads under a snapshot prefix; will retry', {
        snapshotId: r.snapshotId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

export async function runBackupWriteSessionJanitor(deps: JanitorDeps = defaultDeps): Promise<JanitorSummary> {
  const summary: JanitorSummary = { abortedUploads: 0, sweptPrefixes: 0, published: 0, abandoned: 0, failures: 0 };
  await abortRecordedUploads(deps, summary);
  await abandonEndedReservations(deps, summary);
  await publishSealed(deps, summary);
  await sweepFinishedPrefixes(deps, summary);
  return summary;
}

let queue: Queue | null = null;
let worker: Worker | null = null;

function getQueue(): Queue {
  if (!queue) queue = new Queue(QUEUE_NAME, { connection: getBullMQConnection() });
  return queue;
}

export async function initializeBackupWriteSessionJanitor(): Promise<void> {
  worker = new Worker(
    QUEUE_NAME,
    async () => {
      const summary = await runBackupWriteSessionJanitor();
      if (summary.failures > 0) {
        console.warn('[BackupWriteSessionJanitor] run finished with failures', summary);
      }
      return summary;
    },
    { connection: getBullMQConnection(), concurrency: 1 },
  );
  attachWorkerObservability(worker, 'backupWriteSessionJanitor');
  worker.on('failed', (job, error) => {
    console.error(`[BackupWriteSessionJanitor] Job ${job?.id} failed:`, error);
    captureException(error);
  });
  await getQueue().add(JOB_NAME, {}, {
    jobId: REPEAT_JOB_ID,
    repeat: { every: RUN_EVERY_MS },
    removeOnComplete: { count: 10 },
    removeOnFail: { count: 25 },
  });
  console.log('[BackupWriteSessionJanitor] Worker initialized');
}

export async function shutdownBackupWriteSessionJanitor(): Promise<void> {
  await worker?.close();
  worker = null;
  await queue?.close();
  queue = null;
}
