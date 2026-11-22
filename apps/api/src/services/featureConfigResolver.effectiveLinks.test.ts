import { describe, it, expect, vi, beforeEach } from 'vitest';

// Deliberately NOT mocking '../db/schema': the point of this suite is table
// IDENTITY. Asserting against the real `configPolicyEffectiveFeatureLinks`
// object means a stubbed lookalike cannot make it pass, and a resolver left on
// the base table cannot either.
vi.mock('../db', () => ({
  db: { select: vi.fn() },
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  getCurrentDbAccessContext: vi.fn(() => ({ scope: 'system' as const })),
}));

import {
  resolvePatchConfigPolicyForDevice,
  scanScheduledAutomations,
  scanDueComplianceChecks,
  resolveAutomationsForDeviceWithPolicy,
  resolveAutomationAssignmentForDevice,
  resolveAllVulnerabilityEnabledDevices,
  resolvePatchConfigDetailsForDevice,
  resolveBackupConfigForDevice,
  resolveMaintenanceConfigForDevice,
  resolveComplianceRulesForDevice,
  resolveComplianceAssignmentForDevice,
  resolveSoftwarePolicyForDevice,
  resolveVulnerabilityEnabledForDevice,
  resolveDeviceIdsForSoftwarePolicy,
  resolveBackupProtectionForDevice,
  resolveAllBackupAssignedDevices,
} from './featureConfigResolver';
import { db, getCurrentDbAccessContext, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import {
  configPolicyAutomations,
  configPolicyComplianceRules,
  configPolicyEffectiveFeatureLinks,
  configPolicyFeatureLinks,
  partners,
} from '../db/schema';

// Records the first argument of every join so a test can ask "which tables did
// this query actually touch?".
interface Recorder {
  joined: unknown[];
}

function chain(rows: unknown[], rec: Recorder, own: Recorder) {
  const c: any = {
    then(resolve: (v: unknown) => void) {
      resolve(rows);
    },
  };
  for (const m of ['from', 'where', 'orderBy', 'limit', 'groupBy']) c[m] = () => c;
  for (const m of ['innerJoin', 'leftJoin']) {
    c[m] = (table: unknown) => {
      rec.joined.push(table);
      own.joined.push(table);
      return c;
    };
  }
  // `.from()` is also a table reference worth recording.
  c.from = (table: unknown) => {
    rec.joined.push(table);
    own.joined.push(table);
    return c;
  };
  return c;
}

let rec: Recorder;
// The tables each query touched, one entry per queued `db.select()` in call
// order, so a test can ask what ONE query joined rather than the whole call.
let perQuery: unknown[][];

beforeEach(() => {
  // mockReset, not clearAllMocks: `mockReturnValueOnce` values survive a clear,
  // so an unconsumed chain from the previous test would be handed to this one's
  // first query and every assertion after it would be about the wrong call.
  vi.mocked(db.select).mockReset();
  rec = { joined: [] };
  perQuery = [];
});

function queue(...rowSets: unknown[][]) {
  const m = vi.mocked(db.select);
  for (const rows of rowSets) {
    const own: Recorder = { joined: [] };
    perQuery.push(own.joined);
    m.mockReturnValueOnce(chain(rows, rec, own) as any);
  }
}

const DEVICE = {
  id: 'dev-1',
  orgId: 'org-1',
  siteId: 'site-1',
  deviceRole: 'workstation',
  osType: 'windows',
};

// loadDeviceHierarchy issues three selects before the resolver's own query.
function queueHierarchy(...rowSets: unknown[][]) {
  queue([DEVICE], [{ partnerId: 'ptr-1' }], [], ...rowSets);
}

// Some resolvers issue follow-up queries (timezone lookups, settings joins)
// after the one under test. Queue spare empty chains so an extra call cannot
// throw on an undefined builder and turn a real assertion into an error.
function queueSpares(n: number) {
  queue(...Array.from({ length: n }, () => [] as unknown[]));
}

function expectReadsEffectiveLinks() {
  expect(rec.joined).toContain(configPolicyEffectiveFeatureLinks);
  expect(rec.joined).not.toContain(configPolicyFeatureLinks);
}

describe('featureConfigResolver reads effective feature links', () => {
  it('scanScheduledAutomations joins the effective view, not the base table', async () => {
    queue([]);
    await scanScheduledAutomations();
    expectReadsEffectiveLinks();
  });

  it('scanScheduledAutomations reports the policy the effective link belongs to', async () => {
    // Through the view the parent's automation link surfaces once per policy
    // that effectively has it, each row naming that policy. The scheduler keys
    // its execution identity on this id, so it has to be the child's, not the
    // authoring parent's.
    queue([
      { automation: { id: 'auto-1' }, assignmentLevel: 'organization', assignmentTargetId: 'org-1', policyId: 'child-a', policyName: 'A' },
      { automation: { id: 'auto-1' }, assignmentLevel: 'organization', assignmentTargetId: 'org-2', policyId: 'child-b', policyName: 'B' },
    ]);
    const rows = await scanScheduledAutomations();
    expect(rows.map((r) => r.policyId)).toEqual(['child-a', 'child-b']);
  });

  it('scanDueComplianceChecks joins the effective view', async () => {
    queue([]);
    await scanDueComplianceChecks();
    expectReadsEffectiveLinks();
  });

  it('resolveAllVulnerabilityEnabledDevices joins the effective view', async () => {
    queue([]);
    await resolveAllVulnerabilityEnabledDevices();
    expectReadsEffectiveLinks();
  });

  // The remaining hierarchy resolvers. Each one decides what a device gets, so
  // a missed switch here is the same "child policy delivers nothing" bug — and
  // a schema-stub rename alone would not catch it, because the stub is renamed
  // in lockstep with the source. These assert against the REAL schema exports.
  const deviceResolvers: Array<[string, (id: string) => Promise<unknown>, number]> = [
    ['resolvePatchConfigDetailsForDevice', resolvePatchConfigDetailsForDevice, 3],
    ['resolvePatchConfigPolicyForDevice', resolvePatchConfigPolicyForDevice, 3],
    ['resolveBackupConfigForDevice', resolveBackupConfigForDevice, 3],
    ['resolveMaintenanceConfigForDevice', resolveMaintenanceConfigForDevice, 3],
    ['resolveComplianceRulesForDevice', resolveComplianceRulesForDevice, 3],
    ['resolveSoftwarePolicyForDevice', resolveSoftwarePolicyForDevice, 3],
    ['resolveVulnerabilityEnabledForDevice', resolveVulnerabilityEnabledForDevice, 3],
    ['resolveBackupProtectionForDevice', resolveBackupProtectionForDevice, 3],
  ];

  for (const [name, call, spares] of deviceResolvers) {
    it(`${name} joins the effective view`, async () => {
      queueHierarchy([]);
      queueSpares(spares);
      await call('dev-1');
      expectReadsEffectiveLinks();
    });
  }

  it('resolveDeviceIdsForSoftwarePolicy joins the effective view (it feeds the compliance worker)', async () => {
    queue([]);
    queueSpares(2);
    await resolveDeviceIdsForSoftwarePolicy('sp-1');
    expectReadsEffectiveLinks();
  });

  it('resolveAllBackupAssignedDevices joins the effective view', async () => {
    queue([{ partnerId: 'ptr-1' }]);
    queueSpares(3);
    await resolveAllBackupAssignedDevices('org-1');
    expectReadsEffectiveLinks();
  });
});

// #12488: both list resolvers pick the winning LINK first (no child join, so a
// link with an empty list is still a candidate), then load that link's rows.
// Query order after loadDeviceHierarchy's three: [candidates], [winner's rows].
const candidate = (over: Record<string, unknown>) => ({
  assignmentLevel: 'organization',
  assignmentPriority: 0,
  assignmentCreatedAt: new Date('2026-01-01T00:00:00Z'),
  ...over,
});
const ORG = { assignmentId: 'asg-org', policyId: 'policy-org', policyName: 'Org', featureLinkId: 'fl-org' };
const SITE = { assignmentLevel: 'site', assignmentId: 'asg-site', policyId: 'policy-site', policyName: 'Site', featureLinkId: 'fl-site' };

describe('resolveAutomationsForDeviceWithPolicy', () => {
  it('returns the WINNING assignment\'s policy id alongside its automations', async () => {
    // Sorted by hierarchy: the device-level assignment beats the org-level one,
    // so only its policy and its link's automations come back.
    queueHierarchy(
      [
        candidate(ORG),
        candidate({
          assignmentLevel: 'device', assignmentCreatedAt: new Date('2026-01-02T00:00:00Z'),
          assignmentId: 'asg-device', policyId: 'policy-device', policyName: 'Device', featureLinkId: 'fl-device',
        }),
      ],
      [{ id: 'auto-device', featureLinkId: 'fl-device', retiredAt: null }],
    );

    const resolved = await resolveAutomationsForDeviceWithPolicy('dev-1');
    expect(resolved).not.toBeNull();
    expect(resolved!.configPolicyId).toBe('policy-device');
    expect(resolved!.automations.map((a) => a.id)).toEqual(['auto-device']);
  });

  it('returns null when nothing is assigned (callers must skip, not fall through)', async () => {
    queueHierarchy([]);
    expect(await resolveAutomationsForDeviceWithPolicy('dev-1')).toBeNull();
  });

  it('returns null when the device does not exist', async () => {
    queue([]); // loadDeviceHierarchy: no device row
    expect(await resolveAutomationsForDeviceWithPolicy('nope')).toBeNull();
  });
});

describe('an empty closer list overrides a broader one (#12488)', () => {
  it('automations: the candidate query does not join the automation rows, so an empty link can win', async () => {
    queueHierarchy([candidate(ORG), candidate(SITE)], []); // the site link has no automations
    expect(await resolveAutomationAssignmentForDevice('dev-1')).toEqual({ configPolicyId: 'policy-site', automations: [] });
    // perQuery[3] is the candidate query (after loadDeviceHierarchy's three).
    expect(perQuery[3]).toContain(configPolicyEffectiveFeatureLinks);
    expect(perQuery[3]).not.toContain(configPolicyAutomations);
    expect(perQuery[4]).toContain(configPolicyAutomations);
  });

  it('compliance: the candidate query does not join the rule rows, so an empty link can win', async () => {
    queueHierarchy([candidate(ORG), candidate(SITE)], []); // the site link has no rules
    expect(await resolveComplianceAssignmentForDevice('dev-1')).toEqual({
      configPolicyId: 'policy-site', configPolicyName: 'Site', rules: [],
    });
    expect(perQuery[3]).toContain(configPolicyEffectiveFeatureLinks);
    expect(perQuery[3]).not.toContain(configPolicyComplianceRules);
    expect(perQuery[4]).toContain(configPolicyComplianceRules);
  });

  it('compliance: with no closer link the broader policy\'s rules come back', async () => {
    const rules = [{ id: 'r-1', name: 'Disk', featureLinkId: 'fl-org' }];
    queueHierarchy([candidate(ORG)], rules);
    expect(await resolveComplianceAssignmentForDevice('dev-1')).toEqual({
      configPolicyId: 'policy-org', configPolicyName: 'Org', rules,
    });
  });

  it('nothing assigned is null for both, and no child query runs', async () => {
    queueHierarchy([]);
    expect(await resolveComplianceAssignmentForDevice('dev-1')).toBeNull();
    expect(vi.mocked(db.select)).toHaveBeenCalledTimes(4);
    vi.mocked(db.select).mockReset();
    queueHierarchy([]);
    expect(await resolveAutomationAssignmentForDevice('dev-1')).toBeNull();
    expect(vi.mocked(db.select)).toHaveBeenCalledTimes(4);
  });
});

it('a converted child still wins; only its legacy executable rows disappear', async () => {
  const converted = { id: 'child-auto', featureLinkId: 'fl-site', retiredAt: new Date(0) };
  queueHierarchy([candidate(ORG), candidate(SITE)], [converted]);
  expect(await resolveAutomationAssignmentForDevice('dev-1')).toEqual({ configPolicyId: 'policy-site', automations: [converted] });
  queueHierarchy([candidate(ORG), candidate(SITE)], [converted]);
  expect(await resolveAutomationsForDeviceWithPolicy('dev-1')).toEqual({ configPolicyId: 'policy-site', automations: [] });
  // #12488: a child whose rows are ALL filtered out (retired with no live
  // conversion) still wins; the broader policy's automations do not come back.
  queueHierarchy([candidate(ORG), candidate(SITE)], []);
  expect(await resolveAutomationsForDeviceWithPolicy('dev-1')).toEqual({ configPolicyId: 'policy-site', automations: [] });
});

// #7647: the ring-aware approval evaluator only needs WHICH config policy won.
// The timezone half of resolvePatchConfigDetailsForDevice reads the
// partner-axis `partners` row through a system escape (a second pooled
// connection under a request context), so the evaluator's resolver must not
// pay it.
describe('resolvePatchConfigPolicyForDevice (#7647)', () => {
  it('resolves the winning policy without the partner timezone read or any system escape', async () => {
    vi.mocked(runOutsideDbContext).mockClear();
    vi.mocked(withSystemDbAccessContext).mockClear();
    vi.mocked(getCurrentDbAccessContext).mockReturnValue({
      scope: 'organization', orgId: 'org-1', accessibleOrgIds: ['org-1'],
      accessiblePartnerIds: [], currentPartnerId: 'ptr-1',
    } as any);
    queueHierarchy([{
      patchSettings: { id: 'ps-1' }, featureLinkId: 'fl-1', configPolicyId: 'cp-1', configPolicyName: 'P',
      featurePolicyId: 'ring-1', assignmentTargetId: 'org-1', assignmentLevel: 'organization',
      assignmentPriority: 0, assignmentCreatedAt: new Date(), assignmentId: 'a-1',
    }]);
    queueSpares(3);
    try {
      const resolved = await resolvePatchConfigPolicyForDevice('dev-1');
      expect(resolved).toMatchObject({ configPolicyId: 'cp-1', featurePolicyId: 'ring-1' });
      expect(resolved).not.toHaveProperty('resolvedTimezone');
      expect(rec.joined).not.toContain(partners);
      expect(runOutsideDbContext).not.toHaveBeenCalled();
      expect(withSystemDbAccessContext).not.toHaveBeenCalled();
    } finally {
      vi.mocked(getCurrentDbAccessContext).mockReturnValue({ scope: 'system' } as any);
    }
  });
});
