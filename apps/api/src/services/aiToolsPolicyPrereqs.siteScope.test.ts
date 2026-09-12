import { beforeEach, describe, expect, it, vi } from 'vitest';

const { insertMock, updateMock, selectMock, resolvePolicyDeviceIdsMock, schedulePolicyDevicesMock } = vi.hoisted(() => ({
  insertMock: vi.fn(),
  updateMock: vi.fn(),
  selectMock: vi.fn(),
  resolvePolicyDeviceIdsMock: vi.fn().mockResolvedValue(['device-1']),
  schedulePolicyDevicesMock: vi.fn().mockResolvedValue(['job-1']),
}));

vi.mock('../jobs/peripheralJobs', () => ({
  resolvePeripheralPolicyDeviceIds: resolvePolicyDeviceIdsMock,
  schedulePeripheralPolicyDevices: schedulePolicyDevicesMock,
}));

vi.mock('../db', () => ({ db: { insert: insertMock, update: updateMock, select: selectMock } }));

vi.mock('../db/schema/patches', () => ({
  patchPolicies: {
    id: 'patchPolicies.id', partnerId: 'patchPolicies.partnerId', kind: 'patchPolicies.kind',
    name: 'patchPolicies.name', enabled: 'patchPolicies.enabled', autoApprove: 'patchPolicies.autoApprove',
    ringOrder: 'patchPolicies.ringOrder', createdAt: 'patchPolicies.createdAt', description: 'patchPolicies.description',
    deferralDays: 'patchPolicies.deferralDays', deadlineDays: 'patchPolicies.deadlineDays',
    gracePeriodHours: 'patchPolicies.gracePeriodHours', categories: 'patchPolicies.categories',
    excludeCategories: 'patchPolicies.excludeCategories',
  },
}));
vi.mock('../db/schema/softwarePolicies', () => ({ softwarePolicies: {} }));
vi.mock('./aiToolsSoftwarePolicyAudit', () => ({
  auditSoftwarePolicyToolEvent: vi.fn(),
  summarizeEnforcementChange: vi.fn(() => ({})),
}));
vi.mock('../db/schema/peripheralControl', () => ({ peripheralPolicies: {} }));
vi.mock('../db/schema/backup', () => ({ backupConfigs: {}, backupProfiles: {} }));
vi.mock('../db/schema/configurationPolicies', () => ({ configPolicyBackupSettings: {} }));

import { registerPolicyPrereqTools } from './aiToolsPolicyPrereqs';

function tools() {
  const registry = new Map<string, any>();
  registerPolicyPrereqTools(registry);
  return registry;
}

const ORG_ID = '33333333-3333-3333-3333-333333333333';

function makeAuth(allowedSiteIds: string[] | undefined) {
  return {
    user: { id: 'user-1', email: 'test@example.com', name: 'Test User' },
    scope: 'organization',
    partnerId: null,
    orgId: ORG_ID,
    accessibleOrgIds: [ORG_ID],
    allowedSiteIds,
    canAccessOrg: (id: string) => id === ORG_ID,
    orgCondition: () => undefined,
  } as any;
}

describe('aiToolsPolicyPrereqs — site-ceiling gate (contract §7A)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const cases: Array<[string, Record<string, unknown>]> = [
    ['manage_software_policies', { action: 'create', name: 'p', mode: 'allowlist' }],
    ['manage_software_policies', { action: 'update', policyId: 'x' }],
    ['manage_peripheral_policies', { action: 'create', name: 'p', deviceClass: 'storage', action_type: 'block' }],
    ['manage_peripheral_policies', { action: 'update', policyId: 'x' }],
    ['manage_backup_profiles', { action: 'create', name: 'p' }],
    ['manage_backup_profiles', { action: 'update', profileId: 'x' }],
    ['manage_backup_profiles', { action: 'delete', profileId: 'x' }],
    ['manage_backup_configs', { action: 'create', name: 'c', type: 'file', provider: 'local' }],
    ['manage_backup_configs', { action: 'update', configId: 'x' }],
  ];

  it.each(cases)('%s action=%j: site-restricted caller denied before any DB access', async (toolName, input) => {
    const output = await tools().get(toolName)!.handler(input, makeAuth(['s1']));
    expect(JSON.parse(output).error).toMatch(/site-restricted/i);
    expect(insertMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it.each(['manage_software_policies', 'manage_peripheral_policies', 'manage_backup_profiles', 'manage_backup_configs'])(
    '%s: empty allowedSiteIds ([]) is also denied on create',
    async (toolName) => {
      const output = await tools().get(toolName)!.handler({ action: 'create', name: 'p' }, makeAuth([]));
      expect(JSON.parse(output).error).toMatch(/site-restricted/i);
    }
  );

  it.each(['manage_software_policies', 'manage_peripheral_policies', 'manage_backup_profiles', 'manage_backup_configs'])(
    '%s: "list" action is a read and NOT gated for a site-restricted caller',
    async (toolName) => {
      selectMock.mockReturnValue({
        from: () => ({ where: () => ({ orderBy: () => ({ limit: () => Promise.resolve([]) }) }) }),
      });
      const output = await tools().get(toolName)!.handler({ action: 'list' }, makeAuth(['s1']));
      expect(JSON.parse(output).error).toBeUndefined();
    }
  );
});
