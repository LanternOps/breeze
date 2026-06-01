import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: any) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() },
}));
vi.mock('./commandQueue', () => ({
  CommandTypes: { MSSQL_BACKUP: 'mssql_backup', MSSQL_RESTORE: 'mssql_restore', MSSQL_VERIFY: 'mssql_verify' },
  queueCommandForExecution: vi.fn(async () => ({ command: { id: 'c1', status: 'sent' } })),
}));
vi.mock('./featureConfigResolver', () => ({ resolveBackupConfigForDevice: vi.fn(async () => ({ configId: 'cfg', featureLinkId: 'fl' })) }));

import { db } from '../db';
import { registerMssqlTools } from './aiToolsMssql';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';

const mockDb = db as unknown as { select: ReturnType<typeof vi.fn> };

function handlerFor(name: string): AiTool['handler'] {
  const reg = new Map<string, AiTool>();
  registerMssqlTools(reg);
  return reg.get(name)!.handler;
}
function makeAuth(allowedSiteIds?: string[]): AuthContext {
  return {
    user: { id: 'u1', email: 'a@b.c', name: 'A', isPlatformAdmin: false },
    token: {} as any, partnerId: null, orgId: 'org-1', scope: 'organization',
    accessibleOrgIds: ['org-1'], orgCondition: () => undefined, canAccessOrg: () => true,
    allowedSiteIds,
    canAccessSite: (s) => (!allowedSiteIds ? true : !!s && allowedSiteIds.includes(s)),
  };
}

describe('mssql tools — site scoping', () => {
  beforeEach(() => vi.clearAllMocks());

  it('trigger_mssql_backup denies a device in a forbidden site', async () => {
    mockDb.select.mockReturnValue({ from: () => ({ where: () => ({ limit: () => Promise.resolve([{ id: 'd1', orgId: 'org-1', siteId: 'site-B' }]) }) }) });
    const r = await handlerFor('trigger_mssql_backup')({ deviceId: 'd1', instance: 'I', database: 'D' }, makeAuth(['site-A']));
    expect(r).toContain('access denied');
  });

  it('restore_mssql_database denies a device in a forbidden site', async () => {
    mockDb.select.mockReturnValue({ from: () => ({ where: () => ({ limit: () => Promise.resolve([{ id: 'd1', siteId: 'site-B' }]) }) }) });
    const r = await handlerFor('restore_mssql_database')({ deviceId: 'd1', snapshotId: 's1', targetDatabase: 'D' }, makeAuth(['site-A']));
    expect(r).toContain('access denied');
  });

  it('verify_mssql_backup denies when snapshot device is in a forbidden site', async () => {
    let call = 0;
    mockDb.select.mockImplementation(() => {
      call++;
      // 1: snapshot row; 2: deviceIdSiteDenied -> { siteId }
      if (call === 1) return { from: () => ({ where: () => ({ limit: () => Promise.resolve([{ id: 's1', deviceId: 'd1', providerSnapshotId: 'ps', metadata: { backupKind: 'mssql_database', backupFileName: 'f.bak' } }]) }) }) };
      return { from: () => ({ where: () => ({ limit: () => Promise.resolve([{ siteId: 'site-B' }]) }) }) };
    });
    const r = await handlerFor('verify_mssql_backup')({ snapshotId: 's1' }, makeAuth(['site-A']));
    expect(r).toContain('access denied');
  });

  it('trigger_mssql_backup unrestricted caller is unaffected', async () => {
    mockDb.select.mockReturnValue({ from: () => ({ where: () => ({ limit: () => Promise.resolve([{ id: 'd1', orgId: 'org-1', siteId: 'site-Z' }]) }) }) });
    (db as any).insert = vi.fn(() => ({ values: () => ({ returning: () => Promise.resolve([{ id: 'job1' }]) }) }));
    const r = await handlerFor('trigger_mssql_backup')({ deviceId: 'd1', instance: 'I', database: 'D' }, makeAuth(undefined));
    expect(r).not.toContain('access denied');
  });
});
