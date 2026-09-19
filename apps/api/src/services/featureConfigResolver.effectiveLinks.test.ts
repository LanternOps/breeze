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
  scanScheduledAutomations,
  scanDueComplianceChecks,
  resolveAlertRulesForDevice,
  resolveAutomationsForDeviceWithPolicy,
  resolveAllVulnerabilityEnabledDevices,
  resolveGoverningAlertRulePolicyForDevice,
  resolvePatchConfigDetailsForDevice,
  resolveBackupConfigForDevice,
  resolveMaintenanceConfigForDevice,
  resolveComplianceRulesForDevice,
  resolveSoftwarePolicyForDevice,
  resolveVulnerabilityEnabledForDevice,
  resolveDeviceIdsForSoftwarePolicy,
  resolveBackupProtectionForDevice,
  resolveAllBackupAssignedDevices,
} from './featureConfigResolver';
import { db } from '../db';
import {
  configPolicyEffectiveFeatureLinks,
  configPolicyFeatureLinks,
} from '../db/schema';

// Records the first argument of every join so a test can ask "which tables did
// this query actually touch?".
interface Recorder {
  joined: unknown[];
}

function chain(rows: unknown[], rec: Recorder) {
  const c: any = {
    then(resolve: (v: unknown) => void) {
      resolve(rows);
    },
  };
  for (const m of ['from', 'where', 'orderBy', 'limit', 'groupBy']) c[m] = () => c;
  for (const m of ['innerJoin', 'leftJoin']) {
    c[m] = (table: unknown) => {
      rec.joined.push(table);
      return c;
    };
  }
  // `.from()` is also a table reference worth recording.
  c.from = (table: unknown) => {
    rec.joined.push(table);
    return c;
  };
  return c;
}

let rec: Recorder;

beforeEach(() => {
  // mockReset, not clearAllMocks: `mockReturnValueOnce` values survive a clear,
  // so an unconsumed chain from the previous test would be handed to this one's
  // first query and every assertion after it would be about the wrong call.
  vi.mocked(db.select).mockReset();
  rec = { joined: [] };
});

function queue(...rowSets: unknown[][]) {
  const m = vi.mocked(db.select);
  for (const rows of rowSets) m.mockReturnValueOnce(chain(rows, rec) as any);
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

  it('resolveAlertRulesForDevice joins the effective view', async () => {
    queueHierarchy([], []);
    await resolveAlertRulesForDevice('dev-1');
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

  it('resolveGoverningAlertRulePolicyForDevice joins the effective view', async () => {
    // This one short-circuits with `unassigned` before its view query unless the
    // candidate policy is actually among the assignments — feeding [] here would
    // make the assertion pass for the wrong reason on the OTHER branch, so the
    // seed has to reach the second query.
    queueHierarchy([
      {
        configPolicyId: 'p-1',
        assignmentLevel: 'organization',
        assignmentPriority: 0,
        assignmentCreatedAt: new Date('2026-01-01T00:00:00Z'),
      },
    ]);
    queueSpares(3);

    const outcome = await resolveGoverningAlertRulePolicyForDevice('dev-1', 'p-1');

    expect(outcome).toEqual({ outcome: 'governs' });
    expectReadsEffectiveLinks();
  });

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

describe('resolveAutomationsForDeviceWithPolicy', () => {
  it('returns the WINNING assignment\'s policy id alongside its automations', async () => {
    // Sorted by hierarchy: the device-level assignment beats the org-level one,
    // so only its policy and its automations come back.
    queueHierarchy([
      {
        automation: { id: 'auto-device' },
        assignmentLevel: 'device',
        assignmentPriority: 0,
        assignmentCreatedAt: new Date('2026-01-02T00:00:00Z'),
        assignmentId: 'asg-device',
        policyId: 'policy-device',
      },
      {
        automation: { id: 'auto-org' },
        assignmentLevel: 'organization',
        assignmentPriority: 0,
        assignmentCreatedAt: new Date('2026-01-01T00:00:00Z'),
        assignmentId: 'asg-org',
        policyId: 'policy-org',
      },
    ]);

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
