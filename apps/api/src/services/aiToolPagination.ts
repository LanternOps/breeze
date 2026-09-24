/**
 * A-W05 (D11): the one pagination envelope every list tool emits, ADDITIVELY,
 * on top of its existing keys. Two modes:
 *  - offset: `limit` + `offset` + opaque `cursor` (stable lists);
 *  - keyset: `limit` + opaque `cursor` carrying the last row's sort key
 *    (churn tables — alerts, agent_logs, audit_logs, device_change_log —
 *    where an insert between pages would shift every later offset without
 *    the model noticing).
 * A cursor is bound to a fingerprint of the tool name + every non-page filter,
 * so a cursor replayed against a different query is refused with a typed tool
 * error (never silently reset to page 1 — that re-delivers page 1 forever).
 *
 * Q1 (keyset precision — blocking): the four keyset sort columns
 * (`alerts.triggeredAt`, `agentLogs.createdAt`, `auditLogs.timestamp`,
 * `deviceChangeLog.timestamp`) are Postgres `timestamp` WITHOUT time zone and
 * hold microseconds. The sort key MUST be selected as `col::text` (e.g.
 * `sql<string>\`${alerts.triggeredAt}::text\`.as('triggeredAtText')`) and
 * carried through the cursor as that exact text:
 *  - NEVER round-trip it through a JS `Date` or `.toISOString()` — that drops
 *    precision to milliseconds and can misorder or duplicate rows that share
 *    a millisecond but differ in microseconds.
 *  - NEVER cast it to `timestamptz` — a timezone shift can reorder rows
 *    relative to the (un-shifted) index scan the query planner used.
 * `keysetWhereCondition` builds the WHERE fragment as
 * `(col, id) < ($t::timestamp, $i::uuid)` against that text, so the DB
 * comparison happens at full column precision with no JS-side rounding.
 *
 * Q2 (cursor input hygiene — blocking): `readKeysetArgs` validates the
 * decoded cursor's `t` (timestamp text) and `i` (UUID) against fixed regexes
 * BEFORE any value reaches SQL, returning the typed `CURSOR_INVALID` tool
 * error otherwise. A malformed value must never reach a `::timestamp`/`::uuid`
 * cast — Postgres 22P02 (invalid_text_representation) poisons the request
 * transaction. Opt-in projection flags (`includeX`) never affect the
 * fingerprint, so toggling one mid-pagination doesn't invalidate an otherwise
 * identical cursor. `offset` is capped at `MAX_OFFSET` (10,000) — both on the
 * raw request param and on a decoded cursor's stored offset — to bound how
 * deep an offset-mode query can be asked to scan.
 */
import { createHash } from 'node:crypto';
import { sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { z } from 'zod';

export const PAGE_CONTROL_KEYS = ['limit', 'offset', 'cursor'] as const;
const CURSOR_MAX_CHARS = 256;
export const MAX_OFFSET = 10_000;

// Q2: cursor payload format guards — checked before any value reaches SQL.
// Matches `col::text` output for a Postgres `timestamp` (no tz) column:
// `YYYY-MM-DD HH:MM:SS[.ffffff]`, up to microsecond precision (Postgres emits
// only as many fractional digits as are non-zero, so 1-6 digits are all valid).
const TIMESTAMP_TEXT_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const src = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(src).sort().map((k) => [k, canonical(src[k])]));
  }
  return value;
}

// Q2: opt-in projection flags (`includeX`) are excluded from the fingerprint —
// they change what a row LOOKS like, not which rows are in the result set.
function isFingerprintExempt(key: string): boolean {
  return (PAGE_CONTROL_KEYS as readonly string[]).includes(key) || /^include[A-Z]/.test(key);
}

export function pageFingerprint(toolName: string, input: Record<string, unknown>): string {
  const filters: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (isFingerprintExempt(k) || v === undefined) continue;
    filters[k] = v;
  }
  return createHash('sha256').update(`${toolName}\n${JSON.stringify(canonical(filters))}`).digest('hex').slice(0, 16);
}

type OffsetCursorBody = { f: string; o: number };
type KeysetCursorBody = { f: string; t: string; i: string };

function encodeCursor(body: OffsetCursorBody | KeysetCursorBody): string {
  return Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
}

type DecodeResult = { ok: true; body: Record<string, unknown> } | { ok: false; code: 'CURSOR_MISMATCH' | 'CURSOR_INVALID'; error: string };

function decodeCursorRaw(token: unknown, expectedFingerprint: string): DecodeResult {
  if (typeof token !== 'string' || token.length === 0 || token.length > CURSOR_MAX_CHARS) {
    return { ok: false, code: 'CURSOR_INVALID', error: 'cursor is not a nextCursor value from a previous call' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, code: 'CURSOR_INVALID', error: 'cursor is not a nextCursor value from a previous call' };
  }
  if (!parsed || typeof parsed !== 'object' || typeof (parsed as Record<string, unknown>).f !== 'string') {
    return { ok: false, code: 'CURSOR_INVALID', error: 'cursor is not a nextCursor value from a previous call' };
  }
  const body = parsed as Record<string, unknown>;
  if (body.f !== expectedFingerprint) {
    return { ok: false, code: 'CURSOR_MISMATCH', error: 'cursor was issued for a different query; repeat the same filters or drop the cursor' };
  }
  return { ok: true, body };
}

function clampLimit(raw: unknown, opts: { defaultLimit: number; maxLimit: number }): number {
  const n = Math.trunc(Number(raw));
  const base = Number.isFinite(n) && n > 0 ? n : opts.defaultLimit;
  return Math.min(Math.max(1, base), opts.maxLimit);
}

export function readPageArgs(
  toolName: string,
  input: Record<string, unknown>,
  opts: { defaultLimit: number; maxLimit: number },
):
  | { ok: true; limit: number; offset: number; fingerprint: string }
  | { ok: false; error: string; code: 'CURSOR_MISMATCH' | 'CURSOR_INVALID' } {
  const fingerprint = pageFingerprint(toolName, input);
  const limit = clampLimit(input.limit, opts);
  const rawOffset = Math.trunc(Number(input.offset));
  let offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.min(rawOffset, MAX_OFFSET) : 0;
  if (input.cursor !== undefined && input.cursor !== null && input.cursor !== '') {
    const decoded = decodeCursorRaw(input.cursor, fingerprint);
    if (!decoded.ok) return decoded;
    const o = decoded.body.o;
    if (typeof o !== 'number' || !Number.isInteger(o) || o < 0) {
      return { ok: false, code: 'CURSOR_INVALID', error: 'cursor is not a nextCursor value from a previous call' };
    }
    offset = Math.min(o, MAX_OFFSET);
  }
  return { ok: true, limit, offset, fingerprint };
}

export function pageEnvelope<T>(p: {
  key: string;
  items: T[];
  limit: number;
  offset: number;
  fingerprint: string;
  total?: number;
  totalMode?: 'exact' | 'estimated';
}): Record<string, unknown> {
  const overFetched = p.total === undefined && p.items.length > p.limit;
  const items = overFetched ? p.items.slice(0, p.limit) : p.items;
  const hasMore = p.total !== undefined ? p.offset + items.length < p.total : overFetched;
  const nextOffset = p.offset + items.length;
  return {
    [p.key]: items,
    showing: items.length,
    limit: p.limit,
    offset: p.offset,
    ...(p.total !== undefined ? { total: p.total, totalMode: p.totalMode ?? 'exact' } : {}),
    hasMore,
    nextCursor: hasMore ? encodeCursor({ f: p.fingerprint, o: nextOffset }) : null,
  };
}

export function readKeysetArgs(
  toolName: string,
  input: Record<string, unknown>,
  opts: { defaultLimit: number; maxLimit: number },
):
  | { ok: true; limit: number; after: { t: string; i: string } | null; fingerprint: string }
  | { ok: false; error: string; code: 'CURSOR_MISMATCH' | 'CURSOR_INVALID' } {
  const fingerprint = pageFingerprint(toolName, input);
  const limit = clampLimit(input.limit, opts);
  if (input.cursor === undefined || input.cursor === null || input.cursor === '') {
    return { ok: true, limit, after: null, fingerprint };
  }
  const decoded = decodeCursorRaw(input.cursor, fingerprint);
  if (!decoded.ok) return decoded;
  const t = decoded.body.t;
  const i = decoded.body.i;
  // Q1/Q2: format-validate BEFORE any value can reach a SQL cast.
  if (typeof t !== 'string' || typeof i !== 'string' || !TIMESTAMP_TEXT_RE.test(t) || !UUID_RE.test(i)) {
    return { ok: false, code: 'CURSOR_INVALID', error: 'cursor is not a nextCursor value from a previous call' };
  }
  return { ok: true, limit, after: { t, i }, fingerprint };
}

export function keysetEnvelope<T>(p: {
  key: string;
  items: T[];
  limit: number;
  fingerprint: string;
  /**
   * Must return the sort column's value as Postgres `timestamp::text`
   * (e.g. `'2026-09-20 10:00:40.123456'`) — never a JS `Date` or
   * `.toISOString()` string. See the Q1 module doc above.
   */
  keyOf: (item: T) => { t: string; i: string };
  total?: number;
  totalMode?: 'exact' | 'estimated';
}): Record<string, unknown> {
  const hasMore = p.items.length > p.limit;
  const items = hasMore ? p.items.slice(0, p.limit) : p.items;
  const last = items[items.length - 1];
  return {
    [p.key]: items,
    showing: items.length,
    limit: p.limit,
    ...(p.total !== undefined ? { total: p.total, totalMode: p.totalMode ?? 'exact' } : {}),
    hasMore,
    nextCursor: hasMore && last !== undefined ? encodeCursor({ f: p.fingerprint, ...p.keyOf(last) }) : null,
  };
}

/**
 * Q1: the keyset WHERE predicate `(col, id) < ($t::timestamp, $i::uuid)`.
 * Callers MUST select the sort column as `col::text` in the query that
 * produces the values passed to `keyOf` above (and consequently to `after.t`
 * here) — this fragment casts `$t` to `timestamp` (no timezone) and relies on
 * the text having full microsecond precision and no timezone conversion.
 * Returns `undefined` for the first page (`after === null`), so callers can
 * spread it straight into an `and(...)` filter list without an `if`.
 */
export function keysetWhereCondition(tsColumn: AnyColumn, idColumn: AnyColumn, after: { t: string; i: string } | null): SQL | undefined {
  if (!after) return undefined;
  return sql`(${tsColumn}, ${idColumn}) < (${after.t}::timestamp, ${after.i}::uuid)`;
}

/** Registry JSON-schema properties. Text is fixed so the A-W03 budget lint and Task 4's "default N, max M" lint see one spelling. */
export function pageParamSchema(defaultLimit: number, maxLimit: number) {
  return {
    limit: { type: 'number', description: `Max results (default ${defaultLimit}, max ${maxLimit})` },
    offset: { type: 'number', description: 'Pagination offset (default 0)' },
    cursor: { type: 'string', description: 'nextCursor from a previous call with the same filters' },
  } as const;
}

export function keysetParamSchema(defaultLimit: number, maxLimit: number) {
  const { limit, cursor } = pageParamSchema(defaultLimit, maxLimit);
  return { limit, cursor } as const;
}

/**
 * SDK `tool()` and `toolInputSchemas` Zod shapes — the other two surfaces
 * (Q7: the registry's `.description` text above is NOT derived by these SDK
 * shapes, so each carries its own `.describe()` with the same wording).
 */
const OFFSET_DESCRIPTION = 'Pagination offset (default 0)';
const CURSOR_DESCRIPTION = 'nextCursor from a previous call with the same filters';

export function pageZodShape(defaultLimit: number, maxLimit: number) {
  return {
    limit: z.number().int().min(1).max(maxLimit).optional().describe(`Max results (default ${defaultLimit}, max ${maxLimit})`),
    offset: z.number().int().min(0).optional().describe(OFFSET_DESCRIPTION),
    cursor: z.string().max(CURSOR_MAX_CHARS).optional().describe(CURSOR_DESCRIPTION),
  };
}

export function keysetZodShape(defaultLimit: number, maxLimit: number) {
  return {
    limit: z.number().int().min(1).max(maxLimit).optional().describe(`Max results (default ${defaultLimit}, max ${maxLimit})`),
    cursor: z.string().max(CURSOR_MAX_CHARS).optional().describe(CURSOR_DESCRIPTION),
  };
}
