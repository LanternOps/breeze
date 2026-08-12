import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceDatabase } from '../hostTypes';
import { SHARED_DEVICE_KEY } from './runScope';
import { createActivityService } from './activityService';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const SMB_SOURCE_ID = '22222222-2222-2222-2222-222222222222';
const DEVICE_ID = '33333333-3333-3333-3333-333333333333';
const FILE_ID = '88888888-8888-8888-8888-888888888888';

/**
 * Values reachable from a raw drizzle sql template. Raw templates store bound
 * params as bare primitives between StringChunks (crawlRunsService.test.ts
 * convention), so primitives count as bound values here.
 */
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

/** A joined activity/file/source row as raw execute() returns it (snake_case, bigint as string). */
function joinedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: FILE_ID,
    source_id: SMB_SOURCE_ID,
    device_key: SHARED_DEVICE_KEY,
    rel_path: 'a/b.pdf',
    parent_path: 'a',
    name: 'b.pdf',
    is_dir: false,
    ext: 'pdf',
    size: '10',
    mtime: new Date('2026-07-01T00:00:00Z'),
    kind: 'smb_share',
    root_path: '\\\\srv\\share',
    last_activity_at: new Date('2026-07-02T00:00:00Z'),
    ...overrides,
  };
}

function makeDb(executeResults: unknown[][] = []) {
  let executeIndex = 0;
  const executed: unknown[] = [];
  const insertValues: unknown[] = [];
  const db = {
    execute: vi.fn(async (query: unknown) => {
      executed.push(query);
      return executeResults[executeIndex++] ?? [];
    }),
    insert: vi.fn(() => ({
      values: vi.fn(async (value: unknown) => {
        insertValues.push(value);
      }),
    })),
  };
  return { db: db as unknown as WorkspaceDatabase, raw: db, executed, insertValues };
}

const MAPPED_SMB_FILE = {
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
};

describe('activityService', () => {
  describe('record', () => {
    it('returns notFound and writes nothing when the file is unknown, tombstoned, or hidden', async () => {
      const { db, raw, executed, insertValues } = makeDb([[]]);
      const result = await createActivityService(db).record(ORG_ID, {
        fileIndexId: FILE_ID, deviceId: DEVICE_ID, helperUser: 'Dana', action: 'open',
      });
      expect(result).toEqual({ notFound: true });
      expect(raw.insert).not.toHaveBeenCalled();
      expect(insertValues).toEqual([]);
      // The verification query itself must encode every fail-closed rule.
      const text = sqlText(executed[0]);
      expect(text).toContain('deleted_at is null');
      expect(text).toContain("'[]'::jsonb");
      expect(text).toContain("'active'");
      const values = boundValues(executed[0]);
      expect(values).toContain(ORG_ID);
      expect(values).toContain(FILE_ID);
      expect(values).toContain(DEVICE_ID);
      expect(values).toContain(SHARED_DEVICE_KEY);
    });

    it('inserts a device-attributed row with null user_id and the helper label', async () => {
      const { db, insertValues } = makeDb([[{ id: FILE_ID }]]);
      const result = await createActivityService(db).record(ORG_ID, {
        fileIndexId: FILE_ID, deviceId: DEVICE_ID, helperUser: 'Dana', action: 'copy_path',
      });
      expect(result).toEqual({ recorded: true });
      expect(insertValues).toEqual([{
        orgId: ORG_ID,
        userId: null,
        fileIndexId: FILE_ID,
        deviceId: DEVICE_ID,
        helperUser: 'Dana',
        action: 'copy_path',
      }]);
    });

    it('inserts a null helper label unchanged', async () => {
      const { db, insertValues } = makeDb([[{ id: FILE_ID }]]);
      await createActivityService(db).record(ORG_ID, {
        fileIndexId: FILE_ID, deviceId: DEVICE_ID, helperUser: null, action: 'open',
      });
      expect(insertValues[0]).toMatchObject({ userId: null, helperUser: null, action: 'open' });
    });
  });

  describe('recents', () => {
    it('returns the latest activity per file, newest first, mapped like search results', async () => {
      const { db, executed } = makeDb([[joinedRow()]]);
      const result = await createActivityService(db).recents(ORG_ID, DEVICE_ID, null);
      expect(result).toEqual([MAPPED_SMB_FILE]);
      const text = sqlText(executed[0]);
      expect(text).toContain('distinct on (a.file_index_id)');
      expect(text).toContain('order by a.file_index_id, a.created_at desc');
      expect(text).toContain('order by t.last_activity_at desc');
      expect(text).toContain('deleted_at is null');
      expect(text).toContain("'[]'::jsonb");
      const values = boundValues(executed[0]);
      expect(values).toContain(DEVICE_ID);
      expect(values).toContain(SHARED_DEVICE_KEY);
    });

    it('filters by helper label only when one is provided', async () => {
      const { db, executed } = makeDb([[], []]);
      const service = createActivityService(db);
      await service.recents(ORG_ID, DEVICE_ID, 'Dana');
      expect(sqlText(executed[0])).toContain('helper_user');
      expect(boundValues(executed[0])).toContain('Dana');
      await service.recents(ORG_ID, DEVICE_ID, null);
      expect(sqlText(executed[1])).not.toContain('helper_user');
    });

    it('maps local-profile rows to a null openPath', async () => {
      const { db } = makeDb([[joinedRow({ kind: 'local_profile', device_key: DEVICE_ID })]]);
      const result = await createActivityService(db).recents(ORG_ID, DEVICE_ID, null);
      expect(result[0]?.openPath).toBeNull();
    });

    it('clamps the limit to 1..50 and defaults to 20', async () => {
      const { db, executed } = makeDb([[], [], []]);
      const service = createActivityService(db);
      await service.recents(ORG_ID, DEVICE_ID, null, 0);
      await service.recents(ORG_ID, DEVICE_ID, null, 500);
      await service.recents(ORG_ID, DEVICE_ID, null);
      expect(boundValues(executed[0])).toContain(1);
      expect(boundValues(executed[1])).toContain(50);
      expect(boundValues(executed[2])).toContain(20);
    });
  });

  describe('departmentRecent', () => {
    it('aggregates the newest activity per file org-wide with no actor attribution', async () => {
      const { db, executed } = makeDb([[joinedRow()]]);
      const result = await createActivityService(db).departmentRecent(ORG_ID, DEVICE_ID);
      expect(result).toEqual([{ ...MAPPED_SMB_FILE, lastActivityAt: '2026-07-02T00:00:00.000Z' }]);
      const text = sqlText(executed[0]);
      expect(text).toContain('max(a.created_at)');
      expect(text).toContain('group by a.file_index_id');
      // Substrate stays "track work, not workers": no who/which-device columns.
      expect(text).not.toContain('helper_user');
      expect(text).not.toContain('a.device_id');
    });

    it('restricts rows to visible sources and the caller-visible partition', async () => {
      const { db, executed } = makeDb([[]]);
      await createActivityService(db).departmentRecent(ORG_ID, DEVICE_ID);
      const text = sqlText(executed[0]);
      expect(text).toContain("'[]'::jsonb");
      expect(text).toContain("'active'");
      expect(text).toContain('deleted_at is null');
      const values = boundValues(executed[0]);
      expect(values).toContain(DEVICE_ID);
      expect(values).toContain(SHARED_DEVICE_KEY);
    });

    it('clamps the limit to 1..50 and defaults to 20', async () => {
      const { db, executed } = makeDb([[], [], []]);
      const service = createActivityService(db);
      await service.departmentRecent(ORG_ID, DEVICE_ID, 0);
      await service.departmentRecent(ORG_ID, DEVICE_ID, 500);
      await service.departmentRecent(ORG_ID, DEVICE_ID);
      expect(boundValues(executed[0])).toContain(1);
      expect(boundValues(executed[1])).toContain(50);
      expect(boundValues(executed[2])).toContain(20);
    });
  });
});
