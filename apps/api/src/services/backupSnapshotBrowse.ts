import { and, asc, eq, gt, sql } from 'drizzle-orm';
import { db } from '../db';
import { lockTimeoutWasChanged, tightenStatementTimeout } from '../db/lockTimeout';
import { pgErrorCode } from '../utils/pgErrors';
import { backupSnapshotFiles, backupSnapshots } from '../db/schema/backup';
import { backupSnapshotAttestations } from '../db/schema/backupSnapshotAttestations';
import { readableIndexCondition } from './backupRestoreIntegrity';
import { createSelectionResolver, normalizeSnapshotPath, type SelectedSnapshotPathsResolution } from './backupSelectedPaths';
import type { SnapshotEntryKind } from './backupSnapshotEntryKind';

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
export const SEARCH_DEFAULT_LIMIT = 50;
export const SEARCH_MAX_LIMIT = 100;
export const SEARCH_QUERY_MIN_LENGTH = 2;
export const SEARCH_QUERY_MAX_LENGTH = 256;

// #11026: a million-row index is browsed and searched by a person waiting on
// the answer. Past these, the honest answer is "try again", not a hung request
// holding a pooled connection.
export const BROWSE_STATEMENT_TIMEOUT_MS = 15_000;
export const SEARCH_STATEMENT_TIMEOUT_MS = 10_000;

/** A browse or search statement that ran past its timeout. */
export class IndexQueryTimeoutError extends Error {
  constructor() {
    super('The snapshot file index query took too long');
    this.name = 'IndexQueryTimeoutError';
  }
}

type Executor = Pick<typeof db, 'execute' | 'select'>;

/**
 * Runs `query` in a savepoint of the request's transaction with
 * statement_timeout lowered to `boundMs` (SET LOCAL, never widened). A timeout
 * rolls back only the savepoint, so the request's transaction stays usable for
 * its answer, and is reported as IndexQueryTimeoutError. On success the
 * caller's own value is put back: a released savepoint keeps a SET LOCAL until
 * the whole transaction ends.
 */
async function withStatementTimeout<T>(boundMs: number, query: (tx: Executor) => Promise<T>): Promise<T> {
  try {
    return await db.transaction(async (tx) => {
      const priorMs = await tightenStatementTimeout(tx, boundMs);
      const result = await query(tx);
      if (lockTimeoutWasChanged(priorMs, boundMs)) {
        await tx.execute(sql`SELECT set_config('statement_timeout', ${`${priorMs}ms`}, true)`);
      }
      return result;
    });
  } catch (err) {
    // 57014 query_canceled: what statement_timeout raises.
    if (pgErrorCode(err) === '57014') throw new IndexQueryTimeoutError();
    throw err;
  }
}

export type BrowseEntry = {
  name: string;
  /** Directories: `/`-rooted tree path (the value to pass back as `dir`).
   *  Files: the normalized stored path, exactly what selective restore
   *  resolves against (#7219 — Windows paths keep `C:/…` with no leading `/`). */
  path: string;
  type: 'file' | 'directory';
  sizeBytes?: number;
  modifiedAt?: string;
  /**
   * Directories only: indexed files at any depth beneath it (#9628), symlinks
   * included, directory entries not (#11235). Absent on a search result.
   */
  fileCount?: number;
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
  /** Files at or beneath this entry (directories only matter). */
  file_count?: string | number | null;
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
      const fileCount = Number(row.file_count);
      return {
        name: row.name,
        path: `${parent}/${row.name}`,
        type: 'directory',
        ...(Number.isFinite(fileCount) && row.file_count != null ? { fileCount } : {}),
      };
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

/** Stored paths read per statement while resolving a selection. */
export const SELECTION_PAGE_SIZE = 5000;

/**
 * readableIndexCondition for one snapshot, as a subquery on no row of the file
 * table: Postgres evaluates it once per statement, where a join would repeat it
 * for each of a million rows. Still decided in the statement that reads them.
 */
function snapshotIndexIsReadable(snapshotDbId: string) {
  return sql`EXISTS (
    SELECT 1 FROM ${backupSnapshots}
    LEFT JOIN ${backupSnapshotAttestations} ON ${backupSnapshotAttestations.snapshotDbId} = ${backupSnapshots.id}
    WHERE ${backupSnapshots.id} = ${snapshotDbId} AND ${readableIndexCondition()}
  )`;
}

/**
 * The keyset bound, on every page including the first (a stored path is never
 * empty). It makes (snapshot_db_id, source_path) the obvious index whatever the
 * statistics say: right after a bulk publish they still claim one row, and the
 * planner would otherwise read and sort the whole snapshot for the first page.
 */
function afterSourcePath(after: string | null) {
  return gt(backupSnapshotFiles.sourcePath, after ?? '');
}

/**
 * One keyset page of the stored source paths a selective restore may resolve
 * against: the same rows the listing would show (#11026), decided in the
 * statement that reads them, with each row's kind (a directory entry is the
 * folder it names, #11235). Ordered by source_path, the second column of
 * backup_snapshot_files_snapshot_source_idx, so each page is an index range
 * once the table's statistics know the snapshot's rows (#11209). Exported,
 * unexecuted, so a test can EXPLAIN this exact statement.
 */
export function readableSourcePathPageQuery(snapshotDbId: string, after: string | null) {
  return db
    .select({ sourcePath: backupSnapshotFiles.sourcePath, kind: backupSnapshotFiles.kind })
    .from(backupSnapshotFiles)
    .where(and(
      eq(backupSnapshotFiles.snapshotDbId, snapshotDbId),
      snapshotIndexIsReadable(snapshotDbId),
      afterSourcePath(after),
    ))
    .orderBy(asc(backupSnapshotFiles.sourcePath))
    .limit(SELECTION_PAGE_SIZE);
}

type ReadableSourcePath = { sourcePath: string; kind: SnapshotEntryKind | null };

async function* readableSourcePaths(snapshotDbId: string): AsyncGenerator<ReadableSourcePath[]> {
  let after: string | null = null;
  for (;;) {
    const page: ReadableSourcePath[] = await readableSourcePathPageQuery(snapshotDbId, after);
    if (page.length > 0) yield page;
    if (page.length < SELECTION_PAGE_SIZE) return;
    after = page[page.length - 1]!.sourcePath;
  }
}

/**
 * Every readable stored path of a snapshot, held in memory. For tests and small
 * fixtures: request paths walk pages instead (resolveSelectedSnapshotPathsInDb).
 */
export async function readableSnapshotSourcePaths(snapshotDbId: string): Promise<string[]> {
  const all: string[] = [];
  for await (const page of readableSourcePaths(snapshotDbId)) all.push(...page.map((row) => row.sourcePath));
  return all;
}

export type SnapshotSelectionResolution =
  | SelectedSnapshotPathsResolution
  /** The snapshot has no rows that may be trusted: nothing can be selected yet. */
  | { ok: false; reason: 'no_readable_index' };

/**
 * Resolves a selective restore's selections against a snapshot's readable
 * index (createSelectionResolver) without loading every path: the rows are
 * walked in keyset pages, and only the selections and their results are held.
 */
export async function resolveSelectedSnapshotPathsInDb(
  snapshotDbId: string,
  selected: readonly string[],
): Promise<SnapshotSelectionResolution> {
  const resolver = createSelectionResolver(selected);
  let anyRows = false;
  for await (const page of readableSourcePaths(snapshotDbId)) {
    anyRows = true;
    for (const row of page) resolver.add(row.sourcePath, row.kind);
    // Nothing to match: the first page already answers whether rows exist.
    if (selected.length === 0) break;
  }
  if (!anyRows) return { ok: false, reason: 'no_readable_index' };
  return resolver.finish();
}

export async function listSnapshotDirectory(params: {
  snapshotDbId: string;
  segments: string[];
  limit: number;
  cursor?: { rank: 0 | 1; name: string } | null;
  /** Test seam: the timeout to apply instead of BROWSE_STATEMENT_TIMEOUT_MS. */
  statementTimeoutMs?: number;
}): Promise<BrowsePage> {
  const { snapshotDbId, segments, limit, cursor } = params;
  const prefix = segments.join('/');
  const cursorFilter = cursor
    ? sql`WHERE (g.rank, g.name COLLATE "C") > (${cursor.rank}::int, ${cursor.name}::text COLLATE "C")`
    : sql``;

  // np = stored path with `\`→`/`, repeated `/` collapsed and leading `/`
  // stripped — the same segmentation normalizeSnapshotPath + filter(Boolean)
  // gave the old in-JS tree builder, so Windows and POSIX roots are unchanged.
  //
  // A directory entry (kind 'dir', #11235) is a folder at its own level: it
  // groups with the rows beneath it, so a folder recorded for its mode or ACL
  // is listed once, and an empty one is listed at all. It is not counted as a
  // file. A symlink is a file. A content-less row of unknown kind (written
  // before kinds were recorded) is a file, as it always was.
  const result = await withStatementTimeout(params.statementTimeoutMs ?? BROWSE_STATEMENT_TIMEOUT_MS, (tx) => tx.execute(sql`
    WITH n AS (
      SELECT source_path, size, modified_at, kind,
        regexp_replace(regexp_replace(replace(source_path, E'\\\\', '/'), '/{2,}', '/', 'g'), '^/+', '') AS np
      FROM backup_snapshot_files
      WHERE snapshot_db_id = ${snapshotDbId}
        AND EXISTS (
          SELECT 1 FROM ${backupSnapshots}
          LEFT JOIN ${backupSnapshotAttestations} ON ${backupSnapshotAttestations.snapshotDbId} = ${backupSnapshots.id}
          WHERE ${backupSnapshots.id} = ${snapshotDbId} AND ${readableIndexCondition()}
        )
    ),
    r AS (
      SELECT source_path, size, modified_at, kind,
        CASE WHEN ${prefix}::text = '' THEN np ELSE substr(np, length(${prefix}::text) + 2) END AS rest
      FROM n
      WHERE ${prefix}::text = '' OR left(np, length(${prefix}::text) + 1) = ${prefix}::text || '/'
    ),
    g AS (
      SELECT split_part(rest, '/', 1) AS name,
        (position('/' in rest) > 0 OR kind IS NOT DISTINCT FROM 'dir') AS is_dir,
        CASE WHEN position('/' in rest) > 0 OR kind IS NOT DISTINCT FROM 'dir' THEN 0 ELSE 1 END AS rank,
        min(source_path) AS source_path,
        max(size) AS size,
        max(modified_at) AS modified_at,
        count(*) FILTER (WHERE kind IS DISTINCT FROM 'dir') AS file_count
      FROM r
      WHERE rest <> ''
      GROUP BY 1, 2, 3
    )
    SELECT g.name, g.is_dir, g.source_path, g.size, g.modified_at, g.file_count
    FROM g
    ${cursorFilter}
    ORDER BY g.rank, g.name COLLATE "C"
    LIMIT ${limit + 1}
  `));

  const rows = (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])) as BrowseRow[];
  return shapeBrowseRows(rows, segments, limit);
}

/** Search cursor: the stored source_path of the last result returned. */
export function encodeSearchCursor(sourcePath: string): string {
  return Buffer.from(sourcePath, 'utf8').toString('base64url');
}

export function decodeSearchCursor(cursor: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) return null;
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  // Postgres cannot take a NUL as text, so it could never be a stored path.
  return decoded.length > 0 && !decoded.includes('\0') ? decoded : null;
}

function lastSegment(sourcePath: string): string {
  const segments = normalizeSnapshotPath(sourcePath).split('/').filter(Boolean);
  return segments[segments.length - 1] ?? sourcePath;
}

/**
 * Entries of a snapshot whose stored path contains `query`, case-insensitively,
 * anywhere: a file name or any folder above it. Matched with position(), so
 * `%` and `_` are plain characters. Only an index that may be listed is read
 * (readableIndexCondition), in source_path order, keyset-paged after `after`.
 * A directory entry (#11235) is returned as a folder at its browse path, the
 * value browse takes back as `dir` and selection resolves.
 */
export async function searchSnapshotFiles(params: {
  snapshotDbId: string;
  query: string;
  limit: number;
  after: string | null;
  /** Test seam: the timeout to apply instead of SEARCH_STATEMENT_TIMEOUT_MS. */
  statementTimeoutMs?: number;
}): Promise<BrowsePage> {
  const { snapshotDbId, query, limit, after } = params;
  const rows = await withStatementTimeout(params.statementTimeoutMs ?? SEARCH_STATEMENT_TIMEOUT_MS, (tx) =>
    tx
      .select({
        sourcePath: backupSnapshotFiles.sourcePath,
        size: backupSnapshotFiles.size,
        modifiedAt: backupSnapshotFiles.modifiedAt,
        kind: backupSnapshotFiles.kind,
      })
      .from(backupSnapshotFiles)
      .where(and(
        eq(backupSnapshotFiles.snapshotDbId, snapshotDbId),
        snapshotIndexIsReadable(snapshotDbId),
        // Compared as the browser shows paths (forward slashes), so a Windows path
        // is found whichever separator was typed. chr(92) is a backslash.
        sql`position(lower(${normalizeSnapshotPath(query)}::text) in lower(replace(${backupSnapshotFiles.sourcePath}, chr(92), '/'))) > 0`,
        afterSourcePath(after),
      ))
      .orderBy(asc(backupSnapshotFiles.sourcePath))
      .limit(limit + 1),
  );

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const entries: BrowseEntry[] = page.map((row) => {
    if (row.kind === 'dir') {
      const segments = dirSegments(row.sourcePath);
      return { name: lastSegment(row.sourcePath), path: `/${segments.join('/')}`, type: 'directory' };
    }
    return {
      name: lastSegment(row.sourcePath),
      path: normalizeSnapshotPath(row.sourcePath),
      type: 'file',
      sizeBytes: row.size === null || row.size === undefined ? undefined : Number(row.size),
      modifiedAt: row.modifiedAt ? new Date(row.modifiedAt).toISOString() : undefined,
    };
  });
  const last = page[page.length - 1];
  return { entries, nextCursor: hasMore && last ? encodeSearchCursor(last.sourcePath) : null };
}
