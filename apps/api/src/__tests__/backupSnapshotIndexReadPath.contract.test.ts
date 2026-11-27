/**
 * #11736 step 1: every read of a snapshot's file index goes through one source,
 * `snapshotIndexEntries` in services/backupSnapshotIndexEntries.ts.
 *
 * Today a snapshot's tree is its own `backup_snapshot_files` rows. Step 2 stores
 * an incremental as differences against a shared checkpoint, whose entries are
 * in `backup_tree_checkpoint_entries`. From then on a reader that queries
 * either table directly sees only part of the tree: a browse that lists a
 * fraction of it, or, worse, a membership check that authorizes a checkpoint
 * key the snapshot has since replaced or deleted. So no file outside the layer
 * may read either table. Writers (the inline-result persistence, the
 * hydrator's publish, checkpoint GC) and the schema definition are allowed.
 *
 * Static scan of every non-test .ts file under apps/api/src and ee/. After
 * import statements and comments are dropped, each remaining mention of a
 * Drizzle table (`backupSnapshotFiles`, `backupTreeCheckpointEntries`) must be
 * the target of `.insert(`, `.update(`, `.delete(` or `INSERT INTO ${…}`, or a
 * column of that table named inside that same write statement (its WHERE, SET,
 * conflict target or RETURNING). Each raw-SQL mention (`backup_snapshot_files`,
 * `backup_tree_checkpoint_entries`, any case) must follow `INSERT INTO`,
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
  'apps/api/src/services/backupSnapshotIndexPublish.ts':
    'The writer (#11736 step 2). It reads checkpoint entries only to diff a verified manifest against them, '
    + 'inside the publish transaction under the lineage lock, and writes the delta or a new checkpoint. '
    + 'It never serves a snapshot\'s tree to a caller.',
  // Checkpoint GC (services/backupTreeCheckpointGc.ts) is not listed: it
  // deletes headers and their entries go by ON DELETE CASCADE, so it names
  // neither table. The "still needs its entry" check below keeps it that way.
};

/**
 * Files exempted by path before they exist, so a wave can pre-allow the
 * writer the next wave adds without that wave editing this contract. Empty
 * now: #11736 step 2's publisher has landed and is in ALLOWLIST. A check
 * below fails once a pending file exists, so an entry cannot outlive its
 * reason.
 */
const PENDING_ALLOWLIST: Readonly<Record<string, string>> = {};

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

const DRIZZLE_WRITE_BEFORE = /(?:\.(?:insert|update|delete)\(\s*|INSERT\s+INTO\s+\$\{\s*)$/;
const RAW_WRITE_BEFORE = /(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:public\.)?$/i;

/** The tables that hold a snapshot's file index, by Drizzle export name and SQL name. */
const INDEX_TABLES = [
  { drizzle: 'backupSnapshotFiles', raw: 'backup_snapshot_files' },
  { drizzle: 'backupTreeCheckpointEntries', raw: 'backup_tree_checkpoint_entries' },
] as const;

interface TablePatterns {
  drizzle: string;
  drizzleTable: RegExp;
  bareMention: RegExp;
  rawTable: RegExp;
  writeTarget: RegExp;
  importAlias: RegExp;
}

const TABLE_PATTERNS: TablePatterns[] = INDEX_TABLES.map(({ drizzle, raw }) => ({
  drizzle,
  drizzleTable: new RegExp(`\\b${drizzle}\\b`, 'g'),
  bareMention: new RegExp(`\\b${drizzle}\\b(?!\\.)`),
  rawTable: new RegExp(`(?<!\\w)${raw}(?!\\w)`, 'gi'),
  writeTarget: new RegExp(`\\.(?:insert|update|delete)\\(\\s*${drizzle}\\s*\\)`, 'g'),
  importAlias: new RegExp(`^\\s*import\\s[^;]*?\\b${drizzle}\\s+as\\s+\\w+`, 'gm'),
}));

/** Every mention of an index table in `source` that is not a write. */
export function findDirectIndexReads(source: string): DirectRead[] {
  const code = stripNonCode(source);
  const found: DirectRead[] = [];
  const report = (index: number) => {
    const line = code.slice(0, index).split('\n').length;
    found.push({ line, snippet: source.split('\n')[line - 1]!.trim() });
  };
  for (const table of TABLE_PATTERNS) {
    for (const m of code.matchAll(table.drizzleTable)) {
      const before = code.slice(Math.max(0, m.index! - 40), m.index!);
      // `backupSnapshotFiles.snapshotDbId` inside a write's own WHERE is part of
      // that write: a delete's filter names the table's columns.
      if (DRIZZLE_WRITE_BEFORE.test(before)) continue;
      if (/^\.\w+/.test(code.slice(m.index! + m[0].length)) && isInsideWriteStatement(code, m.index!, table)) continue;
      report(m.index!);
    }
    for (const m of code.matchAll(table.rawTable)) {
      const before = code.slice(Math.max(0, m.index! - 40), m.index!);
      if (RAW_WRITE_BEFORE.test(before)) continue;
      report(m.index!);
    }
    // An import under another name escapes every check above.
    for (const m of source.matchAll(table.importAlias)) {
      report(m.index! + m[0].indexOf(table.drizzle));
    }
  }
  return found;
}

/**
 * Whether the column reference at `index` belongs to an insert, update or
 * delete of `table`: the nearest preceding write target is that table, and
 * neither a statement boundary (`;`) nor another bare mention of the table
 * lies between them. A write to a different table does not exempt it.
 */
function isInsideWriteStatement(code: string, index: number, table: TablePatterns): boolean {
  const head = code.slice(0, index);
  let last: RegExpMatchArray | null = null;
  for (const m of head.matchAll(table.writeTarget)) last = m;
  if (!last) return false;
  const between = head.slice(last.index! + last[0].length);
  return !between.includes(';') && !table.bareMention.test(between);
}

function scan(): Array<{ file: string; reads: DirectRead[] }> {
  const out: Array<{ file: string; reads: DirectRead[] }> = [];
  for (const root of SCAN_ROOTS) {
    for (const full of listSourceFiles(root)) {
      const rel = relative(REPO_ROOT, full);
      if (ALLOWLIST[rel] || PENDING_ALLOWLIST[rel]) continue;
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

  it('reports a Drizzle select and a raw JOIN of the checkpoint entries table, in any case', () => {
    const source = [
      'const rows = await db.select({ p: backupTreeCheckpointEntries.sourcePath }).from(backupTreeCheckpointEntries);',
      'await db.execute(sql`SELECT 1 FROM s JOIN backup_tree_checkpoint_entries e ON e.checkpoint_id = s.id`);',
      'await db.execute(sql`SELECT 1 FROM s JOIN public.backup_tree_checkpoint_entries e ON e.checkpoint_id = s.id`);',
      'await db.execute(sql`SELECT 1 FROM s JOIN BACKUP_TREE_CHECKPOINT_ENTRIES e ON e.checkpoint_id = s.id`);',
    ].join('\n');
    expect(findDirectIndexReads(source).map((r) => r.line)).toEqual([1, 1, 2, 3, 4]);
  });

  it('accepts writes to, imports of and longer identifiers around the checkpoint entries table', () => {
    const source = [
      "import { backupTreeCheckpointEntries } from '../db/schema';",
      '// backupTreeCheckpointEntries is read elsewhere; FROM backup_tree_checkpoint_entries',
      '/* SELECT * FROM backup_tree_checkpoint_entries */',
      'await tx.insert(backupTreeCheckpointEntries).values(rows);',
      'await tx.delete(backupTreeCheckpointEntries).where(eq(backupTreeCheckpointEntries.checkpointId, id));',
      'await tx.execute(sql`INSERT INTO backup_tree_checkpoint_entries (checkpoint_id) SELECT 1`);',
      'await tx.execute(sql`DELETE FROM backup_tree_checkpoint_entries WHERE checkpoint_id = ${id}`);',
      'await db.execute(sql`SELECT public.breeze_analyze_backup_tree_checkpoint_entries()`);',
    ].join('\n');
    expect(findDirectIndexReads(source)).toEqual([]);
  });

  it('reports the checkpoint entries table imported under another name', () => {
    const source = [
      "import { backupTreeCheckpointEntries as e } from '../db/schema';",
      'const rows = await db.select().from(e);',
    ].join('\n');
    expect(findDirectIndexReads(source).map((r) => r.line)).toEqual([1]);
  });

  it('exempts a column reference only inside a write to the same table', () => {
    const source = [
      'await tx.insert(backupSnapshotFiles).values(rows)',
      '  .returning({ p: backupTreeCheckpointEntries.sourcePath });',
    ].join('\n');
    expect(findDirectIndexReads(source).map((r) => r.line)).toEqual([2]);
  });
});

describe('a snapshot\'s file index tables are read only through snapshotIndexEntries (#11736)', () => {
  it('the read layer exists and every allowlisted file still exists', () => {
    for (const rel of Object.keys(ALLOWLIST)) {
      expect(existsSync(join(REPO_ROOT, rel)), rel).toBe(true);
    }
  });

  it('every allowlisted file still needs its entry: without it, the scan would report the file', () => {
    const unneeded = Object.keys(ALLOWLIST)
      .filter((rel) => findDirectIndexReads(readFileSync(join(REPO_ROOT, rel), 'utf8')).length === 0);
    expect(unneeded, 'Drop these entries: an exemption a file does not need would hide its next direct read.').toEqual([]);
  });

  it('a pending entry names a file that does not exist yet', () => {
    const landed = Object.keys(PENDING_ALLOWLIST).filter((rel) => existsSync(join(REPO_ROOT, rel)));
    expect(landed, 'Move these entries to ALLOWLIST, with the reason each file may name the tables.').toEqual([]);
  });

  it('no file outside the read layer reads either table', () => {
    const offenders = scan().flatMap(({ file, reads }) => reads.map((r) => `${file}:${r.line}  ${r.snippet}`));
    expect(
      offenders,
      'Read a snapshot\'s file index through snapshotIndexEntries (services/backupSnapshotIndexEntries.ts). '
      + 'From #11736 step 2 backup_snapshot_files holds only differences for an incremental, and the rest lives in the '
      + 'shared checkpoint\'s backup_tree_checkpoint_entries, so a direct read of either table sees a partial tree.',
    ).toEqual([]);
  });
});
