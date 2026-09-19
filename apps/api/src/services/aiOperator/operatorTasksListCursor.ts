/**
 * Keyset cursor pagination for `GET /ai/operator/tasks` (W07 of #5205, read
 * side). Mirrors `services/aiAgents/runsListCursor.ts`'s token shape and
 * malformed-input handling, adapted to this table's one fixed sort:
 * `(created_at DESC, id DESC)`.
 *
 * `created_at` was chosen over `updated_at` deliberately (review fix, PR
 * #5254) — `runsListCursor.ts`'s own precedent keysets on `ai_agent_runs
 * .queued_at`, which is written exactly once. `ai_operator_tasks.updated_at`
 * is rewritten on every coordinator touch (state/phase/lease changes), so a
 * task that moves while a caller is paging would jump ahead of or behind the
 * cursor and be silently skipped or duplicated — the walk's stability
 * invariant depends on the sort column being immutable after insert, which
 * `created_at` is and `updated_at` is not. This also matches the query shape
 * `aiOperatorIndexes.integration.test.ts`'s "device-page task feed" case
 * already commits to (W03): `WHERE device_id = ... ORDER BY created_at DESC`,
 * served by `ai_operator_tasks_device_idx`.
 *
 * `id` is a required tiebreaker: `created_at` is not unique (two tasks can be
 * admitted in the same millisecond), so a keyset on `created_at` alone can
 * skip or duplicate rows across pages when that happens.
 */

import { sql, type SQL } from 'drizzle-orm';
import { aiOperatorTasks } from '../../db/schema';
import { UUID_REGEX } from '../../utils/uuid';

/** Wire shape carried in the opaque base64url-JSON cursor token. `v` is
 *  bumped if the shape ever changes incompatibly. */
export interface OperatorTasksCursor {
  v: 1;
  /**
   * Last-row `created_at`, ISO-8601 — MUST carry full microsecond precision.
   * `ai_operator_tasks.created_at` is a bare `timestamptz` (microsecond
   * resolution), while a JS `Date` truncates to milliseconds. Building this
   * from `row.createdAt.toISOString()` would round the true value down, so
   * the keyset predicate (below) could exclude a sibling row created in the
   * same millisecond as the page boundary — permanently, with no duplicate
   * and no error. The route projects a `createdAtRaw` text column via
   * `to_char(...)` specifically to avoid ever routing this value through a
   * `Date` for cursor purposes.
   */
  c: string;
  /** Tiebreaker — last-row `ai_operator_tasks.id`. */
  id: string;
}

const BASE64URL_TOKEN_RE = /^[A-Za-z0-9_-]+={0,2}$/;

/**
 * Exact shape the route's `to_char(created_at AT TIME ZONE 'UTC',
 * 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')` projection emits. `Date.parse` alone is
 * far more permissive than this — `Date.parse('1')` succeeds while
 * `'1'::timestamptz` raises Postgres 22007 — so a cursor whose `c` passes
 * `Date.parse` but fails this regex would reach the query and turn into a
 * 500 (transaction-poisoning) on what the route's contract promises is a
 * 400 (review fix, PR #5254).
 */
const CURSOR_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

/** Encode the cursor as a URL-safe base64 JSON token (padding trimmed so it
 *  slots into a query string without %-encoding noise). */
export function encodeOperatorTasksCursor(c: OperatorTasksCursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

/**
 * Decode + validate an incoming cursor token. Returns `null` on any
 * malformed input — the caller 400s on a non-empty malformed token (matches
 * the runs list's `?cursor set, decode fails => 400` contract) rather than
 * silently restarting the walk, which would look like data loss to the
 * client.
 */
export function decodeOperatorTasksCursor(token: string | undefined | null): OperatorTasksCursor | null {
  if (!token) return null;
  if (!BASE64URL_TOKEN_RE.test(token)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const p = parsed as Record<string, unknown>;
  if (p.v !== 1) return null;
  if (typeof p.c !== 'string' || !CURSOR_TIMESTAMP_RE.test(p.c)) return null;
  if (typeof p.id !== 'string' || !UUID_REGEX.test(p.id)) return null;
  return { v: 1, c: p.c, id: p.id };
}

/** Build the WHERE-clause keyset predicate that resumes the DESC walk from
 *  `cursor`: strictly-less-than on the `(created_at, id)` tuple. */
export function buildOperatorTasksKeysetPredicate(cursor: OperatorTasksCursor): SQL {
  return sql`(${aiOperatorTasks.createdAt}, ${aiOperatorTasks.id}) < (${cursor.c}::timestamptz, ${cursor.id}::uuid)`;
}

/**
 * Pull the cursor-shaped `{c, id}` pair out of the last-returned row.
 * Deliberately takes `createdAtRaw` — the microsecond-precision
 * `to_char(...)` text projected by the route's query — NOT a JS `Date`. See
 * `OperatorTasksCursor.c`'s docstring for why.
 */
export function operatorTasksCursorFromRow(row: { id: string; createdAtRaw: string }): OperatorTasksCursor {
  return { v: 1, c: row.createdAtRaw, id: row.id };
}
