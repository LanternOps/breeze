/**
 * Keyset cursor pagination for `GET /ai/operator/tasks` (W07 of #5205, read
 * side). Mirrors `services/aiAgents/runsListCursor.ts`'s token shape and
 * malformed-input handling, adapted to this table's one fixed sort:
 * `(updated_at DESC, id DESC)` — partially covered by
 * `ai_operator_tasks_org_state_updated_idx` (org_id, state, updated_at desc)
 * when a `state` filter is present; an unfiltered list still walks correctly,
 * just without the state-equality index prefix.
 *
 * `id` is a required tiebreaker: `updated_at` is not unique (two tasks can be
 * touched by the coordinator in the same millisecond), so a keyset on
 * `updated_at` alone can skip or duplicate rows across pages when that
 * happens.
 */

import { sql, type SQL } from 'drizzle-orm';
import { aiOperatorTasks } from '../../db/schema';
import { UUID_REGEX } from '../../utils/uuid';

/** Wire shape carried in the opaque base64url-JSON cursor token. `v` is
 *  bumped if the shape ever changes incompatibly. */
export interface OperatorTasksCursor {
  v: 1;
  /**
   * Last-row `updated_at`, ISO-8601 — MUST carry full microsecond precision.
   * `ai_operator_tasks.updated_at` is a bare `timestamptz` (microsecond
   * resolution), while a JS `Date` truncates to milliseconds. Building this
   * from `row.updatedAt.toISOString()` would round the true value down, so
   * the keyset predicate (below) could exclude a sibling row updated in the
   * same millisecond as the page boundary — permanently, with no duplicate
   * and no error. The route projects an `updatedAtRaw` text column via
   * `to_char(...)` specifically to avoid ever routing this value through a
   * `Date` for cursor purposes.
   */
  u: string;
  /** Tiebreaker — last-row `ai_operator_tasks.id`. */
  id: string;
}

const BASE64URL_TOKEN_RE = /^[A-Za-z0-9_-]+={0,2}$/;

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
  if (typeof p.u !== 'string' || Number.isNaN(Date.parse(p.u))) return null;
  if (typeof p.id !== 'string' || !UUID_REGEX.test(p.id)) return null;
  return { v: 1, u: p.u, id: p.id };
}

/** Build the WHERE-clause keyset predicate that resumes the DESC walk from
 *  `cursor`: strictly-less-than on the `(updated_at, id)` tuple. */
export function buildOperatorTasksKeysetPredicate(cursor: OperatorTasksCursor): SQL {
  return sql`(${aiOperatorTasks.updatedAt}, ${aiOperatorTasks.id}) < (${cursor.u}::timestamptz, ${cursor.id}::uuid)`;
}

/**
 * Pull the cursor-shaped `{u, id}` pair out of the last-returned row.
 * Deliberately takes `updatedAtRaw` — the microsecond-precision
 * `to_char(...)` text projected by the route's query — NOT a JS `Date`. See
 * `OperatorTasksCursor.u`'s docstring for why.
 */
export function operatorTasksCursorFromRow(row: { id: string; updatedAtRaw: string }): OperatorTasksCursor {
  return { v: 1, u: row.updatedAtRaw, id: row.id };
}
