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

import { and, desc, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
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
  // Accept the UTC ISO shape emitted by this codec, not Date's permissive
  // inputs such as "1" that PostgreSQL cannot compare as a timestamp.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(rawDate)) return null;
  const parsed = new Date(rawDate);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 19) !== rawDate.slice(0, 19)) return null;
  return { requestedAt: rawDate, id };
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
      // requested_at is timestamp WITHOUT time zone; avoid the driver's Date
      // decoder, which truncates PostgreSQL microseconds before keyset paging.
      requestedAt: sql<string>`to_char(${deviceFilesystemCleanupRuns.requestedAt}, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
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

/** Anything that can run these UPDATEs: the ambient `db`, or a caller's open tx. */
type CleanupRunExecutor = Pick<typeof db, 'update' | 'select'>;

/**
 * Terminalise a cleanup run whose dispatched command was cancelled (spec §13
 * #13). Only a `running` run moves; a `previewed` one was never dispatched and
 * an already-terminal one keeps the outcome the operator has read.
 *
 * Takes the caller's executor because the cancel-on-event paths (device
 * org-move, decommission) run inside their own transaction and must
 * terminalise the owning record atomically with the cancel itself.
 */
export async function cancelCleanupRunForCommand(params: {
  cleanupRunId: string;
  reason: string;
  completedAt: Date;
  executor?: CleanupRunExecutor;
}): Promise<boolean> {
  const executor = params.executor ?? db;
  const [row] = await executor
    .update(deviceFilesystemCleanupRuns)
    .set({ status: 'failed', error: params.reason, updatedAt: params.completedAt })
    .where(and(
      eq(deviceFilesystemCleanupRuns.id, params.cleanupRunId),
      eq(deviceFilesystemCleanupRuns.status, 'running'),
      eq(deviceFilesystemCleanupRuns.kind, 'files'),
    ))
    .returning({ id: deviceFilesystemCleanupRuns.id });
  return Boolean(row);
}

/** Normalise legacy arrays and current envelopes without a read/modify/write race. */
function currentCleanupActions(): SQL {
  const current = deviceFilesystemCleanupRuns.executedActions;
  return sql`CASE
    WHEN jsonb_typeof(${current}) = 'array' THEN ${current}
    WHEN jsonb_typeof(${current} -> 'actions') = 'array' THEN ${current} -> 'actions'
    ELSE '[]'::jsonb END`;
}

/**
 * Finalise against the row held by UPDATE, preserving receipts that won the
 * lock first. The first entry for a command wins; actions without commands
 * (e.g. rejected paths) remain distinct. Preserve order and envelope metadata.
 */
export function mergeCleanupExecutedActions(envelope: {
  partial: boolean;
  budgetMs: number;
  actions: unknown[];
}): SQL {
  const current = deviceFilesystemCleanupRuns.executedActions;
  return sql`jsonb_set(
    (CASE WHEN jsonb_typeof(${current}) = 'object' THEN ${current} ELSE '{}'::jsonb END)
      || ${JSON.stringify(envelope)}::jsonb,
    '{actions}',
    (SELECT COALESCE(jsonb_agg(action ORDER BY position), '[]'::jsonb)
      FROM (
        SELECT DISTINCT ON (action ->> 'commandId',
          CASE WHEN action ->> 'commandId' IS NULL THEN position ELSE 0 END)
          action, position
        FROM jsonb_array_elements(${currentCleanupActions()} || ${JSON.stringify(envelope.actions)}::jsonb)
          WITH ORDINALITY AS entries(action, position)
        ORDER BY action ->> 'commandId',
          CASE WHEN action ->> 'commandId' IS NULL THEN position ELSE 0 END, position
      ) AS deduplicated), true)`;
}

/**
 * Record a `file_delete` result that arrived after its run was finalised.
 *
 * It is appended to `executed_actions` tagged `lateResult: true` and the run's
 * `status` is deliberately NOT in the update set: a late `completed` must never
 * turn a run the operator has already read as `failed` into a success, and a
 * late `failed` must not reopen a closed one. Dropping it instead would lose
 * the only record that the device eventually acted.
 */
export async function recordLateCleanupResult(params: {
  cleanupRunId: string;
  commandId: string;
  path: string;
  status: string;
  error?: string | null;
  completedAt: Date;
}): Promise<'recorded' | 'ignored'> {
  const entry = JSON.stringify([{
    path: params.path,
    status: params.status,
    error: params.error ?? undefined,
    commandId: params.commandId,
    lateResult: true,
    receivedAt: params.completedAt.toISOString(),
  }]);
  const current = deviceFilesystemCleanupRuns.executedActions;
  // Append against the row under PostgreSQL's update lock. Reading the list
  // into JS first would lose simultaneous receipts or overwrite a finaliser's
  // newer envelope. Preserve envelope metadata and historical bare arrays.
  const appended = sql`
    CASE WHEN jsonb_typeof(${current}) = 'object'
      THEN jsonb_set(${current}, '{actions}',
        (CASE WHEN jsonb_typeof(${current} -> 'actions') = 'array'
          THEN ${current} -> 'actions' ELSE '[]'::jsonb END) || ${entry}::jsonb, true)
      ELSE (CASE WHEN jsonb_typeof(${current}) = 'array'
        THEN ${current} ELSE '[]'::jsonb END) || ${entry}::jsonb
    END
  `;
  const [updated] = await db
    .update(deviceFilesystemCleanupRuns)
    .set({ executedActions: appended, updatedAt: params.completedAt })
    .where(and(
      eq(deviceFilesystemCleanupRuns.id, params.cleanupRunId),
      eq(deviceFilesystemCleanupRuns.kind, 'files'),
      inArray(deviceFilesystemCleanupRuns.status, ['running', 'executed', 'failed']),
      sql`NOT EXISTS (SELECT 1 FROM jsonb_array_elements(${currentCleanupActions()}) AS entry
        WHERE entry ->> 'commandId' = ${params.commandId})`,
    ))
    .returning({ id: deviceFilesystemCleanupRuns.id });

  return updated ? 'recorded' : 'ignored';
}
