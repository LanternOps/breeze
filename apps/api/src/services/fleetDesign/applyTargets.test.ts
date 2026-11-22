/**
 * W16 PR B (#6786, T8): what a four-eyes Fleet Design apply or rollback is bound
 * to. The effect-digest resolver has no auth, so it cannot be the preview; this
 * snapshot has to pin what the preview showed the approver, and every class of
 * drift the plan names has to change it. The fake database returns each table's
 * rows whatever the WHERE (real predicates: aiToolsAiDesignWrites.integration).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FleetDesignApproval, FleetDesignOutcome } from '@breeze/shared';

const h = vi.hoisted(() => ({
  tables: new Map<unknown, Array<Record<string, unknown>>>(),
  reusable: new Map<string, { groupId: string }>(),
  locked: null as unknown,
}));

function fakeDb() {
  const chain = (rows: () => Array<Record<string, unknown>>) => {
    const query: Record<string, unknown> = {
      innerJoin: () => query,
      where: () => query,
      orderBy: () => query,
      limit: () => query,
      for: () => query,
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(rows()).then(resolve, reject),
    };
    return query;
  };
  return {
    select: () => ({ from: (table: unknown) => chain(() => h.tables.get(table) ?? []) }),
  };
}

vi.mock('../../db', () => ({ db: fakeDb() }));
vi.mock('./ledger', () => ({
  findReusableGroup: vi.fn(async (_org: string, key: string) => h.reusable.get(key) ?? null),
  loadLedger: vi.fn(async () => h.tables.get(fleetDesignAppliedItems) ?? []),
  lockReportRun: vi.fn(async () => h.locked),
}));
vi.mock('../configurationPolicy', () => ({ policyAccessCondition: vi.fn(() => undefined) }));
vi.mock('../scriptBundle', () => ({
  previewBundle: vi.fn(async () => ({ target: {}, entries: [{ index: 0, status: 'ok' }] })),
  findSecretVariableReferences: vi.fn(async () => []),
}));
vi.mock('./monitorAttachments', () => ({
  snapshotFleetMonitors: vi.fn(async (ids: string[]) => Object.fromEntries(ids.map((id) => [id, h.tables.get('monitorDefs')?.find((m) => m.id === id) ?? null]))),
}));

import type { Database } from '../../db';
import {
  configPolicyAssignments,
  configPolicyFeatureLinks,
  configurationPolicies,
  deviceFunctionAssessments,
  deviceGroupMemberships,
  devices,
  fleetDesignAppliedItems,
  notificationChannelConfigs,
  notificationChannels,
  reportRuns,
} from '../../db/schema';
import { previewFleetDesignApply } from './preview';
import { snapshotFleetDesignApplyTargets, snapshotFleetDesignRollbackTargets } from './applyTargets';

const ORG = '00000000-0000-4000-8000-0000000000a1';
const RUN = '00000000-0000-4000-8000-0000000000a3';
const D1 = '00000000-0000-4000-8000-0000000000d1';
const D2 = '00000000-0000-4000-8000-0000000000d2';
const D3 = '00000000-0000-4000-8000-0000000000d3';
const GROUP = '00000000-0000-4000-8000-0000000000e1';
const POLICY = '00000000-0000-4000-8000-0000000000f1';
const CHANNEL = '00000000-0000-4000-8000-0000000000c1';

const database = fakeDb() as unknown as Database;

function outcome(): FleetDesignOutcome {
  return {
    sections: {
      functions: [{ functionKey: 'file_server', label: 'File server', deviceIds: [D1, D2, D3], confidence: 0.9, evidence: [] }],
      monitoring: [{
        functionKey: 'file_server',
        watches: [{ watchType: 'service', name: 'LanmanServer', alertOnStop: true, autoRestart: true, rationale: 'why' }],
        alertRules: [{ name: 'Disk', severity: 'high', kind: 'disk', condition: {}, responses: [], deliveryMode: 'channels', deliveryChannelIds: [CHANNEL], cooldownMinutes: 5, rationale: 'why', action: 'none', paging: 'none' }],
      }],
      retired: [],
      automation: [{ functionKey: 'file_server', scripts: [{ name: 'Fix', purpose: 'p', osTypes: ['windows'], language: 'powershell', content: 'Restart-Service x' }] }],
      unsure: { roleCorrections: [{ deviceId: D1, proposedRole: 'server', reason: 'r' }] },
    },
  } as unknown as FleetDesignOutcome;
}

const reportRow = (over: Record<string, unknown> = {}) => ({
  reportRunId: RUN, summary: { fleetDesign: { outcome: outcome() } }, ...over,
});

const approval = (over: Partial<FleetDesignApproval> = {}): FleetDesignApproval => ({
  functions: ['file_server'],
  monitoring: ['monitoring:file_server:watch:0', 'monitoring:file_server:rule:0'],
  retired: [],
  automation: ['automation:file_server:script:0'],
  legacy: [],
  roleCorrections: [D1],
  displacementsAccepted: [],
  ...over,
});

const deviceRow = (id: string, over: Record<string, unknown> = {}) => ({
  id, hostname: `host-${id.slice(-2)}`, deviceRole: 'workstation', deviceRoleSource: 'auto', deviceFunctionSource: 'ai', ...over,
});

function seed() {
  h.tables.clear();
  h.reusable.clear();
  h.reusable.set('file_server', { groupId: GROUP });
  h.tables.set(reportRuns, [reportRow()]);
  h.tables.set(devices, [deviceRow(D1), deviceRow(D2), deviceRow(D3)]);
  h.tables.set(deviceGroupMemberships, [{ groupId: GROUP, deviceId: D1 }, { groupId: GROUP, deviceId: D2 }]);
  h.tables.set(deviceFunctionAssessments, [{ id: 'a1', deviceId: D1, functionKey: 'file_server', source: 'ai' }]);
  h.tables.set(fleetDesignAppliedItems, [
    { id: 'l1', itemRef: 'policy:file_server', itemKind: 'policy', status: 'applied', step: 3, appliedAt: new Date('2026-11-01T00:00:00Z'), createdRefs: { policyId: POLICY, groupId: GROUP, monitorIdsByItemRef: { r: 'm1' } }, beforeImage: null },
  ]);
  h.tables.set(configurationPolicies, [{ id: POLICY, orgId: ORG, partnerId: null, status: 'active' }]);
  h.tables.set(configPolicyAssignments, [{ id: 'as1', configPolicyId: POLICY, level: 'device_group', targetId: GROUP, priority: 100, roleFilter: null, osFilter: null }]);
  h.tables.set(configPolicyFeatureLinks, [{ id: 'lk1', configPolicyId: POLICY, featureType: 'monitors', featurePolicyId: null, inlineSettings: { items: [], inheritance: 'cumulative' } }]);
  h.tables.set(notificationChannels, [{ id: CHANNEL, orgId: ORG, partnerId: null, type: 'webhook', name: 'Ops', enabled: true }]);
  h.tables.set(notificationChannelConfigs, [{ channelId: CHANNEL, config: { url: 'https://hooks.example.test/x' } }]);
  h.tables.set('monitorDefs', [{ id: 'm1', name: 'Disk' }]);
  h.locked = { reportRunId: RUN, reportId: 'rep', orgId: ORG, summary: null, outcome: outcome() };
}

const update = (table: unknown, fn: (row: Record<string, unknown>) => Record<string, unknown>) => {
  h.tables.set(table, (h.tables.get(table) ?? []).map(fn));
};

const applySnap = (a: FleetDesignApproval = approval()) => snapshotFleetDesignApplyTargets(RUN, ORG, a, database);

beforeEach(seed);

describe('snapshotFleetDesignApplyTargets', () => {
  it('agrees with the preview on what the approver saw', async () => {
    const preview = await previewFleetDesignApply({ orgCondition: () => undefined } as never, RUN, approval());
    const snap = await applySnap();
    const fn = snap!.functions.find((f) => f.functionKey === 'file_server')!;
    const shown = preview.functions[0]!;
    expect(shown.groupId).toBe(fn.groupId);
    // Wanted = what the group will hold; added/removed are its difference with the members.
    expect([...fn.wantedDeviceIds].sort()).toEqual([D1, D2, D3].sort());
    expect(fn.wantedDeviceIds.filter((d) => !fn.groupMemberIds.includes(d))).toEqual(shown.devicesAdded);
    expect(fn.groupMemberIds.filter((d) => !fn.wantedDeviceIds.includes(d))).toEqual(shown.devicesRemoved);
    expect(preview.roleCorrections.map((r) => r.deviceId)).toEqual(snap!.approval.roleCorrections);
    expect(preview.scripts.map((s) => s.itemRef)).toEqual(snap!.scripts.map((s) => s.itemRef));
  });

  it('drops a named device that left the org, as the preview does', async () => {
    update(devices, (r) => r);
    h.tables.set(devices, [deviceRow(D1), deviceRow(D2)]);
    const preview = await previewFleetDesignApply({ orgCondition: () => undefined } as never, RUN, approval());
    const snap = await applySnap();
    expect(preview.functions[0]!.missingDevices).toEqual([D3]);
    expect(snap!.functions[0]!.missingDeviceIds).toEqual([D3]);
    expect(snap!.functions[0]!.wantedDeviceIds).not.toContain(D3);
  });

  it('pins the group of a monitored function the approval does not itself approve', async () => {
    const snap = await applySnap(approval({ functions: [], automation: [], roleCorrections: [] }));
    expect(snap!.functions[0]).toMatchObject({ functionKey: 'file_server', groupId: GROUP, wantedDeviceIds: [D1, D2].sort() });
  });

  describe('digest changes when', () => {
    const cases: Array<[string, () => void]> = [
      ['a named device leaves the org', () => h.tables.set(devices, [deviceRow(D1), deviceRow(D2)])],
      ['a function group gains a member', () => h.tables.get(deviceGroupMemberships)!.push({ groupId: GROUP, deviceId: D3 })],
      ['a function group loses a member', () => h.tables.set(deviceGroupMemberships, [{ groupId: GROUP, deviceId: D1 }])],
      ['the reusable group changes', () => h.reusable.set('file_server', { groupId: 'other-group' })],
      ['a policy gains an assignment', () => h.tables.get(configPolicyAssignments)!.push({ id: 'as2', configPolicyId: POLICY, level: 'site', targetId: 's', priority: 1, roleFilter: null, osFilter: null })],
      ["a policy's status changes", () => update(configurationPolicies, (r) => ({ ...r, status: 'inactive' }))],
      ["a policy's monitor-link inheritance changes", () => update(configPolicyFeatureLinks, (r) => ({ ...r, inlineSettings: { items: [], inheritance: 'replace' } }))],
      ['another apply records a ledger row', () => h.tables.get(fleetDesignAppliedItems)!.push({ id: 'l2', itemRef: 'functions:file_server', itemKind: 'function', status: 'applied', step: 1, appliedAt: new Date(), createdRefs: {} })],
      ['a ledger row is rolled back', () => update(fleetDesignAppliedItems, (r) => ({ ...r, status: 'rolled_back' }))],
      ["a device's role source becomes manual", () => update(devices, (r) => (r.id === D1 ? { ...r, deviceRoleSource: 'manual' } : r))],
      ["a device's function source becomes manual", () => update(devices, (r) => (r.id === D2 ? { ...r, deviceFunctionSource: 'manual' } : r))],
      ['a function assessment changes', () => update(deviceFunctionAssessments, (r) => ({ ...r, id: 'a2' }))],
      ['a notification destination changes', () => update(notificationChannelConfigs, (r) => ({ ...r, config: { url: 'https://hooks.example.test/y' } }))],
      ['a notification channel is disabled', () => update(notificationChannels, (r) => ({ ...r, enabled: false }))],
      ['the stored design changes', () => {
        const next = outcome();
        next.sections.functions[0]!.deviceIds = [D1];
        h.tables.set(reportRuns, [reportRow({ summary: { fleetDesign: { outcome: next } } })]);
      }],
    ];
    it.each(cases)('%s', async (_label, mutate) => {
      const before = JSON.stringify(await applySnap());
      mutate();
      expect(JSON.stringify(await applySnap())).not.toBe(before);
    });
  });

  it("is stable across approval array order and duplicates, and never holds a channel's destination in the clear", async () => {
    const a = await applySnap();
    const b = await applySnap(approval({
      monitoring: ['monitoring:file_server:rule:0', 'monitoring:file_server:watch:0', 'monitoring:file_server:rule:0'],
      roleCorrections: [D1, D1],
    }));
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(JSON.stringify(a)).not.toContain('hooks.example.test');
  });

  it('is stable across row order', async () => {
    h.tables.set(deviceGroupMemberships, [{ groupId: GROUP, deviceId: D1 }, { groupId: GROUP, deviceId: D2 }]);
    const a = JSON.stringify(await applySnap());
    h.tables.set(deviceGroupMemberships, [{ groupId: GROUP, deviceId: D2 }, { groupId: GROUP, deviceId: D1 }]);
    h.tables.set(devices, [deviceRow(D3), deviceRow(D2), deviceRow(D1)]);
    expect(JSON.stringify(await applySnap())).toBe(a);
  });

  it.each([
    ['a missing run', () => h.tables.set(reportRuns, [])],
    ['a run with no stored design', () => h.tables.set(reportRuns, [reportRow({ summary: {} })])],
  ])('%s is null, the resolver reports TARGET_ABSENT', async (_label, mutate) => {
    mutate();
    await expect(applySnap()).resolves.toBeNull();
  });
});

describe('snapshotFleetDesignRollbackTargets', () => {
  beforeEach(() => {
    h.tables.set(fleetDesignAppliedItems, [
      { id: 'l1', itemRef: `roleCorrections:${D1}`, itemKind: 'role_correction', status: 'applied', step: 5, appliedAt: new Date('2026-11-01T00:00:03Z'), createdRefs: {}, beforeImage: { deviceRole: 'workstation', deviceRoleSource: 'auto' } },
      { id: 'l2', itemRef: 'policy:file_server', itemKind: 'policy', status: 'applied', step: 3, appliedAt: new Date('2026-11-01T00:00:02Z'), createdRefs: { policyId: POLICY, groupId: GROUP, monitorIdsByItemRef: { r: 'm1' } }, beforeImage: null },
      { id: 'l3', itemRef: 'functions:file_server', itemKind: 'function', status: 'applied', step: 1, appliedAt: new Date('2026-11-01T00:00:01Z'), createdRefs: { groupId: GROUP, assessmentIds: ['a1'], membershipSnapshot: [D1, D2] }, beforeImage: { memberships: [] } },
      { id: 'l4', itemRef: 'functions:old', itemKind: 'function', status: 'rolled_back', step: 1, appliedAt: new Date('2026-10-01T00:00:01Z'), createdRefs: {}, beforeImage: null },
    ]);
  });
  const rollbackSnap = () => snapshotFleetDesignRollbackTargets(RUN, ORG, database);

  it('pins only applied rows, with their before-image hashed', async () => {
    const snap = await rollbackSnap();
    expect(snap!.ledger.map((r) => r.itemRef)).toEqual(['functions:file_server', 'policy:file_server', `roleCorrections:${D1}`]);
    expect(JSON.stringify(snap!.ledger)).not.toContain('workstation');
    expect(snap!.ledger[2]!.beforeImageHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each<[string, () => void]>([
    ['a ledger row changes', () => update(fleetDesignAppliedItems, (r) => (r.id === 'l1' ? { ...r, status: 'rolled_back' } : r))],
    ["a device's role changes", () => update(devices, (r) => (r.id === D1 ? { ...r, deviceRole: 'server' } : r))],
    ["a device's role source changes", () => update(devices, (r) => (r.id === D1 ? { ...r, deviceRoleSource: 'manual' } : r))],
    ['a policy gains an assignment', () => h.tables.get(configPolicyAssignments)!.push({ id: 'as2', configPolicyId: POLICY, level: 'site', targetId: 's', priority: 1, roleFilter: null, osFilter: null })],
    ["a policy's status changes", () => update(configurationPolicies, (r) => ({ ...r, status: 'archived' }))],
    ['a monitor definition is edited', () => update('monitorDefs', (r) => ({ ...r, name: 'Edited' }))],
    ['a group gains a member', () => h.tables.get(deviceGroupMemberships)!.push({ groupId: GROUP, deviceId: D3 })],
    ['an assessment was superseded', () => h.tables.set(deviceFunctionAssessments, [])],
  ])('changes when %s', async (_label, mutate) => {
    const before = JSON.stringify(await rollbackSnap());
    mutate();
    expect(JSON.stringify(await rollbackSnap())).not.toBe(before);
  });

  it('a missing run is null', async () => {
    h.tables.set(reportRuns, []);
    await expect(rollbackSnap()).resolves.toBeNull();
  });
});
