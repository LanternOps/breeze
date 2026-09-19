/**
 * Contract-A D4 (#5505 W05): the AI may never arm
 * `remediationOptions.autoInstall` via `manage_software_policies`
 * (aiToolsPolicyPrereqs.ts). Refused outright at both write sites, never
 * silently stripped.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { insertMock, updateMock, selectMock, recordPolicyAuditMock, writeAuditEventMock } = vi.hoisted(() => ({
  insertMock: vi.fn(),
  updateMock: vi.fn(),
  selectMock: vi.fn(),
  recordPolicyAuditMock: vi.fn(async () => {}),
  writeAuditEventMock: vi.fn(),
}));

vi.mock('../db', () => ({ db: { insert: insertMock, update: updateMock, select: selectMock } }));
vi.mock('../db/schema/patches', () => ({ patchPolicies: {} }));
vi.mock('../db/schema/softwarePolicies', () => ({ softwarePolicies: {} }));
vi.mock('../db/schema/peripheralControl', () => ({ peripheralPolicies: {} }));
vi.mock('../db/schema/backup', () => ({ backupConfigs: {}, backupProfiles: {} }));
vi.mock('../db/schema/configurationPolicies', () => ({ configPolicyBackupSettings: {} }));
vi.mock('../jobs/peripheralJobs', () => ({
  resolvePeripheralPolicyDeviceIds: vi.fn(async () => []),
  schedulePeripheralPolicyDevices: vi.fn(async () => undefined),
}));
vi.mock('./softwarePolicyService', () => ({ recordSoftwarePolicyAudit: recordPolicyAuditMock }));
vi.mock('./auditEvents', () => ({
  writeAuditEvent: writeAuditEventMock,
  requestLikeFromSnapshot: vi.fn(() => ({ req: { header: () => undefined } })),
}));

import { registerPolicyPrereqTools } from './aiToolsPolicyPrereqs';
import { AI_AUTO_INSTALL_REFUSAL_MESSAGE } from './aiToolsSoftwarePolicyAudit';

const PARTNER_ID = '00000000-0000-0000-0000-000000000001';
const ORG_ID = '33333333-3333-3333-3333-333333333333';
const POLICY_ID = '55555555-5555-5555-5555-555555555555';
const USER_ID = 'user-1';

function makeOrgAuth() {
  return {
    user: { id: USER_ID, email: 'ai@example.com', name: 'AI' },
    scope: 'organization',
    partnerId: PARTNER_ID,
    orgId: ORG_ID,
    accessibleOrgIds: [ORG_ID],
    canAccessOrg: () => true,
    orgCondition: () => undefined,
  } as any;
}

function tool() {
  const tools = new Map<string, any>();
  registerPolicyPrereqTools(tools);
  return tools.get('manage_software_policies');
}

function mockInsertReturns(row: unknown) {
  const returning = vi.fn(async () => [row]);
  const values = vi.fn(() => ({ returning }));
  insertMock.mockReturnValue({ values });
}

function mockUpdate() {
  const where = vi.fn(async () => undefined);
  const set = vi.fn((_payload: Record<string, unknown>) => ({ where }));
  updateMock.mockReturnValue({ set });
  return { set, where };
}

function mockSelectReturns(rows: unknown[]) {
  selectMock.mockReturnValue({
    from: () => ({ where: () => ({ limit: async () => rows }) }),
  });
}

beforeEach(() => {
  insertMock.mockReset();
  updateMock.mockReset();
  selectMock.mockReset();
  recordPolicyAuditMock.mockClear();
  writeAuditEventMock.mockClear();
});

describe('manage_software_policies create — autoInstall refusal (contract-A D4)', () => {
  it('refuses { autoInstall: true } with the exact contract message and writes nothing', async () => {
    const out = JSON.parse(await tool().handler({
      action: 'create',
      name: 'Armed policy',
      mode: 'allowlist',
      enforceMode: true,
      remediationOptions: { autoInstall: true },
    }, makeOrgAuth()));

    expect(out.error).toBe(AI_AUTO_INSTALL_REFUSAL_MESSAGE);
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('still allows autoUninstall arming (unrelated, unchanged verb) when autoInstall is absent', async () => {
    mockInsertReturns({ id: POLICY_ID, name: 'Armed for uninstall', orgId: ORG_ID, partnerId: null, mode: 'allowlist' });

    const out = JSON.parse(await tool().handler({
      action: 'create',
      name: 'Armed for uninstall',
      mode: 'allowlist',
      enforceMode: true,
      remediationOptions: { autoUninstall: true },
    }, makeOrgAuth()));

    expect(out.error).toBeUndefined();
    expect(out.success).toBe(true);
  });
});

describe('manage_software_policies update — autoInstall refusal (contract-A D4)', () => {
  it('refuses { autoInstall: true } on an existing policy and writes nothing', async () => {
    mockSelectReturns([{ id: POLICY_ID, name: 'Detect only', orgId: ORG_ID, partnerId: null, mode: 'allowlist' }]);
    mockUpdate();

    const out = JSON.parse(await tool().handler({
      action: 'update',
      policyId: POLICY_ID,
      remediationOptions: { autoInstall: true },
    }, makeOrgAuth()));

    expect(out.error).toBe(AI_AUTO_INSTALL_REFUSAL_MESSAGE);
    expect(updateMock).not.toHaveBeenCalled();
  });
});
