// apps/api/src/services/backupHealthCursor.ts
/**
 * Keyset cursor for the unified backup-health feed.
 *
 * The feed is a merge of two independently-queried legs (Breeze devices,
 * provider devices), so there is no single base-table primary key to walk.
 * The key is `(lower(name), key)` where `key` is the row's globally unique
 * `'breeze:<uuid>'` / `'provider:<uuid>'` identity — that pair is TOTAL, which
 * matters here: two machines called "SRV01" in different orgs are the everyday
 * case in an MSP fleet, and ordering on the name alone leaves their relative
 * order undefined between two page requests, so a client paging the fleet sees
 * one twice and misses the other.
 *
 * `n` is stored ALREADY LOWER-CASED. Both sides of the keyset predicate then
 * compare `lower(<name expr>)` against a plain bound string under `COLLATE "C"`
 * — byte order in Postgres, code-point order in JS — so the SQL walk and the
 * in-memory merge can never disagree about which row comes next. Comparing raw
 * names would put the two under different collations (the database's, and
 * JavaScript's `<`), which is exactly how a keyset develops a hole.
 */

/** Wire shape of the opaque token. `v` is bumped on an incompatible change;
 *  {@link decodeBackupHealthCursor} rejects an unknown version rather than
 *  silently mis-walking it. */
export interface BackupHealthCursor {
  v: 1;
  /** Last-row name, lower-cased. */
  n: string;
  /** Last-row `BackupHealthRow.key`. */
  k: string;
}

const BASE64URL_TOKEN_RE = /^[A-Za-z0-9_-]{1,4096}$/;
const ROW_KEY_RE = /^(?:breeze|provider):[0-9a-fA-F-]{36}$/;

/** Per-request default page size when the client passes no `limit`. */
export const BACKUP_HEALTH_DEFAULT_LIMIT = 50;
/** Defensive per-response ceiling — one page stays a small JSON body even with
 *  28 history cells and a data-source array on every row. */
export const BACKUP_HEALTH_MAX_LIMIT = 200;

export function encodeBackupHealthCursor(c: BackupHealthCursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

/**
 * Decode + validate an incoming token. Returns null on ANY malformed input so
 * the route can 400 cleanly on adversarial input instead of throwing a 500.
 */
export function decodeBackupHealthCursor(token: string | undefined | null): BackupHealthCursor | null {
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
  if (typeof p.n !== 'string' || p.n.length > 512) return null;
  if (typeof p.k !== 'string' || !ROW_KEY_RE.test(p.k)) return null;
  return { v: 1, n: p.n, k: p.k };
}

/** The cursor that resumes AFTER the given row. */
export function cursorFromRow(row: { key: string; name: string }): BackupHealthCursor {
  return { v: 1, n: row.name.toLowerCase(), k: row.key };
}

/**
 * In-memory twin of the SQL `ORDER BY lower(name) COLLATE "C", key COLLATE "C"`.
 * Sorts ascending. Used to merge the two legs and to slice a batch at the
 * cursor; expressing the order once keeps the merge and the walk aligned.
 */
export function compareRowKeys(
  a: { key: string; name: string },
  b: { key: string; name: string },
): number {
  const an = a.name.toLowerCase();
  const bn = b.name.toLowerCase();
  if (an !== bn) return an < bn ? -1 : 1;
  if (a.key === b.key) return 0;
  return a.key < b.key ? -1 : 1;
}
