import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: any) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() },
}));
vi.mock('./commandQueue', () => ({
  CommandTypes: { BACKUP_RESTORE: 'backup_restore' },
}));
vi.mock('./aiDispatch', () => ({
  aiQueueCommandForExecution: vi.fn(),
}));
vi.mock('./backupJobCreation', () => ({ createManualBackupJobIfIdle: vi.fn() }));
vi.mock('../jobs/backupEnqueue', () => ({ enqueueBackupDispatch: vi.fn() }));

import { db } from '../db';
import { registerBackupTools } from './aiToolsBackup';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';

const mockDb = db as unknown as { select: ReturnType<typeof vi.fn> };

function handlerFor(name: string): AiTool['handler'] {
  const reg = new Map<string, AiTool>();
  registerBackupTools(reg);
  const tool = reg.get(name);
  if (!tool) throw new Error(`tool not registered: ${name}`);
  return tool.handler;
}

function makeAuth(opts: { allowedDeviceIds?: string[]; allowedSiteIds?: string[] }): AuthContext {
  const { allowedDeviceIds, allowedSiteIds } = opts;
  return {
    user: { id: 'u1', email: 'a@b.c', name: 'A', isPlatformAdmin: false },
    token: {} as any,
    partnerId: null,
    orgId: 'org-1',
    scope: 'organization',
    accessibleOrgIds: ['org-1'],
    orgCondition: () => undefined,
    canAccessOrg: () => true,
    allowedDeviceIds,
    allowedSiteIds,
    canAccessSite: allowedSiteIds
      ? (s: string | null | undefined) => !!s && allowedSiteIds.includes(s)
      : undefined,
  } as unknown as AuthContext;
}

/** See aiToolsPlaybooks.deviceScope.test.ts — order-preserving drizzle SQL render. */
function renderSql(node: any): string {
  if (node == null) return '';
  if (Array.isArray(node)) return node.map(renderSql).join('');
  if (typeof node === 'string') return node;
  if (typeof node !== 'object') return String(node);
  if (Array.isArray(node.queryChunks)) return node.queryChunks.map(renderSql).join('');
  if ('encoder' in node && 'value' in node) return JSON.stringify(node.value);
  if (typeof node.name === 'string' && node.table) return node.name;
  if (Array.isArray(node.value)) return node.value.join('');
  return '';
}

function isDeviceResolverSelect(cols: unknown): boolean {
  return (
    !!cols && typeof cols === 'object' &&
    'id' in (cols as object) && 'siteId' in (cols as object) &&
    Object.keys(cols as object).length === 2
  );
}

describe('get_backup_status — exact-device axis (finding 9a)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('device-bound caller gets NO org-wide aggregate when no deviceId is given', async () => {
    let aggregateScanRan = false;
    mockDb.select.mockImplementation(() => {
      aggregateScanRan = true;
      return { from: () => ({ where: () => Promise.resolve([{ total: 9, active: 9 }]) }) };
    });

    const raw = await handlerFor('get_backup_status')(
      {},
      makeAuth({ allowedDeviceIds: ['dev-1'], allowedSiteIds: ['site-1'] }),
    );
    const parsed = JSON.parse(raw);
    expect(parsed.configs).toBeUndefined();
    expect(parsed.jobsLast7Days).toBeUndefined();
    expect(parsed.storage).toBeUndefined();
    expect(String(parsed.error)).toMatch(/deviceId/);
    expect(aggregateScanRan).toBe(false);
  });

  it('device-LESS analysis shape (no site axis) also gets no org-wide aggregate', async () => {
    let aggregateScanRan = false;
    mockDb.select.mockImplementation(() => {
      aggregateScanRan = true;
      return { from: () => ({ where: () => Promise.resolve([{ total: 9, active: 9 }]) }) };
    });

    const raw = await handlerFor('get_backup_status')({}, makeAuth({ allowedDeviceIds: ['dev-1'] }));
    const parsed = JSON.parse(raw);
    expect(parsed.storage).toBeUndefined();
    expect(String(parsed.error)).toMatch(/deviceId/);
    expect(aggregateScanRan).toBe(false);
  });

  it('device-bound caller still gets its OWN device summary', async () => {
    // snapshot stats query ends at .where() (no orderBy), so give that chain a thenable
    mockDb.select.mockImplementation((cols?: unknown) => {
      if (isDeviceResolverSelect(cols)) {
        return {
          from: () => ({
            where: () => ({ limit: () => Promise.resolve([{ id: 'dev-1', siteId: 'site-1' }]) }),
          }),
        };
      }
      const chain: any = Promise.resolve([{ id: 'job-1', status: 'completed', count: 3, totalSize: 10 }]);
      chain.orderBy = () => ({ limit: () => Promise.resolve([{ id: 'job-1', status: 'completed' }]) });
      return { from: () => ({ where: () => chain }) };
    });

    const raw = await handlerFor('get_backup_status')(
      { deviceId: 'dev-1' },
      makeAuth({ allowedDeviceIds: ['dev-1'], allowedSiteIds: ['site-1'] }),
    );
    const parsed = JSON.parse(raw);
    expect(parsed.error).toBeUndefined();
    expect(parsed.deviceId).toBe('dev-1');
    expect(parsed.latestJob).toMatchObject({ id: 'job-1' });
  });

  it('device-bound caller cannot read a sibling device summary', async () => {
    mockDb.select.mockImplementation(() => ({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve([{ id: 'dev-2', siteId: 'site-1' }]) }),
      }),
    }));
    const raw = await handlerFor('get_backup_status')(
      { deviceId: 'dev-2' },
      makeAuth({ allowedDeviceIds: ['dev-1'], allowedSiteIds: ['site-1'] }),
    );
    expect(JSON.parse(raw).error).toBe('Device not found or access denied');
  });

  it('unrestricted caller still gets the org-wide aggregate (no regression)', async () => {
    mockDb.select.mockImplementation(() => {
      const chain: any = Promise.resolve([
        { total: 4, active: 3, snapshotCount: 7, totalStorage: 100 },
      ]);
      return { from: () => ({ where: () => chain }) };
    });
    const raw = await handlerFor('get_backup_status')({}, makeAuth({}));
    const parsed = JSON.parse(raw);
    expect(parsed.error).toBeUndefined();
    expect(parsed.configs).toEqual({ total: 4, active: 3 });
    expect(parsed.storage).toEqual({ snapshotCount: 7, totalBytes: 100 });
  });
});

describe('query_backups list_jobs — exact-device axis (finding 9b)', () => {
  beforeEach(() => vi.clearAllMocks());

  function mockJobsQuery(rows: unknown[] = []): { where: () => string } {
    let captured = '';
    mockDb.select.mockImplementation((cols?: unknown) => {
      if (isDeviceResolverSelect(cols)) {
        return {
          from: () => ({
            where: () => Promise.resolve([
              { id: 'dev-1', siteId: 'site-1' },
              { id: 'dev-2', siteId: 'site-1' },
            ]),
          }),
        };
      }
      return {
        from: () => ({
          leftJoin: () => ({
            leftJoin: () => ({
              where: (cond: unknown) => {
                captured = renderSql(cond);
                return { orderBy: () => ({ limit: () => Promise.resolve(rows) }) };
              },
            }),
          }),
        }),
      };
    });
    return { where: () => captured };
  }

  it('device-LESS analysis shape narrows job history to its own device', async () => {
    const cap = mockJobsQuery();
    const raw = await handlerFor('query_backups')(
      { action: 'list_jobs' },
      makeAuth({ allowedDeviceIds: ['dev-1'] }),
    );
    expect(JSON.parse(raw).error).toBeUndefined();
    expect(cap.where()).toMatch(/device_id in \(?"dev-1"/);
    expect(cap.where()).not.toContain('dev-2');
  });

  it('device-bound caller (both axes) narrows job history to its own device', async () => {
    const cap = mockJobsQuery();
    await handlerFor('query_backups')(
      { action: 'list_jobs' },
      makeAuth({ allowedDeviceIds: ['dev-1'], allowedSiteIds: ['site-1'] }),
    );
    expect(cap.where()).toMatch(/device_id in \(?"dev-1"/);
    expect(cap.where()).not.toContain('dev-2');
  });

  it('device-bound caller asking for a sibling device gets nothing', async () => {
    mockJobsQuery([{ id: 'job-x', deviceId: 'dev-2', status: 'completed' }]);
    const raw = await handlerFor('query_backups')(
      { action: 'list_jobs', deviceId: 'dev-2' },
      makeAuth({ allowedDeviceIds: ['dev-1'] }),
    );
    expect(JSON.parse(raw).jobs).toEqual([]);
  });

  it('unrestricted caller is not narrowed at all', async () => {
    const cap = mockJobsQuery();
    await handlerFor('query_backups')({ action: 'list_jobs' }, makeAuth({}));
    expect(cap.where()).toBe('');
  });
});
