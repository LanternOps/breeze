import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FleetDesignApplyPreview, FleetDesignApproval, FleetDesignOutcome, FleetDesignRule } from '@breeze/shared';

const previewMock = vi.hoisted(() => ({ previewFleetDesignApplyWithContext: vi.fn() }));
vi.mock('./preview', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./preview')>();
  return { ...actual, previewFleetDesignApplyWithContext: previewMock.previewFleetDesignApplyWithContext };
});

const ledgerMock = vi.hoisted(() => ({
  findReusableGroup: vi.fn(),
  recordApplied: vi.fn(),
  recordFailed: vi.fn(),
  updateCreatedRefs: vi.fn(),
}));
vi.mock('./ledger', () => ledgerMock);

const configPolicyMock = vi.hoisted(() => ({
  addFeatureLink: vi.fn(),
  assignPolicy: vi.fn(),
  createConfigPolicy: vi.fn(),
  listFeatureLinks: vi.fn(),
  updateConfigPolicy: vi.fn(),
  updateFeatureLink: vi.fn(),
}));
vi.mock('../configurationPolicy', () => configPolicyMock);

const deviceFunctionMock = vi.hoisted(() => ({ applyDesignFunctions: vi.fn() }));
vi.mock('../deviceFunction', () => deviceFunctionMock);

const groupMembershipMock = vi.hoisted(() => ({
  addManualGroupMemberships: vi.fn(),
  validateManualMembershipDevices: vi.fn(),
}));
vi.mock('../groupMembership', () => groupMembershipMock);

const peripheralJobsMock = vi.hoisted(() => ({ schedulePeripheralPolicyDevice: vi.fn(async () => undefined) }));
vi.mock('../../jobs/peripheralJobs', () => peripheralJobsMock);

const bundleMock = vi.hoisted(() => ({ importBundle: vi.fn() }));
vi.mock('../scriptBundle', () => bundleMock);

const auditMock = vi.hoisted(() => ({
  writeAuditEvent: vi.fn(),
  requestLikeFromSnapshot: vi.fn(() => ({ fake: true })),
}));
vi.mock('../auditEvents', () => auditMock);

// --- Table-routed fake db ---------------------------------------------------
type Row = Record<string, unknown>;
const dbHolder = vi.hoisted(() => ({
  selectQueues: new Map<unknown, Row[][]>(),
  insertQueues: new Map<unknown, Row[][]>(),
  updateQueues: new Map<unknown, Row[][]>(),
  inserts: [] as Array<{ table: unknown; values: unknown }>,
  updates: [] as Array<{ table: unknown; set: Record<string, unknown>; where?: unknown }>,
  deletes: [] as Array<{ table: unknown; where?: unknown }>,
}));
function selectSeed(table: unknown, rows: Row[]) {
  const q = dbHolder.selectQueues.get(table) ?? [];
  q.push(rows);
  dbHolder.selectQueues.set(table, q);
}
function insertSeed(table: unknown, rows: Row[]) {
  const q = dbHolder.insertQueues.get(table) ?? [];
  q.push(rows);
  dbHolder.insertQueues.set(table, q);
}
function updateSeed(table: unknown, rows: Row[]) {
  const q = dbHolder.updateQueues.get(table) ?? [];
  q.push(rows);
  dbHolder.updateQueues.set(table, q);
}
const transactionState = vi.hoisted(() => ({ tx: null as unknown, ambientCalls: vi.fn() }));
vi.mock('../../db', () => {
  const tx = {
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
    insert: (table: unknown) => ({
      values: (values: unknown) => {
        dbHolder.inserts.push({ table, values });
        const q = dbHolder.insertQueues.get(table) ?? [];
        const rows = q.shift() ?? [];
        return { returning: (_p?: unknown) => Promise.resolve(rows) };
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
  };
  transactionState.tx = tx;
  return { db: {
    ...Object.fromEntries(Object.entries(tx).map(([name, method]) => [name, (...args: unknown[]) => {
      transactionState.ambientCalls(name);
      return (method as (...args: unknown[]) => unknown)(...args);
    }])),
    transaction: (cb: (tx: unknown) => Promise<unknown>) => cb(tx),
  } };
});

import {
  applyFleetDesign,
  canonical,
  describeAction,
  retireRewrite,
  snapshotLinks,
  toRuleItem,
  toWatchItem,
} from './apply';
import { FleetDesignApplyError, type FleetDesignPreviewContext } from './preview';
import type { FleetDesignLedgerRow } from './ledger';
import { deviceFunctionAssessments, deviceGroupMemberships, deviceGroups, devices } from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';

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

function makeApproval(overrides: Partial<FleetDesignApproval> = {}): FleetDesignApproval {
  return { functions: [], monitoring: [], retired: [], automation: [], legacy: [], roleCorrections: [], displacementsAccepted: [], ...overrides };
}

function makePreview(overrides: Partial<FleetDesignApplyPreview> = {}): FleetDesignApplyPreview {
  return { functions: [], policies: [], retired: [], scripts: [], roleCorrections: [], alreadyApplied: [], blockers: [], ...overrides };
}

function makeOutcome(overrides: Partial<FleetDesignOutcome['sections']> = {}): FleetDesignOutcome {
  return {
    schemaVersion: 1,
    sections: {
      found: { summary: [], findings: [] },
      functions: [],
      monitoring: [],
      retired: [],
      automation: [],
      legacy: [],
      baseline: { notes: [], numbers: { alertsPer100EndpointsPerMonth: null, ticketsPerMonth: null, precursors: [] } },
      unsure: { lowConfidenceFunctions: [], unreachableDevices: [], needsHuman: [], roleCorrections: [] },
      ...overrides,
    },
    thresholds: { confidence: 0.6, precursors: { diskUsedPercent: 80, rebootPendingDays: 7, patchAgeDays: 30, certificateDays: 30, serviceRestartsPer30d: 2 } },
    generatedAt: '2026-09-01T00:00:00Z',
    markdown: '',
  };
}

/** Build a full FleetDesignPreviewContext, defaulting every field to empty/no-op. */
function makeCtx(overrides: Partial<FleetDesignPreviewContext> = {}): FleetDesignPreviewContext {
  return {
    locked: { reportRunId: RUN, reportId: 'report-1', orgId: ORG, outcome: makeOutcome(), summary: { fleetDesign: { runId: 'run-1' } } },
    outcome: makeOutcome(),
    ledger: [],
    appliedRefs: new Set<string>(),
    orgDevices: new Map(),
    preview: makePreview(),
    wantedByFunction: new Map(),
    monitoringByFunction: new Map(),
    retiredResolved: new Map(),
    policyRowByFunction: new Map(),
    scriptsToCreate: [],
    ...overrides,
  } as FleetDesignPreviewContext;
}

beforeEach(() => {
  vi.clearAllMocks();
  dbHolder.selectQueues.clear();
  dbHolder.insertQueues.clear();
  dbHolder.updateQueues.clear();
  dbHolder.inserts.length = 0;
  dbHolder.updates.length = 0;
  dbHolder.deletes.length = 0;
  ledgerMock.recordApplied.mockImplementation(async () => ({ id: 'ledger-row' }));
  groupMembershipMock.validateManualMembershipDevices.mockResolvedValue({ ok: true });
});

// Every scenario below uses a distinct savepoint executor. This also covers
// reused policies, script-rule linking and the failure path's earlier steps.
afterEach(() => {
  expect(transactionState.ambientCalls).not.toHaveBeenCalled();
  for (const helper of [
    ...Object.values(configPolicyMock), ...Object.values(deviceFunctionMock),
    ...Object.values(groupMembershipMock), bundleMock.importBundle,
    ledgerMock.findReusableGroup, ledgerMock.recordApplied, ledgerMock.updateCreatedRefs,
  ]) {
    for (const args of helper.mock.calls) expect(args.at(-1)).toBe(transactionState.tx);
  }
});

describe('applyFleetDesign — blocked', () => {
  it('refuses a displaced policy that is not in displacementsAccepted: throws FleetDesignApplyError(blocked), nothing written', async () => {
    const previewCtx = makeCtx({
      preview: makePreview({
        policies: [{ functionKey: 'file_server', policyName: 'Fleet Design: File Server', watchCount: 1, ruleCount: 0, displaces: [{ policyId: 'p1', policyName: 'Old', featureType: 'monitoring', deviceCount: 2 }] }],
      }),
    });
    previewMock.previewFleetDesignApplyWithContext.mockResolvedValue(previewCtx);

    await expect(applyFleetDesign(makeAuth(), RUN, makeApproval())).rejects.toMatchObject({
      code: 'blocked',
      payload: { unaccepted: [{ policyId: 'p1', policyName: 'Old', featureType: 'monitoring', deviceCount: 2 }] },
    });
    expect(ledgerMock.recordApplied).not.toHaveBeenCalled();
    expect(configPolicyMock.createConfigPolicy).not.toHaveBeenCalled();
  });

  it('is an instance of FleetDesignApplyError', async () => {
    previewMock.previewFleetDesignApplyWithContext.mockResolvedValue(
      makeCtx({ preview: makePreview({ blockers: [{ itemRef: 'functions:x', reason: 'not_in_design' }] }) }),
    );
    await expect(applyFleetDesign(makeAuth(), RUN, makeApproval())).rejects.toBeInstanceOf(FleetDesignApplyError);
  });
});

describe('applyFleetDesign — step 1 (functions)', () => {
  it('writes assessments, creates the group, sets membership to the approved set, records the ledger row with before-image memberships', async () => {
    const outcome = makeOutcome({
      functions: [{ functionKey: 'file_server', label: 'File Server', deviceIds: ['d1', 'd2'], confidence: 0.9, evidence: ['x'] }],
    });
    const previewCtx = makeCtx({
      outcome,
      locked: { reportRunId: RUN, reportId: 'report-1', orgId: ORG, outcome, summary: { fleetDesign: { runId: 'run-1' } } },
      preview: makePreview({
        functions: [{ functionKey: 'file_server', label: 'File Server', groupId: null, groupName: 'Fleet Design: File Server', deviceCount: 2, devicesAdded: ['d1', 'd2'], devicesRemoved: [], keptManual: 0, missingDevices: [] }],
      }),
      wantedByFunction: new Map([['file_server', ['d1', 'd2']]]),
    });
    previewMock.previewFleetDesignApplyWithContext.mockResolvedValue(previewCtx);

    selectSeed(deviceFunctionAssessments, []); // no active assessments before apply
    deviceFunctionMock.applyDesignFunctions.mockResolvedValue({ written: 2, keptManual: 0, skippedForeign: 0 });
    selectSeed(deviceFunctionAssessments, [{ id: 'assess-1', deviceId: 'd1' }, { id: 'assess-2', deviceId: 'd2' }]);
    insertSeed(deviceGroups, [{ id: 'g-new' }]);
    selectSeed(deviceGroups, [{ siteId: null }]);

    const result = await applyFleetDesign(makeAuth(), RUN, makeApproval({ functions: ['file_server'] }));

    expect(deviceFunctionMock.applyDesignFunctions).toHaveBeenCalledWith({
      orgId: ORG, reportRunId: RUN, runId: 'run-1', userId: USER,
      functions: [{ functionKey: 'file_server', label: 'File Server', deviceIds: ['d1', 'd2'], confidence: 0.9, evidence: ['x'] }],
    }, transactionState.tx);
    expect(dbHolder.inserts).toContainEqual({ table: deviceGroups, values: expect.objectContaining({ orgId: ORG, name: 'Fleet Design: File Server', type: 'static' }) });
    expect(groupMembershipMock.validateManualMembershipDevices).toHaveBeenCalledWith({ deviceIds: ['d1', 'd2'], orgId: ORG, siteId: null }, transactionState.tx);
    expect(groupMembershipMock.addManualGroupMemberships).toHaveBeenCalledWith({ groupId: 'g-new', orgId: ORG, deviceIds: ['d1', 'd2'] }, transactionState.tx);
    expect(ledgerMock.recordApplied).toHaveBeenCalledWith({
      orgId: ORG, reportRunId: RUN, itemRef: 'functions:file_server', itemKind: 'function', step: 1,
      createdRefs: { groupId: 'g-new', groupCreated: true, assessmentIds: ['assess-1', 'assess-2'], membershipSnapshot: ['d1', 'd2'] },
      beforeImage: { memberships: [], priorAssessmentIdByDevice: { d1: null, d2: null } },
      userId: USER,
    }, transactionState.tx);
    expect(result.applied).toContain('functions:file_server');
    expect(auditMock.writeAuditEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'fleet_design.apply.function' }));
  });
});

describe('applyFleetDesign — step 2 (retire)', () => {
  it('rewrites the feature link with the named watch disabled and records the previous inlineSettings as before-image', async () => {
    const inlineSettings = { checkIntervalSeconds: 60, watches: [{ name: 'Spooler', enabled: true }] };
    const previewCtx = makeCtx({
      retiredResolved: new Map([[
        'retired:0',
        { item: { kind: 'watch' as const, policyId: 'p2', policyName: 'Old Policy', itemName: 'Spooler', reason: 'unused' }, linkId: 'link-1', inlineSettings, policyOrgId: ORG },
      ]]),
    });
    previewMock.previewFleetDesignApplyWithContext.mockResolvedValue(previewCtx);
    configPolicyMock.updateFeatureLink.mockResolvedValue({ id: 'link-1' });

    const result = await applyFleetDesign(makeAuth(), RUN, makeApproval({ retired: ['retired:0'] }));

    expect(configPolicyMock.updateFeatureLink).toHaveBeenCalledWith(
      'link-1',
      { inlineSettings: { checkIntervalSeconds: 60, watches: [{ name: 'Spooler', enabled: false }] } },
      'p2',
      undefined, transactionState.tx,
    );
    expect(ledgerMock.recordApplied).toHaveBeenCalledWith(expect.objectContaining({
      itemRef: 'retired:0', itemKind: 'retired', step: 2,
      createdRefs: { policyId: 'p2', linkId: 'link-1' },
      beforeImage: { inlineSettings },
    }), transactionState.tx);
    expect(result.applied).toContain('retired:0');
  });
});

describe('applyFleetDesign — step 3 (monitoring)', () => {
  it('creates the policy inactive, adds monitoring and alert_rule links with rationale, assigns device_group priority 100 with null filters, activates, records policy + item rows', async () => {
    const rule: FleetDesignRule = {
      name: 'Disk full', severity: 'high', conditions: [], cooldownMinutes: 30, rationale: 'why', action: 'none', paging: 'always',
    };
    const outcome = makeOutcome({
      monitoring: [{
        functionKey: 'file_server',
        watches: [{ watchType: 'service', name: 'Spooler', alertOnStop: true, autoRestart: false, rationale: 'because' }],
        alertRules: [rule],
      }],
    });
    const previewCtx = makeCtx({
      outcome,
      preview: makePreview({
        functions: [{ functionKey: 'file_server', label: 'File Server', groupId: 'g1', groupName: 'Fleet Design: File Server', deviceCount: 2, devicesAdded: [], devicesRemoved: [], keptManual: 0, missingDevices: [] }],
        policies: [{ functionKey: 'file_server', policyName: 'Fleet Design: File Server', watchCount: 1, ruleCount: 1, displaces: [] }],
      }),
      monitoringByFunction: new Map([['file_server', { watches: [0], rules: [0] }]]),
      wantedByFunction: new Map([['file_server', ['d1', 'd2']]]),
    });
    previewMock.previewFleetDesignApplyWithContext.mockResolvedValue(previewCtx);

    configPolicyMock.createConfigPolicy.mockResolvedValue({ id: 'p-new' });
    configPolicyMock.addFeatureLink.mockResolvedValueOnce({ id: 'link-w' }).mockResolvedValueOnce({ id: 'link-r' });
    configPolicyMock.assignPolicy.mockResolvedValue({ id: 'assign-1' });
    configPolicyMock.updateConfigPolicy.mockResolvedValue({ id: 'p-new', status: 'active' });
    configPolicyMock.listFeatureLinks.mockResolvedValue([
      { featureType: 'monitoring', featurePolicyId: null, inlineSettings: { watches: [{ name: 'Spooler', enabled: true }] } },
      { featureType: 'alert_rule', featurePolicyId: null, inlineSettings: { items: [{ name: 'Disk full' }] } },
    ]);

    const result = await applyFleetDesign(makeAuth(), RUN, makeApproval({ monitoring: ['monitoring:file_server:watch:0', 'monitoring:file_server:rule:0'] }));

    expect(configPolicyMock.createConfigPolicy).toHaveBeenCalledWith(
      { orgId: ORG },
      expect.objectContaining({ name: 'Fleet Design: File Server', status: 'inactive' }),
      USER,
      transactionState.tx,
    );
    expect(configPolicyMock.addFeatureLink).toHaveBeenNthCalledWith(1, 'p-new', 'monitoring', null, {
      checkIntervalSeconds: 60,
      watches: [{ watchType: 'service', name: 'Spooler', enabled: true, alertOnStop: true, autoRestart: false, rationale: 'because' }],
    }, undefined, transactionState.tx);
    expect(configPolicyMock.addFeatureLink).toHaveBeenNthCalledWith(2, 'p-new', 'alert_rule', null, {
      items: [{ name: 'Disk full', severity: 'high', conditions: [], cooldownMinutes: 30, rationale: 'why [Action: none; Paging: always]' }],
    }, undefined, transactionState.tx);
    expect(configPolicyMock.assignPolicy).toHaveBeenCalledWith('p-new', 'device_group', 'g1', 100, USER, undefined, undefined, transactionState.tx);
    expect(configPolicyMock.updateConfigPolicy).toHaveBeenCalledWith('p-new', { status: 'active' }, expect.anything(), transactionState.tx);
    expect(ledgerMock.recordApplied).toHaveBeenCalledWith(expect.objectContaining({ itemRef: 'policy:file_server', itemKind: 'policy', step: 3 }), transactionState.tx);
    expect(ledgerMock.recordApplied).toHaveBeenCalledWith(expect.objectContaining({ itemRef: 'monitoring:file_server:watch:0', itemKind: 'watch', step: 3, createdRefs: { policyId: 'p-new' } }), transactionState.tx);
    expect(ledgerMock.recordApplied).toHaveBeenCalledWith(expect.objectContaining({ itemRef: 'monitoring:file_server:rule:0', itemKind: 'rule', step: 3, createdRefs: { policyId: 'p-new' } }), transactionState.tx);
    expect(result.applied).toEqual(expect.arrayContaining(['policy:file_server', 'monitoring:file_server:watch:0', 'monitoring:file_server:rule:0']));
  });
});

describe('applyFleetDesign — step 3 (monitoring) — second apply in the same run', () => {
  it('unions new watches into the existing monitoring link, creates the missing alert_rule link, and refreshes created_refs.linksSnapshot instead of creating a new policy', async () => {
    const rule: FleetDesignRule = {
      name: 'Disk full', severity: 'high', conditions: [], cooldownMinutes: 30, rationale: 'why', action: 'none', paging: 'always',
    };
    const outcome = makeOutcome({
      monitoring: [{
        functionKey: 'file_server',
        watches: [
          { watchType: 'service', name: 'Spooler', alertOnStop: true, autoRestart: false, rationale: 'first apply' },
          { watchType: 'service', name: 'BITS', alertOnStop: true, autoRestart: false, rationale: 'second apply' },
        ],
        alertRules: [rule],
      }],
    });
    const existingRow = {
      id: 'ledger-row-policy',
      createdRefs: { policyId: 'p-existing', groupId: 'g1' },
    } as unknown as FleetDesignLedgerRow;
    const previewCtx = makeCtx({
      outcome,
      preview: makePreview({
        functions: [{ functionKey: 'file_server', label: 'File Server', groupId: 'g1', groupName: 'Fleet Design: File Server', deviceCount: 2, devicesAdded: [], devicesRemoved: [], keptManual: 0, missingDevices: [] }],
        policies: [{ functionKey: 'file_server', policyName: 'Fleet Design: File Server', watchCount: 1, ruleCount: 1, displaces: [] }],
      }),
      // Only the NEW items are approved this time — index 0 (Spooler) was
      // already applied in a prior run and is not part of this approval.
      monitoringByFunction: new Map([['file_server', { watches: [1], rules: [0] }]]),
      policyRowByFunction: new Map([['file_server', existingRow]]),
    });
    previewMock.previewFleetDesignApplyWithContext.mockResolvedValue(previewCtx);

    const existingWatchItem = { watchType: 'service', name: 'Spooler', enabled: true, alertOnStop: true, autoRestart: false, rationale: 'first apply' };
    const newWatchItem = toWatchItem(outcome.sections.monitoring[0]!.watches[1]!);
    const newRuleItem = toRuleItem(rule);
    const afterLinks = [
      { id: 'link-mon-old', featureType: 'monitoring', featurePolicyId: null, inlineSettings: { checkIntervalSeconds: 60, watches: [existingWatchItem, newWatchItem] } },
      { id: 'link-rule-new', featureType: 'alert_rule', featurePolicyId: null, inlineSettings: { items: [newRuleItem] } },
    ];
    configPolicyMock.listFeatureLinks
      .mockResolvedValueOnce([{ id: 'link-mon-old', featureType: 'monitoring', featurePolicyId: null, inlineSettings: { checkIntervalSeconds: 60, watches: [existingWatchItem] } }])
      .mockResolvedValueOnce(afterLinks);
    configPolicyMock.updateFeatureLink.mockResolvedValue({ id: 'link-mon-old' });
    configPolicyMock.addFeatureLink.mockResolvedValue({ id: 'link-rule-new' });

    const result = await applyFleetDesign(makeAuth(), RUN, makeApproval({ monitoring: ['monitoring:file_server:watch:1', 'monitoring:file_server:rule:0'] }));

    // Not a new policy: the second apply reuses the existing one.
    expect(configPolicyMock.createConfigPolicy).not.toHaveBeenCalled();
    expect(configPolicyMock.assignPolicy).not.toHaveBeenCalled();

    // Existing monitoring link updated with the union of old + new watches.
    expect(configPolicyMock.updateFeatureLink).toHaveBeenCalledWith(
      'link-mon-old',
      { inlineSettings: { checkIntervalSeconds: 60, watches: [existingWatchItem, newWatchItem] } },
      'p-existing',
      undefined, transactionState.tx,
    );
    // Missing alert_rule link created fresh.
    expect(configPolicyMock.addFeatureLink).toHaveBeenCalledWith('p-existing', 'alert_rule', null, { items: [newRuleItem] }, undefined, transactionState.tx);

    // created_refs refreshed with a snapshot of the union, on the SAME ledger row.
    expect(ledgerMock.updateCreatedRefs).toHaveBeenCalledWith(
      'ledger-row-policy',
      ORG,
      expect.objectContaining({
        policyId: 'p-existing',
        groupId: 'g1',
        monitoringLinkId: 'link-mon-old',
        alertRuleLinkId: 'link-rule-new',
        linksSnapshot: snapshotLinks(afterLinks),
      }),
      transactionState.tx,
    );

    // New item rows recorded; the policy ref itself is not (it already exists).
    expect(ledgerMock.recordApplied).not.toHaveBeenCalledWith(expect.objectContaining({ itemRef: 'policy:file_server' }), transactionState.tx);
    expect(ledgerMock.recordApplied).toHaveBeenCalledWith(expect.objectContaining({ itemRef: 'monitoring:file_server:watch:1', itemKind: 'watch', step: 3, createdRefs: { policyId: 'p-existing' } }), transactionState.tx);
    expect(ledgerMock.recordApplied).toHaveBeenCalledWith(expect.objectContaining({ itemRef: 'monitoring:file_server:rule:0', itemKind: 'rule', step: 3, createdRefs: { policyId: 'p-existing' } }), transactionState.tx);
    expect(result.applied).toEqual(expect.arrayContaining(['monitoring:file_server:watch:1', 'monitoring:file_server:rule:0']));
    expect(result.applied).not.toContain('policy:file_server');
  });
});

describe('applyFleetDesign — step 5 (role corrections)', () => {
  it('updates device_role with source ai, audits the device, records the before-image', async () => {
    const previewCtx = makeCtx({
      preview: makePreview({ roleCorrections: [{ deviceId: 'd1', hostname: 'HOST1', from: 'workstation', to: 'server', billingRelevant: true }] }),
    });
    previewMock.previewFleetDesignApplyWithContext.mockResolvedValue(previewCtx);
    selectSeed(devices, [{ deviceRole: 'workstation', deviceRoleSource: 'discovered' }]);
    updateSeed(devices, [{ id: 'd1' }]);

    const result = await applyFleetDesign(makeAuth(), RUN, makeApproval({ roleCorrections: ['d1'] }));

    const roleUpdate = dbHolder.updates.find((u) => u.table === devices);
    expect(roleUpdate!.set).toMatchObject({ deviceRole: 'server', deviceRoleSource: 'ai' });
    expect(ledgerMock.recordApplied).toHaveBeenCalledWith(expect.objectContaining({
      itemRef: 'roleCorrections:d1', itemKind: 'role_correction', step: 5,
      beforeImage: { deviceRole: 'workstation', deviceRoleSource: 'discovered' },
    }), transactionState.tx);
    expect(auditMock.writeAuditEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'device.role.ai_correction' }));
    expect(result.applied).toContain('roleCorrections:d1');
  });
});

describe('applyFleetDesign — step 4 (scripts, W04)', () => {
  const spooler = { name: 'Restart print spooler', purpose: 'Restart spooler when stuck', osTypes: ['windows' as const], language: 'powershell' as const, content: 'Restart-Service Spooler' };
  const cleanup = { name: 'Clean temp', purpose: 'Free disk', osTypes: ['windows' as const], language: 'powershell' as const, content: 'Remove-Item temp' };
  const toCreate = [
    { itemRef: 'automation:file_server:script:0', functionKey: 'file_server', script: spooler },
    { itemRef: 'automation:file_server:script:1', functionKey: 'file_server', script: cleanup },
  ];
  const importOk = {
    target: { orgId: ORG, partnerId: null, availability: 'org' },
    imported: 1, renamed: 1, skipped: 0, versioned: 0, errors: [] as Array<{ index: number; name: string; error: string }>,
    scripts: [
      { index: 0, name: spooler.name, action: 'renamed', finalName: `${spooler.name} (2)`, scriptId: 'script-a' },
      { index: 1, name: cleanup.name, action: 'imported', scriptId: 'script-b' },
    ],
  };
  const approval = () => makeApproval({ automation: toCreate.map((t) => t.itemRef) });

  it('creates every approved script in ONE importer call — org-owned, rename on collision, tagged fleet-design — and records one ledger row each', async () => {
    previewMock.previewFleetDesignApplyWithContext.mockResolvedValue(makeCtx({ scriptsToCreate: toCreate }));
    bundleMock.importBundle.mockResolvedValue(importOk);

    const result = await applyFleetDesign(makeAuth(), RUN, approval());

    expect(bundleMock.importBundle).toHaveBeenCalledTimes(1);
    const [auth, envelope, options] = bundleMock.importBundle.mock.calls[0]!;
    expect(auth.user.id).toBe(USER);
    expect(envelope).toEqual({
      bundleVersion: 1,
      scripts: [
        { name: spooler.name, description: spooler.purpose, category: 'Fleet Design', tags: ['fleet-design'], osTypes: ['windows'], language: 'powershell', content: spooler.content, timeoutSeconds: 300, runAs: 'system' },
        { name: cleanup.name, description: cleanup.purpose, category: 'Fleet Design', tags: ['fleet-design'], osTypes: ['windows'], language: 'powershell', content: cleanup.content, timeoutSeconds: 300, runAs: 'system' },
      ],
    });
    expect(options).toMatchObject({ availability: 'org', orgId: ORG, mode: 'rename', tags: ['fleet-design'] });

    expect(ledgerMock.recordApplied).toHaveBeenCalledWith({
      orgId: ORG, reportRunId: RUN, itemRef: 'automation:file_server:script:0', itemKind: 'script', step: 4,
      createdRefs: { scriptId: 'script-a', scriptName: `${spooler.name} (2)` }, userId: USER,
    }, transactionState.tx);
    expect(ledgerMock.recordApplied).toHaveBeenCalledWith(expect.objectContaining({
      itemRef: 'automation:file_server:script:1', step: 4, createdRefs: { scriptId: 'script-b', scriptName: cleanup.name },
    }), transactionState.tx);
    expect(result.applied).toEqual(['automation:file_server:script:0', 'automation:file_server:script:1']);
    expect(result.partial).toBeNull();
    expect(auditMock.writeAuditEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'fleet_design.apply.script', resourceType: 'script', resourceId: 'script-a',
    }));
  });

  it('stamps honest provenance: AI-authored (ai_proposal), approved by the applying user, no proposal or review id', async () => {
    previewMock.previewFleetDesignApplyWithContext.mockResolvedValue(makeCtx({ scriptsToCreate: toCreate }));
    bundleMock.importBundle.mockResolvedValue(importOk);
    await applyFleetDesign(makeAuth(), RUN, approval());
    const options = bundleMock.importBundle.mock.calls[0]![2] as { provenanceFor: (e: unknown, i: number) => Record<string, unknown> };
    const p = options.provenanceFor({}, 1);
    expect(p).toMatchObject({ origin: 'ai_proposal', approvedBy: USER });
    expect(p.approvedAt).toBeInstanceOf(Date);
    expect(p.changelog).toContain(RUN);
    expect(p.changelog).toContain('automation:file_server:script:1');
    expect(p).not.toHaveProperty('proposalId');
    expect(p).not.toHaveProperty('reviewId');
    // Creation is not run authorisation: no approvalMethod is claimed.
    expect(p).not.toHaveProperty('approvalMethod');
  });

  it('a per-entry importer error fails step 4 as a whole (savepoint) — no script ledger rows, partial failedStep 4, step 5 not run', async () => {
    previewMock.previewFleetDesignApplyWithContext.mockResolvedValue(makeCtx({
      scriptsToCreate: toCreate,
      preview: makePreview({ roleCorrections: [{ deviceId: 'd1', hostname: 'h', from: 'workstation', to: 'server', billingRelevant: true }] }),
    }));
    bundleMock.importBundle.mockResolvedValue({ ...importOk, imported: 1, renamed: 0, errors: [{ index: 0, name: spooler.name, error: 'references secret variable' }], scripts: [importOk.scripts[1]] });

    const result = await applyFleetDesign(makeAuth(), RUN, approval());

    expect(result.partial).toEqual({ failedStep: 4, reason: expect.stringContaining('references secret variable') });
    expect(ledgerMock.recordApplied).not.toHaveBeenCalledWith(expect.objectContaining({ itemKind: 'script' }), transactionState.tx);
    expect(ledgerMock.recordFailed).toHaveBeenCalledWith(expect.objectContaining({ itemRef: 'step:4', itemKind: 'script', step: 4 }));
    expect(dbHolder.updates.find((u) => u.table === devices)).toBeUndefined();
  });

  it('a scope error from the importer fails step 4', async () => {
    previewMock.previewFleetDesignApplyWithContext.mockResolvedValue(makeCtx({ scriptsToCreate: toCreate }));
    bundleMock.importBundle.mockResolvedValue({ error: 'Partner-wide write denied', status: 403 });
    const result = await applyFleetDesign(makeAuth(), RUN, approval());
    expect(result.partial).toEqual({ failedStep: 4, reason: expect.stringContaining('script_scope_denied') });
  });

  it('does not call the importer when every approved script was created by an earlier apply', async () => {
    previewMock.previewFleetDesignApplyWithContext.mockResolvedValue(makeCtx({ scriptsToCreate: [] }));
    await applyFleetDesign(makeAuth(), RUN, approval());
    expect(bundleMock.importBundle).not.toHaveBeenCalled();
  });

  it('appends the created id to the rationale of an applied rule that names the proposal, and refreshes the policy snapshot', async () => {
    const rule: FleetDesignRule = {
      name: 'Spooler stuck', severity: 'medium', conditions: [], cooldownMinutes: 30, rationale: 'jobs pile up',
      action: { kind: 'script', ref: spooler.name }, paging: 'business_hours',
    };
    const other: FleetDesignRule = { ...rule, name: 'Unrelated', action: 'none' };
    const outcome = makeOutcome({
      monitoring: [{ functionKey: 'file_server', watches: [], alertRules: [rule, other] }],
      automation: [{ functionKey: 'file_server', playbooks: [], scripts: [spooler, cleanup] }],
    });
    const policyRow = { id: 'ledger-policy', createdRefs: { policyId: 'p1', groupId: 'g1', alertRuleLinkId: 'link-r' } } as unknown as FleetDesignLedgerRow;
    previewMock.previewFleetDesignApplyWithContext.mockResolvedValue(makeCtx({
      outcome,
      scriptsToCreate: toCreate,
      policyRowByFunction: new Map([['file_server', policyRow]]),
    }));
    bundleMock.importBundle.mockResolvedValue(importOk);
    const before = { items: [toRuleItem(rule), toRuleItem(other)] };
    const patchedItems = [{ ...toRuleItem(rule), rationale: `${toRuleItem(rule).rationale} [script created: script-a]` }, toRuleItem(other)];
    configPolicyMock.listFeatureLinks
      .mockResolvedValueOnce([{ id: 'link-r', featureType: 'alert_rule', featurePolicyId: null, inlineSettings: before }])
      .mockResolvedValueOnce([{ id: 'link-r', featureType: 'alert_rule', featurePolicyId: null, inlineSettings: { items: patchedItems } }]);
    configPolicyMock.updateFeatureLink.mockResolvedValue({ id: 'link-r' });

    await applyFleetDesign(makeAuth(), RUN, approval());

    expect(configPolicyMock.updateFeatureLink).toHaveBeenCalledWith('link-r', { inlineSettings: { items: patchedItems } }, 'p1', undefined, transactionState.tx);
    expect(ledgerMock.updateCreatedRefs).toHaveBeenCalledWith('ledger-policy', ORG, expect.objectContaining({
      policyId: 'p1',
      linksSnapshot: snapshotLinks([{ featureType: 'alert_rule', featurePolicyId: null, inlineSettings: { items: patchedItems } }]),
    }), transactionState.tx);
  });

  it('a second apply that adds a rule (reused policy) AND its script keeps the refs step 3 just wrote when step 4 refreshes the snapshot', async () => {
    const rule: FleetDesignRule = {
      name: 'Spooler stuck', severity: 'medium', conditions: [], cooldownMinutes: 30, rationale: 'jobs pile up',
      action: { kind: 'script', ref: spooler.name }, paging: 'none',
    };
    const outcome = makeOutcome({
      monitoring: [{ functionKey: 'file_server', watches: [], alertRules: [rule] }],
      automation: [{ functionKey: 'file_server', playbooks: [], scripts: [spooler] }],
    });
    // First apply created the policy with watches only — no alert_rule link yet.
    const existingRow = { id: 'ledger-policy', createdRefs: { policyId: 'p1', groupId: 'g1', monitoringLinkId: 'link-m' } } as unknown as FleetDesignLedgerRow;
    previewMock.previewFleetDesignApplyWithContext.mockResolvedValue(makeCtx({
      outcome,
      scriptsToCreate: [toCreate[0]!],
      preview: makePreview({
        functions: [{ functionKey: 'file_server', label: 'File Server', groupId: 'g1', groupName: 'Fleet Design: File Server', deviceCount: 1, devicesAdded: [], devicesRemoved: [], keptManual: 0, missingDevices: [] }],
        policies: [{ functionKey: 'file_server', policyName: 'Fleet Design: File Server', watchCount: 0, ruleCount: 1, displaces: [] }],
      }),
      monitoringByFunction: new Map([['file_server', { watches: [], rules: [0] }]]),
      policyRowByFunction: new Map([['file_server', existingRow]]),
    }));
    bundleMock.importBundle.mockResolvedValue({ ...importOk, imported: 1, renamed: 0, scripts: [{ index: 0, name: spooler.name, action: 'imported', scriptId: 'script-a' }] });
    const ruleItem = toRuleItem(rule);
    const monitoringLink = { id: 'link-m', featureType: 'monitoring', featurePolicyId: null, inlineSettings: { watches: [] } };
    configPolicyMock.listFeatureLinks
      .mockResolvedValueOnce([monitoringLink]) // step 3 reads the policy's links before adding the rule link
      .mockResolvedValue([monitoringLink, { id: 'link-r', featureType: 'alert_rule', featurePolicyId: null, inlineSettings: { items: [ruleItem] } }]);
    configPolicyMock.addFeatureLink.mockResolvedValue({ id: 'link-r' });
    configPolicyMock.updateFeatureLink.mockResolvedValue({ id: 'link-r' });

    await applyFleetDesign(makeAuth(), RUN, makeApproval({ monitoring: ['monitoring:file_server:rule:0'], automation: ['automation:file_server:script:0'] }));

    const calls = ledgerMock.updateCreatedRefs.mock.calls.filter((c) => c[0] === 'ledger-policy');
    expect(calls.length).toBe(2); // step 3 union, then step 4 snapshot refresh
    expect(calls[1]![2]).toMatchObject({ policyId: 'p1', monitoringLinkId: 'link-m', alertRuleLinkId: 'link-r' });
  });

  it('step 3 of a LATER apply writes the id of a script an earlier apply created into the rule rationale', async () => {
    const rule: FleetDesignRule = {
      name: 'Spooler stuck', severity: 'medium', conditions: [], cooldownMinutes: 30, rationale: 'jobs pile up',
      action: { kind: 'script', ref: 'automation:file_server:script:0' }, paging: 'none',
    };
    const outcome = makeOutcome({
      monitoring: [{ functionKey: 'file_server', watches: [], alertRules: [rule] }],
      automation: [{ functionKey: 'file_server', playbooks: [], scripts: [spooler] }],
    });
    previewMock.previewFleetDesignApplyWithContext.mockResolvedValue(makeCtx({
      outcome,
      ledger: [{ id: 'l-s', itemRef: 'automation:file_server:script:0', itemKind: 'script', status: 'applied', step: 4, createdRefs: { scriptId: 'script-old' } } as unknown as FleetDesignLedgerRow],
      preview: makePreview({
        functions: [{ functionKey: 'file_server', label: 'File Server', groupId: 'g1', groupName: 'Fleet Design: File Server', deviceCount: 1, devicesAdded: [], devicesRemoved: [], keptManual: 0, missingDevices: [] }],
        policies: [{ functionKey: 'file_server', policyName: 'Fleet Design: File Server', watchCount: 0, ruleCount: 1, displaces: [] }],
      }),
      monitoringByFunction: new Map([['file_server', { watches: [], rules: [0] }]]),
    }));
    configPolicyMock.createConfigPolicy.mockResolvedValue({ id: 'p-new' });
    configPolicyMock.addFeatureLink.mockResolvedValue({ id: 'link-r' });
    configPolicyMock.assignPolicy.mockResolvedValue({ id: 'a1' });
    configPolicyMock.updateConfigPolicy.mockResolvedValue({ id: 'p-new' });
    configPolicyMock.listFeatureLinks.mockResolvedValue([]);

    await applyFleetDesign(makeAuth(), RUN, makeApproval({ monitoring: ['monitoring:file_server:rule:0'] }));

    expect(configPolicyMock.addFeatureLink).toHaveBeenCalledWith('p-new', 'alert_rule', null, {
      items: [expect.objectContaining({ rationale: 'jobs pile up [Action: script automation:file_server:script:0; Paging: none] [script created: script-old]' })],
    }, undefined, transactionState.tx);
  });
});

describe('applyFleetDesign — partial failure', () => {
  it('a failure in step 3 leaves step 1 and 2 rows applied, records a failed row with the error, returns partial with failedStep 3', async () => {
    const outcome = makeOutcome({
      functions: [{ functionKey: 'domain_controller', label: 'Domain Controller', deviceIds: ['d1'], confidence: 0.9, evidence: [] }],
      monitoring: [{
        functionKey: 'file_server',
        watches: [{ watchType: 'service', name: 'Spooler', alertOnStop: true, autoRestart: false, rationale: 'because' }],
        alertRules: [],
      }],
    });
    const previewCtx = makeCtx({
      outcome,
      locked: { reportRunId: RUN, reportId: 'report-1', orgId: ORG, outcome, summary: { fleetDesign: { runId: 'run-1' } } },
      preview: makePreview({
        functions: [{ functionKey: 'domain_controller', label: 'Domain Controller', groupId: null, groupName: 'Fleet Design: Domain Controller', deviceCount: 1, devicesAdded: ['d1'], devicesRemoved: [], keptManual: 0, missingDevices: [] }],
      }),
      wantedByFunction: new Map([['domain_controller', ['d1']]]),
      retiredResolved: new Map([[
        'retired:0',
        { item: { kind: 'watch' as const, policyId: 'p2', policyName: 'Old Policy', itemName: 'Spooler', reason: 'unused' }, linkId: 'link-1', inlineSettings: { watches: [{ name: 'Spooler', enabled: true }] }, policyOrgId: ORG },
      ]]),
      // References a DIFFERENT function than the approved one, and no group exists for it.
      monitoringByFunction: new Map([['file_server', { watches: [0], rules: [] }]]),
    });
    previewMock.previewFleetDesignApplyWithContext.mockResolvedValue(previewCtx);

    // Step 1 setup
    selectSeed(deviceFunctionAssessments, []);
    deviceFunctionMock.applyDesignFunctions.mockResolvedValue({ written: 1, keptManual: 0, skippedForeign: 0 });
    selectSeed(deviceFunctionAssessments, [{ id: 'assess-1', deviceId: 'd1' }]);
    insertSeed(deviceGroups, [{ id: 'g-new' }]);
    selectSeed(deviceGroups, [{ siteId: null }]);
    // Step 2 setup
    configPolicyMock.updateFeatureLink.mockResolvedValue({ id: 'link-1' });
    // Step 3: no group for file_server anywhere → function_group_missing
    ledgerMock.findReusableGroup.mockResolvedValue(null);

    const result = await applyFleetDesign(makeAuth(), RUN, makeApproval({
      functions: ['domain_controller'], retired: ['retired:0'], monitoring: ['monitoring:file_server:watch:0'],
    }));

    expect(result.partial).toEqual({ failedStep: 3, reason: expect.stringContaining('function_group_missing') });
    expect(result.applied).toEqual(expect.arrayContaining(['functions:domain_controller', 'retired:0']));
    expect(result.applied).not.toContain('policy:file_server');
    expect(result.rollbackAvailable).toBe(true);
    expect(ledgerMock.recordFailed).toHaveBeenCalledWith(expect.objectContaining({
      itemRef: 'step:3', itemKind: 'policy', step: 3, error: expect.stringContaining('function_group_missing'), userId: USER,
    }));
    // step 5 never runs after a step-3 failure
    expect(dbHolder.updates.find((u) => u.table === devices)).toBeUndefined();
  });
});

describe('applyFleetDesign — idempotent re-apply', () => {
  it('skips refs already in the ledger and applies only new ones', async () => {
    const outcome = makeOutcome({
      functions: [
        { functionKey: 'file_server', label: 'File Server', deviceIds: ['d1'], confidence: 0.9, evidence: [] },
        { functionKey: 'domain_controller', label: 'Domain Controller', deviceIds: ['d2'], confidence: 0.9, evidence: [] },
      ],
    });
    const previewCtx = makeCtx({
      outcome,
      locked: { reportRunId: RUN, reportId: 'report-1', orgId: ORG, outcome, summary: { fleetDesign: { runId: 'run-1' } } },
      appliedRefs: new Set(['functions:file_server']),
      preview: makePreview({
        functions: [
          { functionKey: 'file_server', label: 'File Server', groupId: 'g-existing', groupName: 'Fleet Design: File Server', deviceCount: 1, devicesAdded: [], devicesRemoved: [], keptManual: 0, missingDevices: [] },
          { functionKey: 'domain_controller', label: 'Domain Controller', groupId: null, groupName: 'Fleet Design: Domain Controller', deviceCount: 1, devicesAdded: ['d2'], devicesRemoved: [], keptManual: 0, missingDevices: [] },
        ],
        alreadyApplied: ['functions:file_server'],
      }),
      wantedByFunction: new Map([['file_server', ['d1']], ['domain_controller', ['d2']]]),
    });
    previewMock.previewFleetDesignApplyWithContext.mockResolvedValue(previewCtx);

    selectSeed(deviceFunctionAssessments, []); // only for domain_controller
    deviceFunctionMock.applyDesignFunctions.mockResolvedValue({ written: 1, keptManual: 0, skippedForeign: 0 });
    selectSeed(deviceFunctionAssessments, [{ id: 'assess-2', deviceId: 'd2' }]);
    insertSeed(deviceGroups, [{ id: 'g-new-2' }]);
    selectSeed(deviceGroups, [{ siteId: null }]);

    const result = await applyFleetDesign(makeAuth(), RUN, makeApproval({ functions: ['file_server', 'domain_controller'] }));

    expect(deviceFunctionMock.applyDesignFunctions).toHaveBeenCalledTimes(1);
    expect(deviceFunctionMock.applyDesignFunctions).toHaveBeenCalledWith(expect.objectContaining({ functions: [expect.objectContaining({ functionKey: 'domain_controller' })] }), transactionState.tx);
    expect(result.skipped).toEqual(['functions:file_server']);
    expect(result.applied).toEqual(['functions:domain_controller']);
  });
});

describe('pure helpers', () => {
  describe('retireRewrite', () => {
    it('disables the named watch by name, leaving other watches untouched', () => {
      const result = retireRewrite('watch', 'Spooler', { checkIntervalSeconds: 60, watches: [{ name: 'Spooler', enabled: true }, { name: 'BITS', enabled: true }] });
      expect(result).toEqual({ checkIntervalSeconds: 60, watches: [{ name: 'Spooler', enabled: false }, { name: 'BITS', enabled: true }] });
    });

    it('removes the named rule by name from items', () => {
      const result = retireRewrite('rule', 'Disk full', { items: [{ name: 'Disk full' }, { name: 'CPU high' }] });
      expect(result).toEqual({ items: [{ name: 'CPU high' }] });
    });
  });

  describe('describeAction / toRuleItem', () => {
    it('describes a none action plainly', () => {
      expect(describeAction('none')).toBe('none');
    });

    it('describes a kinded action as "<kind> <ref>"', () => {
      expect(describeAction({ kind: 'playbook', ref: 'pb-1' })).toBe('playbook pb-1');
    });

    it('appends "[Action: …; Paging: …]" to the rationale', () => {
      const rule: FleetDesignRule = { name: 'Disk full', severity: 'high', conditions: [], cooldownMinutes: 30, rationale: 'disk fills up', action: { kind: 'playbook', ref: 'pb-1' }, paging: 'business_hours' };
      expect(toRuleItem(rule).rationale).toBe('disk fills up [Action: playbook pb-1; Paging: business_hours]');
    });
  });

  describe('toWatchItem', () => {
    it('forces enabled:true regardless of design intent (a design never proposes a disabled watch)', () => {
      const watch = { watchType: 'process' as const, name: 'chrome.exe', alertOnStop: false, autoRestart: true, rationale: 'perf' };
      expect(toWatchItem(watch)).toEqual({ watchType: 'process', name: 'chrome.exe', enabled: true, alertOnStop: false, autoRestart: true, rationale: 'perf' });
    });
  });

  describe('snapshotLinks / canonical', () => {
    it('is independent of key order and array-of-links order', () => {
      const linksA = [
        { featureType: 'monitoring', featurePolicyId: null, inlineSettings: { b: 2, a: 1 } },
        { featureType: 'alert_rule', featurePolicyId: null, inlineSettings: { y: 2, x: 1 } },
      ];
      const linksB = [
        { featureType: 'alert_rule', featurePolicyId: null, inlineSettings: { x: 1, y: 2 } },
        { featureType: 'monitoring', featurePolicyId: null, inlineSettings: { a: 1, b: 2 } },
      ];
      expect(snapshotLinks(linksA)).toEqual(snapshotLinks(linksB));
    });

    it('ignores a link that belongs to a linked feature policy (featurePolicyId set)', () => {
      const links = [{ featureType: 'monitoring', featurePolicyId: 'other-policy', inlineSettings: { a: 1 } }];
      expect(snapshotLinks(links).monitoring).toBeNull();
    });

    it('canonical drops undefined keys so two structurally-different-but-equivalent objects compare equal', () => {
      expect(canonical({ a: 1, b: undefined })).toEqual(canonical({ a: 1 }));
    });
  });
});
