import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FleetDesignApproval, FleetDesignOutcome } from '@breeze/shared';

const ledgerMock = vi.hoisted(() => ({
  findReusableGroup: vi.fn(),
  loadLedger: vi.fn(),
  lockReportRun: vi.fn(),
}));
vi.mock('./ledger', () => ledgerMock);

const configPolicyMock = vi.hoisted(() => ({
  listFeatureLinks: vi.fn(),
  policyAccessCondition: vi.fn(() => undefined),
  resolveEffectiveConfig: vi.fn(),
}));
vi.mock('../configurationPolicy', () => configPolicyMock);

const partnerWideMock = vi.hoisted(() => ({ canManagePartnerWidePolicies: vi.fn(() => false) }));
vi.mock('../partnerWideAccess', () => partnerWideMock);

const bundleMock = vi.hoisted(() => ({
  previewBundle: vi.fn(),
  findSecretVariableReferences: vi.fn(async () => [] as string[]),
}));
vi.mock('../scriptBundle', () => bundleMock);

// --- Table-routed fake db (FIFO queue per table) ---------------------------
type Row = Record<string, unknown>;
const dbHolder = vi.hoisted(() => ({
  queues: new Map<unknown, Row[][]>(),
  selects: [] as Array<{ table: unknown }>,
}));
function dbSeed(table: unknown, rows: Row[]) {
  const q = dbHolder.queues.get(table) ?? [];
  q.push(rows);
  dbHolder.queues.set(table, q);
}
vi.mock('../../db', () => ({
  db: {
    select: (_proj?: unknown) => ({
      from: (table: unknown) => {
        const q = dbHolder.queues.get(table) ?? [];
        const rows = q.shift() ?? [];
        dbHolder.selects.push({ table });
        const finish = (r: Row[]) => {
          const p = Promise.resolve(r) as Promise<Row[]> & { limit?: (n: number) => Promise<Row[]> };
          p.limit = (n: number) => Promise.resolve(r.slice(0, n));
          return p;
        };
        return { where: (_cond: unknown) => finish(rows) };
      },
    }),
  },
}));

import { previewFleetDesignApply, previewFleetDesignApplyWithContext, wouldBeDisplaced } from './preview';
import { configurationPolicies, deviceGroupMemberships, devices } from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';

const ORG = '11111111-1111-4111-8111-111111111111';
const RUN = '22222222-2222-4222-8222-222222222222';

function makeAuth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    principal: 'user',
    user: { id: 'user-1', email: 'tech@example.com', name: 'Tech', isPlatformAdmin: false },
    token: null,
    partnerId: null,
    orgId: ORG,
    scope: 'organization',
    accessibleOrgIds: [ORG],
    partnerOrgAccess: null,
    orgCondition: () => undefined,
    canAccessOrg: () => true,
    ...overrides,
  } as AuthContext;
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

function makeApproval(overrides: Partial<FleetDesignApproval> = {}): FleetDesignApproval {
  return { functions: [], monitoring: [], retired: [], automation: [], legacy: [], roleCorrections: [], displacementsAccepted: [], ...overrides };
}

function lockedOk(outcome: FleetDesignOutcome, reportRunId = RUN, orgId = ORG) {
  return { reportRunId, reportId: 'report-1', orgId, outcome, summary: { fleetDesign: { outcome } } };
}

beforeEach(() => {
  vi.clearAllMocks();
  dbHolder.queues.clear();
  dbHolder.selects.length = 0;
  ledgerMock.loadLedger.mockResolvedValue([]);
  configPolicyMock.policyAccessCondition.mockReturnValue(undefined);
});

describe('wouldBeDisplaced', () => {
  it.each([
    ['site', 0, true],
    ['organization', 999, true],
    ['partner', 0, true],
    ['device', 0, false],
    ['device_group', 0, false],
    ['device_group', 100, false],
    ['device_group', 101, true],
    ['unknown_level', 0, true],
  ] as const)('sourceLevel=%s priority=%s -> %s', (level, priority, expected) => {
    expect(wouldBeDisplaced(level, priority)).toBe(expected);
  });
});

describe('previewFleetDesignApplyWithContext — functions', () => {
  it('lists devices added/removed against a reusable group and counts manual-kept devices', async () => {
    const outcome = makeOutcome({
      functions: [{ functionKey: 'file_server', label: 'File Server', deviceIds: ['d1', 'd2', 'd3'], confidence: 0.9, evidence: [] }],
    });
    ledgerMock.lockReportRun.mockResolvedValue(lockedOk(outcome));
    ledgerMock.findReusableGroup.mockResolvedValue({ groupId: 'g1' });
    dbSeed(devices, [
      { id: 'd1', hostname: 'H1', deviceRole: 'workstation', deviceRoleSource: 'ai', deviceFunctionSource: 'manual' },
      { id: 'd2', hostname: 'H2', deviceRole: 'workstation', deviceRoleSource: 'ai', deviceFunctionSource: 'ai' },
      { id: 'd3', hostname: 'H3', deviceRole: 'workstation', deviceRoleSource: 'ai', deviceFunctionSource: null },
    ]);
    dbSeed(deviceGroupMemberships, [{ deviceId: 'd2' }, { deviceId: 'd4' }]);

    const ctx = await previewFleetDesignApplyWithContext(makeAuth(), RUN, makeApproval({ functions: ['file_server'] }));

    expect(ctx.preview.functions).toEqual([{
      functionKey: 'file_server', label: 'File Server', groupId: 'g1', groupName: 'Fleet Design: File Server',
      deviceCount: 3, devicesAdded: ['d1', 'd3'], devicesRemoved: ['d4'], keptManual: 1, missingDevices: [],
    }]);
    expect(ctx.preview.blockers).toEqual([]);
  });

  it('reports a not_in_design blocker for a function key absent from the outcome', async () => {
    const outcome = makeOutcome({ functions: [] });
    ledgerMock.lockReportRun.mockResolvedValue(lockedOk(outcome));

    const preview = await previewFleetDesignApply(makeAuth(), RUN, makeApproval({ functions: ['unknown_fn'] }));

    expect(preview.functions).toEqual([]);
    expect(preview.blockers).toEqual([{ itemRef: 'functions:unknown_fn', reason: 'not_in_design' }]);
    expect(ledgerMock.findReusableGroup).not.toHaveBeenCalled();
  });
});

describe('previewFleetDesignApplyWithContext — monitoring displacement', () => {
  it('computes displaced policies per feature type from resolveEffectiveConfig, deduped with device counts, skipping default/device/low-priority device_group winners', async () => {
    const outcome = makeOutcome({
      functions: [{ functionKey: 'file_server', label: 'File Server', deviceIds: ['d1', 'd2', 'd3'], confidence: 0.9, evidence: [] }],
      monitoring: [{
        functionKey: 'file_server',
        watches: [{ watchType: 'service', name: 'Spooler', alertOnStop: true, autoRestart: false, rationale: 'r' }],
        alertRules: [],
      }],
    });
    ledgerMock.lockReportRun.mockResolvedValue(lockedOk(outcome));
    ledgerMock.findReusableGroup.mockResolvedValue(null); // functions:file_server approved → group created in apply, no reuse yet
    dbSeed(devices, [
      { id: 'd1', hostname: 'H1', deviceRole: 'workstation', deviceRoleSource: 'ai', deviceFunctionSource: null },
      { id: 'd2', hostname: 'H2', deviceRole: 'workstation', deviceRoleSource: 'ai', deviceFunctionSource: null },
      { id: 'd3', hostname: 'H3', deviceRole: 'workstation', deviceRoleSource: 'ai', deviceFunctionSource: null },
    ]);

    configPolicyMock.resolveEffectiveConfig.mockImplementation(async (deviceId: string) => {
      if (deviceId === 'd1') {
        return {
          deviceId, inheritanceChain: [],
          features: {
            monitors: { sourceLevel: 'organization', sourcePolicyId: 'p1', sourcePolicyName: 'Org Monitoring', sourcePriority: 0 },
            alert_rule: { sourceLevel: 'device', sourcePolicyId: 'p-device', sourcePolicyName: 'Device Local', sourcePriority: 0 },
          },
        };
      }
      if (deviceId === 'd2') {
        return {
          deviceId, inheritanceChain: [],
          features: {
            monitors: { sourceLevel: 'device_group', sourcePolicyId: 'p2', sourcePolicyName: 'Legacy Group Monitoring', sourcePriority: 0 },
            alert_rule: { sourceLevel: 'default', sourcePolicyId: 'breeze-defaults', sourcePolicyName: 'Breeze Defaults', sourcePriority: 0 },
          },
        };
      }
      return {
        deviceId, inheritanceChain: [],
        features: {
          monitors: { sourceLevel: 'organization', sourcePolicyId: 'p1', sourcePolicyName: 'Org Monitoring', sourcePriority: 0 },
          alert_rule: { sourceLevel: 'device_group', sourcePolicyId: 'p3', sourcePolicyName: 'Old Group Rules', sourcePriority: 150 },
        },
      };
    });

    const preview = await previewFleetDesignApply(
      makeAuth(),
      RUN,
      makeApproval({ functions: ['file_server'], monitoring: ['monitoring:file_server:watch:0'] }),
    );

    expect(preview.policies).toHaveLength(1);
    expect(preview.policies[0]!.displaces).toEqual(
      expect.arrayContaining([
        { policyId: 'p1', policyName: 'Org Monitoring', featureType: 'monitors', deviceCount: 2 },
      ]),
    );
    expect(preview.policies[0]!.displaces).toHaveLength(1);
  });
});

describe('previewFleetDesignApplyWithContext — legacy rule proposals (W05c2)', () => {
  const legacyRule = {
    name: 'Old disk', severity: 'high', conditions: [{ type: 'metric', metric: 'disk', operator: 'gt', value: 90 }],
    cooldownMinutes: 30, rationale: 'r', action: 'none', paging: 'none',
  };
  const monitorRule = {
    name: 'New disk', severity: 'high', kind: 'disk', condition: { operator: 'gt', value: 90 },
    cooldownMinutes: 30, responses: [], deliveryMode: 'inherit', deliveryChannelIds: [], rationale: 'r', action: 'none', paging: 'none',
  };
  function outcomeWithRules() {
    return makeOutcome({
      functions: [{ functionKey: 'file_server', label: 'File Server', deviceIds: ['d1'], confidence: 0.9, evidence: [] }],
      monitoring: [{ functionKey: 'file_server', watches: [], alertRules: [legacyRule, monitorRule] as any }],
    });
  }

  it('blocks a selected legacy rule proposal but not a monitor-shaped one', async () => {
    ledgerMock.lockReportRun.mockResolvedValue(lockedOk(outcomeWithRules()));
    ledgerMock.findReusableGroup.mockResolvedValue(null);
    dbSeed(devices, [{ id: 'd1', hostname: 'H1', deviceRole: 'workstation', deviceRoleSource: 'ai', deviceFunctionSource: null }]);
    configPolicyMock.resolveEffectiveConfig.mockResolvedValue({ deviceId: 'd1', inheritanceChain: [], features: {} });

    const preview = await previewFleetDesignApply(makeAuth(), RUN, makeApproval({
      functions: ['file_server'],
      monitoring: ['monitoring:file_server:rule:0', 'monitoring:file_server:rule:1'],
    }));

    expect(preview.blockers).toEqual([{ itemRef: 'monitoring:file_server:rule:0', reason: 'legacy_monitor_proposal' }]);
  });

  it('does not block a legacy rule an earlier apply already applied', async () => {
    ledgerMock.lockReportRun.mockResolvedValue(lockedOk(outcomeWithRules()));
    ledgerMock.loadLedger.mockResolvedValue([{ itemRef: 'monitoring:file_server:rule:0', status: 'applied' }]);
    ledgerMock.findReusableGroup.mockResolvedValue(null);
    dbSeed(devices, [{ id: 'd1', hostname: 'H1', deviceRole: 'workstation', deviceRoleSource: 'ai', deviceFunctionSource: null }]);
    configPolicyMock.resolveEffectiveConfig.mockResolvedValue({ deviceId: 'd1', inheritanceChain: [], features: {} });

    const preview = await previewFleetDesignApply(makeAuth(), RUN, makeApproval({
      functions: ['file_server'], monitoring: ['monitoring:file_server:rule:0'],
    }));

    expect(preview.blockers).toEqual([]);
  });
});

describe('previewFleetDesignApplyWithContext — retired', () => {
  it.each(['watch', 'rule'] as const)('blocks an accessible legacy %s proposal without reading filtered feature links', async (kind) => {
    const outcome = makeOutcome({
      retired: [{ kind, policyId: 'p2', policyName: 'Old Policy', itemName: 'Spooler', reason: 'unused' }],
    });
    ledgerMock.lockReportRun.mockResolvedValue(lockedOk(outcome));
    dbSeed(configurationPolicies, [{ id: 'p2', orgId: ORG, name: 'Old Policy' }]);
    configPolicyMock.listFeatureLinks.mockResolvedValue([
      { id: 'link1', featureType: 'monitoring', featurePolicyId: null, inlineSettings: { watches: [{ name: 'OtherWatch', enabled: true }] } },
    ]);

    const preview = await previewFleetDesignApply(makeAuth(), RUN, makeApproval({ retired: ['retired:0'] }));

    expect(preview.retired).toEqual([{ itemRef: 'retired:0', policyId: 'p2', policyName: 'Old Policy', kind, itemName: 'Spooler', found: true, editable: false }]);
    expect(configPolicyMock.listFeatureLinks).not.toHaveBeenCalled();
    expect(preview.blockers).toEqual([{ itemRef: 'retired:0', reason: 'legacy_source_retired' }]);
  });

  it.each([null, '33333333-3333-4333-8333-333333333333'])('keeps missing and cross-org policy proposals hidden (%s)', async (policyOrgId) => {
    ledgerMock.lockReportRun.mockResolvedValue(lockedOk(makeOutcome({
      retired: [{ kind: 'rule', policyId: 'p2', policyName: 'Historical policy', itemName: 'Disk', reason: 'unused' }],
    })));
    dbSeed(configurationPolicies, policyOrgId ? [{ id: 'p2', orgId: policyOrgId, name: 'Other org' }] : []);
    const preview = await previewFleetDesignApply(makeAuth(), RUN, makeApproval({ retired: ['retired:0'] }));
    expect(preview.retired[0]).toMatchObject({ found: false, editable: false });
    expect(preview.blockers).toEqual([{ itemRef: 'retired:0', reason: 'retired_item_not_found' }]);
    expect(configPolicyMock.listFeatureLinks).not.toHaveBeenCalled();
  });

  it('marks a retired item non-editable when the policy is partner-wide and the caller cannot manage partner-wide policies', async () => {
    const outcome = makeOutcome({
      retired: [{ kind: 'watch', policyId: 'p2', policyName: 'Partner Policy', itemName: 'Spooler', reason: 'unused' }],
    });
    ledgerMock.lockReportRun.mockResolvedValue(lockedOk(outcome));
    dbSeed(configurationPolicies, [{ id: 'p2', orgId: null, name: 'Partner Policy' }]);
    configPolicyMock.listFeatureLinks.mockResolvedValue([
      { id: 'link1', featureType: 'monitoring', featurePolicyId: null, inlineSettings: { watches: [{ name: 'Spooler', enabled: true }] } },
    ]);
    partnerWideMock.canManagePartnerWidePolicies.mockReturnValue(false);

    const preview = await previewFleetDesignApply(makeAuth(), RUN, makeApproval({ retired: ['retired:0'] }));

    expect(preview.retired[0]).toMatchObject({ found: true, editable: false });
    expect(preview.blockers).toEqual([{ itemRef: 'retired:0', reason: 'partner_wide_write_denied' }]);
  });

  it('reports item refs with an applied ledger row under alreadyApplied and NOT in blockers, even when currently unresolvable', async () => {
    const outcome = makeOutcome({
      retired: [{ kind: 'watch', policyId: 'p2', policyName: 'Old Policy', itemName: 'Spooler', reason: 'unused' }],
    });
    ledgerMock.lockReportRun.mockResolvedValue(lockedOk(outcome));
    ledgerMock.loadLedger.mockResolvedValue([{ itemRef: 'retired:0', status: 'applied', itemKind: 'retired' }]);
    dbSeed(configurationPolicies, [{ id: 'p2', orgId: ORG, name: 'Old Policy' }]);
    configPolicyMock.listFeatureLinks.mockResolvedValue([
      { id: 'link1', featureType: 'monitoring', featurePolicyId: null, inlineSettings: { watches: [] } }, // no longer found
    ]);

    const preview = await previewFleetDesignApply(makeAuth(), RUN, makeApproval({ retired: ['retired:0'] }));

    expect(preview.alreadyApplied).toEqual(['retired:0']);
    expect(preview.blockers).toEqual([]);
  });
});

describe('previewFleetDesignApplyWithContext — role corrections', () => {
  it('blocks a role correction with role_is_manual when the device role source is manual', async () => {
    const outcome = makeOutcome({
      unsure: {
        lowConfidenceFunctions: [], unreachableDevices: [], needsHuman: [],
        roleCorrections: [{ deviceId: 'd1', currentRole: 'workstation', proposedRole: 'server', evidence: [], billingRelevant: true }],
      },
    });
    ledgerMock.lockReportRun.mockResolvedValue(lockedOk(outcome));
    dbSeed(devices, [{ id: 'd1', hostname: 'H1', deviceRole: 'workstation', deviceRoleSource: 'manual', deviceFunctionSource: null }]);

    const preview = await previewFleetDesignApply(makeAuth(), RUN, makeApproval({ roleCorrections: ['d1'] }));

    expect(preview.roleCorrections).toEqual([]);
    expect(preview.blockers).toEqual([{ itemRef: 'roleCorrections:d1', reason: 'role_is_manual' }]);
  });

  it('accepts a role correction when the device role source is not manual', async () => {
    const outcome = makeOutcome({
      unsure: {
        lowConfidenceFunctions: [], unreachableDevices: [], needsHuman: [],
        roleCorrections: [{ deviceId: 'd1', currentRole: 'workstation', proposedRole: 'server', evidence: [], billingRelevant: true }],
      },
    });
    ledgerMock.lockReportRun.mockResolvedValue(lockedOk(outcome));
    dbSeed(devices, [{ id: 'd1', hostname: 'H1', deviceRole: 'workstation', deviceRoleSource: 'discovered', deviceFunctionSource: null }]);

    const preview = await previewFleetDesignApply(makeAuth(), RUN, makeApproval({ roleCorrections: ['d1'] }));

    expect(preview.roleCorrections).toEqual([{ deviceId: 'd1', hostname: 'H1', from: 'workstation', to: 'server', billingRelevant: true }]);
    expect(preview.blockers).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// W04 (#5654): step 4 — approved automation scripts
// ---------------------------------------------------------------------------
describe('previewFleetDesignApply — automation scripts (W04)', () => {
  const spooler = { name: 'Restart print spooler', purpose: 'Restart spooler when stuck', osTypes: ['windows' as const], language: 'powershell' as const, content: 'Restart-Service Spooler' };
  const cleanup = { name: 'Clean temp', purpose: 'Free disk', osTypes: ['windows' as const], language: 'powershell' as const, content: 'Remove-Item $env:TEMP\\* -Recurse' };
  const outcome = makeOutcome({ automation: [{ functionKey: 'file_server', playbooks: [], scripts: [spooler, cleanup] }] });
  const target = { orgId: ORG, partnerId: null, availability: 'org' as const };

  it('lists each approved script with its name, language, OS and whether a same-named script already exists', async () => {
    ledgerMock.lockReportRun.mockResolvedValue(lockedOk(outcome));
    bundleMock.previewBundle.mockResolvedValue({ target, entries: [{ index: 0, name: spooler.name, status: 'name-conflict' }, { index: 1, name: cleanup.name, status: 'new' }] });

    const preview = await previewFleetDesignApply(makeAuth(), RUN, makeApproval({ automation: ['automation:file_server:script:0', 'automation:file_server:script:1'] }));

    expect(preview.scripts).toEqual([
      { itemRef: 'automation:file_server:script:0', functionKey: 'file_server', name: spooler.name, language: 'powershell', osTypes: ['windows'], alreadyExists: true },
      { itemRef: 'automation:file_server:script:1', functionKey: 'file_server', name: cleanup.name, language: 'powershell', osTypes: ['windows'], alreadyExists: false },
    ]);
    expect(preview.blockers).toEqual([]);
    // Checked against the same importer the apply will call, org-owned.
    expect(bundleMock.previewBundle).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ bundleVersion: 1, scripts: [expect.objectContaining({ name: spooler.name, tags: ['fleet-design'] }), expect.objectContaining({ name: cleanup.name })] }),
      { availability: 'org', orgId: ORG },
    );
  });

  it('blocks a ref that is not in the design or is malformed', async () => {
    ledgerMock.lockReportRun.mockResolvedValue(lockedOk(outcome));
    const preview = await previewFleetDesignApply(makeAuth(), RUN, makeApproval({ automation: ['automation:file_server:script:7', 'automation:print_server:script:0'] }));
    expect(preview.blockers).toEqual([
      { itemRef: 'automation:file_server:script:7', reason: 'not_in_design' },
      { itemRef: 'automation:print_server:script:0', reason: 'not_in_design' },
    ]);
    expect(preview.scripts).toEqual([]);
    expect(bundleMock.previewBundle).not.toHaveBeenCalled();
  });

  it('blocks a script the importer would reject (invalid entry, secret variable reference, scope denied)', async () => {
    ledgerMock.lockReportRun.mockResolvedValue(lockedOk(outcome));
    bundleMock.previewBundle.mockResolvedValueOnce({ target, entries: [{ index: 0, name: spooler.name, status: 'invalid', error: 'too long' }, { index: 1, name: cleanup.name, status: 'new' }] });
    bundleMock.findSecretVariableReferences.mockResolvedValueOnce(['api_key']);
    const approval = makeApproval({ automation: ['automation:file_server:script:0', 'automation:file_server:script:1'] });
    const preview = await previewFleetDesignApply(makeAuth(), RUN, approval);
    expect(preview.blockers).toEqual([
      { itemRef: 'automation:file_server:script:0', reason: 'script_invalid' },
      { itemRef: 'automation:file_server:script:1', reason: 'script_secret_reference' },
    ]);

    bundleMock.previewBundle.mockResolvedValueOnce({ error: 'denied', status: 403 });
    const denied = await previewFleetDesignApply(makeAuth(), RUN, approval);
    expect(denied.blockers.map((b) => b.reason)).toEqual(['script_scope_denied', 'script_scope_denied']);
  });

  it('an already-applied script is reported in alreadyApplied, not re-created and not checked again', async () => {
    ledgerMock.lockReportRun.mockResolvedValue(lockedOk(outcome));
    ledgerMock.loadLedger.mockResolvedValue([{ id: 'l1', itemRef: 'automation:file_server:script:0', itemKind: 'script', status: 'applied', step: 4, createdRefs: { scriptId: 's1' }, beforeImage: null, appliedAt: new Date() }]);
    const preview = await previewFleetDesignApply(makeAuth(), RUN, makeApproval({ automation: ['automation:file_server:script:0'] }));
    expect(preview.alreadyApplied).toEqual(['automation:file_server:script:0']);
    expect(preview.scripts).toEqual([]);
    expect(bundleMock.previewBundle).not.toHaveBeenCalled();
  });
});
