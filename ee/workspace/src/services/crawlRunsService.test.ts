import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceDatabase } from '../hostTypes';
import { SQL } from 'drizzle-orm';
import { workspaceCrawlRuns, workspaceFileIndex, workspaceSources } from '../schema/workspace';
import { createCrawlRunsService, STALE_RUN_MINUTES } from './crawlRunsService';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const SOURCE_ID = '22222222-2222-2222-2222-222222222222';
const DEVICE_A = '33333333-3333-3333-3333-333333333333';
const DEVICE_B = '44444444-4444-4444-4444-444444444444';
const RUN_ID = '55555555-5555-5555-5555-555555555555';
const CROSS_ORG_RUN_ID = '66666666-6666-6666-6666-666666666666';
const WRONG_RUN_ID = '77777777-7777-7777-7777-777777777777';
const WRONG_SOURCE_RUN_ID = '88888888-8888-8888-8888-888888888888';
const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

function boundValues(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => item && typeof item === 'object' ? boundValues(item) : [item]);
  }
  if (!value || typeof value !== 'object') return [];
  const candidate = value as { value?: unknown; queryChunks?: unknown[] };
  const own = Object.prototype.hasOwnProperty.call(candidate, 'value')
    ? (Array.isArray(candidate.value) ? candidate.value : [candidate.value])
    : [];
  return [
    ...own,
    ...(candidate.queryChunks ?? []).flatMap((item) =>
      item && typeof item === 'object' ? boundValues(item) : [item]),
  ];
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

function run(overrides: Record<string, unknown> = {}) {
  return {
    id: RUN_ID,
    orgId: ORG_ID,
    sourceId: SOURCE_ID,
    deviceId: DEVICE_A,
    deviceKey: DEVICE_A,
    status: 'running',
    startedAt: new Date('2026-07-12T10:00:00.000Z'),
    lastActivityAt: new Date(),
    completedAt: null,
    cursor: null,
    stats: {},
    errorReason: null,
    ...overrides,
  };
}

function makeDb(
  selectResults: unknown[][] = [],
  updateReturns: unknown[][] = [],
  sourceKind: 'smb_share' | 'local_profile' = 'local_profile',
) {
  let selectIndex = 0;
  let updateIndex = 0;
  const updateTables: unknown[] = [];
  const updateSets: unknown[] = [];
  const insertValues: unknown[] = [];
  const db = {
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => table === workspaceSources
            ? [{ kind: sourceKind, crawlDeviceId: DEVICE_A }]
            : selectResults[selectIndex++] ?? []),
        })),
      })),
    })),
    update: vi.fn((table: unknown) => {
      updateTables.push(table);
      return {
        set: vi.fn((value: unknown) => {
          updateSets.push(value);
          return {
            where: vi.fn(() => ({
              returning: vi.fn(async () => updateReturns[updateIndex++] ?? []),
            })),
          };
        }),
      };
    }),
    insert: vi.fn(() => ({
      values: vi.fn((value: unknown) => {
        insertValues.push(value);
        return {
          returning: vi.fn(async () => [run({
            ...(value as Record<string, unknown>),
            startedAt: new Date('2026-07-12T12:00:00.000Z'),
            lastActivityAt: new Date('2026-07-12T12:00:00.000Z'),
          })]),
        };
      }),
    })),
    execute: vi.fn(async () => []),
  };
  const withTransaction = Object.assign(db, {
    transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(db)),
  });
  return {
    db: withTransaction as unknown as WorkspaceDatabase,
    raw: withTransaction,
    updateTables,
    updateSets,
    insertValues,
  };
}

function makeStatefulFinishDb(options: { failSourceUpdate?: boolean } = {}) {
  const startedAt = new Date('2026-07-12T10:00:00.000Z');
  const files = [
    { id: 'file-a', orgId: ORG_ID, sourceId: SOURCE_ID, deviceKey: DEVICE_A, lastSeenAt: new Date('2026-07-12T09:00:00Z'), deletedAt: null as Date | null },
    { id: 'file-b', orgId: ORG_ID, sourceId: SOURCE_ID, deviceKey: DEVICE_B, lastSeenAt: new Date('2026-07-12T09:00:00Z'), deletedAt: null as Date | null },
    { id: 'cross-org', orgId: DEVICE_B, sourceId: SOURCE_ID, deviceKey: DEVICE_A, lastSeenAt: new Date('2026-07-12T09:00:00Z'), deletedAt: null as Date | null },
    { id: 'wrong-source', orgId: ORG_ID, sourceId: DEVICE_B, deviceKey: DEVICE_A, lastSeenAt: new Date('2026-07-12T09:00:00Z'), deletedAt: null as Date | null },
  ];
  const runs = [
    run({ id: CROSS_ORG_RUN_ID, orgId: DEVICE_B, sourceId: SOURCE_ID, status: 'running' }),
    run({ id: WRONG_RUN_ID, orgId: ORG_ID, sourceId: SOURCE_ID, status: 'running' }),
    run({ id: WRONG_SOURCE_RUN_ID, orgId: ORG_ID, sourceId: DEVICE_B, status: 'running' }),
    run({ id: RUN_ID, orgId: ORG_ID, sourceId: SOURCE_ID, deviceId: DEVICE_A, deviceKey: DEVICE_A, startedAt }),
  ];
  const updateTables: unknown[] = [];
  const updateSets: unknown[] = [];
  const selectedTables: unknown[] = [];
  const runConditions: unknown[] = [];
  const db: Record<string, unknown> = {};
  db.select = vi.fn(() => ({
    from: vi.fn((table: unknown) => ({
      where: vi.fn((condition: unknown) => ({
        limit: vi.fn(async () => {
          selectedTables.push(table);
          const values = boundValues(condition);
          if (table === workspaceSources) {
            const sourceRows = [
              { id: SOURCE_ID, orgId: DEVICE_B, kind: 'local_profile', crawlDeviceId: DEVICE_A },
              { id: DEVICE_B, orgId: ORG_ID, kind: 'local_profile', crawlDeviceId: DEVICE_A },
              { id: SOURCE_ID, orgId: ORG_ID, kind: 'local_profile', crawlDeviceId: DEVICE_A },
            ];
            return sourceRows.filter((row) =>
              (!values.includes(ORG_ID) || row.orgId === ORG_ID) &&
              (!values.includes(SOURCE_ID) || row.id === SOURCE_ID)).slice(0, 1);
          }
          if (table !== workspaceCrawlRuns) return [];
          runConditions.push(condition);
          return runs.filter((row) =>
            (!values.includes(ORG_ID) || row.orgId === ORG_ID) &&
            (!values.includes(RUN_ID) || row.id === RUN_ID) &&
            (!values.includes(SOURCE_ID) || row.sourceId === SOURCE_ID) &&
            (!values.includes('running') || row.status === 'running')).slice(0, 1);
        }),
      })),
    })),
  }));
  db.update = vi.fn((table: unknown) => {
    updateTables.push(table);
    return {
      set: vi.fn((setValue: Record<string, unknown>) => {
        updateSets.push(setValue);
        return {
          where: vi.fn((condition: unknown) => ({
            returning: vi.fn(async () => {
              if (table === workspaceSources && options.failSourceUpdate) {
                throw new Error('source update failed');
              }
              if (table === workspaceCrawlRuns) {
                runConditions.push(condition);
                const values = boundValues(condition);
                const matches = runs.filter((row) =>
                  (!values.includes(ORG_ID) || row.orgId === ORG_ID) &&
                  (!values.includes(RUN_ID) || row.id === RUN_ID) &&
                  (!values.includes('running') || row.status === 'running'));
                matches.forEach((row) => { row.status = setValue.status as string; });
                return matches.map(({ id }) => ({ id }));
              }
              if (table !== workspaceFileIndex) return [];
              const values = boundValues(condition);
              const threshold = values.find((value) => value instanceof Date) as Date | undefined;
              const matching = files.filter((file) =>
                (!values.includes(ORG_ID) || file.orgId === ORG_ID) &&
                (!values.includes(SOURCE_ID) || file.sourceId === SOURCE_ID) &&
                (!values.includes(DEVICE_A) || file.deviceKey === DEVICE_A) &&
                file.deletedAt === null && (!threshold || file.lastSeenAt < threshold));
              for (const file of matching) file.deletedAt = new Date();
              return matching.map(({ id }) => ({ id }));
            }),
          })),
        };
      }),
    };
  });
  db.transaction = vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
    const snapshot = files.map((file) => file.deletedAt);
    const runSnapshot = runs.map((row) => row.status);
    try {
      return await callback(db);
    } catch (error) {
      files.forEach((file, index) => { file.deletedAt = snapshot[index] ?? null; });
      runs.forEach((row, index) => { row.status = runSnapshot[index] ?? row.status; });
      throw error;
    }
  });
  db.execute = vi.fn(async () => []);
  return {
    db: db as unknown as WorkspaceDatabase, raw: db, files, runs,
    updateTables, updateSets, selectedTables, runConditions,
  };
}

describe('crawlRunsService', () => {
  it('exports the exact stale-run threshold', () => {
    expect(STALE_RUN_MINUTES).toBe(60);
  });

  it('returns a conflict for a fresh running crawl', async () => {
    const rows = [
      run({
        id: WRONG_SOURCE_RUN_ID,
        sourceId: DEVICE_B,
        lastActivityAt: new Date(Date.now() - 61 * 60_000),
      }),
      run({ lastActivityAt: new Date() }),
    ];
    const rawDb = {
      execute: vi.fn(async () => []),
      select: vi.fn(() => ({ from: vi.fn((table: unknown) => ({
        where: vi.fn((condition: unknown) => ({ limit: vi.fn(async () => {
          const values = boundValues(condition);
          if (table === workspaceSources) return [{ kind: 'local_profile', crawlDeviceId: DEVICE_A }];
          return rows.filter((row) =>
            (!values.includes(ORG_ID) || row.orgId === ORG_ID) &&
            (!values.includes(SOURCE_ID) || row.sourceId === SOURCE_ID) &&
            (!values.includes('running') || row.status === 'running')).slice(0, 1);
        }) })),
      })) })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn((condition: unknown) => ({
            returning: vi.fn(async () => {
              expect(sqlText(condition)).toContain("now() - ( * interval '1 minute')");
              expect(boundValues(condition)).toContain(STALE_RUN_MINUTES);
              return [];
            }),
          })),
        })),
      })),
      insert: vi.fn(),
    };
    const db = Object.assign(rawDb, {
      transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(rawDb)),
    });
    await expect(createCrawlRunsService(db as unknown as WorkspaceDatabase).start(ORG_ID, SOURCE_ID, DEVICE_A))
      .resolves.toEqual({ conflict: true });
    expect(rawDb.update).toHaveBeenCalledTimes(1);
    expect(rawDb.insert).not.toHaveBeenCalled();
  });

  it('abandons a run older than 60 minutes before creating its replacement', async () => {
    const stale = run({ lastActivityAt: new Date(Date.now() - 61 * 60_000) });
    const h = makeDb([[stale]], [[stale]]);
    const result = await createCrawlRunsService(h.db).start(ORG_ID, SOURCE_ID, DEVICE_A);
    expect(result).toHaveProperty('run');
    expect(h.updateTables[0]).toBe(workspaceCrawlRuns);
    expect(h.updateSets[0]).toMatchObject({ status: 'abandoned' });
    expectDatabaseNow((h.updateSets[0] as Record<string, unknown>).completedAt);
    expect(h.insertValues[0]).toMatchObject({
      orgId: ORG_ID, sourceId: SOURCE_ID, deviceId: DEVICE_A, deviceKey: DEVICE_A, status: 'running',
    });
    expectDatabaseNow((h.insertValues[0] as Record<string, unknown>).startedAt);
    expectDatabaseNow((h.insertValues[0] as Record<string, unknown>).lastActivityAt);
  });

  it('starts a run when no active crawl exists', async () => {
    const h = makeDb([[]]);
    await expect(createCrawlRunsService(h.db).start(ORG_ID, SOURCE_ID, DEVICE_A))
      .resolves.toHaveProperty('run');
    expect(h.raw.update).not.toHaveBeenCalled();
    expect(h.raw.insert).toHaveBeenCalledTimes(1);
    expect(h.raw.transaction).toHaveBeenCalledTimes(1);
    expect(h.raw.execute).toHaveBeenCalledTimes(1);
    expectDatabaseNow((h.insertValues[0] as Record<string, unknown>).startedAt);
    expectDatabaseNow((h.insertValues[0] as Record<string, unknown>).lastActivityAt);
  });

  it('serializes repeated starts and inserts only once before returning conflict', async () => {
    const h = makeDb([[], [run({ lastActivityAt: new Date() })]]);
    const service = createCrawlRunsService(h.db);
    await expect(service.start(ORG_ID, SOURCE_ID, DEVICE_A)).resolves.toHaveProperty('run');
    await expect(service.start(ORG_ID, SOURCE_ID, DEVICE_A)).resolves.toEqual({ conflict: true });
    expect(h.raw.transaction).toHaveBeenCalledTimes(2);
    expect(h.raw.execute).toHaveBeenCalledTimes(2);
    expect(h.raw.insert).toHaveBeenCalledTimes(1);
  });

  it('stores an SMB run with a null device id and zero device key', async () => {
    const h = makeDb([[]], [], 'smb_share');
    await createCrawlRunsService(h.db).start(ORG_ID, SOURCE_ID, DEVICE_A);
    expect(h.insertValues[0]).toMatchObject({
      orgId: ORG_ID, sourceId: SOURCE_ID, deviceId: null, deviceKey: ZERO_UUID,
    });
  });

  it('rejects SMB start from an unassigned device', async () => {
    const h = makeDb([[]], [], 'smb_share');
    await expect(createCrawlRunsService(h.db).start(ORG_ID, SOURCE_ID, DEVICE_B))
      .rejects.toThrow('Workspace source is not assigned to this device');
    expect(h.raw.insert).not.toHaveBeenCalled();
  });

  it('returns null for SMB active lookup from an unassigned device', async () => {
    const h = makeDb([[run({ deviceId: null, deviceKey: ZERO_UUID })]], [], 'smb_share');
    await expect(createCrawlRunsService(h.db).getActive(ORG_ID, SOURCE_ID, DEVICE_B)).resolves.toBeNull();
  });

  it('returns notFound for SMB finish from an unassigned device', async () => {
    const h = makeDb([[run({ deviceId: null, deviceKey: ZERO_UUID })]], [], 'smb_share');
    await expect(createCrawlRunsService(h.db).finish(ORG_ID, RUN_ID, DEVICE_B, { complete: false }))
      .resolves.toEqual({ notFound: true });
    expect(h.raw.update).not.toHaveBeenCalled();
  });

  it('finds an SMB active run through its zero-key dimension', async () => {
    const smbRun = run({ deviceId: null, deviceKey: ZERO_UUID });
    const db = {
      select: vi.fn(() => ({
        from: vi.fn((table: unknown) => ({
          where: vi.fn((condition: unknown) => ({
            limit: vi.fn(async () => {
              if (table === workspaceSources) return [{ kind: 'smb_share', crawlDeviceId: DEVICE_A }];
              const values = boundValues(condition);
              return values.includes(ZERO_UUID) ? [smbRun] : [];
            }),
          })),
        })),
      })),
    } as unknown as WorkspaceDatabase;
    await expect(createCrawlRunsService(db).getActive(ORG_ID, SOURCE_ID, DEVICE_A)).resolves.toEqual(smbRun);
  });

  it('finishes an SMB run by resolving its zero-key dimension', async () => {
    const smbRun = run({ deviceId: null, deviceKey: ZERO_UUID });
    const updateSets: unknown[] = [];
    const selectedTables: unknown[] = [];
    const rawDb = {
      select: vi.fn(() => ({
        from: vi.fn((table: unknown) => {
          selectedTables.push(table);
          return {
            where: vi.fn((condition: unknown) => ({
              limit: vi.fn(async () => {
                if (table === workspaceSources) return [{ kind: 'smb_share', crawlDeviceId: DEVICE_A }];
                const values = boundValues(condition);
                return values.includes(RUN_ID) ? [smbRun] : [];
              }),
            })),
          };
        }),
      })),
      update: vi.fn(() => ({
        set: vi.fn((value: unknown) => {
          updateSets.push(value);
          return { where: vi.fn(() => ({ returning: vi.fn(async () => [{ id: RUN_ID }]) })) };
        }),
      })),
      execute: vi.fn(async () => []),
    };
    const db = Object.assign(rawDb, {
      transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(rawDb)),
    });
    await expect(createCrawlRunsService(db as unknown as WorkspaceDatabase).finish(ORG_ID, RUN_ID, DEVICE_A, {
      complete: false, errorReason: 'network timeout',
    })).resolves.toEqual({ tombstoned: 0 });
    expect(updateSets[0]).toMatchObject({ status: 'failed' });
    expect(selectedTables).toContain(workspaceSources);
  });

  it('touches activity, cursor, and increments seen stats in one run update', async () => {
    const h = makeDb();
    await createCrawlRunsService(h.db).touch(ORG_ID, RUN_ID, 'next-page', { seen: 17 });
    expect(h.updateTables).toEqual([workspaceCrawlRuns]);
    expect(h.updateSets[0]).toMatchObject({ cursor: 'next-page' });
    expectDatabaseNow((h.updateSets[0] as Record<string, unknown>).lastActivityAt);
    expect(h.updateSets[0]).toHaveProperty('stats');
  });

  it('touch scopes on org, run, and running status, and reports the updated count', async () => {
    const conditions: unknown[] = [];
    const makeTouchDb = (returningRows: unknown[]) => ({
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn((condition: unknown) => {
            conditions.push(condition);
            return { returning: vi.fn(async () => returningRows) };
          }),
        })),
      })),
    }) as unknown as WorkspaceDatabase;

    await expect(createCrawlRunsService(makeTouchDb([{ id: RUN_ID }]))
      .touch(ORG_ID, RUN_ID, 'cursor', { seen: 1 })).resolves.toBe(1);
    expect(boundValues(conditions[0])).toEqual(
      expect.arrayContaining([ORG_ID, RUN_ID, 'running']),
    );
    expect(containsIdentity(conditions[0], workspaceCrawlRuns.orgId)).toBe(true);
    expect(containsIdentity(conditions[0], workspaceCrawlRuns.id)).toBe(true);
    expect(containsIdentity(conditions[0], workspaceCrawlRuns.status)).toBe(true);

    // 0 means the run went terminal and the cursor/stats were NOT persisted —
    // the route must turn this into a 409 rather than reporting success.
    await expect(createCrawlRunsService(makeTouchDb([]))
      .touch(ORG_ID, RUN_ID, 'cursor', { seen: 1 })).resolves.toBe(0);
  });

  it('an incomplete finish never sweeps and marks an auth failure on the source', async () => {
    const h = makeDb([[run()]], [[{ id: RUN_ID }], []]);
    await expect(createCrawlRunsService(h.db).finish(ORG_ID, RUN_ID, DEVICE_A, {
      complete: false, errorReason: 'Authentication denied', stats: { seen: 4 },
    })).resolves.toEqual({ tombstoned: 0 });
    expect(h.updateTables).toEqual([workspaceCrawlRuns, workspaceSources]);
    expect(h.updateTables).not.toContain(workspaceFileIndex);
    expect(h.updateSets[0]).toMatchObject({
      status: 'failed', errorReason: 'Authentication denied', stats: { seen: 4 },
    });
    expectDatabaseNow((h.updateSets[0] as Record<string, unknown>).completedAt);
    expectDatabaseNow((h.updateSets[0] as Record<string, unknown>).lastActivityAt);
    expectDatabaseNow((h.updateSets[1] as Record<string, unknown>).updatedAt);
    expect(h.updateSets[1]).toMatchObject({ status: 'error', errorReason: 'Authentication denied' });
    expect(h.raw.transaction).toHaveBeenCalledTimes(1);
    expect(h.raw.execute).toHaveBeenCalledTimes(1);
  });

  it('a non-auth failure records the reason on the source without flipping status, and never sweeps', async () => {
    const h = makeDb([[run()]], [[{ id: RUN_ID }]]);
    await createCrawlRunsService(h.db).finish(ORG_ID, RUN_ID, DEVICE_A, {
      complete: false, errorReason: 'network timeout',
    });
    // The failure must be visible on the source (errorReason) so admins can
    // see a crawl that stopped advancing — but only auth failures park the
    // source in status 'error'.
    expect(h.updateTables).toEqual([workspaceCrawlRuns, workspaceSources]);
    expect(h.updateTables).not.toContain(workspaceFileIndex);
    expect(h.updateSets[1]).toMatchObject({ errorReason: 'network timeout' });
    expect(h.updateSets[1]).not.toHaveProperty('status');
  });

  it('a failed finish without an error reason still surfaces a fallback reason on the source', async () => {
    const h = makeDb([[run()]], [[{ id: RUN_ID }]]);
    await createCrawlRunsService(h.db).finish(ORG_ID, RUN_ID, DEVICE_A, { complete: false });
    expect(h.updateSets[1]).toMatchObject({ errorReason: 'crawl failed' });
    expect(h.updateSets[1]).not.toHaveProperty('status');
  });

  it('finishing an already-terminal owned run is an idempotent no-op', async () => {
    const h = makeDb([[run({ status: 'complete' })]]);
    await expect(createCrawlRunsService(h.db).finish(ORG_ID, RUN_ID, DEVICE_A, { complete: true }))
      .resolves.toEqual({ alreadyFinished: true });
    expect(h.raw.update).not.toHaveBeenCalled();
    expect(h.raw.insert).not.toHaveBeenCalled();
  });

  it('allows only one terminal transition across duplicate failed finishes', async () => {
    const h = makeDb([[run()], []], [[{ id: RUN_ID }]]);
    const service = createCrawlRunsService(h.db);
    await expect(service.finish(ORG_ID, RUN_ID, DEVICE_A, { complete: false })).resolves.toEqual({ tombstoned: 0 });
    await expect(service.finish(ORG_ID, RUN_ID, DEVICE_A, { complete: false })).resolves.toEqual({ notFound: true });
    expect(h.updateTables.filter((table) => table === workspaceCrawlRuns)).toHaveLength(1);
    expect(h.raw.transaction).toHaveBeenCalledTimes(2);
  });

  it('rolls back a failed auth terminal transition when the source update fails', async () => {
    let status = 'running';
    const db: Record<string, unknown> = {};
    db.execute = vi.fn(async () => []);
    db.select = vi.fn(() => ({
      from: vi.fn((table: unknown) => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => table === workspaceSources
            ? [{ kind: 'local_profile', crawlDeviceId: DEVICE_A }]
            : status === 'running' ? [run({ status })] : []),
        })),
      })),
    }));
    db.update = vi.fn((table: unknown) => ({
      set: vi.fn((setValue: { status?: string }) => ({
        where: vi.fn(() => ({
          returning: vi.fn(async () => {
            if (table === workspaceSources) throw new Error('source update failed');
            if (table === workspaceCrawlRuns) status = setValue.status ?? status;
            return [{ id: RUN_ID }];
          }),
        })),
      })),
    }));
    db.transaction = vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
      const snapshot = status;
      try { return await callback(db); } catch (error) { status = snapshot; throw error; }
    });
    await expect(createCrawlRunsService(db as unknown as WorkspaceDatabase).finish(
      ORG_ID, RUN_ID, DEVICE_A, { complete: false, errorReason: 'auth denied' },
    )).rejects.toThrow('source update failed');
    expect(status).toBe('running');
  });

  it('a complete finish performs one device-scoped sweep then completes run and source', async () => {
    const h = makeStatefulFinishDb();
    await expect(createCrawlRunsService(h.db).finish(ORG_ID, RUN_ID, DEVICE_A, {
      complete: true, stats: { seen: 12 },
    })).resolves.toEqual({ tombstoned: 1 });

    expect(h.updateTables).toEqual([workspaceCrawlRuns, workspaceFileIndex, workspaceSources]);
    expect(h.updateTables.filter((table) => table === workspaceFileIndex)).toHaveLength(1);
    expect(h.raw.transaction).toHaveBeenCalledTimes(1);
    expect(h.files[0]).toMatchObject({ deviceKey: DEVICE_A, deletedAt: expect.any(Date) });
    expect(h.files.slice(1).every((file) => file.deletedAt === null)).toBe(true);
    expect(h.runs.filter((row) => row.status === 'complete')).toHaveLength(1);
    expectDatabaseNow((h.updateSets[0] as Record<string, unknown>).completedAt);
    expectDatabaseNow((h.updateSets[0] as Record<string, unknown>).lastActivityAt);
    expectDatabaseNow((h.updateSets[1] as Record<string, unknown>).deletedAt);
    expectDatabaseNow((h.updateSets[1] as Record<string, unknown>).updatedAt);
    expectDatabaseNow((h.updateSets[2] as Record<string, unknown>).lastCompleteRunAt);
    expectDatabaseNow((h.updateSets[2] as Record<string, unknown>).updatedAt);
    // The ownership lookup no longer filters on status (idempotency needs the
    // terminal row); the status guard lives in the transition UPDATE.
    const firstLookup = h.runConditions[0];
    expect(boundValues(firstLookup)).toEqual(expect.arrayContaining([ORG_ID, RUN_ID]));
    expect(containsIdentity(firstLookup, workspaceCrawlRuns.orgId)).toBe(true);
    expect(containsIdentity(firstLookup, workspaceCrawlRuns.id)).toBe(true);
    const transitionUpdate = h.runConditions[1];
    expect(boundValues(transitionUpdate)).toEqual(expect.arrayContaining([ORG_ID, RUN_ID, 'running']));
    expect(containsIdentity(transitionUpdate, workspaceCrawlRuns.status)).toBe(true);
    const runUpdates = h.updateTables.filter((table) => table === workspaceCrawlRuns).length;
    const sweeps = h.updateTables.filter((table) => table === workspaceFileIndex).length;
    // A retried complete (lost response) answers idempotently and re-runs
    // neither the transition nor the sweep.
    await expect(createCrawlRunsService(h.db).finish(ORG_ID, RUN_ID, DEVICE_A, { complete: true }))
      .resolves.toEqual({ alreadyFinished: true });
    expect(h.updateTables.filter((table) => table === workspaceCrawlRuns)).toHaveLength(runUpdates);
    expect(h.updateTables.filter((table) => table === workspaceFileIndex)).toHaveLength(sweeps);
  });

  it('rolls back a completed sweep when the source completion update fails', async () => {
    const h = makeStatefulFinishDb({ failSourceUpdate: true });
    await expect(createCrawlRunsService(h.db).finish(ORG_ID, RUN_ID, DEVICE_A, { complete: true }))
      .rejects.toThrow('source update failed');
    expect(h.raw.transaction).toHaveBeenCalledTimes(1);
    expect(h.files.every((file) => file.deletedAt === null)).toBe(true);
    expect(h.runs.at(-1)?.status).toBe('running');
  });

  it('returns notFound without writes when the scoped run is absent or device mismatched', async () => {
    const h = makeDb([[]]);
    await expect(createCrawlRunsService(h.db).finish(ORG_ID, RUN_ID, DEVICE_A, { complete: true }))
      .resolves.toEqual({ notFound: true });
    expect(h.raw.update).not.toHaveBeenCalled();
  });

  it('gets the active run or null for a source and device', async () => {
    const row = run();
    const h = makeDb([[row], []]);
    const service = createCrawlRunsService(h.db);
    await expect(service.getActive(ORG_ID, SOURCE_ID, DEVICE_A)).resolves.toEqual(row);
    await expect(service.getActive(ORG_ID, SOURCE_ID, DEVICE_A)).resolves.toBeNull();
  });

  it('gets a run by org and id while hiding cross-org and missing rows', async () => {
    const crossOrg = run({ orgId: DEVICE_B });
    const correct = run();
    const rows = [crossOrg, correct];
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn((condition: unknown) => ({
            limit: vi.fn(async () => {
              const values = boundValues(condition);
              return rows.filter((row) =>
                values.includes(row.orgId) && values.includes(row.id)).slice(0, 1);
            }),
          })),
        })),
      })),
    } as unknown as WorkspaceDatabase;
    const service = createCrawlRunsService(db);

    await expect(service.getById(ORG_ID, RUN_ID)).resolves.toEqual(correct);
    rows.pop();
    await expect(service.getById(ORG_ID, RUN_ID)).resolves.toBeNull();
    await expect(service.getById(ORG_ID, WRONG_RUN_ID)).resolves.toBeNull();
  });
});
