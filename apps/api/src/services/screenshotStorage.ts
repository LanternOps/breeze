/**
 * Screenshot Storage Service
 *
 * Handles temporary storage of screenshots for AI vision analysis.
 * Uses local filesystem. Screenshots auto-expire based on retention policy.
 *
 * WHERE A FILE LIVES (#8117): a row's `storage_key` is the file's location —
 * `screenshots/<org>/<device>/<uuid>.jpg` relative to SCREENSHOT_DIR, fixed at
 * capture time. Never rebuild the path from the row's CURRENT `org_id`: a
 * device org move (and an org merge) re-points `org_id` but leaves the file
 * where it was, so a recomputed path misses it — the expiry sweep used to read
 * that miss as "already gone", delete the row, and orphan the file.
 *
 * WHO REMOVES FILES: the expiry sweep (rows past `expires_at`), every path that
 * deletes rows (org erasure, device purge, site delete — after their
 * transaction commits, via `removeScreenshotFiles`), and the orphan sweep for
 * anything those miss (a crash between commit and unlink, a purge path that
 * does not hand keys over, files orphaned before this existed).
 */

import { db, withSystemDbAccessContext } from '../db';
import { aiScreenshots } from '../db/schema/ai';
import { eq, and, gt, inArray, lte, sql } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { writeFile, mkdir, unlink, readFile, readdir, stat, rmdir } from 'fs/promises';
import { join } from 'path';
import { envInt } from '../utils/envInt';
import { captureMessage } from './sentry';
import {
  SCREENSHOT_DIR,
  SCREENSHOT_DIR_SEGMENT_RE,
  SCREENSHOT_FILE_RE,
  errnoCode,
  resolveScreenshotPath,
} from './screenshotFiles';

export { removeScreenshotFiles, resolveScreenshotPath, type ScreenshotFileRemoval } from './screenshotFiles';

const DEFAULT_RETENTION_HOURS = 24;

/**
 * How old an unreferenced file (or empty directory) must be before the orphan
 * sweep removes it. `storeScreenshot` writes the file BEFORE inserting its row,
 * so a brand-new file legitimately has no row for a moment; an hour is orders
 * of magnitude past that gap.
 */
const ORPHAN_MIN_AGE_MS = envInt('SCREENSHOT_ORPHAN_MIN_AGE_MS', 60 * 60 * 1000);
/** Keys per `storage_key IN (...)` lookup in the orphan sweep. */
const ORPHAN_LOOKUP_BATCH = 500;

/**
 * Storage keys of every screenshot row for a device. Read it inside the
 * transaction that purges the device — after the device row lock where the
 * caller holds one, which also blocks a concurrent capture's FK check — and
 * hand the keys to `removeScreenshotFiles` once that transaction commits.
 */
export async function listDeviceScreenshotStorageKeys(
  executor: Pick<typeof db, 'select'>,
  deviceId: string,
): Promise<string[]> {
  const rows = await executor
    .select({ storageKey: aiScreenshots.storageKey })
    .from(aiScreenshots)
    .where(eq(aiScreenshots.deviceId, deviceId));
  return rows.map((row) => row.storageKey);
}

/**
 * Per-device storage budget. `ai_screenshots` has no quota today, so a single
 * device can write an unbounded number of ~1 MiB-body-gated files until the
 * shared `SCREENSHOT_STORAGE_DIR` fills — a 64 MB tmpfs in the repo compose,
 * or the host disk if a droplet points the dir at a real volume — breaking
 * screenshot capture, installer-zip builds and software uploads for every
 * tenant on the instance. Bounding one device's LIVE (non-expired) footprint
 * keeps that failure local to the offending device instead.
 */
const MAX_SCREENSHOT_BYTES = envInt('SCREENSHOT_MAX_BYTES', 1_600_000);
const MAX_SCREENSHOTS_PER_DEVICE = envInt('SCREENSHOT_MAX_PER_DEVICE', 20);
const MAX_SCREENSHOT_BYTES_PER_DEVICE = envInt(
  'SCREENSHOT_MAX_BYTES_PER_DEVICE',
  MAX_SCREENSHOTS_PER_DEVICE * MAX_SCREENSHOT_BYTES,
);

export class ScreenshotTooLargeError extends Error {
  constructor(public readonly sizeBytes: number, public readonly maxBytes: number) {
    super(`Screenshot of ${sizeBytes} bytes exceeds the ${maxBytes} byte limit`);
    this.name = 'ScreenshotTooLargeError';
  }
}

export class ScreenshotQuotaExceededError extends Error {
  constructor(public readonly deviceId: string, public readonly reason: 'count' | 'bytes') {
    super(`Device ${deviceId} exceeded its live screenshot ${reason} quota`);
    this.name = 'ScreenshotQuotaExceededError';
  }
}

interface StoreScreenshotParams {
  deviceId: string;
  orgId: string;
  sessionId?: string;
  imageBase64: string;
  width: number;
  height: number;
  capturedBy: 'agent' | 'helper' | 'user';
  reason?: string;
  retentionHours?: number;
}

interface StoredScreenshot {
  id: string;
  storageKey: string;
  width: number;
  height: number;
  sizeBytes: number;
  expiresAt: Date;
}

/** Live (non-expired) screenshot count and total bytes currently stored for a device. */
async function getDeviceScreenshotUsage(deviceId: string): Promise<{ count: number; bytes: number }> {
  const [row] = await db
    .select({
      count: sql<number>`count(*)::int`,
      bytes: sql<number>`coalesce(sum(${aiScreenshots.sizeBytes}), 0)::bigint`,
    })
    .from(aiScreenshots)
    .where(and(eq(aiScreenshots.deviceId, deviceId), gt(aiScreenshots.expiresAt, new Date())))
    .limit(1);

  return { count: Number(row?.count ?? 0), bytes: Number(row?.bytes ?? 0) };
}

export async function storeScreenshot(params: StoreScreenshotParams): Promise<StoredScreenshot> {
  const {
    deviceId,
    orgId,
    sessionId,
    imageBase64,
    width,
    height,
    capturedBy,
    reason,
    retentionHours = DEFAULT_RETENTION_HOURS,
  } = params;

  const imageBuffer = Buffer.from(imageBase64, 'base64');
  const sizeBytes = imageBuffer.length;

  if (sizeBytes > MAX_SCREENSHOT_BYTES) {
    throw new ScreenshotTooLargeError(sizeBytes, MAX_SCREENSHOT_BYTES);
  }

  const usage = await getDeviceScreenshotUsage(deviceId);
  if (usage.count >= MAX_SCREENSHOTS_PER_DEVICE) {
    throw new ScreenshotQuotaExceededError(deviceId, 'count');
  }
  if (usage.bytes + sizeBytes > MAX_SCREENSHOT_BYTES_PER_DEVICE) {
    throw new ScreenshotQuotaExceededError(deviceId, 'bytes');
  }

  const uuid = randomUUID();
  const storageKey = `screenshots/${orgId}/${deviceId}/${uuid}.jpg`;

  const fullPath = join(SCREENSHOT_DIR, orgId, deviceId);
  const filePath = join(fullPath, `${uuid}.jpg`);
  await mkdir(fullPath, { recursive: true });
  try {
    await writeFile(filePath, imageBuffer);
  } catch (err) {
    // The orphan sweep prunes empty device directories; one that went idle
    // long enough can be removed between the mkdir and this write. Recreate it
    // once rather than fail the capture.
    if (errnoCode(err) !== 'ENOENT') throw err;
    await mkdir(fullPath, { recursive: true });
    await writeFile(filePath, imageBuffer);
  }

  const expiresAt = new Date(Date.now() + retentionHours * 60 * 60 * 1000);

  // The file is written first so a row never points at missing bytes. If the
  // row cannot be recorded, remove the file again: nothing else references
  // it, so the retention sweep (which walks rows) would never reclaim it.
  let record: typeof aiScreenshots.$inferSelect | undefined;
  try {
    [record] = await db.insert(aiScreenshots).values({
      deviceId,
      orgId,
      sessionId,
      storageKey,
      width,
      height,
      sizeBytes,
      capturedBy,
      reason,
      expiresAt,
    }).returning();
    if (!record) throw new Error('Failed to store screenshot record in database');
  } catch (err) {
    await unlink(filePath).catch((cleanupErr: unknown) => {
      console.error(`[ScreenshotStorage] Failed to remove screenshot file ${filePath} after insert failure:`, cleanupErr);
    });
    throw err;
  }

  return {
    id: record.id,
    storageKey,
    width,
    height,
    sizeBytes,
    expiresAt,
  };
}

export async function getScreenshot(id: string, orgId: string): Promise<{ data: Buffer; record: typeof aiScreenshots.$inferSelect } | null> {
  const [record] = await db.select().from(aiScreenshots)
    .where(and(eq(aiScreenshots.id, id), eq(aiScreenshots.orgId, orgId)))
    .limit(1);

  if (!record) return null;

  // The stored key, not record.orgId: see "WHERE A FILE LIVES" above.
  const fullPath = resolveScreenshotPath(record.storageKey);
  if (!fullPath) {
    console.error(`[ScreenshotStorage] Screenshot ${record.id} has an unrecognised storage key; cannot read it`);
    return null;
  }

  try {
    const data = await readFile(fullPath);
    return { data, record };
  } catch (err: unknown) {
    if (errnoCode(err) !== 'ENOENT') {
      console.error(`[ScreenshotStorage] Failed to read screenshot file at ${fullPath}:`, err);
    }
    return null;
  }
}

/**
 * Expiry sweep, run by jobs/helperScreenshotRetention.ts. The DB reads and
 * deletes run in SYSTEM scope: the job has no request context, and
 * ai_screenshots is FORCE ROW LEVEL SECURITY with org-access policies, so a
 * contextless read matches no rows at all. Each statement gets its own short
 * transaction; the file I/O happens outside any of them.
 */
export async function deleteExpiredScreenshots(): Promise<number> {
  const now = new Date();
  const expired = await withSystemDbAccessContext(
    () => db.select().from(aiScreenshots).where(lte(aiScreenshots.expiresAt, now)),
    'screenshotStorage.expiredScan',
  );

  let deleted = 0;
  for (const record of expired) {
    // The stored key, not record.orgId: after an org move the recomputed path
    // misses the file, and the ENOENT below would orphan it (#8117).
    const fullPath = resolveScreenshotPath(record.storageKey);
    if (fullPath) {
      try {
        await unlink(fullPath);
      } catch (err: unknown) {
        if (errnoCode(err) !== 'ENOENT') {
          // Keep the row: it is the only pointer to these bytes, and the next
          // retention run retries the delete.
          console.error(`[ScreenshotStorage] Failed to delete expired screenshot file ${fullPath}; keeping row for retry:`, err);
          continue;
        }
      }
    } else {
      // Not a key this service writes, so there is no file it could locate;
      // the row itself is all that is left to expire.
      console.error(`[ScreenshotStorage] Expired screenshot ${record.id} has an unrecognised storage key; deleting the row only`);
    }

    await withSystemDbAccessContext(
      () => db.delete(aiScreenshots).where(eq(aiScreenshots.id, record.id)),
      'screenshotStorage.expiredDelete',
    );
    deleted++;
  }

  return deleted;
}

export interface OrphanSweepResult {
  /** Screenshot-shaped files old enough to be checked against the table. */
  scanned: number;
  removed: number;
  failed: number;
  directoriesRemoved: number;
}

/**
 * Remove screenshot files that no `ai_screenshots` row references, plus the
 * empty org/device directories they leave (#8117). Covers whatever the
 * delete paths could not: a crash between commit and unlink, a purge path
 * that does not hand its keys over, and every file orphaned before this
 * existed (rows deleted by an org erasure, a device purge, or the old expiry
 * sweep after an org move).
 *
 * Only `<uuid>/<uuid>/<uuid>.jpg` entries under SCREENSHOT_DIR are considered —
 * the layout `storeScreenshot` writes — so anything else sharing the directory
 * is never touched. Files and directories younger than `minAgeMs` are left
 * alone, because a capture writes its file before inserting its row.
 *
 * Fails closed: if a row lookup throws, the sweep throws before unlinking that
 * batch. Treating "could not read rows" as "no rows" would delete every live
 * screenshot.
 */
export async function sweepOrphanedScreenshotFiles(
  opts: { now?: Date; minAgeMs?: number } = {},
): Promise<OrphanSweepResult> {
  const cutoffMs = (opts.now ?? new Date()).getTime() - (opts.minAgeMs ?? ORPHAN_MIN_AGE_MS);
  const result: OrphanSweepResult = { scanned: 0, removed: 0, failed: 0, directoriesRemoved: 0 };
  const failures: string[] = [];

  const recordFailure = (path: string, err: unknown) => {
    result.failed++;
    failures.push(`${path}: ${errnoCode(err) ?? (err instanceof Error ? err.message : String(err))}`);
  };
  const subdirectories = async (path: string): Promise<string[]> => {
    try {
      const entries = await readdir(path, { withFileTypes: true });
      return entries.filter((e) => e.isDirectory() && SCREENSHOT_DIR_SEGMENT_RE.test(e.name)).map((e) => e.name);
    } catch (err) {
      if (errnoCode(err) !== 'ENOENT') recordFailure(path, err);
      return [];
    }
  };
  const isIdle = async (path: string): Promise<boolean> => {
    try {
      const info = await stat(path);
      return info.mtimeMs < cutoffMs;
    } catch (err) {
      if (errnoCode(err) !== 'ENOENT') recordFailure(path, err);
      return false;
    }
  };

  try {
    await stat(SCREENSHOT_DIR);
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return result;
    throw err;
  }

  const candidates: Array<{ key: string; path: string }> = [];
  // Directories idle at scan time, deepest first so a device directory is
  // pruned before its org directory. The scan-time mtime is what counts: our
  // own unlinks below bump it.
  const idleDeviceDirs: string[] = [];
  const idleOrgDirs: string[] = [];

  for (const orgName of await subdirectories(SCREENSHOT_DIR)) {
    const orgPath = join(SCREENSHOT_DIR, orgName);
    if (await isIdle(orgPath)) idleOrgDirs.push(orgPath);

    for (const deviceName of await subdirectories(orgPath)) {
      const devicePath = join(orgPath, deviceName);
      if (await isIdle(devicePath)) idleDeviceDirs.push(devicePath);

      let files: string[];
      try {
        files = (await readdir(devicePath, { withFileTypes: true }))
          .filter((e) => e.isFile() && SCREENSHOT_FILE_RE.test(e.name))
          .map((e) => e.name);
      } catch (err) {
        if (errnoCode(err) !== 'ENOENT') recordFailure(devicePath, err);
        continue;
      }
      for (const fileName of files) {
        const filePath = join(devicePath, fileName);
        if (!(await isIdle(filePath))) continue;
        candidates.push({ key: `screenshots/${orgName}/${deviceName}/${fileName}`, path: filePath });
      }
    }
  }

  result.scanned = candidates.length;
  for (let i = 0; i < candidates.length; i += ORPHAN_LOOKUP_BATCH) {
    const batch = candidates.slice(i, i + ORPHAN_LOOKUP_BATCH);
    // System scope for the same reason as the expiry sweep: a contextless read
    // sees no rows, which here would make every file look orphaned.
    const rows = await withSystemDbAccessContext(
      () => db
        .select({ storageKey: aiScreenshots.storageKey })
        .from(aiScreenshots)
        .where(inArray(aiScreenshots.storageKey, batch.map((c) => c.key))),
      'screenshotStorage.orphanSweep',
    );
    const referenced = new Set(rows.map((row) => row.storageKey));
    for (const candidate of batch) {
      if (referenced.has(candidate.key)) continue;
      try {
        await unlink(candidate.path);
        result.removed++;
      } catch (err) {
        if (errnoCode(err) !== 'ENOENT') recordFailure(candidate.path, err);
      }
    }
  }

  for (const dir of [...idleDeviceDirs, ...idleOrgDirs]) {
    try {
      await rmdir(dir);
      result.directoriesRemoved++;
    } catch (err) {
      // Not empty (still holds live screenshots, or a capture just wrote into
      // it) or already gone: both are fine.
      const code = errnoCode(err);
      if (code !== 'ENOTEMPTY' && code !== 'EEXIST' && code !== 'ENOENT') recordFailure(dir, err);
    }
  }

  if (result.failed > 0) {
    console.error(
      `[ScreenshotStorage] orphan sweep: ${result.failed} failure(s) (${result.removed} orphaned file(s) removed)`,
      failures.slice(0, 20),
    );
    captureMessage('[ScreenshotStorage] orphan sweep could not remove some screenshot files', {
      eventCode: 'screenshot_file_removal_failed',
      level: 'error',
    });
  }
  return result;
}
