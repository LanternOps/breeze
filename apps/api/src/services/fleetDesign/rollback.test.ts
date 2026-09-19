import { beforeEach, describe, expect, it, vi } from 'vitest';

const ledgerMock = vi.hoisted(() => ({
  loadLedger: vi.fn(),
  lockReportRun: vi.fn(),
  markRolledBack: vi.fn(async () => undefined),
}));
vi.mock('./ledger', () => ledgerMock);

const configPolicyMock = vi.hoisted(() => ({
  listFeatureLinks: vi.fn(),
  policyAccessCondition: vi.fn(() => undefined),
  updateConfigPolicy: vi.fn(),
  updateFeatureLink: vi.fn(),
}));
vi.mock('../configurationPolicy', () => configPolicyMock);

const deviceGroupDeleteMock = vi.hoisted(() => ({ deleteDeviceGroup: vi.fn() }));
vi.mock('../deviceGroupDelete', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../deviceGroupDelete')>();
  return { ...actual, deleteDeviceGroup: deviceGroupDeleteMock.deleteDeviceGroup };
});

const deviceFunctionMock = vi.hoisted(() => ({ restoreDeviceFunction: vi.fn(async () => ({ outcome: 'restored', supersededAssessmentId: null })) }));
vi.mock('../deviceFunction', () => deviceFunctionMock);

const groupMembershipMock = vi.hoisted(() => ({
  addManualGroupMemberships: vi.fn(async () => ({ added: [], skipped: 0 })),
  validateManualMembershipDevices: vi.fn(async () => ({ ok: true })),
}));
vi.mock('../groupMembership', () => groupMembershipMock);

const partnerWideMock = vi.hoisted(() => ({ canManagePartnerWidePolicies: vi.fn(() => false) }));
vi.mock('../partnerWideAccess', () => partnerWideMock);

const peripheralJobsMock = vi.hoisted(() => ({ schedulePeripheralPolicyDevice: vi.fn(async () => undefined) }));
vi.mock('../../jobs/peripheralJobs', () => peripheralJobsMock);

const auditMock = vi.hoisted(() => ({
  writeAuditEvent: vi.fn(),
  requestLikeFromSnapshot: vi.fn(() => ({ fake: true })),
}));
vi.mock('../auditEvents', () => auditMock);

// --- Table-routed fake db ---------------------------------------------------
type Row = Record<string, unknown>;
const dbHolder = vi.hoisted(() => ({
  selectQueues: new Map<unknown, Row[][]>(),
  updateQueues: new Map<unknown, Row[][]>(),
  updates: [] as Array<{ table: unknown; set: Record<string, unknown>; where?: unknown }>,
  deletes: [] as Array<{ table: unknown; where?: unknown }>,
}));
function selectSeed(table: unknown, rows: Row[]) {
  const q = dbHolder.selectQueues.get(table) ?? [];
  q.push(rows);
  dbHolder.selectQueues.set(table, q);
}
function updateSeed(table: unknown, rows: Row[]) {
  const q = dbHolder.updateQueues.get(table) ?? [];
  q.push(rows);
  dbHolder.updateQueues.set(table, q);
}
vi.mock('../../db', () => ({
  db: {
    select: (_proj?: unknown) => ({
      from: (table: unknown) => {
        const q = dbHolder.selectQueues.get(table) ?? [];
        const rows = q.shift() ?? [];
        const withLimit = (r: Row[]) => {
          const p = Promise.resolve(r) as Promise<Row[]> & { limit?: (n: number) => Promise<Row[]> };
          p.limit = (n: number) => Promise.resolve(r.slice(0, n));
          return p;
        };
        return { where: (_cond: unknown) => withLimit(rows) };
      },
    }),
    update: (table: unknown) => ({
      set: (set: Record<string, unknown>) => {
        const entry = { table, set } as { table: unknown; set: Record<string, unknown>; where?: unknown };
        dbHolder.updates.push(entry);
        const q = dbHolder.updateQueues.get(table) ?? [];
        const rows = q.shift() ?? [];
        return { where: (cond: unknown) => { entry.where = cond; return { returning: (_p?: unknown) => Promise.resolve(rows) }; } };
      },
    }),
    delete: (table: unknown) => ({
      where: (cond: unknown) => { dbHolder.deletes.push({ table, where: cond }); return Promise.resolve(); },
    }),
    transaction: (cb: (tx?: unknown) => Promise<unknown>) => cb(),
  },
}));

import { rollbackFleetDesign } from './rollback';
import { snapshotLinks } from './apply';
import { FleetDesignApplyError } from './preview';
import { DeviceGroupDeleteError } from '../deviceGroupDelete';
import { configPolicyAssignments, configurationPolicies, deviceFunctionAssessments, deviceGroupMemberships, deviceGroups, devices, scripts, scriptTags, scriptToTags } from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import type { FleetDesignLedgerRow } from './ledger';

const ORG = '11111111-1111-4111-8111-111111111111';
const RUN = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';

function makeAuth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    principal: 'user',
    user: { id: USER, email: 'tech@example.com', name: 'Tech', isPlatformAdmin: false },
    token: null,
    partnerId: null,
    orgId: ORG,
    scope: 'organization',
    accessibleOrgIds: [ORG],
    partnerOrgAccess: null,
    orgCondition: () => undefined,
    canAccessOrg: () => true,
    ...overrides,
  } as unknown as AuthContext;
}

function row(overrides: Partial<FleetDesignLedgerRow>): FleetDesignLedgerRow {
  return {
    id: overrides.id ?? 'row-id',
    orgId: ORG,
    reportRunId: RUN,
    itemRef: 'x',
    itemKind: 'function',
    status: 'applied',
    step: 1,
    createdRefs: {},
    beforeImage: null,
    error: null,
    appliedByUserId: USER,
    appliedAt: new Date('2026-09-01T00:00:00Z'),
    rolledBackByUserId: null,
    rolledBackAt: null,
    ...overrides,
  } as unknown as FleetDesignLedgerRow;
}

function lockedOk() {
  return { reportRunId: RUN, reportId: 'report-1', orgId: ORG, outcome: null, summary: null };
}

beforeEach(() => {
  vi.clearAllMocks();
  dbHolder.selectQueues.clear();
  dbHolder.updateQueues.clear();
  dbHolder.updates.length = 0;
  dbHolder.deletes.length = 0;
  ledgerMock.markRolledBack.mockResolvedValue(undefined);
  ledgerMock.lockReportRun.mockResolvedValue(lockedOk());
  groupMembershipMock.validateManualMembershipDevices.mockResolvedValue({ ok: true });
});

describe('rollbackFleetDesign — not found', () => {
  it('throws FleetDesignApplyError(not_found) when the report run does not lock', async () => {
    ledgerMock.lockReportRun.mockResolvedValue(null);
    await expect(rollbackFleetDesign(makeAuth(), RUN)).rejects.toBeInstanceOf(FleetDesignApplyError);
    await expect(rollbackFleetDesign(makeAuth(), RUN)).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('rollbackFleetDesign — reverse order', () => {
  // NOTE: a step-3 policy row is deliberately excluded from this ordering
  // test — it's covered on its own below ("archives the policy, deletes the
  // assignment, and marks the ledger row rolled back when links still
  // match"), which used to document a real bug in rollbackPolicy's "still
  // matches" comparison (fixed; see that test's comment) and is kept
  // separate rather than folded in here.
  it('processes rows in reverse step order (5 -> 2 -> 1)', async () => {
    const roleRow = row({ id: 'role-1', itemRef: 'roleCorrections:d9', itemKind: 'role_correction', step: 5, beforeImage: { deviceRole: 'workstation', deviceRoleSource: 'discovered' } });
    const retiredRow = row({ id: 'retired-1', itemRef: 'retired:0', itemKind: 'retired', step: 2, createdRefs: { policyId: 'p2', linkId: 'link-retired' }, beforeImage: { inlineSettings: { watches: [{ name: 'Spooler', enabled: true }] } } });
    const functionRow = row({ id: 'function-1', itemRef: 'functions:printer_server', itemKind: 'function', step: 1, createdRefs: { groupId: 'g-missing' }, beforeImage: { memberships: [], priorAssessmentIdByDevice: {} } });

    ledgerMock.loadLedger.mockResolvedValue([roleRow, retiredRow, functionRow]);

    // role correction
    updateSeed(devices, [{ id: 'd9' }]);
    // retired
    selectSeed(configurationPolicies, [{ id: 'p2', orgId: ORG }]);
    configPolicyMock.listFeatureLinks.mockResolvedValue([
      { id: 'link-retired', featureType: 'monitoring', featurePolicyId: null, inlineSettings: { watches: [{ name: 'Spooler', enabled: false }] } },
    ]);
    configPolicyMock.updateFeatureLink.mockResolvedValue({ id: 'link-retired' });
    // function: group already gone → early return (no further db calls needed)

    const result = await rollbackFleetDesign(makeAuth(), RUN);

    expect(result.rolledBack).toEqual(expect.arrayContaining(['roleCorrections:d9', 'retired:0', 'functions:printer_server']));
    // Processing order reflected in the audit trail: step 5, then 2, then 1.
    const order = auditMock.writeAuditEvent.mock.calls.map((c) => (c[1] as { details: { itemRef: string } }).details.itemRef);
    expect(order).toEqual(['roleCorrections:d9', 'retired:0', 'functions:printer_server']);
  });

});

describe('rollbackFleetDesign — policy row', () => {
  const links = [
    { id: 'link-mon', featureType: 'monitoring', featurePolicyId: null, inlineSettings: { watches: [{ name: 'Spooler', enabled: true }] } },
    { id: 'link-rule', featureType: 'alert_rule', featurePolicyId: null, inlineSettings: { items: [] } },
  ];

  it('refuses with modified_since_apply when the links no longer equal the linksSnapshot, and the row stays applied', async () => {
    const policyRow = row({ id: 'policy-1', itemRef: 'policy:file_server', itemKind: 'policy', step: 3, createdRefs: { policyId: 'p1', groupId: 'g1', assignmentId: 'assign-1', linksSnapshot: snapshotLinks(links) } });
    ledgerMock.loadLedger.mockResolvedValue([policyRow]);
    selectSeed(configurationPolicies, [{ id: 'p1', orgId: ORG, status: 'active' }]);
    // Current links differ from the snapshot (a technician edited them by hand).
    configPolicyMock.listFeatureLinks.mockResolvedValue([
      { id: 'link-mon', featureType: 'monitoring', featurePolicyId: null, inlineSettings: { watches: [{ name: 'Spooler', enabled: false }] } },
      { id: 'link-rule', featureType: 'alert_rule', featurePolicyId: null, inlineSettings: { items: [] } },
    ]);

    const result = await rollbackFleetDesign(makeAuth(), RUN);

    expect(result.refused).toEqual([{ itemRef: 'policy:file_server', reason: 'modified_since_apply' }]);
    expect(result.rolledBack).toEqual([]);
    expect(configPolicyMock.updateConfigPolicy).not.toHaveBeenCalled();
    expect(ledgerMock.markRolledBack).not.toHaveBeenCalled();
  });

  // Both sides of the linksSnapshot comparison go through canonical(): a
  // mocked ledger row never crosses a jsonb round trip, so this suite cannot
  // see the key-order difference the integration suite (case 6) proved on
  // real Postgres. The assertion here is the sequence, not the comparison.
  it('archives the policy, deletes the assignment, and marks the ledger row rolled back when links still match', async () => {
    const policyRow = row({ id: 'policy-1', itemRef: 'policy:file_server', itemKind: 'policy', step: 3, createdRefs: { policyId: 'p1', groupId: 'g1', assignmentId: 'assign-1', linksSnapshot: snapshotLinks(links) } });
    ledgerMock.loadLedger.mockResolvedValue([policyRow]);
    selectSeed(configurationPolicies, [{ id: 'p1', orgId: ORG, status: 'active' }]);
    configPolicyMock.listFeatureLinks.mockResolvedValue(links);
    configPolicyMock.updateConfigPolicy.mockResolvedValue({ id: 'p1', status: 'archived' });

    const result = await rollbackFleetDesign(makeAuth(), RUN);

    expect(dbHolder.deletes).toContainEqual({ table: configPolicyAssignments, where: expect.anything() });
    expect(configPolicyMock.updateConfigPolicy).toHaveBeenCalledWith('p1', { status: 'archived' }, expect.anything());
    expect(ledgerMock.markRolledBack).toHaveBeenCalledWith(['policy-1'], ORG, USER);
    expect(result.rolledBack).toEqual(['policy:file_server']);
    expect(result.refused).toEqual([]);
  });
});

describe('rollbackFleetDesign — retired row', () => {
  const before = { checkIntervalSeconds: 60, watches: [{ name: 'Spooler', enabled: true }, { name: 'BITS', enabled: true }] };

  it('restores the before-image when the current settings equal the recomputed post-apply value', async () => {
    const retiredRow = row({ id: 'retired-1', itemRef: 'retired:0', itemKind: 'retired', step: 2, createdRefs: { policyId: 'p2', linkId: 'link-1' }, beforeImage: { inlineSettings: before } });
    ledgerMock.loadLedger.mockResolvedValue([retiredRow]);
    selectSeed(configurationPolicies, [{ id: 'p2', orgId: ORG }]);
    configPolicyMock.listFeatureLinks.mockResolvedValue([
      { id: 'link-1', featureType: 'monitoring', featurePolicyId: null, inlineSettings: { checkIntervalSeconds: 60, watches: [{ name: 'Spooler', enabled: false }, { name: 'BITS', enabled: true }] } },
    ]);
    configPolicyMock.updateFeatureLink.mockResolvedValue({ id: 'link-1' });

    const result = await rollbackFleetDesign(makeAuth(), RUN);

    expect(configPolicyMock.updateFeatureLink).toHaveBeenCalledWith('link-1', { inlineSettings: before }, 'p2');
    expect(result.rolledBack).toEqual(['retired:0']);
  });

  it('refuses when the current settings do not match the expected post-apply rewrite (someone else edited it too)', async () => {
    const retiredRow = row({ id: 'retired-1', itemRef: 'retired:0', itemKind: 'retired', step: 2, createdRefs: { policyId: 'p2', linkId: 'link-1' }, beforeImage: { inlineSettings: before } });
    ledgerMock.loadLedger.mockResolvedValue([retiredRow]);
    selectSeed(configurationPolicies, [{ id: 'p2', orgId: ORG }]);
    // BITS was ALSO disabled by hand since the apply — no longer the exact expected rewrite.
    configPolicyMock.listFeatureLinks.mockResolvedValue([
      { id: 'link-1', featureType: 'monitoring', featurePolicyId: null, inlineSettings: { checkIntervalSeconds: 60, watches: [{ name: 'Spooler', enabled: false }, { name: 'BITS', enabled: false }] } },
    ]);

    const result = await rollbackFleetDesign(makeAuth(), RUN);

    expect(result.refused).toEqual([{ itemRef: 'retired:0', reason: 'modified_since_apply' }]);
    expect(configPolicyMock.updateFeatureLink).not.toHaveBeenCalled();
  });

  it('refuses modified_since_apply when the before-image has two identically-named items — ambiguous rewrite, fails closed rather than picking one', async () => {
    // Both entries share the name 'Spooler'; retireRewrite keys purely by
    // name, so retiring either occurrence produces the SAME rewritten
    // settings. `current` legitimately equals that single rewrite, but two
    // distinct before-image entries "explain" it — expectedAfterRetire must
    // refuse rather than silently pick the first.
    const ambiguousBefore = { checkIntervalSeconds: 60, watches: [{ name: 'Spooler', enabled: true }, { name: 'Spooler', enabled: true }] };
    const retiredRow = row({ id: 'retired-1', itemRef: 'retired:0', itemKind: 'retired', step: 2, createdRefs: { policyId: 'p2', linkId: 'link-1' }, beforeImage: { inlineSettings: ambiguousBefore } });
    ledgerMock.loadLedger.mockResolvedValue([retiredRow]);
    selectSeed(configurationPolicies, [{ id: 'p2', orgId: ORG }]);
    configPolicyMock.listFeatureLinks.mockResolvedValue([
      { id: 'link-1', featureType: 'monitoring', featurePolicyId: null, inlineSettings: { checkIntervalSeconds: 60, watches: [{ name: 'Spooler', enabled: false }, { name: 'Spooler', enabled: false }] } },
    ]);

    const result = await rollbackFleetDesign(makeAuth(), RUN);

    expect(result.refused).toEqual([{ itemRef: 'retired:0', reason: 'modified_since_apply' }]);
    expect(configPolicyMock.updateFeatureLink).not.toHaveBeenCalled();
  });

  describe('rule branch', () => {
    const ruleBefore = { items: [{ name: 'Disk full' }, { name: 'CPU high' }] };

    it('restores the before-image for an alert_rule link when the current items equal the recomputed post-apply value', async () => {
      const retiredRow = row({ id: 'retired-1', itemRef: 'retired:0', itemKind: 'retired', step: 2, createdRefs: { policyId: 'p2', linkId: 'link-rule' }, beforeImage: { inlineSettings: ruleBefore } });
      ledgerMock.loadLedger.mockResolvedValue([retiredRow]);
      selectSeed(configurationPolicies, [{ id: 'p2', orgId: ORG }]);
      // 'Disk full' was removed by the apply — matches retireRewrite('rule', 'Disk full', ruleBefore).
      configPolicyMock.listFeatureLinks.mockResolvedValue([
        { id: 'link-rule', featureType: 'alert_rule', featurePolicyId: null, inlineSettings: { items: [{ name: 'CPU high' }] } },
      ]);
      configPolicyMock.updateFeatureLink.mockResolvedValue({ id: 'link-rule' });

      const result = await rollbackFleetDesign(makeAuth(), RUN);

      expect(configPolicyMock.updateFeatureLink).toHaveBeenCalledWith('link-rule', { inlineSettings: ruleBefore }, 'p2');
      expect(result.rolledBack).toEqual(['retired:0']);
    });

    it('refuses when the current alert_rule items do not match the expected post-apply rewrite', async () => {
      const retiredRow = row({ id: 'retired-1', itemRef: 'retired:0', itemKind: 'retired', step: 2, createdRefs: { policyId: 'p2', linkId: 'link-rule' }, beforeImage: { inlineSettings: ruleBefore } });
      ledgerMock.loadLedger.mockResolvedValue([retiredRow]);
      selectSeed(configurationPolicies, [{ id: 'p2', orgId: ORG }]);
      // 'CPU high' was ALSO removed by hand since the apply.
      configPolicyMock.listFeatureLinks.mockResolvedValue([
        { id: 'link-rule', featureType: 'alert_rule', featurePolicyId: null, inlineSettings: { items: [] } },
      ]);

      const result = await rollbackFleetDesign(makeAuth(), RUN);

      expect(result.refused).toEqual([{ itemRef: 'retired:0', reason: 'modified_since_apply' }]);
      expect(configPolicyMock.updateFeatureLink).not.toHaveBeenCalled();
    });
  });

  describe('partner-wide guard', () => {
    it('refuses with partner_wide_write_denied for a partner-wide policy (orgId null) when the caller cannot manage partner-wide policies', async () => {
      const retiredRow = row({ id: 'retired-1', itemRef: 'retired:0', itemKind: 'retired', step: 2, createdRefs: { policyId: 'p2', linkId: 'link-1' }, beforeImage: { inlineSettings: before } });
      ledgerMock.loadLedger.mockResolvedValue([retiredRow]);
      selectSeed(configurationPolicies, [{ id: 'p2', orgId: null }]);
      partnerWideMock.canManagePartnerWidePolicies.mockReturnValueOnce(false);
      const auth = makeAuth({ scope: 'partner', partnerOrgAccess: 'selected' });

      const result = await rollbackFleetDesign(auth, RUN);

      expect(partnerWideMock.canManagePartnerWidePolicies).toHaveBeenCalledWith(auth);
      expect(result.refused).toEqual([{ itemRef: 'retired:0', reason: 'partner_wide_write_denied' }]);
      expect(configPolicyMock.listFeatureLinks).not.toHaveBeenCalled();
      expect(configPolicyMock.updateFeatureLink).not.toHaveBeenCalled();
      expect(ledgerMock.markRolledBack).not.toHaveBeenCalled();
    });

    it('proceeds past the guard for a partner-wide policy when the caller has full partner org access (positive control)', async () => {
      const retiredRow = row({ id: 'retired-1', itemRef: 'retired:0', itemKind: 'retired', step: 2, createdRefs: { policyId: 'p2', linkId: 'link-1' }, beforeImage: { inlineSettings: before } });
      ledgerMock.loadLedger.mockResolvedValue([retiredRow]);
      selectSeed(configurationPolicies, [{ id: 'p2', orgId: null }]);
      configPolicyMock.listFeatureLinks.mockResolvedValue([
        { id: 'link-1', featureType: 'monitoring', featurePolicyId: null, inlineSettings: { checkIntervalSeconds: 60, watches: [{ name: 'Spooler', enabled: false }, { name: 'BITS', enabled: true }] } },
      ]);
      configPolicyMock.updateFeatureLink.mockResolvedValue({ id: 'link-1' });
      partnerWideMock.canManagePartnerWidePolicies.mockReturnValueOnce(true);
      const auth = makeAuth({ scope: 'partner', partnerOrgAccess: 'all' });

      const result = await rollbackFleetDesign(auth, RUN);

      expect(partnerWideMock.canManagePartnerWidePolicies).toHaveBeenCalledWith(auth);
      expect(configPolicyMock.updateFeatureLink).toHaveBeenCalledWith('link-1', { inlineSettings: before }, 'p2');
      expect(result.refused).toEqual([]);
      expect(result.rolledBack).toEqual(['retired:0']);
    });
  });
});

describe('rollbackFleetDesign — function row (group + assessments)', () => {
  it('restores prior assessments and deletes a created group whose membership exactly matches the apply snapshot', async () => {
    const functionRow = row({
      id: 'function-1', itemRef: 'functions:file_server', itemKind: 'function', step: 1,
      createdRefs: { groupId: 'g1', groupCreated: true, assessmentIds: ['assess-1', 'assess-2'], membershipSnapshot: ['d1', 'd2'] },
      beforeImage: { memberships: [], priorAssessmentIdByDevice: { d1: 'prior-1', d2: null } },
    });
    ledgerMock.loadLedger.mockResolvedValue([functionRow]);
    selectSeed(deviceFunctionAssessments, [{ id: 'assess-1', deviceId: 'd1' }, { id: 'assess-2', deviceId: 'd2' }]);
    selectSeed(deviceGroups, [{ id: 'g1', siteId: null }]);
    selectSeed(deviceGroupMemberships, [{ deviceId: 'd1' }, { deviceId: 'd2' }]); // matches snapshot exactly
    deviceGroupDeleteMock.deleteDeviceGroup.mockResolvedValue({ group: { id: 'g1', name: 'x', orgId: ORG }, affectedDeviceIds: ['d1', 'd2'] });

    const result = await rollbackFleetDesign(makeAuth(), RUN);

    expect(deviceFunctionMock.restoreDeviceFunction).toHaveBeenCalledWith({ deviceId: 'd1', orgId: ORG, assessmentId: 'prior-1', userId: USER });
    expect(deviceFunctionMock.restoreDeviceFunction).toHaveBeenCalledWith({ deviceId: 'd2', orgId: ORG, assessmentId: null, userId: USER });
    expect(deviceGroupDeleteMock.deleteDeviceGroup).toHaveBeenCalledWith('g1', ORG);
    expect(result.rolledBack).toEqual(['functions:file_server']);
  });

  it('refuses with group_has_other_members when a created group\'s membership no longer matches the apply snapshot', async () => {
    const functionRow = row({
      id: 'function-1', itemRef: 'functions:file_server', itemKind: 'function', step: 1,
      createdRefs: { groupId: 'g1', groupCreated: true, assessmentIds: [], membershipSnapshot: ['d1', 'd2'] },
      beforeImage: { memberships: [], priorAssessmentIdByDevice: {} },
    });
    ledgerMock.loadLedger.mockResolvedValue([functionRow]);
    selectSeed(deviceGroups, [{ id: 'g1', siteId: null }]);
    selectSeed(deviceGroupMemberships, [{ deviceId: 'd1' }, { deviceId: 'd2' }, { deviceId: 'd3' }]); // a technician added d3 since

    const result = await rollbackFleetDesign(makeAuth(), RUN);

    expect(result.refused).toEqual([{ itemRef: 'functions:file_server', reason: 'group_has_other_members' }]);
    expect(deviceGroupDeleteMock.deleteDeviceGroup).not.toHaveBeenCalled();
  });

  it('for a REUSED group, removes only the memberships this apply added and restores only those it removed', async () => {
    const functionRow = row({
      id: 'function-1', itemRef: 'functions:file_server', itemKind: 'function', step: 1,
      createdRefs: { groupId: 'g1', groupCreated: false, assessmentIds: [], membershipSnapshot: ['d1', 'd2'] },
      beforeImage: { memberships: ['d2', 'd3'], priorAssessmentIdByDevice: {} },
    });
    ledgerMock.loadLedger.mockResolvedValue([functionRow]);
    selectSeed(deviceGroups, [{ id: 'g1', siteId: null }]);
    // Current membership: d1 (added by apply), d2 (unchanged) — d3 was removed by the apply.
    selectSeed(deviceGroupMemberships, [{ deviceId: 'd1' }, { deviceId: 'd2' }]);

    const result = await rollbackFleetDesign(makeAuth(), RUN);

    expect(dbHolder.deletes).toContainEqual({ table: deviceGroupMemberships, where: expect.anything() });
    expect(groupMembershipMock.addManualGroupMemberships).toHaveBeenCalledWith({ groupId: 'g1', orgId: ORG, deviceIds: ['d3'] });
    expect(deviceGroupDeleteMock.deleteDeviceGroup).not.toHaveBeenCalled();
    expect(result.rolledBack).toEqual(['functions:file_server']);
  });
});

describe('rollbackFleetDesign — role correction', () => {
  it('restores the before-image only while the device is still deviceRoleSource=ai', async () => {
    const roleRow = row({ id: 'role-1', itemRef: 'roleCorrections:d9', itemKind: 'role_correction', step: 5, beforeImage: { deviceRole: 'workstation', deviceRoleSource: 'discovered' } });
    ledgerMock.loadLedger.mockResolvedValue([roleRow]);
    updateSeed(devices, [{ id: 'd9' }]); // simulates the WHERE deviceRoleSource='ai' matching

    const result = await rollbackFleetDesign(makeAuth(), RUN);

    expect(dbHolder.updates[0]!.set).toMatchObject({ deviceRole: 'workstation', deviceRoleSource: 'discovered' });
    expect(result.rolledBack).toEqual(['roleCorrections:d9']);
  });

  it('refuses when the device role source has moved on (no longer ai — e.g. a manual edit)', async () => {
    const roleRow = row({ id: 'role-1', itemRef: 'roleCorrections:d9', itemKind: 'role_correction', step: 5, beforeImage: { deviceRole: 'workstation', deviceRoleSource: 'discovered' } });
    ledgerMock.loadLedger.mockResolvedValue([roleRow]);
    updateSeed(devices, []); // WHERE deviceRoleSource='ai' matched nothing

    const result = await rollbackFleetDesign(makeAuth(), RUN);

    expect(result.refused).toEqual([{ itemRef: 'roleCorrections:d9', reason: 'modified_since_apply' }]);
  });
});

describe('rollbackFleetDesign — cross-item dependency', () => {
  it('a refused policy row marks its group as still targeted, so the function row for the same group is refused too', async () => {
    const links = [
      { id: 'link-mon', featureType: 'monitoring', featurePolicyId: null, inlineSettings: { watches: [{ name: 'Spooler', enabled: true }] } },
    ];
    const policyRow = row({ id: 'policy-1', itemRef: 'policy:file_server', itemKind: 'policy', step: 3, createdRefs: { policyId: 'p1', groupId: 'g1', linksSnapshot: snapshotLinks(links) } });
    const functionRow = row({
      id: 'function-1', itemRef: 'functions:file_server', itemKind: 'function', step: 1,
      createdRefs: { groupId: 'g1', groupCreated: true, assessmentIds: [], membershipSnapshot: ['d1'] },
      beforeImage: { memberships: [], priorAssessmentIdByDevice: {} },
    });
    ledgerMock.loadLedger.mockResolvedValue([policyRow, functionRow]);
    selectSeed(configurationPolicies, [{ id: 'p1', orgId: ORG, status: 'active' }]);
    // Current links differ from the snapshot → policy refused.
    configPolicyMock.listFeatureLinks.mockResolvedValue([
      { id: 'link-mon', featureType: 'monitoring', featurePolicyId: null, inlineSettings: { watches: [{ name: 'Spooler', enabled: false }] } },
    ]);

    const result = await rollbackFleetDesign(makeAuth(), RUN);

    expect(result.refused).toEqual(expect.arrayContaining([
      { itemRef: 'policy:file_server', reason: 'modified_since_apply' },
      { itemRef: 'functions:file_server', reason: 'modified_since_apply' },
    ]));
    expect(deviceGroupDeleteMock.deleteDeviceGroup).not.toHaveBeenCalled();
    expect(deviceFunctionMock.restoreDeviceFunction).not.toHaveBeenCalled();
  });
});

describe('rollbackFleetDesign — script row (W04)', () => {
  const scriptRow = () => row({ id: 'script-row', itemRef: 'automation:file_server:script:0', itemKind: 'script', step: 4, createdRefs: { scriptId: 'script-a', scriptName: 'Restart print spooler' } });

  it('removes only the fleet-design tag link and leaves the script in place', async () => {
    ledgerMock.loadLedger.mockResolvedValue([scriptRow()]);
    selectSeed(scriptTags, [{ id: 'tag-fd' }]);

    const result = await rollbackFleetDesign(makeAuth(), RUN, undefined, { canWriteScripts: true });

    expect(result).toEqual({ rolledBack: ['automation:file_server:script:0'], refused: [] });
    expect(dbHolder.deletes.map((d) => d.table)).toEqual([scriptToTags]);
    expect(dbHolder.deletes.find((d) => d.table === scripts)).toBeUndefined();
    expect(dbHolder.updates.find((u) => u.table === scripts)).toBeUndefined();
    expect(ledgerMock.markRolledBack).toHaveBeenCalledWith(['script-row'], ORG, USER);
  });

  it('with no fleet-design tag left in the org there is nothing to untag, and the row still rolls back', async () => {
    ledgerMock.loadLedger.mockResolvedValue([scriptRow()]);
    selectSeed(scriptTags, []);
    const result = await rollbackFleetDesign(makeAuth(), RUN, undefined, { canWriteScripts: true });
    expect(result.rolledBack).toEqual(['automation:file_server:script:0']);
    expect(dbHolder.deletes).toEqual([]);
  });

  it('refuses the script row (scripts_write_required) for a caller without scripts:write — and by default', async () => {
    ledgerMock.loadLedger.mockResolvedValue([scriptRow()]);
    const result = await rollbackFleetDesign(makeAuth(), RUN);
    expect(result).toEqual({ rolledBack: [], refused: [{ itemRef: 'automation:file_server:script:0', reason: 'scripts_write_required' }] });
    expect(dbHolder.deletes).toEqual([]);
    expect(ledgerMock.markRolledBack).not.toHaveBeenCalled();
  });

  it('rolls the script row back after step 5 and before step 1', async () => {
    const roleRow = row({ id: 'role-1', itemRef: 'roleCorrections:d9', itemKind: 'role_correction', step: 5, beforeImage: { deviceRole: 'workstation', deviceRoleSource: 'auto' } });
    const functionRow = row({ id: 'function-1', itemRef: 'functions:x', itemKind: 'function', step: 1, createdRefs: { groupId: 'g-missing' }, beforeImage: { memberships: [], priorAssessmentIdByDevice: {} } });
    ledgerMock.loadLedger.mockResolvedValue([functionRow, scriptRow(), roleRow]);
    updateSeed(devices, [{ id: 'd9' }]);
    selectSeed(scriptTags, [{ id: 'tag-fd' }]);
    await rollbackFleetDesign(makeAuth(), RUN, undefined, { canWriteScripts: true });
    const order = auditMock.writeAuditEvent.mock.calls.map((c) => (c[1] as { details: { itemRef: string } }).details.itemRef);
    expect(order).toEqual(['roleCorrections:d9', 'automation:file_server:script:0', 'functions:x']);
  });
});

describe('rollbackFleetDesign — deleteDeviceGroup guard errors', () => {
  it('converts a thrown DeviceGroupDeleteError into a refusal, not an unhandled throw', async () => {
    const functionRow = row({
      id: 'function-1', itemRef: 'functions:file_server', itemKind: 'function', step: 1,
      createdRefs: { groupId: 'g1', groupCreated: true, assessmentIds: [], membershipSnapshot: ['d1'] },
      beforeImage: { memberships: [], priorAssessmentIdByDevice: {} },
    });
    ledgerMock.loadLedger.mockResolvedValue([functionRow]);
    selectSeed(deviceGroups, [{ id: 'g1', siteId: null }]);
    selectSeed(deviceGroupMemberships, [{ deviceId: 'd1' }]); // matches snapshot → attempts deletion
    deviceGroupDeleteMock.deleteDeviceGroup.mockRejectedValue(new DeviceGroupDeleteError('BILLED_BY_CONTRACTS', 'billed by a contract'));

    const result = await rollbackFleetDesign(makeAuth(), RUN);

    expect(result.refused).toEqual([{ itemRef: 'functions:file_server', reason: 'modified_since_apply' }]);
    expect(result.rolledBack).toEqual([]);
  });
});
