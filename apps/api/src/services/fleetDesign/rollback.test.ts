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
import { configPolicyAssignments, configurationPolicies, deviceFunctionAssessments, deviceGroupMemberships, deviceGroups, devices } from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import type { FleetDesignLedgerRow } from './ledger';

const ORG = '11111111-1111-4111-8111-111111111111';
const RUN = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';

function makeAuth(): AuthContext {
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

  // FIXED (Fleet Designer W03 integration pass, fleetDesignApply.integration.test.ts
  // case 6/7): rollback.ts's rollbackPolicy compared `JSON.stringify(current)`
  // — the RAW `snapshotLinks()` output, whose two top-level keys keep JS
  // insertion order `{ monitoring, alertRule }` — against
  // `JSON.stringify(canonical(expected))`. In THIS mocked suite `expected`
  // (`createdRefs.linksSnapshot`) is the same in-memory object `snapshotLinks`
  // just produced, so the two happened to already agree in key order and this
  // test passed even with the bug in place — a mocked ledger row never goes
  // through a real jsonb round trip. Against live Postgres, jsonb does NOT
  // preserve insertion order: a freshly-read `createdRefs.linksSnapshot` came
  // back with its two top-level keys reordered (alphabetically), so `current`
  // and `canonical(expected)` differed in key order on every call regardless
  // of content — a Fleet Design policy rollback always refused with
  // `modified_since_apply`, even immediately after a clean apply with zero
  // changes. `it.fails` had locked this in as a known-failing case here so it
  // would start FAILING this suite (forcing a promotion back to `it`) the
  // moment rollback.ts was fixed — which is what promotes it below.
  // Fix: wrap `current` in `canonical()` too (rollback.ts's `rollbackPolicy`),
  // so both sides are recursively key-sorted regardless of how the ledger's
  // jsonb column happens to order them.
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
