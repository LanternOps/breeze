import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: any) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() },
}));
vi.mock('./commandQueue', () => ({
  CommandTypes: { BACKUP_RESTORE: 'backup_restore' },
  queueCommandForExecution: vi.fn(async () => ({ command: { id: 'c1', status: 'sent' } })),
}));
vi.mock('./backupJobCreation', () => ({ createManualBackupJobIfIdle: vi.fn() }));
vi.mock('../jobs/backupEnqueue', () => ({ enqueueBackupDispatch: vi.fn() }));

import { db } from '../db';
import { registerBackupTools } from './aiToolsBackup';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';

const mockDb = db as unknown as { select: ReturnType<typeof vi.fn>; insert: ReturnType<typeof vi.fn> };

function handlerFor(name: string): AiTool['handler'] {
  const reg = new Map<string, AiTool>();
  registerBackupTools(reg);
  const tool = reg.get(name);
  if (!tool) throw new Error(`tool not registered: ${name}`);
  return tool.handler;
}

function makeAuth(allowedSiteIds?: string[]): AuthContext {
  return {
    user: { id: 'u1', email: 'a@b.c', name: 'A', isPlatformAdmin: false },
    token: {} as any,
    partnerId: null,
    orgId: 'org-1',
    scope: 'organization',
    accessibleOrgIds: ['org-1'],
    orgCondition: () => undefined,
    canAccessOrg: () => true,
    allowedSiteIds,
    canAccessSite: (siteId) => (!allowedSiteIds ? true : !!siteId && allowedSiteIds.includes(siteId)),
  };
}

// device lookups in backup select { id, ... , siteId }
function deviceFirstThen(deviceRow: Record<string, unknown> | undefined, rest: () => unknown) {
  let call = 0;
  mockDb.select.mockImplementation(() => {
    call++;
    if (call === 1) return { from: () => ({ where: () => ({ limit: () => Promise.resolve(deviceRow ? [deviceRow] : []) }) }) };
    return rest();
  });
}

describe('backup tools — per-device site scoping', () => {
  beforeEach(() => vi.clearAllMocks());

  it('get_backup_status denies a device in a forbidden site', async () => {
    deviceFirstThen({ id: 'd1', siteId: 'site-B' }, () => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit: () => Promise.resolve([]) }) }) }) }));
    const result = await handlerFor('get_backup_status')({ deviceId: 'd1' }, makeAuth(['site-A']));
    expect(result).toContain('access denied');
  });

  it('get_backup_status allows a device in an allowed site (unrestricted unaffected)', async () => {
    // Subsequent queries (jobs/snapshots) have varied shapes; make a chainable
    // thenable that resolves to [] regardless of orderBy/limit/where chaining.
    const empty: any = Promise.resolve([]);
    empty.where = () => empty; empty.orderBy = () => empty; empty.limit = () => empty; empty.from = () => empty;
    deviceFirstThen({ id: 'd1', siteId: 'site-Z' }, () => ({ from: () => empty }));
    const result = await handlerFor('get_backup_status')({ deviceId: 'd1' }, makeAuth(undefined));
    const parsed = JSON.parse(result);
    expect(parsed.deviceId).toBe('d1');
  });

  it('browse_snapshots denies a device in a forbidden site', async () => {
    deviceFirstThen({ id: 'd1', hostname: 'h', siteId: 'site-B' }, () => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit: () => Promise.resolve([]) }) }) }) }));
    const result = await handlerFor('browse_snapshots')({ deviceId: 'd1' }, makeAuth(['site-A']));
    expect(result).toContain('access denied');
  });

  it('trigger_backup denies a device in a forbidden site', async () => {
    deviceFirstThen({ id: 'd1', status: 'online', siteId: 'site-B' }, () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }) }));
    const result = await handlerFor('trigger_backup')({ deviceId: 'd1', configId: 'cfg1' }, makeAuth(['site-A']));
    expect(result).toContain('access denied');
  });

  it('restore_snapshot denies a device in a forbidden site', async () => {
    deviceFirstThen({ id: 'd1', siteId: 'site-B' }, () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }) }));
    const result = await handlerFor('restore_snapshot')({ snapshotId: 's1', deviceId: 'd1' }, makeAuth(['site-A']));
    expect(result).toContain('access denied');
    expect(mockDb.insert).not.toHaveBeenCalled();
  });
});

describe('query_backups list_jobs — site narrowing (device-keyed jobs)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('site-restricted caller with no in-scope devices gets empty jobs, without scanning all jobs', async () => {
    let jobsRan = false;
    mockDb.select.mockImplementation((cols?: unknown) => {
      // resolveSiteAllowedDeviceIds selects { id, siteId }
      if (cols && typeof cols === 'object' && 'id' in (cols as object) && 'siteId' in (cols as object) && Object.keys(cols as object).length === 2) {
        return { from: () => ({ where: () => Promise.resolve([{ id: 'd1', siteId: 'site-FORBIDDEN' }]) }) };
      }
      jobsRan = true;
      return { from: () => ({ leftJoin: () => ({ leftJoin: () => ({ where: () => ({ orderBy: () => ({ limit: () => Promise.resolve([{ id: 'job-leak' }]) }) }) }) }) }) };
    });
    const result = await handlerFor('query_backups')({ action: 'list_jobs' }, makeAuth(['site-A']));
    const parsed = JSON.parse(result);
    expect(parsed.showing).toBe(0);
    expect(jobsRan).toBe(false);
  });

  it('unrestricted caller lists jobs normally (no regression)', async () => {
    mockDb.select.mockImplementation(() => ({
      from: () => ({ leftJoin: () => ({ leftJoin: () => ({ where: () => ({ orderBy: () => ({ limit: () => Promise.resolve([{ id: 'job1' }]) }) }) }) }) }),
    }));
    const result = await handlerFor('query_backups')({ action: 'list_jobs' }, makeAuth(undefined));
    const parsed = JSON.parse(result);
    expect(parsed.showing).toBe(1);
  });
});
