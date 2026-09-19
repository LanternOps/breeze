/**
 * Read model for `device_filesystem_cleanup_runs` (Disk Cleanup v2, spec §5.2).
 *
 * The history list and the run detail are split deliberately. A `previewed`
 * run's `plan.preview.candidates` is up to 1000 objects and an executed run's
 * `executedActions` is up to 200 — a 20-row page carrying both would be
 * megabytes of JSON nobody renders. The list therefore computes the three
 * numbers the UI actually shows (candidate count, estimated bytes, action
 * count) IN SQL, so the blobs never leave Postgres, and the detail route is
 * the one place that ships them.
 *
 * Pagination is a keyset on `(requested_at, id)`, both DESC, not an offset:
 * a cleanup running while an operator pages would shift every offset page.
 * The tuple (rather than a bare timestamp) is what makes the walk stable when
 * two runs share a `requested_at` — `requested_at` is `defaultNow()`, so two
 * previews from one click of a bulk action genuinely can collide.
 */

import { and, desc, eq, or, sql, type SQL } from 'drizzle-orm';
import { db } from '../db';
import { deviceFilesystemCleanupRuns } from '../db/schema';

/** Per-request default when the client passes no `limit`. */
export const CLEANUP_RUNS_DEFAULT_LIMIT = 20;
/** Defensive ceiling; the UI never asks for more than a screenful. */
export const CLEANUP_RUNS_MAX_LIMIT = 100;

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export interface CleanupRunCursor {
  /** ISO-8601, exactly as re-parsed by Postgres on the next round trip. */
  requestedAt: string;
  id: string;
}

export interface CleanupRunListItem {
  id: string;
  kind: string;
  status: string;
  scanPath: string | null;
  requestedAt: string;
  approvedAt: string | null;
  bytesReclaimed: number;
  error: string | null;
  candidateCount: number;
  estimatedBytes: number;
  actionCount: number;
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

/**
 * `"<ISO8601>|<uuid>"`. Readable in a log line and diffable by hand, which a
 * base64url blob is not; there is nothing secret in a page boundary.
 */
export function encodeCleanupRunCursor(row: { requestedAt: Date | string; id: string }): string {
  return `${iso(row.requestedAt)}|${row.id}`;
}

/**
 * Returns null on ANY malformed token. The caller answers 400 rather than
 * ignoring it: silently restarting the walk from the top turns a bad cursor
 * into an infinite "Load more" that re-renders page 1 forever.
 */
export function decodeCleanupRunCursor(token: string): CleanupRunCursor | null {
  if (!token) return null;
  const parts = token.split('|');
  if (parts.length !== 2) return null;
  const [rawDate, id] = parts;
  if (rawDate === undefined || id === undefined) return null;
  if (!UUID_RE.test(id)) return null;
  const parsed = new Date(rawDate);
  if (Number.isNaN(parsed.getTime())) return null;
  return { requestedAt: parsed.toISOString(), id };
}

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit) || limit < 1) return CLEANUP_RUNS_DEFAULT_LIMIT;
  return Math.min(CLEANUP_RUNS_MAX_LIMIT, Math.trunc(limit));
}

/**
 * `jsonb_array_length` raises on a non-array, and a hand-edited or partially
 * trimmed `plan` is exactly where a non-array turns up — so the type is
 * checked first and anything else counts as zero rather than 500ing the page.
 */
const candidateCountSql = sql<number>`
  CASE WHEN jsonb_typeof(${deviceFilesystemCleanupRuns.plan} #> '{preview,candidates}') = 'array'
       THEN jsonb_array_length(${deviceFilesystemCleanupRuns.plan} #> '{preview,candidates}')
       ELSE 0 END
`.mapWith(Number);

const estimatedBytesSql = sql<number>`
  COALESCE((${deviceFilesystemCleanupRuns.plan} #>> '{preview,estimatedBytes}')::bigint, 0)
`.mapWith(Number);

// W01 amendment 8 turned this column into `{ partial, budgetMs, actions }`,
// but pre-W01 rows are still a bare array and `readExecutedActions` tolerates
// both — so the SQL has to as well, or every run the new code writes reports
// `actionCount: 0` in the history while its detail page shows two hundred.
const actionCountSql = sql<number>`
  CASE
    WHEN jsonb_typeof(${deviceFilesystemCleanupRuns.executedActions}) = 'array'
      THEN jsonb_array_length(${deviceFilesystemCleanupRuns.executedActions})
    WHEN jsonb_typeof(${deviceFilesystemCleanupRuns.executedActions} -> 'actions') = 'array'
      THEN jsonb_array_length(${deviceFilesystemCleanupRuns.executedActions} -> 'actions')
    ELSE 0
  END
`.mapWith(Number);

export async function listCleanupRuns(
  deviceId: string,
  opts: { limit: number; cursor?: string },
): Promise<{ runs: CleanupRunListItem[]; nextCursor: string | null }> {
  const limit = clampLimit(opts.limit);

  const conditions: SQL[] = [eq(deviceFilesystemCleanupRuns.deviceId, deviceId)];
  if (opts.cursor) {
    const cursor = decodeCleanupRunCursor(opts.cursor);
    // A cursor that failed to decode never reaches here — the route rejects it
    // — but belt and braces: an undecodable one degrades to "first page".
    if (cursor) {
      const keyset = or(
        sql`${deviceFilesystemCleanupRuns.requestedAt} < ${cursor.requestedAt}::timestamp`,
        and(
          sql`${deviceFilesystemCleanupRuns.requestedAt} = ${cursor.requestedAt}::timestamp`,
          sql`${deviceFilesystemCleanupRuns.id} < ${cursor.id}::uuid`,
        ),
      );
      if (keyset) conditions.push(keyset);
    }
  }

  const rows = await db
    .select({
      id: deviceFilesystemCleanupRuns.id,
      kind: deviceFilesystemCleanupRuns.kind,
      status: deviceFilesystemCleanupRuns.status,
      scanPath: deviceFilesystemCleanupRuns.scanPath,
      requestedAt: deviceFilesystemCleanupRuns.requestedAt,
      approvedAt: deviceFilesystemCleanupRuns.approvedAt,
      bytesReclaimed: deviceFilesystemCleanupRuns.bytesReclaimed,
      error: deviceFilesystemCleanupRuns.error,
      candidateCount: candidateCountSql,
      estimatedBytes: estimatedBytesSql,
      actionCount: actionCountSql,
    })
    .from(deviceFilesystemCleanupRuns)
    .where(and(...conditions))
    .orderBy(desc(deviceFilesystemCleanupRuns.requestedAt), desc(deviceFilesystemCleanupRuns.id))
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor = rows.length > limit && last ? encodeCleanupRunCursor(last) : null;

  return {
    runs: page.map((row) => ({
      id: row.id,
      kind: row.kind,
      status: row.status,
      scanPath: row.scanPath,
      requestedAt: iso(row.requestedAt)!,
      approvedAt: iso(row.approvedAt),
      bytesReclaimed: Number(row.bytesReclaimed ?? 0),
      error: row.error,
      candidateCount: Number(row.candidateCount ?? 0),
      estimatedBytes: Number(row.estimatedBytes ?? 0),
      actionCount: Number(row.actionCount ?? 0),
    })),
    nextCursor,
  };
}

/**
 * The full row, blobs included. Scoped by `deviceId` as well as `id` so a run
 * id guessed from another device answers 404 rather than leaking a plan.
 */
export async function getCleanupRun(
  deviceId: string,
  runId: string,
): Promise<Record<string, unknown> | null> {
  const [run] = await db
    .select({
      id: deviceFilesystemCleanupRuns.id,
      kind: deviceFilesystemCleanupRuns.kind,
      status: deviceFilesystemCleanupRuns.status,
      scanPath: deviceFilesystemCleanupRuns.scanPath,
      requestedAt: deviceFilesystemCleanupRuns.requestedAt,
      approvedAt: deviceFilesystemCleanupRuns.approvedAt,
      bytesReclaimed: deviceFilesystemCleanupRuns.bytesReclaimed,
      error: deviceFilesystemCleanupRuns.error,
      plan: deviceFilesystemCleanupRuns.plan,
      executedActions: deviceFilesystemCleanupRuns.executedActions,
    })
    .from(deviceFilesystemCleanupRuns)
    .where(and(
      eq(deviceFilesystemCleanupRuns.id, runId),
      eq(deviceFilesystemCleanupRuns.deviceId, deviceId),
    ))
    .limit(1);

  if (!run) return null;

  return {
    ...run,
    requestedAt: iso(run.requestedAt),
    approvedAt: iso(run.approvedAt),
    bytesReclaimed: Number(run.bytesReclaimed ?? 0),
  };
}
