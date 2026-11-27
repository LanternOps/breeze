/**
 * #11736 step 2, plan wave W5: helpers for the checkpoint plus delta
 * measurement run (backupIndexDeltaPerf.acceptance.integration.test.ts).
 *
 * Trees are generated in SQL (generate_series), so a million entries cost one
 * statement, not a million JSON objects. A snapshot is published through the
 * real publisher (publishDeltaIndex) inside a transaction shaped like the
 * hydrator's publish (snapshot row lock, delete, temp table, publish, one
 * publishing update), then its statistics are refreshed the way the hydrator
 * refreshes them. Only the manifest download and parse are left out: those
 * are the same for both formats and the 1.1M acceptance run covers them.
 */
import { performance } from 'node:perf_hooks';
import { sql, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { db, runOutsideDbContext, withDbAccessContext, withSystemDbAccessContext } from '../../../db';
import {
  refreshCheckpointEntriesStatistics,
  refreshSnapshotFileIndexStatistics,
  type StatisticsRefreshOutcome,
} from '../../../services/backupSnapshotFileIndexStatistics';
import {
  createIncomingIndexTable,
  lineageKeyOf,
  publishDeltaIndex,
  type PublishedIndex,
  type Tx,
} from '../../../services/backupSnapshotIndexPublish';
import { orgContext } from '../backupWriteFixtures';
import { getTestDb } from '../setup';

export const ms = (started: number) => Math.round((performance.now() - started) * 10) / 10;

/** Entries per leaf folder; folders sit under 'C:\Data\g<group>' with 10,000 entries per group. */
export const FOLDER_SIZE = 200;

/**
 * One tree of `n` entries. `lastDay` is an SQL expression over the entry
 * number `i` (1…n): the backup day that last wrote that entry, 0 for the first
 * full backup. An entry's object key, size and modification time follow its
 * last day, as an incremental chain's manifest does (an unchanged file keeps
 * the object of the snapshot that uploaded it).
 */
export type TreeSpec = { n: number; lastDay: SQL };

/** No entry changed since the first full backup. */
export const unchanged = sql`0`;

/** Every `every`-th entry was rewritten on `day` (the reader runs' drift: 2 rows per changed file, D1). */
export function changedEvery(every: number, day: number): SQL {
  return every <= 0 ? unchanged : sql`CASE WHEN i % ${every}::int = 0 THEN ${day}::int ELSE 0 END`;
}

/**
 * Daily churn over different files each day: each entry has a pseudo-random
 * slot in 0…999, and day d rewrites the entries whose slot lies in the d-th
 * window of `perMille` slots, so consecutive days never share a file until
 * the windows wrap (every 1000/perMille days: 100 at 1%, 20 at 5%). The last
 * day that touched an entry wins.
 */
export function disjointDailyChurn(perMille: number, day: number): SQL {
  if (day <= 0) return unchanged;
  return sql`coalesce((
    SELECT max(d) FROM generate_series(1, ${day}::int) d
     WHERE (((i::bigint * 2654435761) % 1000) - ((d - 1)::bigint * ${perMille}::int) % 1000 + 1000) % 1000 < ${perMille}::int
  ), 0)`;
}

/** The same hot set (every `every`-th entry) rewritten every day: its last day is always today. */
export function hotSetChurn(every: number, day: number): SQL {
  return sql`CASE WHEN i % ${every}::int = 0 THEN ${day}::int ELSE 0 END`;
}

/** The tree as rows of the index's five columns. */
export function treeSelect(spec: TreeSpec): SQL {
  return sql`
    SELECT 'C:\\Data\\g' || lpad((i / 10000)::text, 3, '0')
             || '\\d' || lpad((i / ${FOLDER_SIZE}::int)::text, 5, '0')
             || '\\document-with-a-realistic-name-' || lpad(i::text, 7, '0') || '.docx' AS source_path,
           'snapshots/snapshot-20261101T000000Z-' || lpad(ld::text, 4, '0')
             || '/files/C/Data/g' || lpad((i / 10000)::text, 3, '0')
             || '/d' || lpad((i / ${FOLDER_SIZE}::int)::text, 5, '0')
             || '/document-with-a-realistic-name-' || lpad(i::text, 7, '0') || '.docx' AS backup_path,
           (i::bigint * 10 + ld) AS size,
           (timestamp '2026-11-01 00:00:00' + ld * interval '1 day') AS modified_at,
           NULL::text AS kind
      FROM (SELECT i, (${spec.lastDay})::int AS ld FROM generate_series(1, ${spec.n}::int) i) t`;
}

/** The source path and object key entry `i` has on `day` (it was last written that day). */
export function entryPaths(i: number, day: number): { sourcePath: string; backupPath: string } {
  const g = String(Math.floor(i / 10000)).padStart(3, '0');
  const d = String(Math.floor(i / FOLDER_SIZE)).padStart(5, '0');
  const name = `document-with-a-realistic-name-${String(i).padStart(7, '0')}.docx`;
  return {
    sourcePath: `C:\\Data\\g${g}\\d${d}\\${name}`,
    backupPath: `snapshots/snapshot-20261101T000000Z-${String(day).padStart(4, '0')}/files/C/Data/g${g}/d${d}/${name}`,
  };
}

export type StatementTiming = { step: string; ms: number };

const dialect = new PgDialect();

/** What each statement the publisher issues is, from its text. */
function stepOf(q: SQL): string {
  const text = dialect.sqlToQuery(q).sql.replace(/\s+/g, ' ');
  const steps: Array<[RegExp, string]> = [
    [/^ANALYZE snapshot_index_incoming/, 'analyze temp table'],
    [/pg_advisory_xact_lock/, 'lineage lock'],
    [/lock_timeout/, 'lock_timeout'],
    [/SELECT org_id, device_id, file_index_checkpoint_id FROM backup_snapshots/, 'owner check'],
    [/FOR KEY SHARE/, 'header read'],
    [/AS unreferenced/, 'bound count'],
    [/tree_n/, 'content check'],
    [/written AS \(/, 'delta write'],
    [/FROM checkpoint c WHERE NOT EXISTS/, 'diff count (tombstones)'],
    [/FROM incoming i WHERE NOT EXISTS/, 'diff count (adds)'],
    [/INSERT INTO backup_tree_checkpoints/, 'checkpoint header insert'],
    [/INSERT INTO backup_tree_checkpoint_entries/, 'checkpoint entries insert'],
    [/INSERT INTO backup_snapshot_files/, 'rows copy (bound)'],
    [/last_referenced_at = now\(\)/, 'header touch'],
  ];
  return steps.find(([re]) => re.test(text))?.[1] ?? text.slice(0, 60);
}

/** `tx`, with every execute() timed into `log`. */
function timedTx(tx: Tx, log: StatementTiming[]): Tx {
  return new Proxy(tx, {
    get(target, prop, receiver) {
      if (prop === 'execute') {
        return async (q: SQL) => {
          const started = performance.now();
          try {
            return await target.execute(q);
          } finally {
            log.push({ step: stepOf(q), ms: ms(started) });
          }
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

export type PublishMode = 'rows' | 'delta';

export type PublishMeasurement = {
  mode: PublishMode;
  /** The format the snapshot was published in ('rows' for a delta publish at the lineage bound). */
  format: 'rows' | 'delta';
  checkpointWritten: boolean;
  /** Rows written to backup_snapshot_files. */
  rowsWritten: number;
  /** Entries written to backup_tree_checkpoint_entries. */
  checkpointEntriesWritten: number;
  /** Time to load the manifest's entries (temp table for delta, the snapshot's rows for rows). */
  loadMs: number;
  /** publishDeltaIndex alone (delta only). */
  publisherMs: number;
  /** The whole publish transaction, commit included. */
  transactionMs: number;
  /** The statistics refresh after commit, as the hydrator runs it. */
  statisticsMs: number;
  statistics: { snapshotFiles: StatisticsRefreshOutcome; checkpointEntries: StatisticsRefreshOutcome | null };
  statements: StatementTiming[];
  result: PublishedIndex | null;
};

type PublishCore = { loadMs: number; publisherMs: number; result: PublishedIndex | null; rowsInserted: number };

/**
 * The hydrator's publish, inside the caller's transaction: snapshot row locked
 * first, previous rows deleted, then 'rows' (straight into
 * backup_snapshot_files) or 'delta' (temp table, then publishDeltaIndex), then
 * one publishing update. The caller runs it in system scope, as the hydrator
 * does.
 */
async function publishInTransaction(
  tx: Tx,
  snapshotDbId: string,
  tree: TreeSpec,
  mode: PublishMode,
  statements: StatementTiming[],
  jit: 'default' | 'off' = 'default',
): Promise<PublishCore> {
  // Transaction-local: the comparison for the JIT finding.
  if (jit === 'off') await tx.execute(sql`SELECT set_config('jit', 'off', true)`);
  const digest = `${'f'.repeat(56)}${String(tree.n).padStart(8, '0')}`;
  let loadMs = 0;
  let publisherMs = 0;
  let result: PublishedIndex | null = null;
  let rowsInserted = 0;
  const [current] = (await tx.execute(sql`
    SELECT org_id, device_id, config_id, storage_identity, backup_type, key_layout, key_prefix
      FROM backup_snapshots WHERE id = ${snapshotDbId}::uuid FOR UPDATE
  `)) as unknown as Array<{
    org_id: string; device_id: string; config_id: string | null; storage_identity: string | null;
    backup_type: string | null; key_layout: string; key_prefix: string | null;
  }>;
  if (!current) throw new Error(`snapshot ${snapshotDbId} not found`);
  await tx.execute(sql`DELETE FROM backup_snapshot_files WHERE snapshot_db_id = ${snapshotDbId}::uuid`);
  const loadStarted = performance.now();
  if (mode === 'rows') {
    const inserted = (await tx.execute(sql`
      WITH ins AS (
        INSERT INTO backup_snapshot_files (snapshot_db_id, source_path, backup_path, size, modified_at, kind)
        SELECT ${snapshotDbId}::uuid, t.source_path, t.backup_path, t.size, t.modified_at, t.kind FROM (${treeSelect(tree)}) t
        RETURNING 1
      ) SELECT count(*)::int AS n FROM ins
    `)) as unknown as Array<{ n: number }>;
    rowsInserted = inserted[0]!.n;
    loadMs = ms(loadStarted);
  } else {
    await createIncomingIndexTable(tx);
    await tx.execute(sql`
      INSERT INTO snapshot_index_incoming (source_path, backup_path, size, modified_at, kind)
      SELECT t.source_path, t.backup_path, t.size, t.modified_at, t.kind FROM (${treeSelect(tree)}) t
    `);
    loadMs = ms(loadStarted);
    const lineage = lineageKeyOf({
      orgId: current.org_id,
      deviceId: current.device_id,
      configId: current.config_id,
      storageIdentity: current.storage_identity,
      backupType: current.backup_type,
      keyLayout: current.key_layout,
      keyPrefix: current.key_prefix,
    });
    if (!lineage) throw new Error(`snapshot ${snapshotDbId} has no lineage key`);
    const publishStarted = performance.now();
    result = await publishDeltaIndex(timedTx(tx, statements), {
      snapshotDbId, lineage, manifestSha256: digest, eligibleEntries: tree.n,
    });
    publisherMs = ms(publishStarted);
  }
  const published = result?.format === 'delta' ? result : null;
  await tx.execute(sql`
    UPDATE backup_snapshots
       SET file_index_status = 'complete', file_index_manifest_sha256 = ${digest},
           file_index_hydrated_at = now(), file_index_error = NULL,
           file_index_format = ${published ? 'delta' : 'rows'},
           file_index_checkpoint_id = ${published ? published.checkpointId : null}::uuid
     WHERE id = ${snapshotDbId}::uuid
  `);
  return { loadMs, publisherMs, result, rowsInserted };
}

/** Publishes `tree` as `snapshotDbId`'s complete index (publishInTransaction), commits, refreshes statistics. */
export async function publishTree(
  snapshotDbId: string,
  tree: TreeSpec,
  mode: PublishMode,
  opts: { jit?: 'default' | 'off' } = {},
): Promise<PublishMeasurement> {
  const statements: StatementTiming[] = [];
  const started = performance.now();
  const core = await runOutsideDbContext(() => withSystemDbAccessContext(() => db.transaction(
    (tx) => publishInTransaction(tx, snapshotDbId, tree, mode, statements, opts.jit ?? 'default'),
  )));
  const transactionMs = ms(started);
  const published = core.result;
  const delta = published?.format === 'delta' ? published : null;
  const rowsWritten = mode === 'rows'
    ? core.rowsInserted
    : delta ? delta.adds + delta.tombstones : (published?.format === 'rows' ? published.rows : 0);
  const checkpointEntriesWritten = delta?.checkpointWritten ? delta.checkpointEntries : 0;
  const statsStarted = performance.now();
  const snapshotFiles = await refreshSnapshotFileIndexStatistics(rowsWritten);
  const checkpointEntries = checkpointEntriesWritten > 0 ? await refreshCheckpointEntriesStatistics(checkpointEntriesWritten) : null;
  return {
    mode,
    format: delta ? 'delta' : 'rows',
    checkpointWritten: !!delta?.checkpointWritten,
    rowsWritten,
    checkpointEntriesWritten,
    loadMs: core.loadMs,
    publisherMs: core.publisherMs,
    transactionMs,
    statisticsMs: ms(statsStarted),
    statistics: { snapshotFiles, checkpointEntries },
    statements,
    result: published,
  };
}

export type HeldOutcome =
  | { ok: true; totalMs: number; commitMs: number }
  | { ok: false; totalMs: number; code: string | null; message: string };

/**
 * A delta publish that stops before its commit until release() is called (or
 * for `sleepSeconds`), so another session can be lined up against the locks
 * it holds. `started`
 * resolves with its backend pid as soon as its transaction is open; `ready`
 * once the publish has run and only the commit is left (never, while the
 * publish waits on a lock).
 */
export function heldPublish(snapshotDbId: string, tree: TreeSpec, opts: { sleepSeconds?: number } = {}): {
  started: Promise<number>;
  ready: Promise<number>;
  release: () => void;
  done: Promise<HeldOutcome>;
} {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let signalReady!: (pid: number) => void;
  const ready = new Promise<number>((r) => { signalReady = r; });
  let signalStarted!: (pid: number) => void;
  const started = new Promise<number>((r) => { signalStarted = r; });
  const begun = performance.now();
  let releasedAt = performance.now();
  const done = (async (): Promise<HeldOutcome> => {
    try {
      await runOutsideDbContext(() => withSystemDbAccessContext(() => db.transaction(async (tx) => {
        const [row] = (await tx.execute(sql`SELECT pg_backend_pid() AS pid`)) as unknown as Array<{ pid: number }>;
        signalStarted(row!.pid);
        await publishInTransaction(tx, snapshotDbId, tree, 'delta', []);
        signalReady(row!.pid);
        // Held either idle until release(), or active for sleepSeconds (as a
        // long publish is; an idle transaction would be ended by
        // idle_in_transaction_session_timeout first).
        if (opts.sleepSeconds) await tx.execute(sql`SELECT pg_sleep(${opts.sleepSeconds})`);
        else await gate;
        releasedAt = performance.now();
      })));
      return { ok: true, totalMs: ms(begun), commitMs: ms(releasedAt) };
    } catch (err) {
      return { ok: false, totalMs: ms(begun), code: sqlStateOf(err), message: err instanceof Error ? err.message.slice(0, 300) : String(err) };
    }
  })();
  return { started, ready, release, done };
}

/** The SQLSTATE of a postgres.js or drizzle error, walking `cause`. */
export function sqlStateOf(err: unknown): string | null {
  let cur: unknown = err;
  for (let i = 0; i < 5 && cur && typeof cur === 'object'; i++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return null;
}

/** Waits until backend `pid` is blocked on a lock (pg_stat_activity), up to `timeoutMs`. */
export async function waitUntilBlocked(pid: number, timeoutMs = 15_000): Promise<{ waitEvent: string | null }> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const [row] = (await getTestDb().execute(sql`
      SELECT wait_event_type, wait_event FROM pg_stat_activity WHERE pid = ${pid}
    `)) as unknown as Array<{ wait_event_type: string | null; wait_event: string | null }>;
    if (row?.wait_event_type === 'Lock') return { waitEvent: row.wait_event };
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`backend ${pid} did not block on a lock within ${timeoutMs} ms`);
}

/**
 * Runs `fn` as the snapshot org's request would: breeze_app under RLS. With
 * `jit: 'off'`, the request transaction runs with jit off (transaction-local,
 * inherited by the readers' savepoints): the comparison for the JIT finding.
 */
export function asOrg<T>(orgId: string, fn: () => Promise<T>, opts: PlanSettings = {}): Promise<T> {
  return runOutsideDbContext(() => withDbAccessContext(orgContext(orgId), async () => {
    if (opts.jit === 'off') await db.execute(sql`SELECT set_config('jit', 'off', true)`);
    if (opts.sort === 'off') await db.execute(sql`SELECT set_config('enable_sort', 'off', true)`);
    return fn();
  }));
}

/**
 * Settings a statement is planned under: JIT as the server has it or off, and
 * sorts on or off (a selection page runs with both off, withSelectionPagePlan).
 */
export type PlanSettings = { jit?: 'default' | 'off'; sort?: 'default' | 'off' };

export type Timed<T> = { firstMs: number; medianMs: number; runs: number; result: T | null; error: string | null };

/**
 * `runs` timings of `fn`: the first (coldest) and the median. An error is
 * recorded, not thrown, so the report still carries every other figure; the
 * caller asserts that no reading has one (measureReaders' `errors`).
 */
export async function timedRuns<T>(fn: () => Promise<T>, runs = 3): Promise<Timed<T>> {
  const times: number[] = [];
  let result: T | null = null;
  for (let r = 0; r < runs; r++) {
    const started = performance.now();
    try {
      result = await fn();
    } catch (err) {
      // No result on an error, so an earlier run's answer cannot pass a correctness check.
      return { firstMs: times[0] ?? ms(started), medianMs: NaN, runs: r + 1, result: null, error: err instanceof Error ? err.message.slice(0, 200) : String(err) };
    }
    times.push(ms(started));
  }
  const sorted = [...times].sort((a, b) => a - b);
  return { firstMs: times[0]!, medianMs: sorted[Math.floor(sorted.length / 2)]!, runs, result, error: null };
}

type AnalyzedNode = {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  Alias?: string;
  'Actual Rows'?: number;
  'Actual Loops'?: number;
  'Actual Total Time'?: number;
  'Plan Rows'?: number;
  'Total Cost'?: number;
  'Sort Method'?: string;
  'Sort Space Used'?: number;
  'Sort Space Type'?: string;
  'Shared Hit Blocks'?: number;
  'Shared Read Blocks'?: number;
  'Temp Read Blocks'?: number;
  'Temp Written Blocks'?: number;
  'Subplan Name'?: string;
  Plans?: AnalyzedNode[];
};

type JitInfo = { Functions?: number; Timing?: { Total?: number } };

export type PlanSummary = {
  executionMs: number;
  planningMs: number;
  /** JIT compilation inside executionMs: functions compiled and total ms; null when the statement was not JIT-compiled. */
  jit: { functions: number; totalMs: number } | null;
  /** The planner's total cost of the top node, which jit_above_cost is compared with. */
  totalCost: number;
  sharedHit: number;
  sharedRead: number;
  tempBlocks: number;
  /** A Sort sits above the checkpoint entries scan (sie_entry): the read-all-then-sort shape. */
  entriesUnderSort: boolean;
  /** Rows the checkpoint entries scan returned, and the planner's estimate. */
  entriesScan: { node: string; index: string | null; actualRows: number; planRows: number } | null;
  sorts: Array<{ method: string; spaceKb: number; type: string; rows: number }>;
  /** One line per node: type, alias, index, actual rows. */
  shape: string[];
};

function summarizePlan(root: AnalyzedNode, executionMs: number, planningMs: number, jit?: JitInfo): PlanSummary {
  const shape: string[] = [];
  const sorts: PlanSummary['sorts'] = [];
  let entriesScan: PlanSummary['entriesScan'] = null;
  let entriesUnderSort = false;
  const walk = (node: AnalyzedNode, depth: number, underSort: boolean) => {
    const isSort = node['Node Type'] === 'Sort' || node['Node Type'] === 'Incremental Sort';
    if (isSort) {
      sorts.push({ method: node['Sort Method'] ?? '?', spaceKb: node['Sort Space Used'] ?? 0, type: node['Sort Space Type'] ?? '?', rows: node['Actual Rows'] ?? 0 });
    }
    if (node.Alias === 'sie_entry' && /Scan/.test(node['Node Type'])) {
      const actual = (node['Actual Rows'] ?? 0) * (node['Actual Loops'] ?? 1);
      if (!entriesScan || actual > entriesScan.actualRows) {
        entriesScan = { node: node['Node Type'], index: node['Index Name'] ?? null, actualRows: actual, planRows: node['Plan Rows'] ?? 0 };
      }
      if (underSort) entriesUnderSort = true;
    }
    shape.push(`${'  '.repeat(depth)}${node['Node Type']}${node.Alias ? ` ${node.Alias}` : ''}${node['Index Name'] ? ` [${node['Index Name']}]` : ''}`
      + ` rows=${node['Actual Rows'] ?? '?'}x${node['Actual Loops'] ?? '?'} est=${node['Plan Rows'] ?? '?'}`);
    for (const child of node.Plans ?? []) walk(child, depth + 1, underSort || isSort);
  };
  walk(root, 0, false);
  return {
    executionMs: Math.round(executionMs * 10) / 10,
    planningMs: Math.round(planningMs * 10) / 10,
    jit: jit ? { functions: jit.Functions ?? 0, totalMs: Math.round((jit.Timing?.Total ?? 0) * 10) / 10 } : null,
    totalCost: root['Total Cost'] ?? 0,
    sharedHit: root['Shared Hit Blocks'] ?? 0,
    sharedRead: root['Shared Read Blocks'] ?? 0,
    tempBlocks: (root['Temp Read Blocks'] ?? 0) + (root['Temp Written Blocks'] ?? 0),
    entriesUnderSort,
    entriesScan,
    sorts,
    shape,
  };
}

/** EXPLAIN (ANALYZE, BUFFERS) of `statement` in the org's request context (breeze_app, RLS on). */
export async function explainAnalyze(orgId: string, statement: { getSQL(): SQL }, opts: PlanSettings = {}): Promise<PlanSummary> {
  return asOrg(orgId, async () => {
    const rows = (await db.execute(sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement.getSQL()}`)) as unknown as Array<{
      'QUERY PLAN': Array<{ Plan: AnalyzedNode; 'Execution Time': number; 'Planning Time': number; JIT?: JitInfo }>;
    }>;
    const out = rows[0]!['QUERY PLAN'][0]!;
    return summarizePlan(out.Plan, out['Execution Time'], out['Planning Time'], out.JIT);
  }, opts);
}

/** EXPLAIN (ANALYZE, BUFFERS) of raw SQL on the admin connection (no RLS); for statements outside a reader. */
export async function explainAnalyzeAdmin(statement: SQL): Promise<PlanSummary> {
  const rows = (await getTestDb().execute(sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement}`)) as unknown as Array<{
    'QUERY PLAN': Array<{ Plan: AnalyzedNode; 'Execution Time': number; 'Planning Time': number; JIT?: JitInfo }>;
  }>;
  const out = rows[0]!['QUERY PLAN'][0]!;
  return summarizePlan(out.Plan, out['Execution Time'], out['Planning Time'], out.JIT);
}

export type RelationBytes = { totalBytes: number; heapBytes: number; indexBytes: number; toastBytes: number; liveRows: number };

/** On-disk size of each table (heap, indexes, TOAST) and its exact row count. */
export async function relationBytes(tables: string[]): Promise<Record<string, RelationBytes>> {
  const out: Record<string, RelationBytes> = {};
  for (const table of tables) {
    const [row] = (await getTestDb().execute(sql`
      SELECT pg_total_relation_size(${table}::regclass)::bigint AS total,
             pg_relation_size(${table}::regclass)::bigint AS heap,
             pg_indexes_size(${table}::regclass)::bigint AS idx,
             coalesce(pg_total_relation_size(nullif(c.reltoastrelid, 0)), 0)::bigint AS toast,
             (SELECT count(*) FROM ${sql.identifier(table)})::bigint AS live
        FROM pg_class c WHERE c.oid = ${table}::regclass
    `)) as unknown as Array<{ total: string; heap: string; idx: string; toast: string; live: string }>;
    out[table] = {
      totalBytes: Number(row!.total), heapBytes: Number(row!.heap), indexBytes: Number(row!.idx),
      toastBytes: Number(row!.toast), liveRows: Number(row!.live),
    };
  }
  return out;
}

/** VACUUM (as the table owner): what autovacuum would do after a large delete. Timed. */
export async function vacuum(table: string): Promise<number> {
  const started = performance.now();
  await getTestDb().execute(sql.raw(`VACUUM ${table}`));
  return ms(started);
}

/** The settings that shape these numbers, read from the server measured. */
export async function serverSettings(): Promise<Record<string, string>> {
  const rows = (await getTestDb().execute(sql`
    SELECT name, setting || coalesce(unit, '') AS value FROM pg_settings
     WHERE name IN ('server_version', 'work_mem', 'shared_buffers', 'effective_cache_size', 'maintenance_work_mem',
                    'random_page_cost', 'max_parallel_workers_per_gather', 'jit', 'fsync', 'synchronous_commit',
                    'full_page_writes', 'deadlock_timeout', 'autovacuum', 'default_statistics_target')
     ORDER BY name
  `)) as unknown as Array<{ name: string; value: string }>;
  return Object.fromEntries(rows.map((r) => [r.name, r.value]));
}

/**
 * Database-wide buffer counters. Another backend flushes its counters at most
 * once a second while busy and within about ten seconds once idle
 * (Postgres 15 and later), so this waits that long first.
 */
export async function databaseBlocks(): Promise<{ hit: number; read: number }> {
  const admin = getTestDb();
  await new Promise((r) => setTimeout(r, 11_000));
  await admin.execute(sql`SELECT pg_stat_force_next_flush()`).catch(() => undefined);
  const [row] = (await admin.execute(sql`
    SELECT blks_hit::bigint AS hit, blks_read::bigint AS read FROM pg_stat_database WHERE datname = current_database()
  `)) as unknown as Array<{ hit: string; read: string }>;
  return { hit: Number(row!.hit), read: Number(row!.read) };
}
