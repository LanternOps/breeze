import { describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
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
  snapshot?: { org_id: string; device_id: string } | null;
  header?: { id: string; entry_count: number } | null;
  adds?: number;
  tombstones?: number;
  written?: { adds: number; tombstones: number };
  checkpointEntriesInserted?: number;
}) {
  const statements: string[] = [];
  const params: unknown[][] = [];
  const rows = <T,>(r: T[], count = r.length) => Object.assign(r, { count });
  const execute = vi.fn(async (q: SQL) => {
    const { sql: text, params: p } = render(q);
    statements.push(text);
    params.push(p);
    if (/^\s*SELECT org_id, device_id FROM backup_snapshots/.test(text)) {
      return rows(opts.snapshot === null ? [] : [opts.snapshot ?? { org_id: ORG, device_id: DEVICE }]);
    }
    if (/FROM backup_tree_checkpoints\b[\s\S]*FOR KEY SHARE/.test(text)) return rows(opts.header ? [opts.header] : []);
    // A count stops at its LIMIT (the last parameter), as Postgres would.
    if (/AS n FROM \(\s*SELECT 1 FROM incoming i WHERE NOT EXISTS/.test(text)) return rows([{ n: Math.min(opts.adds ?? 0, Number(p.at(-1))) }]);
    if (/AS n FROM \(\s*SELECT 1 FROM checkpoint c WHERE NOT EXISTS/.test(text)) return rows([{ n: Math.min(opts.tombstones ?? 0, Number(p.at(-1))) }]);
    if (/INSERT INTO backup_tree_checkpoints\b/.test(text)) return rows([{ id: 'new-header' }]);
    if (/INSERT INTO backup_tree_checkpoint_entries/.test(text)) return rows([], opts.checkpointEntriesInserted ?? 0);
    if (/INSERT INTO backup_snapshot_files/.test(text)) {
      return rows([opts.written ?? { adds: opts.adds ?? 0, tombstones: opts.tombstones ?? 0 }]);
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
