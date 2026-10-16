import { sql } from 'drizzle-orm';
import { db } from '../db';
import { normalizeSnapshotPath } from './backupSelectedPaths';

/**
 * One-level, keyset-paged listing of a snapshot's file index (#8230).
 *
 * The browse endpoint used to load every `backup_snapshot_files` row and build
 * the whole tree in JS inside the request's DB context. This pushes the
 * "children of directory X" grouping into SQL so only one bounded page of
 * entries ever leaves Postgres.
 */

export const BROWSE_DEFAULT_LIMIT = 200;
export const BROWSE_MAX_LIMIT = 1000;

export type BrowseEntry = {
  name: string;
  /** Directories: `/`-rooted tree path (the value to pass back as `dir`).
   *  Files: the normalized stored path, exactly what selective restore
   *  resolves against (#7219 — Windows paths keep `C:/…` with no leading `/`). */
  path: string;
  type: 'file' | 'directory';
  sizeBytes?: number;
  modifiedAt?: string;
};

export type BrowsePage = {
  entries: BrowseEntry[];
  nextCursor: string | null;
};

export type BrowseRow = {
  name: string;
  is_dir: boolean;
  source_path: string;
  size: string | number | null;
  modified_at: Date | string | null;
};

/** Split a tree path (`/C:/Users`, `C:\Users`, ``) into its non-empty segments. */
export function dirSegments(dir: string | undefined | null): string[] {
  if (!dir) return [];
  return normalizeSnapshotPath(dir).split('/').filter(Boolean);
}

/** Cursor = `<0|1>:<name>` (0 = directory, 1 = file) — the sort key of the last row. */
export function encodeBrowseCursor(entry: { type: 'file' | 'directory'; name: string }): string {
  return Buffer.from(`${entry.type === 'directory' ? 0 : 1}:${entry.name}`, 'utf8').toString('base64url');
}

export function decodeBrowseCursor(cursor: string): { rank: 0 | 1; name: string } | null {
  const raw = Buffer.from(cursor, 'base64url').toString('utf8');
  const rank = raw[0];
  if ((rank !== '0' && rank !== '1') || raw[1] !== ':') return null;
  return { rank: rank === '0' ? 0 : 1, name: raw.slice(2) };
}

export function shapeBrowseRows(rows: BrowseRow[], segments: string[], limit: number): BrowsePage {
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const parent = segments.length > 0 ? `/${segments.join('/')}` : '';
  const entries: BrowseEntry[] = page.map((row) => {
    if (row.is_dir) {
      return { name: row.name, path: `${parent}/${row.name}`, type: 'directory' };
    }
    return {
      name: row.name,
      path: normalizeSnapshotPath(row.source_path),
      type: 'file',
      sizeBytes: row.size === null || row.size === undefined ? undefined : Number(row.size),
      modifiedAt: row.modified_at ? new Date(row.modified_at).toISOString() : undefined,
    };
  });
  const last = entries[entries.length - 1];
  return { entries, nextCursor: hasMore && last ? encodeBrowseCursor(last) : null };
}

export async function listSnapshotDirectory(params: {
  snapshotDbId: string;
  segments: string[];
  limit: number;
  cursor?: { rank: 0 | 1; name: string } | null;
}): Promise<BrowsePage> {
  const { snapshotDbId, segments, limit, cursor } = params;
  const prefix = segments.join('/');
  const cursorFilter = cursor
    ? sql`WHERE (g.rank, g.name COLLATE "C") > (${cursor.rank}::int, ${cursor.name}::text COLLATE "C")`
    : sql``;

  // np = stored path with `\`→`/`, repeated `/` collapsed and leading `/`
  // stripped — the same segmentation normalizeSnapshotPath + filter(Boolean)
  // gave the old in-JS tree builder, so Windows and POSIX roots are unchanged.
  const result = await db.execute(sql`
    WITH n AS (
      SELECT source_path, size, modified_at,
        regexp_replace(regexp_replace(replace(source_path, E'\\\\', '/'), '/{2,}', '/', 'g'), '^/+', '') AS np
      FROM backup_snapshot_files
      WHERE snapshot_db_id = ${snapshotDbId}
    ),
    r AS (
      SELECT source_path, size, modified_at,
        CASE WHEN ${prefix}::text = '' THEN np ELSE substr(np, length(${prefix}::text) + 2) END AS rest
      FROM n
      WHERE ${prefix}::text = '' OR left(np, length(${prefix}::text) + 1) = ${prefix}::text || '/'
    ),
    g AS (
      SELECT split_part(rest, '/', 1) AS name,
        position('/' in rest) > 0 AS is_dir,
        CASE WHEN position('/' in rest) > 0 THEN 0 ELSE 1 END AS rank,
        min(source_path) AS source_path,
        max(size) AS size,
        max(modified_at) AS modified_at
      FROM r
      WHERE rest <> ''
      GROUP BY 1, 2, 3
    )
    SELECT g.name, g.is_dir, g.source_path, g.size, g.modified_at
    FROM g
    ${cursorFilter}
    ORDER BY g.rank, g.name COLLATE "C"
    LIMIT ${limit + 1}
  `);

  const rows = (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])) as BrowseRow[];
  return shapeBrowseRows(rows, segments, limit);
}
