import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceDatabase } from '../hostTypes';
import { workspaceCrawlRuns, workspaceSources } from '../schema/workspace';
import { createSourcesService, type SourceInput } from './sourcesService';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const SOURCE_ID = '22222222-2222-2222-2222-222222222222';
const DEVICE_ID = '33333333-3333-3333-3333-333333333333';
const OTHER_DEVICE_ID = '44444444-4444-4444-4444-444444444444';

function boundValues(value: unknown): unknown[] {
  if (!value || typeof value !== 'object') return [];
  const candidate = value as { value?: unknown; queryChunks?: unknown[] };
  const own = Object.prototype.hasOwnProperty.call(candidate, 'value') ? [candidate.value] : [];
  return [...own, ...(candidate.queryChunks ?? []).flatMap(boundValues)];
}

function source(overrides: Record<string, unknown> = {}) {
  return {
    id: SOURCE_ID,
    orgId: ORG_ID,
    kind: 'local_profile',
    displayName: 'Profiles',
    rootPath: '/Users',
    crawlDeviceId: DEVICE_ID,
    visibilityGroupIds: [],
    credentialEnc: null,
    excludeGlobs: [],
    watch: true,
    crawlCadenceMinutes: 60,
    crawlCursor: {},
    status: 'active',
    statusDetail: null,
    errorReason: null,
    lastCompleteRunAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

// Mirror of the service's redaction: consumers get rows without credentialEnc
// plus a computed hasCredential.
function safe(row: Record<string, unknown>) {
  const { credentialEnc, ...rest } = row;
  return { ...rest, hasCredential: Boolean(credentialEnc) };
}

const input: SourceInput = {
  kind: 'local_profile',
  displayName: 'Profiles',
  rootPath: '/Users',
  crawlDeviceId: DEVICE_ID,
  visibilityGroupIds: [],
  crawlCadenceMinutes: 60,
  excludeGlobs: ['**/.git/**'],
  watch: true,
  status: 'active',
};

function makeDb(selectResults: unknown[][] = []) {
  let selectIndex = 0;
  const inserted: unknown[] = [];
  const updated: unknown[] = [];
  const selectedTables: unknown[] = [];
  const select = vi.fn(() => ({
    from: vi.fn((table: unknown) => {
      selectedTables.push(table);
      return {
        where: vi.fn(() => ({
          limit: vi.fn(async () => selectResults[selectIndex++] ?? []),
          orderBy: vi.fn(() => table === workspaceCrawlRuns
            ? { limit: vi.fn(async () => selectResults[selectIndex++] ?? []) }
            : Promise.resolve(selectResults[selectIndex++] ?? [])),
        })),
      };
    }),
  }));
  const db = {
    select,
    insert: vi.fn(() => ({
      values: vi.fn((value: unknown) => {
        inserted.push(value);
        return { returning: vi.fn(async () => [source(value as Record<string, unknown>)]) };
      }),
    })),
    update: vi.fn(() => ({
      set: vi.fn((value: unknown) => {
        updated.push(value);
        return {
          where: vi.fn(() => ({
            returning: vi.fn(async () => [source(value as Record<string, unknown>)]),
          })),
        };
      }),
    })),
    delete: vi.fn(() => ({
      where: vi.fn(() => ({ returning: vi.fn(async () => [{ id: SOURCE_ID }]) })),
    })),
  };
  return { db: db as unknown as WorkspaceDatabase, raw: db, inserted, updated, selectedTables };
}

describe('sourcesService', () => {
  it('lists and gets sources scoped through query predicates', async () => {
    const row = source();
    const { db, raw } = makeDb([[row], [row]]);
    const service = createSourcesService(db);

    await expect(service.list(ORG_ID)).resolves.toEqual([safe(row)]);
    await expect(service.get(ORG_ID, SOURCE_ID)).resolves.toEqual(safe(row));
    expect(raw.select).toHaveBeenCalledTimes(2);
  });

  it('never returns credentialEnc and computes hasCredential from it', async () => {
    const withCred = source({ credentialEnc: 'ciphertext' });
    const { db } = makeDb([[withCred]]);
    const result = await createSourcesService(db).get(ORG_ID, SOURCE_ID);
    expect(result).not.toBeNull();
    expect(result).not.toHaveProperty('credentialEnc');
    expect(result?.hasCredential).toBe(true);
  });

  it('returns null when a source is absent', async () => {
    const { db } = makeDb([[]]);
    await expect(createSourcesService(db).get(ORG_ID, SOURCE_ID)).resolves.toBeNull();
  });

  it('creates a source with the complete input', async () => {
    const { db, inserted } = makeDb();
    const result = await createSourcesService(db).create(ORG_ID, input);
    expect(result.id).toBe(SOURCE_ID);
    expect(inserted).toEqual([expect.objectContaining({ orgId: ORG_ID, ...input })]);
  });

  it.each([
    [{ ...input, kind: 'smb_share', crawlDeviceId: null, rootPath: '\\\\server\\share' }, 'crawlDeviceId'],
    [{ ...input, kind: 'smb_share', crawlDeviceId: DEVICE_ID, rootPath: '/mnt/share' }, 'UNC'],
  ] as const)('rejects invalid SMB input', async (badInput, message) => {
    const { db, raw } = makeDb();
    await expect(createSourcesService(db).create(ORG_ID, badInput)).rejects.toThrow(message);
    expect(raw.insert).not.toHaveBeenCalled();
  });

  it('updates a source and returns null when no scoped row matches', async () => {
    const first = makeDb();
    await expect(createSourcesService(first.db).update(ORG_ID, SOURCE_ID, { status: 'paused' }))
      .resolves.toMatchObject({ status: 'paused' });
    expect(first.updated[0]).toMatchObject({ status: 'paused', updatedAt: expect.any(Date) });

    const second = makeDb();
    second.raw.update.mockReturnValueOnce({
      set: vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn(async () => []) })) })),
    });
    await expect(createSourcesService(second.db).update(ORG_ID, SOURCE_ID, {})).resolves.toBeNull();
  });

  it('removes only a matching scoped source', async () => {
    const yes = makeDb();
    await expect(createSourcesService(yes.db).remove(ORG_ID, SOURCE_ID)).resolves.toBe(true);

    const no = makeDb();
    no.raw.delete.mockReturnValueOnce({
      where: vi.fn(() => ({ returning: vi.fn(async () => []) })),
    });
    await expect(createSourcesService(no.db).remove(ORG_ID, SOURCE_ID)).resolves.toBe(false);
  });

  it('lists active local-profile and assigned sources for a device', async () => {
    const activeLocal = source({ id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' });
    const assignedSmb = source({
      id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', kind: 'smb_share', crawlDeviceId: DEVICE_ID,
    });
    const paused = source({ id: 'cccccccc-cccc-cccc-cccc-cccccccccccc', status: 'paused' });
    const wrongDeviceSmb = source({
      id: 'dddddddd-dddd-dddd-dddd-dddddddddddd', kind: 'smb_share', crawlDeviceId: OTHER_DEVICE_ID,
    });
    const crossOrgLocal = source({ id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', orgId: OTHER_DEVICE_ID });
    const rows = [activeLocal, assignedSmb, paused, wrongDeviceSmb, crossOrgLocal];
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn((condition: unknown) => ({
            orderBy: vi.fn(async () => {
              const values = boundValues(condition);
              return rows.filter((row) =>
                (!values.includes(ORG_ID) || row.orgId === ORG_ID) &&
                (!values.includes('active') || row.status === 'active') &&
                (
                  !values.includes('local_profile') ||
                  row.kind === 'local_profile' ||
                  !values.includes(DEVICE_ID) ||
                  row.crawlDeviceId === DEVICE_ID
                ));
            }),
          })),
        })),
      })),
    } as unknown as WorkspaceDatabase;

    await expect(createSourcesService(db).listForDevice(ORG_ID, DEVICE_ID))
      .resolves.toEqual([safe(activeLocal), safe(assignedSmb)]);
  });

  it('lists crawl runs from the runs table with the requested limit', async () => {
    const run = { id: '55555555-5555-5555-5555-555555555555', sourceId: SOURCE_ID };
    const { db, selectedTables } = makeDb([[run]]);
    await expect(createSourcesService(db).listRuns(ORG_ID, SOURCE_ID, 7)).resolves.toEqual([run]);
    expect(selectedTables).toEqual([workspaceCrawlRuns]);
    expect(selectedTables).not.toContain(workspaceSources);
  });

  it('uses exact org/source predicates for get, update, remove, and listRuns', async () => {
    const crossOrg = source({ orgId: OTHER_DEVICE_ID });
    const wrongId = source({ id: OTHER_DEVICE_ID });
    const correct = source();
    const sources = [crossOrg, wrongId, correct];
    const runs = [
      { id: 'cross-org', orgId: OTHER_DEVICE_ID, sourceId: SOURCE_ID },
      { id: 'wrong-source', orgId: ORG_ID, sourceId: OTHER_DEVICE_ID },
      { id: 'correct-run', orgId: ORG_ID, sourceId: SOURCE_ID },
    ];
    const filter = (rows: Array<Record<string, unknown>>, condition: unknown) => {
      const values = boundValues(condition);
      return rows.filter((row) =>
        (!values.includes(ORG_ID) || row.orgId === ORG_ID) &&
        (!values.includes(SOURCE_ID) || row.id === SOURCE_ID || row.sourceId === SOURCE_ID));
    };
    const db = {
      select: vi.fn(() => ({
        from: vi.fn((table: unknown) => ({
          where: vi.fn((condition: unknown) => ({
            limit: vi.fn(async (limit: number) => filter(table === workspaceSources ? sources : runs, condition).slice(0, limit)),
            orderBy: vi.fn(() => table === workspaceCrawlRuns
              ? { limit: vi.fn(async (limit: number) => filter(runs, condition).slice(0, limit)) }
              : Promise.resolve(filter(sources, condition))),
          })),
        })),
      })),
      update: vi.fn(() => ({
        set: vi.fn((patch: Record<string, unknown>) => ({
          where: vi.fn((condition: unknown) => ({
            returning: vi.fn(async () => {
              const matches = filter(sources, condition);
              matches.forEach((row) => Object.assign(row, patch));
              return matches;
            }),
          })),
        })),
      })),
      delete: vi.fn(() => ({
        where: vi.fn((condition: unknown) => ({
          returning: vi.fn(async () => {
            const matches = filter(sources, condition);
            matches.forEach((row) => sources.splice(sources.indexOf(row as typeof correct), 1));
            return matches.map(({ id }) => ({ id }));
          }),
        })),
      })),
    } as unknown as WorkspaceDatabase;
    const service = createSourcesService(db);
    await expect(service.get(ORG_ID, SOURCE_ID)).resolves.toMatchObject({ orgId: ORG_ID, id: SOURCE_ID });
    await expect(service.update(ORG_ID, SOURCE_ID, { status: 'paused' }))
      .resolves.toMatchObject({ orgId: ORG_ID, id: SOURCE_ID });
    expect(crossOrg.status).toBe('active');
    expect(wrongId.status).toBe('active');
    await expect(service.listRuns(ORG_ID, SOURCE_ID, 10)).resolves.toEqual([runs[2]]);
    await expect(service.remove(ORG_ID, SOURCE_ID)).resolves.toBe(true);
    expect(sources).toEqual([crossOrg, wrongId]);
    expect(sources.some((row) => row.id === OTHER_DEVICE_ID && row.orgId === ORG_ID)).toBe(true);
  });

  it('plain list derives tenant filtering from the bound org value', async () => {
    const crossOrg = source({ orgId: OTHER_DEVICE_ID });
    const correct = source();
    const rows = [crossOrg, correct];
    const db = { select: vi.fn(() => ({ from: vi.fn(() => ({
      where: vi.fn((condition: unknown) => ({ orderBy: vi.fn(async () => {
        const values = boundValues(condition);
        return rows.filter((row) => !values.includes(ORG_ID) || row.orgId === ORG_ID);
      }) })),
    })) })) } as unknown as WorkspaceDatabase;
    await expect(createSourcesService(db).list(ORG_ID)).resolves.toEqual([safe(correct)]);
  });

  it('clears the stored credential when a patch flips the kind to local_profile', async () => {
    const flip = makeDb();
    await createSourcesService(flip.db).update(ORG_ID, SOURCE_ID, { kind: 'local_profile' });
    expect(flip.updated[0]).toMatchObject({ kind: 'local_profile', credentialEnc: null });

    const keep = makeDb();
    await createSourcesService(keep.db).update(ORG_ID, SOURCE_ID, { status: 'paused' });
    expect(keep.updated[0]).not.toHaveProperty('credentialEnc');
  });
});
