import { beforeEach, describe, expect, it, vi } from 'vitest';

const { insertMock, updateMock, selectMock } = vi.hoisted(() => ({
  insertMock: vi.fn(),
  updateMock: vi.fn(),
  selectMock: vi.fn(),
}));

vi.mock('../db', () => ({
  db: { insert: insertMock, update: updateMock, select: selectMock },
}));

vi.mock('../db/schema/patches', () => ({
  patchPolicies: {
    id: 'patchPolicies.id',
    partnerId: 'patchPolicies.partnerId',
    kind: 'patchPolicies.kind',
    name: 'patchPolicies.name',
    enabled: 'patchPolicies.enabled',
    autoApprove: 'patchPolicies.autoApprove',
    ringOrder: 'patchPolicies.ringOrder',
    createdAt: 'patchPolicies.createdAt',
    description: 'patchPolicies.description',
    deferralDays: 'patchPolicies.deferralDays',
    deadlineDays: 'patchPolicies.deadlineDays',
    gracePeriodHours: 'patchPolicies.gracePeriodHours',
    categories: 'patchPolicies.categories',
    excludeCategories: 'patchPolicies.excludeCategories',
  },
}));
vi.mock('../db/schema/softwarePolicies', () => ({ softwarePolicies: {} }));
vi.mock('../db/schema/peripheralControl', () => ({ peripheralPolicies: {} }));
vi.mock('../db/schema/backup', () => ({ backupConfigs: {}, backupProfiles: {} }));
vi.mock('../db/schema/configurationPolicies', () => ({ configPolicyBackupSettings: {} }));
vi.mock('../jobs/peripheralJobs', () => ({
  resolvePeripheralPolicyDeviceIds: vi.fn(async () => []),
  schedulePeripheralPolicyDevices: vi.fn(async () => undefined),
}));
vi.mock('./aiToolsSoftwarePolicyAudit', () => ({
  auditSoftwarePolicyToolEvent: vi.fn(),
  summarizeEnforcementChange: vi.fn(() => ({})),
}));

import { registerPolicyPrereqTools } from './aiToolsPolicyPrereqs';

const PARTNER_ID = '00000000-0000-0000-0000-000000000001';
const RING_ID = '22222222-2222-2222-2222-222222222222';

function makeAuth(partnerOrgAccess: 'all' | 'selected') {
  return {
    user: { id: 'user-1', email: 'test@example.com', name: 'Test User' },
    scope: 'partner',
    partnerId: PARTNER_ID,
    partnerOrgAccess,
    orgId: null,
    accessibleOrgIds: [],
    canAccessOrg: () => false,
    orgCondition: () => undefined,
  } as any;
}

function getUpdateRingsTool() {
  const tools = new Map<string, any>();
  registerPolicyPrereqTools(tools);
  const tool = tools.get('manage_update_rings');
  if (!tool) throw new Error('manage_update_rings tool not registered');
  return tool;
}

function mockExistingRing() {
  selectMock.mockReturnValue({
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        limit: vi.fn(async () => [{ id: RING_ID, partnerId: PARTNER_ID, name: 'Pilot', kind: 'ring' }]),
      })),
    })),
  });
}

describe('manage_update_rings partner-wide capability gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('create returns a JSON error requiring full partner org access for selected access', async () => {
    const output = await getUpdateRingsTool().handler(
      { action: 'create', name: 'Pilot' },
      makeAuth('selected'),
    );

    expect(typeof output).toBe('string');
    expect(JSON.parse(output).error).toMatch(/full partner org access/i);
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('create proceeds for all access', async () => {
    insertMock.mockReturnValue({
      values: vi.fn(() => ({
        returning: vi.fn(async () => [{ id: RING_ID, name: 'Pilot' }]),
      })),
    });

    const output = await getUpdateRingsTool().handler(
      { action: 'create', name: 'Pilot' },
      makeAuth('all'),
    );

    expect(JSON.parse(output)).toMatchObject({ success: true, ringId: RING_ID });
    expect(insertMock).toHaveBeenCalledOnce();
  });

  it('update returns a JSON error requiring full partner org access for selected access', async () => {
    mockExistingRing();

    const output = await getUpdateRingsTool().handler(
      { action: 'update', ringId: RING_ID, name: 'Production' },
      makeAuth('selected'),
    );

    expect(typeof output).toBe('string');
    expect(JSON.parse(output).error).toMatch(/full partner org access/i);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('update proceeds for all access', async () => {
    mockExistingRing();
    updateMock.mockReturnValue({
      set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
    });

    const output = await getUpdateRingsTool().handler(
      { action: 'update', ringId: RING_ID, name: 'Production' },
      makeAuth('all'),
    );

    expect(JSON.parse(output).success).toBe(true);
    expect(updateMock).toHaveBeenCalledOnce();
  });
});
