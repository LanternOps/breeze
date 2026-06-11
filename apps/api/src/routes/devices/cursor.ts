/**
 * Keyset cursor pagination for GET /devices (Discussion #742 PR 3).
 *
 * Walks the devices list in a stable order chosen by the caller, using a
 * keyset on `(sortColumn, id)`. Avoids the offset-pagination skip/dup
 * problem under churn: every agent check-in bumps `last_seen_at`, which
 * would shift rows between pages of an offset query — keyset pages are
 * stable against concurrent UPDATEs that don't touch the sort column.
 *
 * Default sort: `hostname ASC`. `hostname` and `enrolled_at` are NOT NULL
 * in the schema, so their keyset predicates are straight tuple
 * comparisons. `last_seen_at` is nullable (never-checked-in devices); the
 * ORDER BY pins NULLs LAST and the keyset predicate has an explicit
 * "transition to NULL phase" branch so the walk crosses the boundary
 * exactly once with no gap or overlap.
 *
 * The keyset ORDER BY / LIMIT is owned here and is **never** delegated to
 * the FilterConditionGroup engine — a filter-supplied ORDER BY would
 * silently break the keyset's monotonicity guarantee.
 */

import { sql, type SQL } from 'drizzle-orm';
import { devices } from '../../db/schema';

/** Defensive per-response ceiling. The user never bumps into this; it
 *  caps any one HTTP response at ~2-3 MB of JSON for the widest current
 *  device shape. Single named constant so the number is greppable. */
export const DEVICES_LIST_HARD_MAX = 1000;

/** Per-request default when the client doesn't pass `limit`. 500 matches
 *  the previous unbounded-default behavior of `?page=1` callers prior to
 *  PR #748's hard cap (the legacy contract returned up to 500 rows when
 *  no `limit` was passed). Keeping the default at 500 means deploying
 *  this PR (#777) before the cursor-walker (#778) ships does NOT visibly
 *  drop the no-param devices-list from 500 to 50 rows for any existing
 *  caller. #778 can lower the default once the cursor walker is in
 *  production. */
export const DEVICES_LIST_DEFAULT_LIMIT = 500;

/** Whitelisted sort columns. Adding a new key requires (a) extending this
 *  tuple, (b) adding a `case` in `buildOrderBy` + `buildKeysetPredicate`,
 *  and (c) adding the matching covering index in a migration
 *  (`devices_<sort>_id_idx`). The TS-`as const` plus the exhaustive
 *  switches keep the three in sync. */
export const DEVICES_SORT_KEYS = ['hostname', 'lastSeen', 'enrolled'] as const;
export type DevicesSortKey = (typeof DEVICES_SORT_KEYS)[number];

export type DevicesSortDir = 'asc' | 'desc';

/**
 * Wire shape carried in the opaque base64url-JSON cursor token.
 * `v` is bumped if the shape ever changes incompatibly; `decodeCursor`
 * rejects unknown versions rather than silently mis-walking.
 */
export interface DevicesCursor {
  v: 1;
  sort: DevicesSortKey;
  sortDir: DevicesSortDir;
  /** Last-row value of the sort column. `null` means the cursor has
   *  crossed into the `last_seen_at IS NULL` phase (devices that have
   *  never checked in); meaningless for sort keys that are NOT NULL. */
  k: string | null;
  /** Tiebreaker — last-row `devices.id`. Always set. */
  id: string;
}

/** ISO-8601 date-time used by the cursor for timestamp sort columns. We
 *  serialize Date → ISO so the cursor token is platform-portable and
 *  diffable in logs, instead of relying on engine-specific timestamp
 *  encodings. Postgres re-parses the ISO on the next round-trip. */
function timestampToCursorKey(v: Date | string | null): string | null {
  if (v === null) return null;
  return v instanceof Date ? v.toISOString() : v;
}

/** Default direction when the caller specifies a sort key but no direction.
 *  Picked so the natural reading is right by default: alphabetical
 *  hostnames, most-recently-seen first, newest-enrolled first. */
export function defaultSortDir(sort: DevicesSortKey): DevicesSortDir {
  return sort === 'hostname' ? 'asc' : 'desc';
}

/** Default sort key when the caller omits `sort`. Differs by pagination
 *  mode: offset mode (legacy `?page=N` callers) keeps the pre-cursor
 *  contract of `last_seen_at DESC`; cursor mode defaults to `hostname`
 *  because the keyset's monotonicity is most stable on a NOT NULL string
 *  column. This branching is what prevents a silent ordering regression
 *  for any external caller that lands between deploying #777 (server)
 *  and #778 (web client). */
export function defaultSortKey(isCursorMode: boolean): DevicesSortKey {
  return isCursorMode ? 'hostname' : 'lastSeen';
}

const BASE64URL_TOKEN_RE = /^[A-Za-z0-9_-]+={0,2}$/;

/** Encode the cursor as a URL-safe base64 JSON token. We trim '=' padding
 *  so the token slots into a query string without %-encoding noise. */
export function encodeCursor(c: DevicesCursor): string {
  const json = JSON.stringify(c);
  return Buffer.from(json, 'utf8').toString('base64url');
}

/**
 * Decode + validate an incoming cursor token. Returns null on any
 * malformed input; the caller should treat null as "no cursor" and start
 * the walk from the beginning. Throwing here would surface a 500 on
 * adversarial input; null lets the route 400 cleanly if it cares.
 */
export function decodeCursor(token: string | undefined | null): DevicesCursor | null {
  if (!token) return null;
  if (!BASE64URL_TOKEN_RE.test(token)) return null;
  let parsed: unknown;
  try {
    const json = Buffer.from(token, 'base64url').toString('utf8');
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const p = parsed as Record<string, unknown>;
  if (p.v !== 1) return null;
  if (typeof p.sort !== 'string' || !DEVICES_SORT_KEYS.includes(p.sort as DevicesSortKey)) return null;
  if (p.sortDir !== 'asc' && p.sortDir !== 'desc') return null;
  if (p.k !== null && typeof p.k !== 'string') return null;
  if (typeof p.id !== 'string' || p.id.length === 0) return null;
  return {
    v: 1,
    sort: p.sort as DevicesSortKey,
    sortDir: p.sortDir,
    k: p.k,
    id: p.id,
  };
}

/**
 * Build the ORDER BY clause for a sort key + direction. NULL handling
 * pins NULLs to the end of the natural reading order (so NULLs LAST under
 * DESC, NULLS LAST under ASC) — the same shape on both directions so
 * `last_seen_at IS NULL` rows always appear at the tail of the walk.
 *
 * The `id` tiebreaker uses the SAME direction as the sort column. Mixed
 * directions break tuple-comparison keysets (`(a, b) <op>` requires
 * uniform direction); the seen-id Set Todd suggested handles boundary
 * fuzz on the volatile sorts at the client.
 */
export function buildOrderBy(sort: DevicesSortKey, dir: DevicesSortDir): SQL[] {
  const idDir = dir === 'asc' ? sql`ASC` : sql`DESC`;
  switch (sort) {
    case 'hostname':
      // hostname is NOT NULL — no NULLS clause needed.
      return [
        sql`${devices.hostname} ${dir === 'asc' ? sql`ASC` : sql`DESC`}`,
        sql`${devices.id} ${idDir}`,
      ];
    case 'lastSeen':
      // last_seen_at is nullable. NULLS LAST regardless of direction so
      // never-checked-in devices always tail the list.
      return [
        sql`${devices.lastSeenAt} ${dir === 'asc' ? sql`ASC` : sql`DESC`} NULLS LAST`,
        sql`${devices.id} ${idDir}`,
      ];
    case 'enrolled':
      // enrolled_at is NOT NULL (defaultNow()).
      return [
        sql`${devices.enrolledAt} ${dir === 'asc' ? sql`ASC` : sql`DESC`}`,
        sql`${devices.id} ${idDir}`,
      ];
  }
}

/**
 * Build the WHERE-clause keyset predicate that resumes the walk from
 * `cursor`. The caller AND-combines this with the row-filter predicates
 * (org access, status, search, etc.).
 *
 * Returns `undefined` when there's no cursor — caller starts from the
 * beginning of the order.
 *
 * NULL handling for `lastSeen`:
 *   - `cursor.k != null` means we're in the non-NULL phase. Next rows
 *     are either further non-NULL rows in the sort order, OR — once
 *     we've exhausted non-NULL — the first NULL rows (transition).
 *   - `cursor.k == null` means we're in the NULL phase. Next rows are
 *     other NULL rows with `id` strictly past `cursor.id` in the sort
 *     direction.
 *
 * `hostname` and `enrolled` use straight tuple comparison — no NULL
 * branches needed because the columns are NOT NULL in the schema.
 */
export function buildKeysetPredicate(cursor: DevicesCursor): SQL {
  const op = cursor.sortDir === 'asc' ? sql`>` : sql`<`;
  switch (cursor.sort) {
    case 'hostname': {
      // hostname NOT NULL. Tuple comparison on (hostname, id).
      return sql`(${devices.hostname}, ${devices.id}) ${op} (${cursor.k!}, ${cursor.id}::uuid)`;
    }
    case 'enrolled': {
      // enrolled_at NOT NULL. Tuple comparison on (enrolled_at, id).
      return sql`(${devices.enrolledAt}, ${devices.id}) ${op} (${cursor.k!}::timestamp, ${cursor.id}::uuid)`;
    }
    case 'lastSeen': {
      // Three-phase logic — see function-level comment.
      if (cursor.k === null) {
        // NULL phase: continue among NULL rows by id only.
        return sql`(${devices.lastSeenAt} IS NULL AND ${devices.id} ${op} ${cursor.id}::uuid)`;
      }
      // Non-NULL phase. Two ways to be "after" the cursor:
      //   (a) another non-NULL row with smaller/larger sort key, OR
      //   (b) any NULL row (NULL is pinned LAST for both directions).
      return sql`(
        (${devices.lastSeenAt} IS NOT NULL
          AND (${devices.lastSeenAt}, ${devices.id}) ${op} (${cursor.k}::timestamp, ${cursor.id}::uuid))
        OR ${devices.lastSeenAt} IS NULL
      )`;
    }
  }
}

/**
 * Pull the cursor-shaped {k, id} pair out of a result row for a given
 * sort key. Used to build the `nextCursor` after a successful walk.
 */
export function cursorFromRow(
  row: { id: string; hostname: string; lastSeenAt: Date | null; enrolledAt: Date },
  sort: DevicesSortKey,
  sortDir: DevicesSortDir
): DevicesCursor {
  switch (sort) {
    case 'hostname':
      return { v: 1, sort, sortDir, k: row.hostname, id: row.id };
    case 'lastSeen':
      return { v: 1, sort, sortDir, k: timestampToCursorKey(row.lastSeenAt), id: row.id };
    case 'enrolled':
      return { v: 1, sort, sortDir, k: timestampToCursorKey(row.enrolledAt), id: row.id };
  }
}
