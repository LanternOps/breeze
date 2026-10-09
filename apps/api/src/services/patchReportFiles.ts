/**
 * Patch compliance report FILE primitives.
 *
 * A generated report is a CSV at `<PATCH_REPORT_STORAGE_PATH>/<report id>.csv`,
 * indexed by its `patch_compliance_reports` row (`output_path`). This module
 * holds the parts that do not need the database, so org erasure
 * (tenantCascade.ts) can unlink report files without pulling the Drizzle
 * schema into its import graph. The retention sweep that ages files out lives
 * in jobs/patchReportRetention.ts.
 */

import { unlink } from 'node:fs/promises';
import path from 'node:path';
import { captureMessage } from './sentry';

export const DEFAULT_PATCH_REPORT_STORAGE_PATH = './data/patch-reports';
export const DEFAULT_PATCH_REPORT_RETENTION_DAYS = 30;

/** A report file name as the report worker writes it: `<uuid>.csv`. */
export const PATCH_REPORT_FILE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.csv$/i;

/** The resolved (absolute) directory report files are written to. */
export function patchReportStorageDir(): string {
  return path.resolve(process.env.PATCH_REPORT_STORAGE_PATH || DEFAULT_PATCH_REPORT_STORAGE_PATH);
}

/**
 * How long a generated report file is kept, in days. Unset or unparsable means
 * the default; anything below one day is raised to one, so a typo can never
 * expire a report while its requester is still waiting to download it.
 */
export function patchReportRetentionDays(): number {
  const raw = process.env.PATCH_REPORT_RETENTION_DAYS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_PATCH_REPORT_RETENTION_DAYS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_PATCH_REPORT_RETENTION_DAYS;
  return Math.max(1, parsed);
}

export function patchReportRetentionMs(): number {
  return patchReportRetentionDays() * 24 * 60 * 60 * 1000;
}

/**
 * True once a report's file is past the retention window: measured from
 * completion, or from creation for a report that never completed.
 */
export function isPatchReportPastRetention(
  report: { completedAt: Date | string | null; createdAt: Date | string | null },
  now: Date = new Date(),
): boolean {
  const reference = report.completedAt ?? report.createdAt;
  if (!reference) return false;
  const time = new Date(reference).getTime();
  if (Number.isNaN(time)) return false;
  return time < now.getTime() - patchReportRetentionMs();
}

/**
 * The file behind a report row, or null when `output_path` is not a path the
 * report worker writes (absolute, named `<report id>.csv`). Removal paths only
 * ever unlink what this returns, so a malformed or foreign `output_path` can
 * never make them delete some other file.
 */
export function patchReportFileFor(reportId: string, outputPath: string | null): string | null {
  if (!outputPath || !path.isAbsolute(outputPath)) return null;
  if (path.basename(outputPath).toLowerCase() !== `${reportId}.csv`.toLowerCase()) return null;
  return path.normalize(outputPath);
}

export function errnoCode(err: unknown): string | undefined {
  return err instanceof Error && 'code' in err ? (err as NodeJS.ErrnoException).code : undefined;
}

export interface PatchReportFileRemoval {
  removed: number;
  /** Already absent: the outcome the caller wanted, not a failure. */
  missing: number;
  /** Could not be removed; the orphan sweep retries it. */
  failed: number;
  /** `output_path` is not one the worker writes, so there is no file to locate. */
  unresolvable: number;
}

/**
 * Remove the files of report rows the caller has ALREADY deleted and
 * committed. Never throws: the rows are gone and must stay gone, so a
 * filesystem fault is logged with counts and reported to Sentry instead of
 * failing (and possibly rolling back) the caller. A file left behind has no
 * row any more, so the orphan sweep in the retention job retries it.
 */
export async function removePatchReportFiles(
  reports: ReadonlyArray<{ id: string; outputPath: string | null }>,
  context: string,
): Promise<PatchReportFileRemoval> {
  const result: PatchReportFileRemoval = { removed: 0, missing: 0, failed: 0, unresolvable: 0 };
  const failures: string[] = [];
  for (const report of reports) {
    if (!report.outputPath) continue;
    const file = patchReportFileFor(report.id, report.outputPath);
    if (!file) {
      result.unresolvable++;
      continue;
    }
    try {
      await unlink(file);
      result.removed++;
    } catch (err) {
      if (errnoCode(err) === 'ENOENT') {
        result.missing++;
        continue;
      }
      result.failed++;
      failures.push(`${file}: ${errnoCode(err) ?? (err instanceof Error ? err.message : String(err))}`);
    }
  }
  if (result.failed > 0) {
    console.error(
      `[PatchReportFiles] ${context}: failed to remove ${result.failed} report file(s) `
      + `(${result.removed} removed, ${result.missing} already absent); their rows are gone, so the orphan sweep will retry`,
      failures.slice(0, 20),
    );
    captureMessage('[PatchReportFiles] patch report files left behind after their rows were deleted', {
      eventCode: 'patch_report_file_removal_failed',
      level: 'error',
    });
  }
  if (result.unresolvable > 0) {
    console.warn(
      `[PatchReportFiles] ${context}: ${result.unresolvable} report row(s) had an unrecognised output path; no file removed`,
    );
  }
  return result;
}
