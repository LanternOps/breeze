import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./deviceGroupOwnership', async (importOriginal) => ({
  ...await importOriginal<typeof import('./deviceGroupOwnership')>(),
  findPartnerOwnedGroupIds: vi.fn(async () => [] as string[]),
}));
import { findPartnerOwnedGroupIds } from './deviceGroupOwnership';

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: any) => fn()),
  withDbAccessContext: vi.fn(async (_c: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() },
}));
vi.mock('./eventBus', () => ({ publishEvent: vi.fn(async () => {}) }));
vi.mock('../jobs/peripheralJobs', () => ({
  resolvePeripheralPolicyDeviceIds: vi.fn(async () => []),
  schedulePeripheralPolicyDevices: vi.fn(async () => []),
}));

import { db } from '../db';
import { registerPeripheralTools } from './aiToolsPeripherals';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';

const mockDb = db as unknown as Record<'select' | 'update', ReturnType<typeof vi.fn>>;
const handler = (() => {
  const reg = new Map<string, AiTool>();
  registerPeripheralTools(reg);
  return reg.get('manage_peripheral_policy')!.handler;
})();
const auth = {
  user: { id: 'u1', email: 'a@b.c', name: 'A', isPlatformAdmin: false },
  token: {} as any, partnerId: null, orgId: 'org-1', scope: 'organization',
  accessibleOrgIds: ['org-1'], orgCondition: () => undefined, canAccessOrg: () => true,
  canAccessSite: () => true,
} as unknown as AuthContext;

const stored = {
  id: 'p1', orgId: 'org-1', partnerId: null, name: 'P', deviceClass: 'storage', action: 'block',
  targetType: 'site', targetIds: { siteIds: ['s1'] }, priority: 5, isActive: true, exceptions: [],
};

let setArg: any;
beforeEach(() => {
  vi.clearAllMocks();
  setArg = undefined;
  mockDb.select.mockImplementation(() => ({
    from: () => ({ where: () => Object.assign(Promise.resolve([]), { limit: () => Promise.resolve([stored]) }) }),
  }));
  mockDb.update.mockImplementation(() => ({
    set: (v: unknown) => { setArg = v; return { where: () => ({ returning: () => Promise.resolve([{ ...stored, ...(v as object) }]) }) }; },
  }));
});

describe('manage_peripheral_policy REST parity', () => {
  it.each(['create', 'update'])('%s refuses partner-group peripheral targets without writes and checks the supplied group ids', async (action) => {
    const groupId = '77777777-7777-4777-8777-777777777777';
    vi.mocked(findPartnerOwnedGroupIds).mockResolvedValueOnce([groupId]);
    const out = JSON.parse(await handler({
      action, policy_id: 'p1', name: 'Policy', device_class: 'storage', policy_action: 'block',
      target_type: 'group', target_ids: { groupIds: [groupId] },
    }, auth));
    expect(out).toMatchObject({ code: 'PARTNER_GROUP_TARGET_UNSUPPORTED', groupIds: [groupId] });
    expect(findPartnerOwnedGroupIds).toHaveBeenCalledWith([groupId]);
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it('update refuses a retained partner-group target before persisting', async () => {
    const groupId = '77777777-7777-4777-8777-777777777777';
    vi.mocked(findPartnerOwnedGroupIds).mockResolvedValueOnce([]).mockResolvedValueOnce([groupId]);
    mockDb.select.mockReturnValue({
      from: () => ({ where: () => ({ limit: () => Promise.resolve([
        { ...stored, targetType: 'group', targetIds: { groupIds: [groupId] } },
      ]) }) }),
    });
    const out = JSON.parse(await handler({ action: 'update', policy_id: 'p1', name: 'Renamed' }, auth));
    expect(out).toMatchObject({ code: 'PARTNER_GROUP_TARGET_UNSUPPORTED', groupIds: [groupId] });
    expect(findPartnerOwnedGroupIds).toHaveBeenCalledWith([groupId]);
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it('update: switching target_type without target_ids clears stored ids (#9620)', async () => {
    const out = JSON.parse(await handler({ action: 'update', policy_id: 'p1', target_type: 'group' }, auth));
    expect(out.success).toBe(true);
    expect(setArg.targetType).toBe('group');
    expect(setArg.targetIds).toEqual({ siteIds: [], groupIds: [], deviceIds: [] });
  });

  it('update: same target_type without target_ids keeps stored ids', async () => {
    await handler({ action: 'update', policy_id: 'p1', target_type: 'site' }, auth);
    expect(setArg.targetIds).toEqual({ siteIds: ['s1'] });
  });

  it('add_exception defaults allow to true', async () => {
    const out = JSON.parse(await handler({ action: 'add_exception', policy_id: 'p1', exception: { vendor: 'Acme' } }, auth));
    expect(out.success).toBe(true);
    expect(setArg.exceptions[0].allow).toBe(true);
  });

  it('add_exception keeps explicit allow:false', async () => {
    await handler({ action: 'add_exception', policy_id: 'p1', exception: { vendor: 'Acme', allow: false } }, auth);
    expect(setArg.exceptions[0].allow).toBe(false);
  });
});
