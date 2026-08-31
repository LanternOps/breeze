/**
 * Keyset cursor pagination for `GET /ai/agents/runs` (org-wide list, Wave 6
 * PR 1 #3828). Mirrors `routes/devices/cursor.ts`'s token shape and
 * malformed-input handling, simplified to the one fixed sort this endpoint
 * offers: `(queued_at DESC, id DESC)` — see the covering index added in
 * migrations/2026-09-17-ai-agent-runs-keyset-index.sql. Devices' cursor
 * module supports three caller-selectable sort keys (including a nullable
 * one) and needs the generality that comes with; this endpoint has exactly
 * one sort, so there is no `sort`/`sortDir`/NULL-phase machinery to carry.
 *
 * `id` is a required tiebreaker, not an optional nicety: `queued_at` is not
 * unique (two runs can queue in the same millisecond), so a keyset on
 * `queued_at` alone can skip or duplicate rows across pages when that
 * happens.
 */

import { sql, type SQL } from 'drizzle-orm';
import { aiAgentRuns } from '../../db/schema';
import { UUID_REGEX } from '../../utils/uuid';

/** Wire shape carried in the opaque base64url-JSON cursor token. `v` is
 *  bumped if the shape ever changes incompatibly. */
export interface AiAgentRunsCursor {
  v: 1;
  /**
   * Last-row `queued_at`, ISO-8601 — MUST carry full microsecond precision.
   * `ai_agent_runs.queued_at` is a bare `timestamptz` (microsecond
   * resolution, no precision modifier), while a JS `Date` truncates to
   * milliseconds. Building this from `row.queuedAt.toISOString()` would
   * round the true value down, so the keyset predicate (below) could exclude
   * a sibling row that queued in the same millisecond as the page boundary —
   * permanently, with no duplicate and no error. The route projects a
   * `queuedAtRaw` text column via `to_char(...)` specifically to avoid ever
   * routing this value through a `Date`.
   */
  q: string;
  /** Tiebreaker — last-row `ai_agent_runs.id`. */
  id: string;
}

const BASE64URL_TOKEN_RE = /^[A-Za-z0-9_-]+={0,2}$/;

/** Encode the cursor as a URL-safe base64 JSON token (padding trimmed so it
 *  slots into a query string without %-encoding noise). */
export function encodeRunsCursor(c: AiAgentRunsCursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

/**
 * Decode + validate an incoming cursor token. Returns `null` on any
 * malformed input — the caller 400s on a non-empty malformed token (matches
 * devices' `?cursor set, decode fails => 400` contract) rather than silently
 * restarting the walk, which would look like data loss to the client.
 */
export function decodeRunsCursor(token: string | undefined | null): AiAgentRunsCursor | null {
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
  if (typeof p.q !== 'string' || Number.isNaN(Date.parse(p.q))) return null;
  if (typeof p.id !== 'string' || !UUID_REGEX.test(p.id)) return null;
  return { v: 1, q: p.q, id: p.id };
}

/** Build the WHERE-clause keyset predicate that resumes the DESC walk from
 *  `cursor`: strictly-less-than on the `(queued_at, id)` tuple. */
export function buildRunsKeysetPredicate(cursor: AiAgentRunsCursor): SQL {
  return sql`(${aiAgentRuns.queuedAt}, ${aiAgentRuns.id}) < (${cursor.q}::timestamptz, ${cursor.id}::uuid)`;
}

/**
 * Pull the cursor-shaped `{q, id}` pair out of the last-returned row.
 * Deliberately takes `queuedAtRaw` — the microsecond-precision `to_char(...)`
 * text projected by the route's query — NOT a JS `Date`. A `Date` truncates
 * to millisecond precision (see `AiAgentRunsCursor.q`'s docstring); building
 * the cursor from one would silently drop same-millisecond siblings from the
 * next page.
 */
export function runsCursorFromRow(row: { id: string; queuedAtRaw: string }): AiAgentRunsCursor {
  return { v: 1, q: row.queuedAtRaw, id: row.id };
}
