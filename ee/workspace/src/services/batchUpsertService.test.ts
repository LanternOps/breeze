import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceDatabase } from '../hostTypes';
import { SQL } from 'drizzle-orm';
import { workspaceFileIndex } from '../schema/workspace';
import { createBatchUpsertService, MAX_BATCH_ENTRIES, type BatchEntry } from './batchUpsertService';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const SOURCE_ID = '22222222-2222-2222-2222-222222222222';
const DEVICE_ID = '33333333-3333-3333-3333-333333333333';
const OTHER_ORG_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

function boundValues(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => item && typeof item === 'object' ? boundValues(item) : [item]);
  }
  if (!value || typeof value !== 'object') return [];
  const candidate = value as { value?: unknown; queryChunks?: unknown[] };
  const own = Object.prototype.hasOwnProperty.call(candidate, 'value')
    ? (Array.isArray(candidate.value) ? candidate.value : [candidate.value])
    : [];
  return [...own, ...(candidate.queryChunks ?? []).flatMap(boundValues)];
}

function containsIdentity(value: unknown, target: unknown): boolean {
  if (value === target) return true;
  if (Array.isArray(value)) return value.some((item) => containsIdentity(item, target));
  if (!value || typeof value !== 'object') return false;
  return ((value as { queryChunks?: unknown[] }).queryChunks ?? [])
    .some((item) => containsIdentity(item, target));
}

function sqlText(value: unknown): string {
  if (Array.isArray(value)) return value.map(sqlText).join('');
  if (!value || typeof value !== 'object') return '';
  const candidate = value as { value?: unknown; queryChunks?: unknown[] };
  const own = Array.isArray(candidate.value) && candidate.value.every((part) => typeof part === 'string')
    ? candidate.value.join('')
    : '';
  return own + (candidate.queryChunks ?? []).map(sqlText).join('');
}

function expectDatabaseNow(value: unknown): void {
  expect(value).toBeInstanceOf(SQL);
  expect(sqlText(value)).toBe('now()');
}

function entry(index = 0): BatchEntry {
  return {
    relPath: `folder/file-${index}.txt`, parentPath: 'folder', name: `file-${index}.txt`,
    isDir: false, size: index, mtime: '2026-07-12T12:00:00.000Z', ctime: null,
    ext: 'txt', attrs: { hidden: false },
  };
}

function makeDb() {
  const batches: Array<Record<string, unknown>[]> = [];
  const conflicts: unknown[] = [];
  const db = {
    insert: vi.fn((table: unknown) => {
      expect(table).toBe(workspaceFileIndex);
      return {
        values: vi.fn((rows: Array<Record<string, unknown>>) => {
          batches.push(rows);
          return {
            onConflictDoUpdate: vi.fn((config: unknown) => {
              conflicts.push(config);
              return { returning: vi.fn(async () => rows.map((_, i) => ({ id: String(i) }))) };
            }),
          };
        }),
      };
    }),
    update: vi.fn(() => ({
      set: vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn(async () => [{ id: '1' }, { id: '2' }]) })) })),
    })),
  };
  return { db: db as unknown as WorkspaceDatabase, raw: db, batches, conflicts };
}

describe('batchUpsertService', () => {
  it('exports the route validation ceiling', () => {
    expect(MAX_BATCH_ENTRIES).toBe(2000);
  });

  it('maps entries to scoped rows and reports inserted and expected counts', async () => {
    const h = makeDb();
    await expect(createBatchUpsertService(h.db).upsertBatch(ORG_ID, SOURCE_ID, DEVICE_ID, [entry()]))
      .resolves.toEqual({ inserted: 1, expected: 1 });
    expect(h.batches[0]?.[0]).toMatchObject({
      orgId: ORG_ID, sourceId: SOURCE_ID, deviceId: DEVICE_ID, deviceKey: DEVICE_ID,
      relPath: 'folder/file-0.txt', mtime: new Date('2026-07-12T12:00:00.000Z'),
    });
    expectDatabaseNow(h.batches[0]?.[0]?.lastSeenAt);
    expectDatabaseNow(h.batches[0]?.[0]?.updatedAt);
  });

  it('uses the four-column conflict target and clears deletedAt to resurrect rows', async () => {
    const h = makeDb();
    await createBatchUpsertService(h.db).upsertBatch(ORG_ID, SOURCE_ID, DEVICE_ID, [entry()]);
    expect(h.conflicts[0]).toMatchObject({
      target: [workspaceFileIndex.orgId, workspaceFileIndex.sourceId, workspaceFileIndex.deviceKey, workspaceFileIndex.relPath],
      set: expect.objectContaining({ deletedAt: null }),
    });
  });

  it('chunks 2,001 entries into exactly five writes of at most 500', async () => {
    const h = makeDb();
    const entries = Array.from({ length: 2001 }, (_, i) => entry(i));
    await expect(createBatchUpsertService(h.db).upsertBatch(ORG_ID, SOURCE_ID, DEVICE_ID, entries))
      .resolves.toEqual({ inserted: 2001, expected: 2001 });
    expect(h.raw.insert).toHaveBeenCalledTimes(5);
    expect(h.batches.map((batch) => batch.length)).toEqual([500, 500, 500, 500, 1]);
  });

  it('deduplicates relPath across a batch with the last entry winning', async () => {
    const h = makeDb();
    const first = entry();
    const last = { ...entry(), name: 'replacement.txt', size: 42, attrs: { hidden: true } };

    await expect(createBatchUpsertService(h.db).upsertBatch(
      ORG_ID, SOURCE_ID, DEVICE_ID, [first, last],
    )).resolves.toEqual({ inserted: 1, expected: 2 });
    expect(h.batches).toHaveLength(1);
    expect(h.batches[0]).toHaveLength(1);
    expect(h.batches[0]?.[0]).toMatchObject({
      relPath: first.relPath,
      name: 'replacement.txt',
      size: 42,
      attrs: { hidden: true },
    });
  });

  it('performs no insert for an empty batch', async () => {
    const h = makeDb();
    await expect(createBatchUpsertService(h.db).upsertBatch(ORG_ID, SOURCE_ID, DEVICE_ID, []))
      .resolves.toEqual({ inserted: 0, expected: 0 });
    expect(h.raw.insert).not.toHaveBeenCalled();
  });

  it('tombstones exact paths and skips an empty path list', async () => {
    const rows = [
      { id: 'match-a', orgId: ORG_ID, sourceId: SOURCE_ID, deviceKey: DEVICE_ID, relPath: 'a.txt', deletedAt: null as Date | null },
      { id: 'match-b', orgId: ORG_ID, sourceId: SOURCE_ID, deviceKey: DEVICE_ID, relPath: 'b.txt', deletedAt: null as Date | null },
      { id: 'cross-org', orgId: OTHER_ORG_ID, sourceId: SOURCE_ID, deviceKey: DEVICE_ID, relPath: 'a.txt', deletedAt: null as Date | null },
      { id: 'wrong-source', orgId: ORG_ID, sourceId: OTHER_ORG_ID, deviceKey: DEVICE_ID, relPath: 'a.txt', deletedAt: null as Date | null },
      { id: 'wrong-device', orgId: ORG_ID, sourceId: SOURCE_ID, deviceKey: OTHER_ORG_ID, relPath: 'a.txt', deletedAt: null as Date | null },
      { id: 'not-requested', orgId: ORG_ID, sourceId: SOURCE_ID, deviceKey: DEVICE_ID, relPath: 'c.txt', deletedAt: null as Date | null },
      { id: 'already-deleted', orgId: ORG_ID, sourceId: SOURCE_ID, deviceKey: DEVICE_ID, relPath: 'a.txt', deletedAt: new Date('2026-01-01') as Date | null },
    ];
    const alreadyDeletedAt = rows.at(-1)?.deletedAt;
    let tombstoneSet: Record<string, unknown> | undefined;
    const update = vi.fn(() => ({
      set: vi.fn((setValue: Record<string, unknown>) => {
        tombstoneSet = setValue;
        return {
          where: vi.fn((condition: unknown) => ({
            returning: vi.fn(async () => {
              const values = boundValues(condition);
              const requested = values.filter((value) => value === 'a.txt' || value === 'b.txt') as string[];
              const requiresUndeleted = containsIdentity(condition, workspaceFileIndex.deletedAt);
              const matches = rows.filter((row) =>
                (!values.includes(ORG_ID) || row.orgId === ORG_ID) &&
                (!values.includes(SOURCE_ID) || row.sourceId === SOURCE_ID) &&
                (!values.includes(DEVICE_ID) || row.deviceKey === DEVICE_ID) &&
                (requested.length === 0 || requested.includes(row.relPath)) &&
                (!requiresUndeleted || row.deletedAt === null));
              for (const row of matches) row.deletedAt = new Date();
              return matches.map(({ id }) => ({ id }));
            }),
          })),
        };
      }),
    }));
    const service = createBatchUpsertService({ update } as unknown as WorkspaceDatabase);
    await expect(service.tombstonePaths(ORG_ID, SOURCE_ID, DEVICE_ID, ['a.txt', 'b.txt'])).resolves.toBe(2);
    await expect(service.tombstonePaths(ORG_ID, SOURCE_ID, DEVICE_ID, [])).resolves.toBe(0);
    expect(rows.slice(0, 2).every((row) => row.deletedAt instanceof Date)).toBe(true);
    expect(rows.slice(2, -1).every((row) => row.deletedAt === null)).toBe(true);
    expect(rows.at(-1)?.deletedAt).toBe(alreadyDeletedAt);
    expect(update).toHaveBeenCalledTimes(1);
    expectDatabaseNow(tombstoneSet?.deletedAt);
    expectDatabaseNow(tombstoneSet?.updatedAt);
  });
});
