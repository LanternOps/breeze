/**
 * #3543 — `manage_software_policies` (aiToolsPolicyPrereqs) writes to both audit
 * stores on create/update.
 *
 * This tool can set `enforceMode` and `remediationOptions.autoUninstall` — the
 * two flags that arm a policy to uninstall software from real machines — and
 * wrote to neither `audit_logs` nor `software_policy_audit`. During the #3381
 * forensics that meant the arming of an enforcing policy was simply absent from
 * the reporter's audit trail.
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

// Spy the two audit stores at their real module boundaries so the shared
// aiToolsSoftwarePolicyAudit helper is exercised for real.
vi.mock('./softwarePolicyService', () => ({ recordSoftwarePolicyAudit: recordPolicyAuditMock }));
vi.mock('./auditEvents', () => ({
  writeAuditEvent: writeAuditEventMock,
  requestLikeFromSnapshot: vi.fn(() => ({ req: { header: () => undefined } })),
}));

import { registerPolicyPrereqTools } from './aiToolsPolicyPrereqs';

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
  const set = vi.fn(() => ({ where }));
  updateMock.mockReturnValue({ set });
  return { set, where };
}

function mockSelectReturns(rows: unknown[]) {
  selectMock.mockReturnValue({
    from: () => ({ where: () => ({ limit: async () => rows }) }),
  });
}

const policyAudit = () => recordPolicyAuditMock.mock.calls.map((c: any[]) => c[0]);
const auditLog = () => writeAuditEventMock.mock.calls.map((c: any[]) => c[1]);

beforeEach(() => {
  insertMock.mockReset();
  updateMock.mockReset();
  selectMock.mockReset();
  recordPolicyAuditMock.mockClear();
  writeAuditEventMock.mockClear();
});

describe('manage_software_policies create — audit fan-out (#3543)', () => {
  it('records policy_created + software_policy.create with actor "ai" and the arming fields', async () => {
    mockInsertReturns({
      id: POLICY_ID, name: 'Enforcing blocklist', orgId: ORG_ID, partnerId: null, mode: 'blocklist',
    });

    const out = JSON.parse(await tool().handler({
      action: 'create',
      name: 'Enforcing blocklist',
      mode: 'blocklist',
      enforceMode: true,
      remediationOptions: { autoUninstall: true, cooldownMinutes: 30 },
    }, makeOrgAuth()));

    expect(out.error).toBeUndefined();

    expect(policyAudit()[0]).toMatchObject({
      orgId: ORG_ID,
      partnerId: null,
      policyId: POLICY_ID,
      action: 'policy_created',
      actor: 'ai',
      actorId: USER_ID,
    });
    expect(policyAudit()[0]!.details).toMatchObject({
      mode: 'blocklist',
      ownerScope: 'organization',
      enforceMode: true,
      autoUninstall: true,
      toolName: 'manage_software_policies',
    });

    expect(auditLog()[0]).toMatchObject({
      orgId: ORG_ID,
      actorId: USER_ID,
      actorEmail: 'ai@example.com',
      action: 'software_policy.create',
      resourceType: 'software_policy',
      resourceId: POLICY_ID,
      result: 'success',
    });
    expect(auditLog()[0]!.details).toMatchObject({ enforceMode: true, autoUninstall: true });
  });

  it('reports autoUninstall:false when remediationOptions opts out', async () => {
    mockInsertReturns({ id: POLICY_ID, name: 'Detect only', orgId: ORG_ID, partnerId: null, mode: 'blocklist' });

    await tool().handler({
      action: 'create', name: 'Detect only', mode: 'blocklist',
      enforceMode: false, remediationOptions: { notifyUser: true },
    }, makeOrgAuth());

    expect(policyAudit()[0]!.details).toMatchObject({ enforceMode: false, autoUninstall: false });
  });

  it('writes no audit when the create is refused before any row exists', async () => {
    const out = JSON.parse(await tool().handler({ action: 'create', mode: 'blocklist' }, makeOrgAuth()));

    expect(out.error).toMatch(/name is required/);
    expect(recordPolicyAuditMock).not.toHaveBeenCalled();
    expect(writeAuditEventMock).not.toHaveBeenCalled();
  });
});

describe('manage_software_policies update — audit fan-out (#3543)', () => {
  it('records policy_updated naming the arming change and only the persisted fields', async () => {
    mockSelectReturns([{ id: POLICY_ID, name: 'Detect only', orgId: ORG_ID, partnerId: null, mode: 'blocklist' }]);
    mockUpdate();

    const out = JSON.parse(await tool().handler({
      action: 'update',
      policyId: POLICY_ID,
      enforceMode: true,
      remediationOptions: { autoUninstall: true },
    }, makeOrgAuth()));

    expect(out.success).toBe(true);

    expect(policyAudit()[0]).toMatchObject({
      orgId: ORG_ID, policyId: POLICY_ID, action: 'policy_updated', actor: 'ai', actorId: USER_ID,
    });
    expect(policyAudit()[0]!.details).toMatchObject({ enforceMode: true, autoUninstall: true });

    const updatedFields = (policyAudit()[0]!.details as any).updatedFields as string[];
    expect(updatedFields).toEqual(expect.arrayContaining(['enforceMode', 'remediationOptions']));
    // Derived from the columns written, so routing keys present in `input` must not leak in.
    expect(updatedFields).not.toContain('action');
    expect(updatedFields).not.toContain('policyId');
    expect(updatedFields).not.toContain('updatedAt');

    expect(auditLog()[0]).toMatchObject({ action: 'software_policy.update', resourceId: POLICY_ID, actorId: USER_ID });
  });

  it('writes no audit when the policy is not visible to the caller', async () => {
    mockSelectReturns([]);

    const out = JSON.parse(await tool().handler({ action: 'update', policyId: POLICY_ID, enforceMode: true }, makeOrgAuth()));

    expect(out.error).toMatch(/not found or access denied/i);
    expect(recordPolicyAuditMock).not.toHaveBeenCalled();
    expect(writeAuditEventMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });
});
