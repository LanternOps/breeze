import { lstat, readdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

import { and, asc, gt, inArray, isNotNull, isNull, lt, or } from 'drizzle-orm';
import { Job, Queue, Worker } from 'bullmq';

import { db, withSystemDbAccessContext } from '../db';
import { patchComplianceReports } from '../db/schema';
import { getBullMQConnection } from '../services/redis';
import { captureMessage } from '../services/sentry';
import { envInt } from '../utils/envInt';
import { errnoCode } from '../utils/fsErrno';
import {
  PATCH_REPORT_FILE_RE,
  patchReportFileFor,
  patchReportRetentionMs,
  patchReportStorageDir,
} from '../services/patchReportFiles';
import { attachWorkerObservability } from './workerObservability';
import { jobSchedule } from './scheduleRegistry';

/**
 * Patch compliance report retention.
 *
 * Generated report CSVs (`<PATCH_REPORT_STORAGE_PATH>/<report id>.csv`) used
 * to live forever. Once a day this job:
 *   1. removes the file of every report older than PATCH_REPORT_RETENTION_DAYS
 *      (measured from completion, or creation if it never completed) and marks
 *      the row `expired` with no `output_path`, and
 *   2. removes `<uuid>.csv` files in the storage directory that no row owns
 *      (leftovers from an erasure that could not unlink, or from a generation
 *      whose row was never completed), once they are older than
 *      PATCH_REPORT_ORPHAN_MIN_AGE_MS (default 1 hour).
 */

export const PATCH_REPORT_RETENTION_QUEUE = 'patch-report-retention';
const JOB_NAME = 'sweep-expired-patch-reports';
const EXPIRY_BATCH = 500;
const ORPHAN_LOOKUP_BATCH = 500;
const DEFAULT_ORPHAN_MIN_AGE_MS = 60 * 60 * 1000;
const ORPHAN_MIN_AGE_FLOOR_MS = 10 * 60 * 1000;

let queue: Queue | null = null;
let worker: Worker | null = null;

function getQueue(): Queue {
  if (!queue) queue = new Queue(PATCH_REPORT_RETENTION_QUEUE, { connection: getBullMQConnection() });
  return queue;
}

export interface PatchReportExpiryResult {
  expired: number;
  /** File could not be removed; the row is left as-is so the next run retries. */
  keptForRetry: number;
}

/**
 * Expire every report past the retention window that still has a file. The
 * file goes first and the row is only flipped once the file is gone (or was
 * already missing): a row is the only pointer to its bytes, so a removal
 * failure must leave it in place for the next run.
 */
export async function expirePatchReportFiles(
  opts: { now?: Date; batchSize?: number } = {},
): Promise<PatchReportExpiryResult> {
  const now = opts.now ?? new Date();
  const batchSize = opts.batchSize ?? EXPIRY_BATCH;
  const cutoff = new Date(now.getTime() - patchReportRetentionMs());
  const result: PatchReportExpiryResult = { expired: 0, keptForRetry: 0 };
  let lastId: string | null = null;

  for (;;) {
    const afterId = lastId;
    const page: Array<{ id: string; outputPath: string | null }> = await withSystemDbAccessContext(
      () => db
        .select({ id: patchComplianceReports.id, outputPath: patchComplianceReports.outputPath })
        .from(patchComplianceReports)
        .where(and(
          isNotNull(patchComplianceReports.outputPath),
          or(
            lt(patchComplianceReports.completedAt, cutoff),
            and(isNull(patchComplianceReports.completedAt), lt(patchComplianceReports.createdAt, cutoff)),
          ),
          afterId ? gt(patchComplianceReports.id, afterId) : undefined,
        ))
        .orderBy(asc(patchComplianceReports.id))
        .limit(batchSize),
      'patchReportRetention.expiredScan',
    );

    // Files first, one by one; then a single UPDATE for the whole page over
    // the rows whose file is gone (removed now or already missing). A row
    // whose file could not be removed stays as it is, so the next run retries.
    const expiredIds: string[] = [];
    for (const row of page) {
      const file = patchReportFileFor(row.id, row.outputPath);
      if (file) {
        try {
          await unlink(file);
        } catch (err) {
          if (errnoCode(err) !== 'ENOENT') {
            console.error(`[patchReportRetention] failed to remove expired report file ${file}; keeping row for retry:`, err);
            result.keptForRetry++;
            continue;
          }
        }
      } else {
        console.warn(`[patchReportRetention] report ${row.id} has an output path outside the storage directory; expiring the row only`);
      }
      expiredIds.push(row.id);
    }

    if (expiredIds.length > 0) {
      const updated = await withSystemDbAccessContext(
        () => db
          .update(patchComplianceReports)
          .set({ status: 'expired', outputPath: null, updatedAt: new Date() })
          .where(and(
            inArray(patchComplianceReports.id, expiredIds),
            isNotNull(patchComplianceReports.outputPath),
          ))
          .returning({ id: patchComplianceReports.id }),
        'patchReportRetention.expire',
      );
      result.expired += updated.length;
    }

    if (page.length < batchSize) break;
    lastId = page[page.length - 1]!.id;
  }

  if (result.keptForRetry > 0) {
    captureMessage('[patchReportRetention] expired patch report files could not be removed', {
      eventCode: 'patch_report_file_removal_failed',
      level: 'error',
    });
  }
  return result;
}

export interface PatchReportOrphanSweep {
  scanned: number;
  removed: number;
  failed: number;
}

/**
 * How old an unowned report file must be before the orphan sweep removes it.
 * The worker writes the file a moment before its transaction commits the
 * row's `output_path` (well inside the 5-minute report job lock), so a file
 * younger than that may simply not be committed yet. Default 1 hour, never
 * below 10 minutes. Deliberately much shorter than the retention window: an
 * orphan has no row, so nothing about it is still downloadable.
 */
function patchReportOrphanMinAgeMs(): number {
  return Math.max(ORPHAN_MIN_AGE_FLOOR_MS, envInt('PATCH_REPORT_ORPHAN_MIN_AGE_MS', DEFAULT_ORPHAN_MIN_AGE_MS));
}

/**
 * Remove report files no row owns: leftovers from an org erasure whose unlink
 * failed, or from a generation whose row was never completed. Only entries
 * named `<uuid>.csv` that are regular files by `lstat` are considered, so a
 * symlink inside the directory is never followed and subdirectories are never
 * entered. The storage directory itself may be a symlink (relocating it that
 * way is normal); it is resolved with `stat`, as the worker writing through it
 * does. A file counts as owned while its report row exists with an
 * `output_path`. Row lookups fail closed: if one throws, nothing in that batch
 * is removed.
 */
export async function sweepOrphanedPatchReportFiles(
  opts: { now?: Date; minAgeMs?: number; lookupBatchSize?: number } = {},
): Promise<PatchReportOrphanSweep> {
  const root = patchReportStorageDir();
  const cutoffMs = (opts.now ?? new Date()).getTime() - (opts.minAgeMs ?? patchReportOrphanMinAgeMs());
  const batchSize = opts.lookupBatchSize ?? ORPHAN_LOOKUP_BATCH;
  const result: PatchReportOrphanSweep = { scanned: 0, removed: 0, failed: 0 };
  const failures: string[] = [];
  const recordFailure = (file: string, err: unknown) => {
    result.failed++;
    failures.push(`${file}: ${errnoCode(err) ?? (err instanceof Error ? err.message : String(err))}`);
  };
  const reportFailures = () => {
    if (result.failed === 0) return;
    console.error(
      `[patchReportRetention] orphan sweep: ${result.failed} failure(s) (${result.removed} orphaned file(s) removed)`,
      failures.slice(0, 20),
    );
    captureMessage('[patchReportRetention] orphan sweep could not remove some patch report files', {
      eventCode: 'patch_report_file_removal_failed',
      level: 'error',
    });
  };

  try {
    const info = await stat(root);
    if (!info.isDirectory()) {
      recordFailure(root, new Error('PATCH_REPORT_STORAGE_PATH is not a directory'));
      reportFailures();
      return result;
    }
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return result;
    throw err;
  }

  const candidates: Array<{ id: string; file: string }> = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!PATCH_REPORT_FILE_RE.test(entry.name)) continue;
    const file = path.join(root, entry.name);
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.mtimeMs >= cutoffMs) continue;
    } catch (err) {
      if (errnoCode(err) !== 'ENOENT') recordFailure(file, err);
      continue;
    }
    candidates.push({ id: entry.name.slice(0, -'.csv'.length).toLowerCase(), file });
  }

  result.scanned = candidates.length;
  for (let i = 0; i < candidates.length; i += batchSize) {
    const batch = candidates.slice(i, i + batchSize);
    // System scope: a contextless read sees no rows under forced RLS, which
    // here would make every live report look orphaned.
    const rows = await withSystemDbAccessContext(
      () => db
        .select({ id: patchComplianceReports.id })
        .from(patchComplianceReports)
        .where(and(
          inArray(patchComplianceReports.id, batch.map((c) => c.id)),
          isNotNull(patchComplianceReports.outputPath),
        )),
      'patchReportRetention.orphanLookup',
    );
    const owned = new Set(rows.map((row) => row.id.toLowerCase()));
    for (const candidate of batch) {
      if (owned.has(candidate.id)) continue;
      try {
        await unlink(candidate.file);
        result.removed++;
      } catch (err) {
        if (errnoCode(err) !== 'ENOENT') recordFailure(candidate.file, err);
      }
    }
  }

  reportFailures();
  return result;
}

/** One retention run: expire old reports, then sweep orphaned files. Exported for tests. */
export async function runPatchReportRetentionOnce(
  opts: { now?: Date } = {},
): Promise<{ expired: PatchReportExpiryResult; orphans: PatchReportOrphanSweep }> {
  const expired = await expirePatchReportFiles({ now: opts.now });
  const orphans = await sweepOrphanedPatchReportFiles({ now: opts.now });
  console.log(
    `[patchReportRetention] expired ${expired.expired} report file(s)`
    + ` (${expired.keptForRetry} kept for retry), removed ${orphans.removed} orphaned file(s)`,
  );
  return { expired, orphans };
}

async function processJob(_job: Job): Promise<unknown> {
  return runPatchReportRetentionOnce();
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
      jobId: PATCH_REPORT_RETENTION_QUEUE,
      // String literal, not the exported const: the schedule contract test
      // statically resolves `jobSchedule('<literal>')` only.
      repeat: { pattern: jobSchedule('patch-report-retention') },
      removeOnComplete: { count: 20 },
      removeOnFail: { count: 200 },
    },
  );
}

export async function initializePatchReportRetentionWorker(): Promise<void> {
  if (worker) return;
  worker = new Worker(PATCH_REPORT_RETENTION_QUEUE, processJob, {
    connection: getBullMQConnection(),
    concurrency: 1,
  });
  attachWorkerObservability(worker, 'patchReportRetention');
  try {
    await scheduleRepeatableJob();
  } catch (err) {
    await worker.close();
    worker = null;
    throw err;
  }
  console.log('[patchReportRetention] Initialized');
}

export async function shutdownPatchReportRetentionWorker(): Promise<void> {
  await worker?.close();
  worker = null;
  await queue?.close();
  queue = null;
}
