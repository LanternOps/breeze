import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: any) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() },
}));
vi.mock('./commandQueue', () => ({
  CommandTypes: { VM_RESTORE_FROM_BACKUP: 'a', VM_INSTANT_BOOT: 'b' },
  queueCommandForExecution: vi.fn(async () => ({ command: { id: 'c1', status: 'sent' } })),
}));

import { db } from '../db';
import { registerBackupVmTools } from './aiToolsBackupVm';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';

const mockDb = db as unknown as { select: ReturnType<typeof vi.fn>; insert: ReturnType<typeof vi.fn> };
function handlerFor(name: string): AiTool['handler'] {
  const reg = new Map<string, AiTool>();
  registerBackupVmTools(reg);
  return reg.get(name)!.handler;
}
function makeAuth(allowedSiteIds?: string[]): AuthContext {
  return {
    user: { id: 'u1', email: 'a@b.c', name: 'A', isPlatformAdmin: false },
    token: {} as any, partnerId: null, orgId: 'org-1', scope: 'organization',
    accessibleOrgIds: ['org-1'], orgCondition: () => undefined, canAccessOrg: () => true,
    allowedSiteIds, canAccessSite: (s) => (!allowedSiteIds ? true : !!s && allowedSiteIds.includes(s)),
  };
}
// snapshot row first, then target device row { id, siteId }
function snapThenDevice(deviceRow: Record<string, unknown> | undefined) {
  let call = 0;
  mockDb.select.mockImplementation(() => {
    call++;
    if (call === 1) return { from: () => ({ where: () => ({ limit: () => Promise.resolve([{ id: 's1', orgId: 'org-1', snapshotId: 'ps' }]) }) }) };
    return { from: () => ({ where: () => ({ limit: () => Promise.resolve(deviceRow ? [deviceRow] : []) }) }) };
  });
}

describe('backupVm tools — site scoping', () => {
  beforeEach(() => vi.clearAllMocks());

  it('restore_as_vm denies a target device in a forbidden site', async () => {
    snapThenDevice({ id: 'd1', siteId: 'site-B' });
    const r = await handlerFor('restore_as_vm')({ snapshotId: 's1', targetDeviceId: 'd1', hypervisor: 'hyperv', vmName: 'VM' }, makeAuth(['site-A']));
    expect(r).toContain('access denied');
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it('instant_boot_vm denies a target device in a forbidden site', async () => {
    snapThenDevice({ id: 'd1', siteId: 'site-B' });
    const r = await handlerFor('instant_boot_vm')({ snapshotId: 's1', targetDeviceId: 'd1', vmName: 'VM' }, makeAuth(['site-A']));
    expect(r).toContain('access denied');
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it('restore_as_vm unrestricted caller is unaffected', async () => {
    snapThenDevice({ id: 'd1', siteId: 'site-Z' });
    (db as any).insert = vi.fn(() => ({ values: () => ({ returning: () => Promise.resolve([{ id: 'rj', status: 'pending', createdAt: new Date() }]) }) }));
    (db as any).update = vi.fn(() => ({ set: () => ({ where: () => Promise.resolve() }) }));
    const r = await handlerFor('restore_as_vm')({ snapshotId: 's1', targetDeviceId: 'd1', hypervisor: 'hyperv', vmName: 'VM' }, makeAuth(undefined));
    expect(r).not.toContain('access denied');
  });

  it('get_vm_restore_estimate denies when the snapshot device is in a forbidden site', async () => {
    // snapshot row carries a deviceId; deviceIdSiteDenied then looks up its siteId.
    let call = 0;
    mockDb.select.mockImplementation(() => {
      call++;
      if (call === 1) return { from: () => ({ where: () => ({ limit: () => Promise.resolve([{ id: 's1', size: 1024, metadata: {}, hardwareProfile: {}, deviceId: 'd1' }]) }) }) };
      // deviceIdSiteDenied: device d1 lives in a forbidden site
      return { from: () => ({ where: () => ({ limit: () => Promise.resolve([{ siteId: 'site-FORBIDDEN' }]) }) }) };
    });
    const r = await handlerFor('get_vm_restore_estimate')({ snapshotId: 's1' }, makeAuth(['site-A']));
    expect(r).toContain('access denied');
  });

  it('get_vm_restore_estimate unrestricted caller is unaffected (no regression)', async () => {
    mockDb.select.mockImplementation(() => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve([{ id: 's1', size: 1024, metadata: { platform: 'win' }, hardwareProfile: { cpuCores: 4 }, deviceId: 'd1' }]) }) }) }));
    const r = await handlerFor('get_vm_restore_estimate')({ snapshotId: 's1' }, makeAuth(undefined));
    expect(r).not.toContain('access denied');
    const parsed = JSON.parse(r);
    expect(parsed.recommendedCpu).toBe(4);
  });
});
