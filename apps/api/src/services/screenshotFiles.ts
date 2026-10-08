/**
 * Helper screenshot FILE primitives (#8117), split from screenshotStorage.ts so
 * the delete paths that only need to unlink files (org erasure in
 * tenantCascade.ts, site delete, device purge) do not pull the Drizzle schema
 * and the DB module into their import graph.
 *
 * WHERE A FILE LIVES: a row's `storage_key` is the file's location —
 * `screenshots/<org>/<device>/<uuid>.jpg` relative to SCREENSHOT_DIR, fixed at
 * capture time. Never rebuild the path from the row's CURRENT `org_id`: a
 * device org move (and an org merge) re-points `org_id` but leaves the file
 * where it was.
 */

import { unlink } from 'fs/promises';
import { join } from 'path';
import { captureMessage } from './sentry';

export const SCREENSHOT_DIR = process.env.SCREENSHOT_STORAGE_DIR || '/tmp/breeze-screenshots';

/** An org or device directory name as `storeScreenshot` writes it. */
export const SCREENSHOT_DIR_SEGMENT_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A screenshot file name as `storeScreenshot` writes it. */
export const SCREENSHOT_FILE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$/i;

const KEY_SEGMENT_RE = /^[A-Za-z0-9_-]+$/;
const KEY_FILE_RE = /^[A-Za-z0-9_-]+\.jpg$/;

export function errnoCode(err: unknown): string | undefined {
  return err instanceof Error && 'code' in err ? (err as NodeJS.ErrnoException).code : undefined;
}

/**
 * The file a `storage_key` points at, or null for a key the storage service
 * never writes. Segments are restricted to `[A-Za-z0-9_-]`, so a key can never
 * climb out of SCREENSHOT_DIR (`..`, absolute paths and extra segments are
 * refused).
 */
export function resolveScreenshotPath(storageKey: string): string | null {
  const parts = storageKey.split('/');
  if (parts.length !== 4 || parts[0] !== 'screenshots') return null;
  const [, orgSegment, deviceSegment, fileName] = parts as [string, string, string, string];
  if (!KEY_SEGMENT_RE.test(orgSegment) || !KEY_SEGMENT_RE.test(deviceSegment) || !KEY_FILE_RE.test(fileName)) {
    return null;
  }
  return join(SCREENSHOT_DIR, orgSegment, deviceSegment, fileName);
}

export interface ScreenshotFileRemoval {
  removed: number;
  /** Already absent — the outcome the caller wanted, not a failure. */
  missing: number;
  /** A file exists (or may) but could not be removed; the orphan sweep retries it. */
  failed: number;
  /**
   * The key is not one the storage service writes, so there is no file this
   * code can locate (and the orphan sweep, which only walks the layout it
   * writes, never will). Logged, not alerted: nothing can be retried.
   */
  unresolvable: number;
}

/**
 * Remove the files behind `storageKeys` whose rows the caller has ALREADY
 * deleted and committed. Never throws: the rows are gone and must stay gone,
 * so a filesystem fault is logged (with counts) and reported to Sentry rather
 * than propagated into — and possibly rolling back — the caller's erasure. A
 * file left behind is unreferenced, so the next orphan sweep
 * (`sweepOrphanedScreenshotFiles`) retries it.
 *
 * Call it only after the deleting transaction has committed: unlinking first
 * and then rolling back would leave rows pointing at missing bytes.
 */
export async function removeScreenshotFiles(
  storageKeys: readonly string[],
  context: string,
): Promise<ScreenshotFileRemoval> {
  const result: ScreenshotFileRemoval = { removed: 0, missing: 0, failed: 0, unresolvable: 0 };
  const failures: string[] = [];
  const unresolvable: string[] = [];
  for (const key of storageKeys) {
    const path = resolveScreenshotPath(key);
    if (!path) {
      result.unresolvable++;
      unresolvable.push(JSON.stringify(key));
      continue;
    }
    try {
      await unlink(path);
      result.removed++;
    } catch (err) {
      if (errnoCode(err) === 'ENOENT') {
        result.missing++;
        continue;
      }
      result.failed++;
      failures.push(`${path}: ${errnoCode(err) ?? (err instanceof Error ? err.message : String(err))}`);
    }
  }
  if (result.failed > 0) {
    console.error(
      `[ScreenshotStorage] ${context}: failed to remove ${result.failed} of ${storageKeys.length} screenshot file(s) `
      + `(${result.removed} removed, ${result.missing} already absent); their rows are gone, so the orphan sweep will retry`,
      failures.slice(0, 20),
    );
    captureMessage('[ScreenshotStorage] screenshot files left behind after their rows were deleted', {
      eventCode: 'screenshot_file_removal_failed',
      level: 'error',
    });
  }
  if (result.unresolvable > 0) {
    console.warn(
      `[ScreenshotStorage] ${context}: ${result.unresolvable} screenshot row(s) had an unrecognised storage key; no file to remove`,
      unresolvable.slice(0, 20),
    );
  }
  return result;
}
