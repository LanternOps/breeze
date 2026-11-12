/**
 * #11736 step 1: every read of a snapshot's file index goes through one source,
 * `snapshotIndexEntries` in services/backupSnapshotIndexEntries.ts.
 *
 * Today a snapshot's tree is its own `backup_snapshot_files` rows. Step 2 stores
 * an incremental as differences against a shared checkpoint, and from then on
 * a reader that queries the table directly sees only the differences: a
 * browse that lists a fraction of the tree, or, worse, a membership check that
 * authorizes a checkpoint key the snapshot has since replaced or deleted. So no
 * file outside the layer may read the table. Writers (the inline-result
 * persistence and the hydrator's publish) and the schema definition are allowed.
 *
 * Static scan of every non-test .ts file under apps/api/src and ee/. After
 * import statements and comments are dropped, each remaining mention of the
 * Drizzle table (`backupSnapshotFiles`) must be the target of `.insert(`,
 * `.update(`, `.delete(` or `INSERT INTO ${…}`, or a column named inside that
 * same write statement (its WHERE, SET, conflict target or RETURNING). Each
 * raw-SQL mention (`backup_snapshot_files`, any case) must follow `INSERT INTO`,
 * `UPDATE` or `DELETE FROM`. Anything else is a read. Importing the table under
 * another name (`backupSnapshotFiles as t`) is reported at the import.
 *
 * Known limits (a heuristic, not a parser): a `//` comment is recognised only
 * at the start of a line or after whitespace; a string holding `/*` (a glob
 * such as '**' + '/*.ts') can hide code up to the next `*` + `/`; the table
 * reached through a local alias (`const t = backupSnapshotFiles`) is reported
 * at the alias, not at each use; and only `.ts` files are read. Review still
 * owns those shapes.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const API_SRC = join(__dirname, '..');
const REPO_ROOT = join(API_SRC, '..', '..', '..');
const SCAN_ROOTS = [API_SRC, join(REPO_ROOT, 'ee')];

/** The read layer itself. */
const READ_LAYER = 'apps/api/src/services/backupSnapshotIndexEntries.ts';

/**
 * Files exempt from the scan, each with the reason it is safe. Keyed by path
 * relative to the repository root.
 */
const ALLOWLIST: Readonly<Record<string, string>> = {
  [READ_LAYER]: 'The read layer: the one place a snapshot\'s entries are selected.',
  'apps/api/src/db/schema/backup.ts': 'The table definition and its index names.',
  'apps/api/src/services/backupSnapshotFileIndexStatistics.ts':
    'Maintenance, not a read: it calls breeze_analyze_backup_snapshot_files() and names the table in log text.',
};

function listSourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules' || name === 'dist') continue;
      out.push(...listSourceFiles(full));
    } else if (name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** Drops import statements, block comments and `//` comments, keeping line numbers. */
function stripNonCode(source: string): string {
  const blank = (s: string) => s.replace(/[^\n]/g, ' ');
  return source
    .replace(/^\s*import\s[\s\S]*?\sfrom\s+['"][^'"]+['"];?/gm, blank)
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|\s)\/\/[^\n]*/g, (m, lead: string) => lead + blank(m.slice(lead.length)));
}

export interface DirectRead {
  line: number;
  snippet: string;
}

const DRIZZLE_TABLE = /\bbackupSnapshotFiles\b/g;
const RAW_TABLE = /(?<!\w)backup_snapshot_files(?!\w)/gi;
const DRIZZLE_WRITE_BEFORE = /(?:\.(?:insert|update|delete)\(\s*|INSERT\s+INTO\s+\$\{\s*)$/;
const RAW_WRITE_BEFORE = /(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:public\.)?$/i;
const WRITE_TARGET = /\.(?:insert|update|delete)\(\s*backupSnapshotFiles\s*\)/g;
const IMPORT_ALIAS = /^\s*import\s[^;]*?\bbackupSnapshotFiles\s+as\s+\w+/gm;

/** Every mention of the table in `source` that is not a write. */
export function findDirectIndexReads(source: string): DirectRead[] {
  const code = stripNonCode(source);
  const found: DirectRead[] = [];
  const report = (index: number) => {
    const line = code.slice(0, index).split('\n').length;
    found.push({ line, snippet: source.split('\n')[line - 1]!.trim() });
  };
  for (const m of code.matchAll(DRIZZLE_TABLE)) {
    const before = code.slice(Math.max(0, m.index! - 40), m.index!);
    // `backupSnapshotFiles.snapshotDbId` inside a write's own WHERE is part of
    // that write: a delete's filter names the table's columns.
    if (DRIZZLE_WRITE_BEFORE.test(before)) continue;
    if (/^\.\w+/.test(code.slice(m.index! + m[0].length)) && isInsideWriteStatement(code, m.index!)) continue;
    report(m.index!);
  }
  for (const m of code.matchAll(RAW_TABLE)) {
    const before = code.slice(Math.max(0, m.index! - 40), m.index!);
    if (RAW_WRITE_BEFORE.test(before)) continue;
    report(m.index!);
  }
  // An import under another name escapes every check above.
  for (const m of source.matchAll(IMPORT_ALIAS)) {
    report(m.index! + m[0].indexOf('backupSnapshotFiles'));
  }
  return found;
}

/**
 * Whether the column reference at `index` belongs to an insert, update or
 * delete of the table: the nearest preceding write target is this table, and
 * neither a statement boundary (`;`) nor another bare mention of the table
 * lies between them.
 */
function isInsideWriteStatement(code: string, index: number): boolean {
  const head = code.slice(0, index);
  let last: RegExpMatchArray | null = null;
  for (const m of head.matchAll(WRITE_TARGET)) last = m;
  if (!last) return false;
  const between = head.slice(last.index! + last[0].length);
  return !between.includes(';') && !/\bbackupSnapshotFiles\b(?!\.)/.test(between);
}

function scan(): Array<{ file: string; reads: DirectRead[] }> {
  const out: Array<{ file: string; reads: DirectRead[] }> = [];
  for (const root of SCAN_ROOTS) {
    for (const full of listSourceFiles(root)) {
      const rel = relative(REPO_ROOT, full);
      if (ALLOWLIST[rel]) continue;
      const reads = findDirectIndexReads(readFileSync(full, 'utf8'));
      if (reads.length > 0) out.push({ file: rel, reads });
    }
  }
  return out;
}

describe('findDirectIndexReads (detector)', () => {
  it('reports a Drizzle select, a raw FROM and a raw JOIN', () => {
    const source = [
      'const rows = await db.select({ p: backupSnapshotFiles.sourcePath }).from(backupSnapshotFiles);',
      'await db.execute(sql`SELECT 1 FROM backup_snapshot_files WHERE x`);',
      'await db.execute(sql`SELECT 1 FROM s JOIN public.backup_snapshot_files f ON f.snapshot_db_id = s.id`);',
      'const hasRows = sql`EXISTS (SELECT 1 FROM ${backupSnapshotFiles} WHERE 1)`;',
    ].join('\n');
    expect(findDirectIndexReads(source).map((r) => r.line)).toEqual([1, 1, 4, 2, 3]);
  });

  it('accepts writes, imports, comments and longer identifiers', () => {
    const source = [
      "import { backupSnapshotFiles, backupSnapshots } from '../db/schema';",
      'import {',
      '  backupSnapshotFiles,',
      "} from '../db/schema';",
      '// backupSnapshotFiles is read elsewhere; FROM backup_snapshot_files',
      '/* SELECT * FROM backup_snapshot_files */',
      'await db.delete(backupSnapshotFiles).where(eq(backupSnapshotFiles.snapshotDbId, id));',
      'await tx.insert(backupSnapshotFiles).values(rows);',
      'await tx.execute(sql`INSERT INTO ${backupSnapshotFiles} (snapshot_db_id) SELECT 1`);',
      'await tx.execute(sql`DELETE FROM backup_snapshot_files WHERE snapshot_db_id = ${id}`);',
      "await db.execute(sql`SELECT public.breeze_analyze_backup_snapshot_files()`);",
      "const url = 'https://example.test/x'; const n = 1;",
    ].join('\n');
    expect(findDirectIndexReads(source)).toEqual([]);
  });

  it('accepts upserts and updates of the table, and reports raw SQL in any case', () => {
    const source = [
      'await tx.insert(backupSnapshotFiles).values(rows)',
      '  .onConflictDoUpdate({ target: [backupSnapshotFiles.id], set: { size: 1 } })',
      '  .returning({ id: backupSnapshotFiles.id });',
      'await tx.update(backupSnapshotFiles).set({ kind: null }).where(eq(backupSnapshotFiles.id, id));',
      'await tx.execute(sql`UPDATE backup_snapshot_files SET kind = NULL`);',
      'await db.execute(sql`SELECT 1 FROM BACKUP_SNAPSHOT_FILES`);',
    ].join('\n');
    expect(findDirectIndexReads(source).map((r) => r.line)).toEqual([6]);
  });

  it('reports the table imported under another name', () => {
    const source = [
      "import { backupSnapshots, backupSnapshotFiles as files } from '../db/schema';",
      'const rows = await db.select().from(files);',
    ].join('\n');
    expect(findDirectIndexReads(source).map((r) => r.line)).toEqual([1]);
  });

  it('reports a column read that follows a finished delete statement', () => {
    const source = [
      'await db.delete(backupSnapshotFiles).where(eq(backupSnapshotFiles.snapshotDbId, id));',
      'const n = await db.select({ n: count() }).from(x).where(eq(backupSnapshotFiles.snapshotDbId, id));',
    ].join('\n');
    expect(findDirectIndexReads(source).map((r) => r.line)).toEqual([2]);
  });
});

describe('backup_snapshot_files is read only through snapshotIndexEntries (#11736)', () => {
  it('the read layer exists and every allowlisted file still exists', () => {
    for (const rel of Object.keys(ALLOWLIST)) {
      expect(existsSync(join(REPO_ROOT, rel)), rel).toBe(true);
    }
  });

  it('no file outside the read layer reads the table', () => {
    const offenders = scan().flatMap(({ file, reads }) => reads.map((r) => `${file}:${r.line}  ${r.snippet}`));
    expect(
      offenders,
      'Read a snapshot\'s file index through snapshotIndexEntries (services/backupSnapshotIndexEntries.ts). '
      + 'From #11736 step 2 the table holds only differences for an incremental, so a direct read sees a partial tree.',
    ).toEqual([]);
  });
});
