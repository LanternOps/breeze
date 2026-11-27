import { describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  CHECKPOINT_MAX_UNREFERENCED_PER_LINEAGE,
  CHECKPOINT_REBASE_RATIO,
  LINEAGE_LOCK_TIMEOUT_MS,
  exceedsRebase,
  lineageKeyOf,
  lineageLockKey,
  loadIncomingBatch,
  publishDeltaIndex,
  type LineageKey,
  type Tx,
} from './backupSnapshotIndexPublish';

const dialect = new PgDialect();
const render = (q: SQL) => dialect.sqlToQuery(q);

const ORG = '11111111-1111-4111-8111-111111111111';
const DEVICE = '22222222-2222-4222-8222-222222222222';
const CONFIG = '33333333-3333-4333-8333-333333333333';
const SNAPSHOT = '44444444-4444-4444-8444-444444444444';
const HEADER = '55555555-5555-4555-8555-555555555555';
const OWN = '77777777-7777-4777-8777-777777777777';

const snapshotFields = {
  orgId: ORG,
  deviceId: DEVICE,
  configId: CONFIG,
  storageIdentity: 's3::bucket',
  backupType: 'file',
  keyLayout: 'legacy_flat',
  keyPrefix: null as string | null,
};

const LINEAGE: LineageKey = lineageKeyOf(snapshotFields)!;

describe('lineageKeyOf (R5)', () => {
  it.each(['configId', 'storageIdentity', 'backupType'] as const)('returns null when %s is missing', (field) => {
    expect(lineageKeyOf({ ...snapshotFields, [field]: null })).toBeNull();
  });

  it('returns null for an empty storage identity', () => {
    expect(lineageKeyOf({ ...snapshotFields, storageIdentity: '' })).toBeNull();
  });

  it('keys on every part, key root and backup type included', () => {
    expect(LINEAGE).toEqual({ ...snapshotFields });
    const variants: Array<Partial<typeof snapshotFields>> = [
      { orgId: '66666666-6666-4666-8666-666666666666' },
      { deviceId: '66666666-6666-4666-8666-666666666666' },
      { configId: '66666666-6666-4666-8666-666666666666' },
      { storageIdentity: 's3::other' },
      { backupType: 'database' },
      { keyLayout: 'prefixed_flat', keyPrefix: 'tenant-a' },
      { keyLayout: 'prefixed_flat', keyPrefix: 'tenant-b' },
    ];
    const keys = new Set([lineageLockKey(LINEAGE)]);
    for (const v of variants) keys.add(lineageLockKey(lineageKeyOf({ ...snapshotFields, ...v })!));
    expect(keys.size).toBe(variants.length + 1);
  });

  it('a NULL key prefix and an empty one are different lineages', () => {
    expect(lineageLockKey(lineageKeyOf({ ...snapshotFields, keyPrefix: '' })!)).not.toBe(lineageLockKey(LINEAGE));
  });
});

describe('exceedsRebase (D4)', () => {
  it('rebase threshold: 5% of 10,000 is 500; 501 changes write a new checkpoint', () => {
    expect(CHECKPOINT_REBASE_RATIO).toBe(0.05);
    expect(exceedsRebase(250, 250, 10_000)).toBe(false);
    expect(exceedsRebase(251, 250, 10_000)).toBe(true);
    expect(exceedsRebase(0, 501, 10_000)).toBe(true);
  });

  it('rounds the threshold up', () => {
    // ceil(0.05 * 30) = 2
    expect(exceedsRebase(1, 1, 30)).toBe(false);
    expect(exceedsRebase(2, 1, 30)).toBe(true);
  });

  it('an empty checkpoint is rebased on any change, and kept when nothing changed', () => {
    expect(exceedsRebase(0, 0, 0)).toBe(false);
    expect(exceedsRebase(1, 0, 0)).toBe(true);
  });
});

/**
 * A transaction that answers each statement by what it is. Every answer is
 * the shape postgres-js returns: an array of rows with a `count`.
 */
function fakeTx(opts: {
  snapshot?: { org_id: string; device_id: string; file_index_checkpoint_id?: string | null } | null;
  header?: { id: string; entry_count: number } | null;
  /** The snapshot's own checkpoint, as the lineage-checked read of its pointer answers it. */
  own?: { id: string; entry_count: number } | null;
  adds?: number;
  tombstones?: number;
  /** Per checkpoint id: the diff's counts against that checkpoint (else adds / tombstones). */
  diffs?: Record<string, { adds: number; tombstones: number }>;
  /** The lineage's headers no snapshot references. */
  unreferenced?: number;
  /** Rows the rows-format fallback copies from the temp table. */
  rowsInserted?: number;
  written?: { adds: number; tombstones: number; misnamed?: number };
  checkpointEntriesInserted?: number;
  /** The content check's answer; by default the rebuilt tree equals the manifest. */
  digests?: { tree_n: number; tree_h: string; manifest_n: number; manifest_h: string };
}) {
  const statements: string[] = [];
  const params: unknown[][] = [];
  const rows = <T,>(r: T[], count = r.length) => Object.assign(r, { count });
  const execute = vi.fn(async (q: SQL) => {
    const { sql: text, params: p } = render(q);
    statements.push(text);
    params.push(p);
    if (/^\s*SELECT org_id, device_id, file_index_checkpoint_id FROM backup_snapshots/.test(text)) {
      return rows(opts.snapshot === null ? [] : [{ org_id: ORG, device_id: DEVICE, file_index_checkpoint_id: null, ...opts.snapshot }]);
    }
    if (/FROM backup_tree_checkpoints\s+WHERE id = \$\d+::uuid[\s\S]*FOR KEY SHARE/.test(text)) return rows(opts.own ? [opts.own] : []);
    if (/FROM backup_tree_checkpoints\b[\s\S]*FOR KEY SHARE/.test(text)) return rows(opts.header ? [opts.header] : []);
    // A count stops at its LIMIT (the last parameter), as Postgres would. The checkpoint is the first parameter.
    const diff = opts.diffs?.[String(p[0])] ?? { adds: opts.adds ?? 0, tombstones: opts.tombstones ?? 0 };
    if (/AS n FROM \(\s*SELECT 1 FROM incoming i WHERE NOT EXISTS/.test(text)) return rows([{ n: Math.min(diff.adds, Number(p.at(-1))) }]);
    if (/AS n FROM \(\s*SELECT 1 FROM checkpoint c WHERE NOT EXISTS/.test(text)) return rows([{ n: Math.min(diff.tombstones, Number(p.at(-1))) }]);
    if (/AS unreferenced/.test(text)) return rows([{ unreferenced: Math.min(opts.unreferenced ?? 0, Number(p.at(-1))) }]);
    if (/INSERT INTO backup_tree_checkpoints\b/.test(text)) return rows([{ id: 'new-header' }]);
    if (/INSERT INTO backup_tree_checkpoint_entries/.test(text)) return rows([], opts.checkpointEntriesInserted ?? 0);
    if (/INSERT INTO backup_snapshot_files[\s\S]*FROM snapshot_index_incoming/.test(text)) return rows([], opts.rowsInserted ?? 0);
    if (/INSERT INTO backup_snapshot_files/.test(text)) {
      return rows([opts.written ?? { adds: opts.adds ?? 0, tombstones: opts.tombstones ?? 0 }]);
    }
    if (/AS tree_n/.test(text)) {
      return rows([opts.digests ?? { tree_n: 3, tree_h: '-42', manifest_n: 3, manifest_h: '-42' }]);
    }
    return rows([]);
  });
  return { tx: { execute } as unknown as Tx, statements, params };
}

const args = (eligibleEntries: number) => ({
  snapshotDbId: SNAPSHOT,
  lineage: LINEAGE,
  manifestSha256: 'a'.repeat(64),
  eligibleEntries,
});

describe('publishDeltaIndex', () => {
  it('writes a new checkpoint when the lineage has none', async () => {
    const { tx, statements } = fakeTx({ header: null, checkpointEntriesInserted: 7 });

    const published = await publishDeltaIndex(tx, args(7));

    expect(published).toEqual({
      format: 'delta', checkpointId: 'new-header', checkpointWritten: true, adds: 0, tombstones: 0, checkpointEntries: 7,
    });
    expect(statements.some((s) => /ANALYZE snapshot_index_incoming/.test(s))).toBe(true);
    expect(statements.some((s) => /pg_advisory_xact_lock\(hashtextextended/.test(s))).toBe(true);
    expect(statements.some((s) => /INSERT INTO backup_snapshot_files/.test(s))).toBe(false);
  });

  it('takes the lineage lock before it reads the newest checkpoint', async () => {
    const { tx, statements } = fakeTx({ header: null, checkpointEntriesInserted: 1 });
    await publishDeltaIndex(tx, args(1));
    const lock = statements.findIndex((s) => /pg_advisory_xact_lock/.test(s));
    const newest = statements.findIndex((s) => /FOR KEY SHARE/.test(s));
    expect(lock).toBeGreaterThan(-1);
    expect(newest).toBeGreaterThan(lock);
  });

  it('writes the differences when they are within 5% of the checkpoint', async () => {
    const { tx, statements } = fakeTx({ header: { id: HEADER, entry_count: 1_000 }, adds: 20, tombstones: 10 });

    const published = await publishDeltaIndex(tx, args(1_010));

    expect(published).toEqual({
      format: 'delta', checkpointId: HEADER, checkpointWritten: false, adds: 20, tombstones: 10, checkpointEntries: 1_000,
    });
    expect(statements.some((s) => /INSERT INTO backup_tree_checkpoints\b/.test(s))).toBe(false);
    expect(statements.some((s) => /INSERT INTO backup_snapshot_files/.test(s))).toBe(true);
    // The header it diffed against is marked as still in use.
    expect(statements.some((s) => /UPDATE backup_tree_checkpoints SET last_referenced_at = now\(\)/.test(s))).toBe(true);
  });

  it('writes a new checkpoint past 5%, without counting tombstones once additions alone exceed it', async () => {
    const { tx, statements } = fakeTx({ header: { id: HEADER, entry_count: 1_000 }, adds: 51, checkpointEntriesInserted: 1_051 });

    const published = await publishDeltaIndex(tx, args(1_051));

    expect(published).toMatchObject({ checkpointId: 'new-header', checkpointWritten: true, adds: 0, tombstones: 0 });
    expect(statements.filter((s) => /count\(\*\)::int AS n/.test(s))).toHaveLength(1);
    expect(statements.some((s) => /INSERT INTO backup_snapshot_files/.test(s))).toBe(false);
  });

  it('refuses a delta that does not reproduce the manifest (D9)', async () => {
    const { tx } = fakeTx({ header: { id: HEADER, entry_count: 1_000 }, adds: 5, tombstones: 5, written: { adds: 5, tombstones: 5 } });

    await expect(publishDeltaIndex(tx, args(1_001))).rejects.toThrow(/snapshot index delta does not reproduce the manifest/);
  });

  it('refuses a tombstone whose source path is not its checkpoint entry\'s (D1)', async () => {
    // The counts balance, so only the path check can refuse it.
    const { tx } = fakeTx({
      header: { id: HEADER, entry_count: 1_000 }, adds: 5, tombstones: 5, written: { adds: 5, tombstones: 5, misnamed: 1 },
    });

    await expect(publishDeltaIndex(tx, args(1_000))).rejects.toThrow(/1 tombstone\(s\) do not carry the source path of the checkpoint entry they name/);
  });

  it('checks each written tombstone against the checkpoint entry it names, in the writing statement', async () => {
    const { tx, statements } = fakeTx({ header: { id: HEADER, entry_count: 1_000 }, adds: 1, tombstones: 1 });
    await publishDeltaIndex(tx, args(1_000));
    const write = statements.find((s) => /INSERT INTO backup_snapshot_files/.test(s))!;
    expect(write).toMatch(/RETURNING checkpoint_entry_no, source_path/);
    expect(write).toMatch(/LEFT JOIN backup_tree_checkpoint_entries e\s+ON e\.checkpoint_id = \$\d+::uuid AND e\.entry_no = w\.checkpoint_entry_no/);
    expect(write).toMatch(/e\.source_path IS DISTINCT FROM w\.source_path/);
  });

  it('refuses a delta whose rebuilt tree differs from the manifest in content, the counts balancing (D9)', async () => {
    for (const digests of [
      { tree_n: 1_000, tree_h: '123', manifest_n: 1_000, manifest_h: '124' },
      { tree_n: 999, tree_h: '123', manifest_n: 1_000, manifest_h: '123' },
    ]) {
      const { tx, statements } = fakeTx({ header: { id: HEADER, entry_count: 1_000 }, adds: 5, tombstones: 5, digests });
      await expect(publishDeltaIndex(tx, args(1_000)))
        .rejects.toThrow(/the rebuilt tree's content differs from the manifest's/);
      // Refused before the header is marked as in use.
      expect(statements.some((s) => /SET last_referenced_at/.test(s))).toBe(false);
    }
  });

  it('reads the rebuilt tree from the stored rows, not through the diff\'s pairing', async () => {
    const { tx, statements } = fakeTx({ header: { id: HEADER, entry_count: 1_000 }, adds: 1, tombstones: 1 });
    await publishDeltaIndex(tx, args(1_000));
    const write = statements.findIndex((s) => /INSERT INTO backup_snapshot_files/.test(s));
    const check = statements.findIndex((s) => /AS tree_n/.test(s));
    expect(check).toBeGreaterThan(write);
    const text = statements[check]!;
    // The read layer's shape: entries a stored tombstone names by entry_no and path are hidden; stored adds are added.
    // Counted as all entries minus the tombstoned ones plus the adds (#12741).
    expect(text).toMatch(/entries\.h - hidden\.h \+ adds\.h/);
    expect(text).toMatch(/x\.entry_no = t\.checkpoint_entry_no\s+AND x\.source_path = t\.source_path/);
    expect(text).toMatch(/f\.checkpoint_entry_no IS NULL/);
    // Every indexed column on every side (entries, tombstoned entries, adds, manifest), and none of the diff's numbering.
    expect(text.match(/ROW\((\w)\.source_path, \1\.backup_path, \1\.size, \1\.modified_at, \1\.kind\)::text/g)).toHaveLength(4);
    expect(text.match(/ROW\(x\.source_path, x\.backup_path, x\.size, x\.modified_at, x\.kind\)::text/g)).toHaveLength(1);
    expect(text).toMatch(/FROM snapshot_index_incoming x/);
    expect(text).not.toMatch(/\bord\b|row_number/);
  });

  it('refuses a checkpoint whose entry count is not the manifest\'s', async () => {
    const { tx } = fakeTx({ header: null, checkpointEntriesInserted: 6 });

    await expect(publishDeltaIndex(tx, args(7))).rejects.toThrow(/does not reproduce the manifest/);
  });

  it('refuses a lineage that names another org or device than the snapshot, before writing anything', async () => {
    for (const snapshot of [
      { org_id: '66666666-6666-4666-8666-666666666666', device_id: DEVICE },
      { org_id: ORG, device_id: '66666666-6666-4666-8666-666666666666' },
      null,
    ]) {
      const { tx, statements } = fakeTx({ snapshot, header: null, checkpointEntriesInserted: 1 });
      await expect(publishDeltaIndex(tx, args(1))).rejects.toThrow(/another org or device|not found/);
      expect(statements.filter((s) => /^\s*(INSERT|UPDATE)/.test(s))).toEqual([]);
    }
  });
});

describe('loadIncomingBatch', () => {
  it('loads one JSON parameter into the temp table and returns the database\'s count', async () => {
    const execute = vi.fn(async () => Object.assign([], { count: 2 }));
    const loaded = await loadIncomingBatch({ execute } as unknown as Tx, [
      { source_path: '/a', backup_path: 'snapshots/s/files/a', size: 1, modified_at: null, kind: null },
      { source_path: '/d', backup_path: '', size: null, modified_at: null, kind: 'dir' },
    ]);
    expect(loaded).toBe(2);
    const { sql: text } = render((execute.mock.calls[0] as unknown as [SQL])[0]);
    expect(text).toMatch(/INSERT INTO snapshot_index_incoming/);
    expect(text).toMatch(/json_to_recordset/);
  });

  it('does nothing for an empty batch', async () => {
    const execute = vi.fn();
    expect(await loadIncomingBatch({ execute } as unknown as Tx, [])).toBe(0);
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('publishDeltaIndex: bounds and lineage', () => {
  it('bounds the wait for the lineage lock, then restores the caller\'s lock_timeout', async () => {
    const { tx, statements, params } = fakeTx({ header: null, checkpointEntriesInserted: 1 });
    const execute = (tx as unknown as { execute: ReturnType<typeof vi.fn<(q: SQL) => Promise<unknown>>> }).execute;
    const base = execute.getMockImplementation()!;
    execute.mockImplementation(async (q: SQL) => {
      if (/set_config\(\s*'lock_timeout'/.test(render(q).sql) && /pg_settings/.test(render(q).sql)) {
        statements.push(render(q).sql);
        params.push(render(q).params);
        return Object.assign([{ prior_ms: 0, applied: `${LINEAGE_LOCK_TIMEOUT_MS}ms` }], { count: 1 });
      }
      return base(q);
    });

    await publishDeltaIndex(tx, args(1));

    const tighten = statements.findIndex((s) => /pg_settings/.test(s) && /lock_timeout/.test(s));
    const lock = statements.findIndex((s) => /pg_advisory_xact_lock/.test(s));
    const restore = statements.findIndex((s, i) => i > lock && /set_config\('lock_timeout'/.test(s));
    expect(tighten).toBeGreaterThan(-1);
    expect(params[tighten]).toContain(LINEAGE_LOCK_TIMEOUT_MS);
    expect(lock).toBeGreaterThan(tighten);
    expect(restore).toBeGreaterThan(lock);
    expect(params[restore]).toContain('0ms');
  });

  it('counts up to one past the threshold, and tombstones up to what is left of it', async () => {
    // 1,000 entries: threshold 50.
    const { tx, statements, params } = fakeTx({ header: { id: HEADER, entry_count: 1_000 }, adds: 30, tombstones: 20 });
    await publishDeltaIndex(tx, args(1_010));
    const addCount = statements.findIndex((s) => /SELECT 1 FROM incoming i WHERE NOT EXISTS/.test(s) && /AS n/.test(s));
    const tombCount = statements.findIndex((s) => /SELECT 1 FROM checkpoint c WHERE NOT EXISTS/.test(s) && /AS n/.test(s));
    expect(params[addCount]!.at(-1)).toBe(51);
    expect(params[tombCount]!.at(-1)).toBe(21);
  });

  it('tombstones alone can tip a delta past 5%: 30 + 20 of 1,000 is a delta, 30 + 21 a new checkpoint', async () => {
    const within = fakeTx({ header: { id: HEADER, entry_count: 1_000 }, adds: 30, tombstones: 20 });
    expect(await publishDeltaIndex(within.tx, args(1_010))).toMatchObject({ checkpointWritten: false, adds: 30, tombstones: 20 });

    const past = fakeTx({ header: { id: HEADER, entry_count: 1_000 }, adds: 30, tombstones: 21, checkpointEntriesInserted: 1_009 });
    expect(await publishDeltaIndex(past.tx, args(1_009))).toMatchObject({ checkpointWritten: true, checkpointId: 'new-header' });
  });

  it('finds the newest checkpoint by every lineage part, a non-NULL key prefix included', async () => {
    const lineage = lineageKeyOf({ ...snapshotFields, keyLayout: 'prefixed_flat', keyPrefix: 'tenant-a' })!;
    const { tx, statements, params } = fakeTx({ header: null, checkpointEntriesInserted: 1 });
    await publishDeltaIndex(tx, { ...args(1), lineage });
    const newest = statements.findIndex((s) => /FOR KEY SHARE/.test(s));
    for (const column of ['org_id', 'device_id', 'config_id', 'storage_identity', 'backup_type', 'key_layout']) {
      expect(statements[newest]).toMatch(new RegExp(`\\b${column} = \\$\\d+`));
    }
    expect(statements[newest]).toMatch(/key_prefix IS NOT DISTINCT FROM \$\d+::text/);
    expect(params[newest]).toEqual([ORG, DEVICE, CONFIG, 's3::bucket', 'file', 'prefixed_flat', 'tenant-a']);
    // The new header carries the same key root.
    const header = statements.findIndex((s) => /INSERT INTO backup_tree_checkpoints\b/.test(s));
    expect(params[header]).toEqual(expect.arrayContaining(['prefixed_flat', 'tenant-a']));
  });
});

describe('publishDeltaIndex: bounded checkpoint creation', () => {
  const K = CHECKPOINT_MAX_UNREFERENCED_PER_LINEAGE;

  it('allows three unreferenced headers a lineage', () => {
    expect(K).toBe(3);
  });

  it('at the bound, publishes rows: the manifest becomes the snapshot\'s own rows and no header is written', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // An empty newest checkpoint: any entry is past 5%, so this would rebase.
      const { tx, statements } = fakeTx({ header: { id: HEADER, entry_count: 0 }, adds: 7, unreferenced: K, rowsInserted: 7 });

      const published = await publishDeltaIndex(tx, args(7));

      expect(published).toEqual({ format: 'rows', rows: 7, reason: 'unreferenced_checkpoint_bound' });
      expect(statements.some((s) => /INSERT INTO backup_tree_checkpoints\b/.test(s))).toBe(false);
      expect(statements.some((s) => /INSERT INTO backup_tree_checkpoint_entries/.test(s))).toBe(false);
      expect(statements.some((s) => /SET last_referenced_at/.test(s))).toBe(false);
      const copy = statements.find((s) => /INSERT INTO backup_snapshot_files/.test(s))!;
      expect(copy).toMatch(/\(snapshot_db_id, source_path, backup_path, size, modified_at, kind\)/);
      expect(copy).toMatch(/FROM snapshot_index_incoming i/);
      expect(copy).not.toMatch(/checkpoint_entry_no/);
      // Logged once, with the lineage's org and device, so an operator can see it.
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toContain(ORG);
      expect(String(warn.mock.calls[0]![0])).toContain(DEVICE);
    } finally {
      warn.mockRestore();
    }
  });

  it('below the bound, still writes a new checkpoint', async () => {
    const { tx } = fakeTx({ header: { id: HEADER, entry_count: 0 }, adds: 7, unreferenced: K - 1, checkpointEntriesInserted: 7 });
    expect(await publishDeltaIndex(tx, args(7))).toMatchObject({ format: 'delta', checkpointId: 'new-header', checkpointWritten: true });
  });

  it('counts the lineage\'s unreferenced headers under its lock, by every lineage part, up to the bound', async () => {
    const lineage = lineageKeyOf({ ...snapshotFields, keyLayout: 'prefixed_flat', keyPrefix: 'tenant-a' })!;
    const { tx, statements, params } = fakeTx({ header: null, unreferenced: 0, checkpointEntriesInserted: 1 });
    await publishDeltaIndex(tx, { ...args(1), lineage });
    const lock = statements.findIndex((s) => /pg_advisory_xact_lock/.test(s));
    const count = statements.findIndex((s) => /AS unreferenced/.test(s));
    const insert = statements.findIndex((s) => /INSERT INTO backup_tree_checkpoints\b/.test(s));
    expect(lock).toBeGreaterThan(-1);
    expect(count).toBeGreaterThan(lock);
    expect(insert).toBeGreaterThan(count);
    const text = statements[count]!;
    // backup_tree_checkpoints_lineage_idx (device_id, config_id, storage_identity, created_at DESC) serves the
    // prefix; backup_snapshots_file_index_checkpoint_idx serves the reference probe.
    expect(text).toMatch(/c\.device_id = \$\d+::uuid\s+AND c\.config_id = \$\d+::uuid\s+AND c\.storage_identity = \$\d+/);
    for (const column of ['org_id', 'backup_type', 'key_layout']) expect(text).toMatch(new RegExp(`c\\.${column} = \\$\\d+`));
    expect(text).toMatch(/c\.key_prefix IS NOT DISTINCT FROM \$\d+::text/);
    expect(text).toMatch(/NOT EXISTS \(\s*SELECT 1 FROM backup_snapshots s WHERE s\.file_index_checkpoint_id = c\.id\s*\)/);
    expect(params[count]).toEqual([DEVICE, CONFIG, 's3::bucket', ORG, 'file', 'prefixed_flat', 'tenant-a', K]);
  });

  it('does not count when it writes no checkpoint', async () => {
    const { tx, statements } = fakeTx({ header: { id: HEADER, entry_count: 1_000 }, adds: 1, tombstones: 1 });
    await publishDeltaIndex(tx, args(1_000));
    expect(statements.some((s) => /AS unreferenced/.test(s))).toBe(false);
  });

  it('refuses rows that do not reproduce the manifest\'s entry count', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { tx } = fakeTx({ header: { id: HEADER, entry_count: 0 }, adds: 7, unreferenced: K, rowsInserted: 6 });
      await expect(publishDeltaIndex(tx, args(7))).rejects.toThrow(/does not reproduce the manifest/);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('publishDeltaIndex: a re-hydration diffs against its own checkpoint first', () => {
  it('an unchanged manifest reuses its own checkpoint and writes no header, whatever the newest is', async () => {
    const { tx, statements } = fakeTx({
      snapshot: { org_id: ORG, device_id: DEVICE, file_index_checkpoint_id: OWN },
      own: { id: OWN, entry_count: 100 },
      header: { id: HEADER, entry_count: 100 },
      diffs: { [OWN]: { adds: 0, tombstones: 0 }, [HEADER]: { adds: 100, tombstones: 100 } },
      written: { adds: 0, tombstones: 0 },
      digests: { tree_n: 100, tree_h: '9', manifest_n: 100, manifest_h: '9' },
    });

    const published = await publishDeltaIndex(tx, args(100));

    expect(published).toEqual({ format: 'delta', checkpointId: OWN, checkpointWritten: false, adds: 0, tombstones: 0, checkpointEntries: 100 });
    expect(statements.some((s) => /INSERT INTO backup_tree_checkpoints\b/.test(s))).toBe(false);
    // The newest is not read when the snapshot's own checkpoint will do.
    expect(statements.some((s) => /ORDER BY created_at DESC/.test(s))).toBe(false);
  });

  it('reads its own checkpoint after the lineage lock, by every lineage part, and holds it FOR KEY SHARE', async () => {
    const { tx, statements, params } = fakeTx({
      snapshot: { org_id: ORG, device_id: DEVICE, file_index_checkpoint_id: OWN },
      own: { id: OWN, entry_count: 10 },
      written: { adds: 0, tombstones: 0 },
      digests: { tree_n: 10, tree_h: '9', manifest_n: 10, manifest_h: '9' },
    });
    await publishDeltaIndex(tx, args(10));
    const lock = statements.findIndex((s) => /pg_advisory_xact_lock/.test(s));
    const own = statements.findIndex((s) => /WHERE id = \$\d+::uuid[\s\S]*FOR KEY SHARE/.test(s));
    expect(lock).toBeGreaterThan(-1);
    expect(own).toBeGreaterThan(lock);
    for (const column of ['org_id', 'device_id', 'config_id', 'storage_identity', 'backup_type', 'key_layout']) {
      expect(statements[own]).toMatch(new RegExp(`\\b${column} = \\$\\d+`));
    }
    expect(statements[own]).toMatch(/key_prefix IS NOT DISTINCT FROM \$\d+::text/);
    expect(params[own]![0]).toBe(OWN);
  });

  it('falls back to the newest checkpoint when its own is of another lineage or past 5%', async () => {
    // Another lineage: the lineage-checked read finds nothing.
    const other = fakeTx({
      snapshot: { org_id: ORG, device_id: DEVICE, file_index_checkpoint_id: OWN },
      own: null,
      header: { id: HEADER, entry_count: 1_000 },
      adds: 1, tombstones: 1,
    });
    expect(await publishDeltaIndex(other.tx, args(1_000))).toMatchObject({ checkpointId: HEADER, checkpointWritten: false });

    // Its own past 5%, the newest within it.
    const past = fakeTx({
      snapshot: { org_id: ORG, device_id: DEVICE, file_index_checkpoint_id: OWN },
      own: { id: OWN, entry_count: 1_000 },
      header: { id: HEADER, entry_count: 1_000 },
      diffs: { [OWN]: { adds: 51, tombstones: 0 }, [HEADER]: { adds: 1, tombstones: 1 } },
      written: { adds: 1, tombstones: 1 },
    });
    expect(await publishDeltaIndex(past.tx, args(1_000))).toMatchObject({ checkpointId: HEADER, checkpointWritten: false });
  });

  it('diffs only once when its own checkpoint is the newest', async () => {
    const { tx, statements } = fakeTx({
      snapshot: { org_id: ORG, device_id: DEVICE, file_index_checkpoint_id: HEADER },
      own: { id: HEADER, entry_count: 1_000 },
      header: { id: HEADER, entry_count: 1_000 },
      adds: 51,
      unreferenced: 0,
      checkpointEntriesInserted: 1_051,
    });
    expect(await publishDeltaIndex(tx, args(1_051))).toMatchObject({ checkpointWritten: true });
    expect(statements.filter((s) => /SELECT 1 FROM incoming i WHERE NOT EXISTS/.test(s) && /AS n/.test(s))).toHaveLength(1);
  });
});
