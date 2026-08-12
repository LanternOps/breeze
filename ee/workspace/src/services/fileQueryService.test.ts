import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceDatabase } from '../hostTypes';
import { workspaceSources } from '../schema/workspace';
import { SHARED_DEVICE_KEY } from './runScope';
import { createFileQueryService } from './fileQueryService';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const DEVICE_ID = '33333333-3333-3333-3333-333333333333';
const OTHER_DEVICE_ID = '44444444-4444-4444-4444-444444444444';
const SMB_SOURCE_ID = '22222222-2222-2222-2222-222222222222';
const LOCAL_SOURCE_ID = '55555555-5555-5555-5555-555555555555';
const HIDDEN_SOURCE_ID = '66666666-6666-6666-6666-666666666666';
const PAUSED_SOURCE_ID = '77777777-7777-7777-7777-777777777777';
const FILE_ID = '88888888-8888-8888-8888-888888888888';
const UNKNOWN_ID = '99999999-9999-9999-9999-999999999999';

/** Bound parameter values reachable from a drizzle condition (Params only). */
function boundValues(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.flatMap(boundValues);
  if (!value || typeof value !== 'object') return [];
  const candidate = value as { value?: unknown; queryChunks?: unknown[] };
  const own = 'encoder' in candidate && Object.prototype.hasOwnProperty.call(candidate, 'value')
    ? [candidate.value]
    : [];
  return [...own, ...(candidate.queryChunks ?? []).flatMap(boundValues)];
}

/** Approximate SQL text of a drizzle expression (columns as bare names, params as ?). */
function sqlText(value: unknown): string {
  if (value == null) return '';
  if (Array.isArray(value)) return value.map(sqlText).join('');
  if (typeof value !== 'object') return String(value);
  const c = value as Record<string, unknown>;
  if ('encoder' in c) return '?';
  if (Array.isArray(c.queryChunks)) return (c.queryChunks as unknown[]).map(sqlText).join('');
  if (Array.isArray(c.value) && (c.value as unknown[]).every((x) => typeof x === 'string')) {
    return (c.value as string[]).join('');
  }
  if (typeof c.name === 'string') return c.name;
  return '';
}

function sourceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: SMB_SOURCE_ID,
    orgId: ORG_ID,
    kind: 'smb_share',
    displayName: 'Alder Creek',
    rootPath: '\\\\srv\\share',
    status: 'active',
    visibilityGroupIds: [] as string[],
    ...overrides,
  };
}

function fileRow(overrides: Record<string, unknown> = {}) {
  return {
    id: FILE_ID,
    orgId: ORG_ID,
    sourceId: SMB_SOURCE_ID,
    deviceId: null,
    deviceKey: SHARED_DEVICE_KEY,
    relPath: 'a/b.pdf',
    parentPath: 'a',
    name: 'b.pdf',
    isDir: false,
    ext: 'pdf',
    mime: null,
    size: 10,
    mtime: new Date('2026-07-01T00:00:00Z'),
    ctime: null,
    attrs: {},
    lastSeenAt: new Date(),
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

const smbSource = sourceRow();
const localSource = sourceRow({
  id: LOCAL_SOURCE_ID, kind: 'local_profile', displayName: 'Profiles', rootPath: '/Users',
});
const hiddenSource = sourceRow({
  id: HIDDEN_SOURCE_ID, displayName: 'Hidden', visibilityGroupIds: ['g1'],
});
const pausedSource = sourceRow({ id: PAUSED_SOURCE_ID, displayName: 'Paused', status: 'paused' });

/** Emulates the sources query: org bound, active status bound, '[]'::jsonb inline. */
function sourceMatches(row: ReturnType<typeof sourceRow>, condition: unknown): boolean {
  const values = boundValues(condition);
  const text = sqlText(condition);
  if (!values.includes(row.orgId)) return false;
  if (values.includes('active') && row.status !== 'active') return false;
  if (text.includes("'[]'::jsonb") && (row.visibilityGroupIds as string[]).length > 0) return false;
  return true;
}

/**
 * Emulates file-index predicates from what the service binds: a row is only
 * reachable when its sourceId and deviceKey were both bound (partition rule),
 * tombstones require an explicit deleted_at IS NULL predicate, and a bound
 * `false` (is_dir = false) excludes directories.
 */
function fileMatches(row: ReturnType<typeof fileRow>, condition: unknown): boolean {
  const values = boundValues(condition);
  const text = sqlText(condition);
  if (!values.includes(row.sourceId)) return false;
  if (!values.includes(row.deviceKey)) return false;
  if (text.includes('deleted_at') && text.includes('is null') && row.deletedAt) return false;
  if (values.includes(false) && row.isDir) return false;
  return true;
}

function makeDb(
  sources: Array<ReturnType<typeof sourceRow>> = [],
  files: Array<ReturnType<typeof fileRow>> = [],
) {
  const captured = {
    limits: [] as number[],
    orderBys: [] as unknown[][],
    fileWheres: [] as unknown[],
    fileQueries: 0,
  };
  const db = {
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => {
        if (table === workspaceSources) {
          return {
            where: vi.fn((condition: unknown) => ({
              orderBy: vi.fn(async () => sources.filter((row) => sourceMatches(row, condition))),
            })),
          };
        }
        captured.fileQueries += 1;
        return {
          where: vi.fn((condition: unknown) => {
            captured.fileWheres.push(condition);
            const matched = files.filter((row) => fileMatches(row, condition));
            return {
              orderBy: vi.fn((...exprs: unknown[]) => {
                captured.orderBys.push(exprs);
                return Object.assign(Promise.resolve(matched), {
                  limit: vi.fn(async (n: number) => {
                    captured.limits.push(n);
                    return matched.slice(0, n);
                  }),
                });
              }),
              // Direct .limit (no orderBy) is the single-row getFile path: the
              // id must have been bound for a row to be reachable.
              limit: vi.fn(async (n: number) =>
                matched.filter((row) => boundValues(condition).includes(row.id)).slice(0, n)),
            };
          }),
        };
      }),
    })),
  };
  return { db: db as unknown as WorkspaceDatabase, captured };
}

describe('fileQueryService', () => {
  describe('visibleSources', () => {
    it('fails closed: only active sources with an empty visibility group list', async () => {
      const { db } = makeDb([smbSource, localSource, hiddenSource, pausedSource]);
      const result = await createFileQueryService(db).visibleSources(ORG_ID);
      expect(result.map((s) => s.id)).toEqual([SMB_SOURCE_ID, LOCAL_SOURCE_ID]);
    });
  });

  describe('search', () => {
    it('returns visible smb rows with a UNC openPath; hidden-source and tombstoned rows never appear', async () => {
      const { db } = makeDb(
        [smbSource, hiddenSource],
        [
          fileRow({ score: 0.9 }),
          fileRow({ id: UNKNOWN_ID, sourceId: HIDDEN_SOURCE_ID, name: 'b-hidden.pdf' }),
          fileRow({ id: PAUSED_SOURCE_ID, name: 'b-gone.pdf', deletedAt: new Date() }),
        ],
      );
      const results = await createFileQueryService(db).search(ORG_ID, DEVICE_ID, { q: 'b' });
      expect(results).toEqual([{
        id: FILE_ID,
        sourceId: SMB_SOURCE_ID,
        deviceKey: SHARED_DEVICE_KEY,
        relPath: 'a/b.pdf',
        parentPath: 'a',
        name: 'b.pdf',
        isDir: false,
        ext: 'pdf',
        size: 10,
        mtime: '2026-07-01T00:00:00.000Z',
        openPath: '\\\\srv\\share\\a\\b.pdf',
        score: 0.9,
      }]);
    });

    it('never returns another device\'s local-profile rows; local openPath is null', async () => {
      const mine = fileRow({ sourceId: LOCAL_SOURCE_ID, deviceId: DEVICE_ID, deviceKey: DEVICE_ID });
      const theirs = fileRow({
        id: UNKNOWN_ID, sourceId: LOCAL_SOURCE_ID, deviceId: OTHER_DEVICE_ID, deviceKey: OTHER_DEVICE_ID,
      });
      const { db } = makeDb([localSource], [mine, theirs]);
      const results = await createFileQueryService(db).search(ORG_ID, DEVICE_ID, { q: 'b' });
      expect(results.map((r) => r.id)).toEqual([FILE_ID]);
      expect(results[0]?.openPath).toBeNull();
    });

    it('clamps the limit to 1..100 and defaults to 25', async () => {
      const { db, captured } = makeDb([smbSource], [fileRow()]);
      const service = createFileQueryService(db);
      await service.search(ORG_ID, DEVICE_ID, { q: 'b', limit: 0 });
      await service.search(ORG_ID, DEVICE_ID, { q: 'b', limit: 500 });
      await service.search(ORG_ID, DEVICE_ID, { q: 'b' });
      expect(captured.limits).toEqual([1, 100, 25]);
    });

    it('returns [] without querying the file index when the sourceId filter is hidden or unknown', async () => {
      const { db, captured } = makeDb([smbSource, hiddenSource], [fileRow()]);
      const service = createFileQueryService(db);
      await expect(service.search(ORG_ID, DEVICE_ID, { q: 'b', sourceId: HIDDEN_SOURCE_ID }))
        .resolves.toEqual([]);
      await expect(service.search(ORG_ID, DEVICE_ID, { q: 'b', sourceId: UNKNOWN_ID }))
        .resolves.toEqual([]);
      expect(captured.fileQueries).toBe(0);
    });

    it('orders by trigram score, then mtime desc nulls last', async () => {
      const { db, captured } = makeDb([smbSource], [fileRow()]);
      await createFileQueryService(db).search(ORG_ID, DEVICE_ID, { q: 'b' });
      const order = (captured.orderBys[0] ?? []).map(sqlText);
      expect(order[0]).toContain('greatest(similarity(');
      expect(order[0]).toContain('desc');
      expect(order[1]).toContain('mtime');
      expect(order[1]).toContain('nulls last');
    });

    it('includes project and docType predicates only when set', async () => {
      const { db, captured } = makeDb([smbSource], [fileRow()]);
      const service = createFileQueryService(db);
      await service.search(ORG_ID, DEVICE_ID, { q: 'b' });
      await service.search(ORG_ID, DEVICE_ID, {
        q: 'b', project: 'Henderson Water Main Replacement', docType: 'easement',
      });
      const withoutFilters = sqlText(captured.fileWheres[0]);
      const withFilters = sqlText(captured.fileWheres[1]);
      expect(withoutFilters).not.toContain('inferred_project_label');
      expect(withoutFilters).not.toContain('inferred_doc_type');
      expect(withFilters).toContain('inferred_project_label =');
      expect(withFilters).toContain('inferred_doc_type =');
      // The two guarded EXISTS fragments are raw sql-template interpolations
      // (not drizzle-encoded Params), so their literal values surface in the
      // rendered text itself rather than through boundValues() — which only
      // walks encoder-based Param chunks (eq/inArray/etc elsewhere in the
      // file). sqlText already proves both predicates render with '='.
      expect(withFilters).toContain('Henderson Water Main Replacement');
      expect(withFilters).toContain('easement');
      // Defence-in-depth: each EXISTS is org-correlated to the file-index row.
      expect(withFilters).toContain('wfe.org_id = workspace_file_index.org_id');
    });
  });

  describe('browse', () => {
    it('lists one visible source dirs-first; dirs and local-profile rows carry no openPath', async () => {
      const dir = fileRow({
        id: UNKNOWN_ID, relPath: 'a', parentPath: '', name: 'a', isDir: true, ext: null, size: null,
      });
      const file = fileRow({ relPath: 'b.pdf', parentPath: '', name: 'b.pdf' });
      const { db, captured } = makeDb([smbSource], [dir, file]);
      const entries = await createFileQueryService(db).browse(ORG_ID, DEVICE_ID, SMB_SOURCE_ID, '');
      expect(entries).toHaveLength(2);
      expect(entries.find((e) => e.isDir)?.openPath).toBeNull();
      expect(entries.find((e) => !e.isDir)?.openPath).toBe('\\\\srv\\share\\b.pdf');
      expect(boundValues(captured.fileWheres[0]).includes('')).toBe(true);
      const order = (captured.orderBys[0] ?? []).map(sqlText);
      expect(order[0]).toContain('is_dir');
      expect(order[0]).toContain('desc');
      expect(order[1]).toContain('name');
      expect(order[1]).toContain('asc');
    });

    it('scopes local-profile browsing to the calling device', async () => {
      const mine = fileRow({
        sourceId: LOCAL_SOURCE_ID, deviceId: DEVICE_ID, deviceKey: DEVICE_ID, parentPath: '',
      });
      const theirs = fileRow({
        id: UNKNOWN_ID, sourceId: LOCAL_SOURCE_ID, deviceId: OTHER_DEVICE_ID,
        deviceKey: OTHER_DEVICE_ID, parentPath: '',
      });
      const { db } = makeDb([localSource], [mine, theirs]);
      const entries = await createFileQueryService(db).browse(ORG_ID, DEVICE_ID, LOCAL_SOURCE_ID, '');
      expect(entries.map((e) => e.id)).toEqual([FILE_ID]);
    });

    it('returns [] for a hidden or unknown source without touching the file index', async () => {
      const { db, captured } = makeDb([smbSource, hiddenSource], [fileRow()]);
      const service = createFileQueryService(db);
      await expect(service.browse(ORG_ID, DEVICE_ID, HIDDEN_SOURCE_ID, '')).resolves.toEqual([]);
      await expect(service.browse(ORG_ID, DEVICE_ID, UNKNOWN_ID, '')).resolves.toEqual([]);
      expect(captured.fileQueries).toBe(0);
    });

    it('includes project and docType predicates only when set', async () => {
      const { db, captured } = makeDb([smbSource], [fileRow()]);
      const service = createFileQueryService(db);
      await service.browse(ORG_ID, DEVICE_ID, SMB_SOURCE_ID, '');
      await service.browse(ORG_ID, DEVICE_ID, SMB_SOURCE_ID, '', {
        project: 'Henderson Water Main Replacement', docType: 'easement',
      });
      const withoutFilters = sqlText(captured.fileWheres[0]);
      const withFilters = sqlText(captured.fileWheres[1]);
      expect(withoutFilters).not.toContain('inferred_project_label');
      expect(withoutFilters).not.toContain('inferred_doc_type');
      expect(withFilters).toContain('inferred_project_label =');
      expect(withFilters).toContain('inferred_doc_type =');
      expect(withFilters).toContain('Henderson Water Main Replacement');
      expect(withFilters).toContain('easement');
      // Defence-in-depth: each EXISTS is org-correlated to the file-index row.
      expect(withFilters).toContain('wfe.org_id = workspace_file_index.org_id');
      // Finding 4a: in Browse the enrichment predicates must not hide
      // directories — each is OR'd with is_dir = true so subfolders stay
      // navigable. The bypass binds a boolean `true` that no other browse
      // predicate binds; the unfiltered browse never binds it.
      expect(boundValues(captured.fileWheres[1])).toContain(true);
      expect(boundValues(captured.fileWheres[0])).not.toContain(true);
    });
  });

  describe('getFile', () => {
    it('maps a visible file; unknown, tombstoned, and hidden-source ids resolve to null', async () => {
      const tombstonedId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
      const hiddenFileId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
      const { db } = makeDb(
        [smbSource, hiddenSource],
        [
          fileRow(),
          fileRow({ id: tombstonedId, deletedAt: new Date() }),
          fileRow({ id: hiddenFileId, sourceId: HIDDEN_SOURCE_ID }),
        ],
      );
      const service = createFileQueryService(db);
      await expect(service.getFile(ORG_ID, DEVICE_ID, FILE_ID)).resolves.toMatchObject({
        id: FILE_ID,
        openPath: '\\\\srv\\share\\a\\b.pdf',
        mtime: '2026-07-01T00:00:00.000Z',
      });
      await expect(service.getFile(ORG_ID, DEVICE_ID, tombstonedId)).resolves.toBeNull();
      await expect(service.getFile(ORG_ID, DEVICE_ID, hiddenFileId)).resolves.toBeNull();
      await expect(service.getFile(ORG_ID, DEVICE_ID, UNKNOWN_ID)).resolves.toBeNull();
    });
  });
});
