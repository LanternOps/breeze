import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: any) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() },
}));
vi.mock('./commandQueue', () => ({
  CommandTypes: { HYPERV_VM_STATE: 'a', HYPERV_BACKUP: 'b', HYPERV_RESTORE: 'c', HYPERV_CHECKPOINT: 'd' },
  queueCommandForExecution: vi.fn(async () => ({ command: { id: 'c1', status: 'sent' } })),
}));
vi.mock('./featureConfigResolver', () => ({ resolveBackupConfigForDevice: vi.fn(async () => ({ configId: 'cfg', featureLinkId: 'fl' })) }));

import { db } from '../db';
import { registerHypervTools } from './aiToolsHyperv';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';

const mockDb = db as unknown as { select: ReturnType<typeof vi.fn> };
function handlerFor(name: string): AiTool['handler'] {
  const reg = new Map<string, AiTool>();
  registerHypervTools(reg);
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
// VM row first, then device { siteId } lookup.
function vmThenDevice(vmRow: Record<string, unknown> | undefined, siteId: string | null) {
  let call = 0;
  mockDb.select.mockImplementation(() => {
    call++;
    if (call === 1) return { from: () => ({ leftJoin: () => ({ where: () => ({ limit: () => Promise.resolve(vmRow ? [vmRow] : []) }) }), where: () => ({ limit: () => Promise.resolve(vmRow ? [vmRow] : []) }) }) };
    return { from: () => ({ where: () => ({ limit: () => Promise.resolve([{ siteId }]) }) }) };
  });
}

describe('hyperv tools — site scoping', () => {
  beforeEach(() => vi.clearAllMocks());

  it('manage_hyperv_vm denies when VM host device is in a forbidden site', async () => {
    vmThenDevice({ id: 'v1', orgId: 'org-1', deviceId: 'd1', vmName: 'VM', state: 'Running' }, 'site-B');
    const r = await handlerFor('manage_hyperv_vm')({ vmId: 'v1', action: 'start' }, makeAuth(['site-A']));
    expect(r).toContain('access denied');
  });

  it('trigger_hyperv_backup denies when VM host device is in a forbidden site', async () => {
    vmThenDevice({ id: 'v1', orgId: 'org-1', deviceId: 'd1', vmName: 'VM', state: 'Running' }, 'site-B');
    const r = await handlerFor('trigger_hyperv_backup')({ vmId: 'v1' }, makeAuth(['site-A']));
    expect(r).toContain('access denied');
  });

  it('restore_hyperv_vm denies a target device in a forbidden site', async () => {
    mockDb.select.mockReturnValue({ from: () => ({ where: () => ({ limit: () => Promise.resolve([{ id: 'd1', siteId: 'site-B' }]) }) }) });
    const r = await handlerFor('restore_hyperv_vm')({ deviceId: 'd1', snapshotId: 's1' }, makeAuth(['site-A']));
    expect(r).toContain('access denied');
  });

  it('manage_hyperv_vm unrestricted caller is unaffected', async () => {
    vmThenDevice({ id: 'v1', orgId: 'org-1', deviceId: 'd1', vmName: 'VM', state: 'Running' }, 'site-Z');
    const r = await handlerFor('manage_hyperv_vm')({ vmId: 'v1', action: 'start' }, makeAuth(undefined));
    expect(r).not.toContain('access denied');
  });
});
