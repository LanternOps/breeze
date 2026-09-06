import { beforeEach, describe, expect, it, vi } from 'vitest';

// Execution identity for config-policy automations (#5080 W02).
//
// Through `config_policy_effective_feature_links` ONE feature-link id belongs
// to the authoring parent AND every child that inherits it. So a link id no
// longer names a policy, and anything that used to reverse-map link → policy
// now picks an arbitrary owner — which would clamp a child's run to the
// parent's org. The rule: the ASSIGNED policy id travels with the link id,
// through the dispatch grouping, both BullMQ job ids, the job payload, and the
// run-time ownership clamp.

const queueAdd = vi.fn(async (_name: string, _data: unknown, opts?: { jobId?: string }) => ({
  id: opts?.jobId ?? 'job-1',
}));
const queueGetJob = vi.fn(async () => null);

vi.mock('../db', () => ({
  db: { select: vi.fn() },
  withSystemDbAccessContext: <T>(fn: () => Promise<T>) => fn(),
}));

vi.mock('../db/schema', () => ({
  automations: {},
  configPolicyAutomations: { id: 'cpa.id', enabled: 'cpa.enabled' },
  configPolicyEffectiveFeatureLinks: {
    id: 'cpefl.id',
    configPolicyId: 'cpefl.configPolicyId',
    sourcePolicyId: 'cpefl.sourcePolicyId',
    inherited: 'cpefl.inherited',
    featureType: 'cpefl.featureType',
  },
  configurationPolicies: {
    id: 'cp.id',
    orgId: 'cp.orgId',
    partnerId: 'cp.partnerId',
    status: 'cp.status',
  },
  devices: { id: 'devices.id', orgId: 'devices.orgId', siteId: 'devices.siteId' },
  deviceGroupMemberships: {
    deviceId: 'deviceGroupMemberships.deviceId',
    groupId: 'deviceGroupMemberships.groupId',
    orgId: 'deviceGroupMemberships.orgId',
  },
  deviceGroups: { id: 'deviceGroups.id', orgId: 'deviceGroups.orgId' },
  organizations: { id: 'organizations.id', partnerId: 'organizations.partnerId' },
}));

vi.mock('bullmq', () => ({
  Queue: class {
    add = queueAdd;
    getJob = queueGetJob;
  },
  Worker: class {},
  Job: class {},
}));
vi.mock('../services/eventBus', () => ({ getEventBus: vi.fn() }));
vi.mock('../services/automationRuntime', () => ({
  createAutomationRunRecord: vi.fn(),
  executeAutomationRun: vi.fn(),
  executeConfigPolicyAutomationRun: vi.fn(),
  formatScheduleTriggerKey: vi.fn(),
  isCronDue: vi.fn(() => true),
  normalizeAutomationTrigger: vi.fn(),
}));
vi.mock('../services/featureConfigResolver', () => ({
  scanScheduledAutomations: vi.fn(),
  resolveAutomationsForDevice: vi.fn(),
  resolveAutomationsForDeviceWithPolicy: vi.fn(),
  resolveMaintenanceConfigForDevice: vi.fn(async () => null),
  isInMaintenanceWindow: vi.fn(() => ({ active: false, suppressAutomations: false })),
}));
vi.mock('../services/redis', () => ({
  getBullMQConnection: vi.fn(() => ({})),
  isRedisAvailable: vi.fn(() => true),
}));
vi.mock('../services/bullmqUtils', () => ({ isReusableState: vi.fn(() => false) }));
vi.mock('../services/bullmqValidation', () => ({
  assertQueueJobName: vi.fn(),
  parseQueueJobData: vi.fn(),
}));
vi.mock('./queueSchemas', () => ({ automationQueueJobDataSchema: {} }));
vi.mock('./workerObservability', () => ({ attachWorkerObservability: vi.fn() }));

import { __testOnly, collectDueConfigPolicyScheduleDispatches } from './automationWorker';
import { db } from '../db';
import { configPolicyEffectiveFeatureLinks, configurationPolicies } from '../db/schema';
import { resolveAutomationsForDeviceWithPolicy } from '../services/featureConfigResolver';

const { processTriggerConfigPolicySchedule } = __testOnly;

const AUTOMATION = {
  id: 'cp-auto-1',
  name: 'Nightly reboot',
  cronExpression: '0 * * * *',
  timezone: 'UTC',
};

function candidate(policyId: string, targetId: string) {
  return {
    automation: AUTOMATION as any,
    assignmentLevel: 'organization',
    assignmentTargetId: targetId,
    policyId,
    policyName: policyId,
  } as any;
}

describe('collectDueConfigPolicyScheduleDispatches — grouping key', () => {
  const scanDate = new Date('2026-01-01T10:00:00Z');

  it('splits one inherited automation into one dispatch per ASSIGNED policy', () => {
    // A partner-wide baseline's automation, inherited by two children in two
    // orgs. Grouping on the automation id alone would collapse both orgs into a
    // single dispatch carrying one arbitrary policy.
    const dispatches = collectDueConfigPolicyScheduleDispatches(
      [candidate('child-a', 'org-a'), candidate('child-b', 'org-b')],
      scanDate,
    );

    expect(dispatches).toHaveLength(2);
    expect(dispatches.map((d) => d.policyId).sort()).toEqual(['child-a', 'child-b']);
    expect(dispatches.every((d) => d.configPolicyAutomationId === 'cp-auto-1')).toBe(true);
    // Each dispatch carries only its own policy's assignment targets.
    expect(dispatches.find((d) => d.policyId === 'child-a')!.assignmentTargets).toEqual([
      { level: 'organization', targetId: 'org-a' },
    ]);
    expect(dispatches.find((d) => d.policyId === 'child-b')!.assignmentTargets).toEqual([
      { level: 'organization', targetId: 'org-b' },
    ]);
  });

  it('still merges multiple assignment targets of the SAME policy into one dispatch', () => {
    const dispatches = collectDueConfigPolicyScheduleDispatches(
      [
        candidate('policy-1', 'org-1'),
        { ...candidate('policy-1', 'site-1'), assignmentLevel: 'site' } as any,
      ],
      scanDate,
    );

    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]!.assignmentTargets).toHaveLength(2);
  });
});

// --- processTriggerConfigPolicySchedule ---

function chain(result: unknown[], extra: Record<string, unknown> = {}) {
  // Thenable so a query that ends at `.where(...)` resolves too, not just the
  // `.limit(1)` shapes.
  const c: any = { ...extra, then: (resolve: (v: unknown) => void) => resolve(result) };
  for (const m of ['from', 'innerJoin', 'where']) c[m] = vi.fn(() => c);
  c.limit = vi.fn(() => Promise.resolve(result));
  return c;
}

const jobData = {
  type: 'trigger-config-policy-schedule',
  configPolicyAutomationId: 'cp-auto-1',
  configPolicyAutomationName: 'Nightly reboot',
  slotKey: '202601011000',
  policyId: 'child-a',
  policyName: 'Child A',
  configPolicyId: 'child-a',
  assignmentTargets: [{ level: 'organization', targetId: 'org-a' }],
  scanAt: '2026-01-01T10:00:00.000Z',
} as any;

function automationChain() {
  return chain([{ id: 'cp-auto-1', featureLinkId: 'fl-parent' }]);
}

describe('processTriggerConfigPolicySchedule — ownership clamp keys on the ASSIGNED policy', () => {
  beforeEach(() => {
    vi.mocked(db.select).mockReset();
    queueAdd.mockClear();
    queueGetJob.mockClear();
    vi.mocked(resolveAutomationsForDeviceWithPolicy).mockReset();
  });

  it('reads ownership from configuration_policies by the assigned id, never via the link', async () => {
    const ownerChain = chain([{ orgId: 'org-a', partnerId: null, status: 'active' }]);
    const effectiveChain = chain([{ id: 'fl-parent' }]);
    vi.mocked(db.select)
      .mockReturnValueOnce(automationChain())
      .mockReturnValueOnce(ownerChain)
      .mockReturnValueOnce(effectiveChain)
      .mockReturnValueOnce(chain([]) as any); // device resolution → none

    await processTriggerConfigPolicySchedule(jobData);

    // The ownership read starts at the policies table, with no join through a
    // feature-link table: a link id maps to many policies now.
    expect(ownerChain.from).toHaveBeenCalledWith(configurationPolicies);
    expect(ownerChain.innerJoin).not.toHaveBeenCalled();
    // Effectiveness is verified through the view, for THIS policy.
    expect(effectiveChain.from).toHaveBeenCalledWith(configPolicyEffectiveFeatureLinks);
  });

  it("skips when the assigned policy is gone (deny, not 'no constraint applies')", async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(automationChain())
      .mockReturnValueOnce(chain([]));

    expect(await processTriggerConfigPolicySchedule(jobData)).toEqual({
      skipped: 'config_policy_not_found',
    });
  });

  it('skips when the assigned policy is no longer active', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(automationChain())
      .mockReturnValueOnce(chain([{ orgId: 'org-a', partnerId: null, status: 'archived' }]));

    expect(await processTriggerConfigPolicySchedule(jobData)).toEqual({
      skipped: 'config_policy_not_found',
    });
  });

  it('skips when the automation is no longer effective for the assigned policy', async () => {
    // The child authored its own automation link, so the parent's is no longer
    // inherited by it. The queued dispatch must not run against this policy.
    vi.mocked(db.select)
      .mockReturnValueOnce(automationChain())
      .mockReturnValueOnce(chain([{ orgId: 'org-a', partnerId: null, status: 'active' }]))
      .mockReturnValueOnce(chain([]));

    expect(await processTriggerConfigPolicySchedule(jobData)).toEqual({
      skipped: 'automation_not_effective_for_policy',
    });
  });

  it('keeps only devices whose WINNING automation assignment is this dispatch policy', async () => {
    const deviceChain: any = {
      from: vi.fn(() => deviceChain),
      innerJoin: vi.fn(() => deviceChain),
      where: vi.fn(() => Promise.resolve([{ id: 'dev-1' }, { id: 'dev-2' }])),
    };
    vi.mocked(db.select)
      .mockReturnValueOnce(automationChain())
      .mockReturnValueOnce(chain([{ orgId: 'org-a', partnerId: null, status: 'active' }]))
      .mockReturnValueOnce(chain([{ id: 'fl-parent' }]))
      .mockReturnValueOnce(deviceChain);

    // dev-1 is governed by this policy; dev-2 is also covered by a closer
    // assignment of a different policy carrying the same inherited automation.
    vi.mocked(resolveAutomationsForDeviceWithPolicy).mockImplementation(async (deviceId: string) =>
      deviceId === 'dev-1'
        ? { configPolicyId: 'child-a', automations: [{ id: 'cp-auto-1' } as any] }
        : { configPolicyId: 'other-policy', automations: [{ id: 'cp-auto-1' } as any] },
    );

    const result = await processTriggerConfigPolicySchedule(jobData);

    expect(result).toEqual({ devicesQueued: 1 });
    const [, payload, opts] = queueAdd.mock.calls[0]!;
    expect((payload as any).targetDeviceIds).toEqual(['dev-1']);
    expect((payload as any).configPolicyId).toBe('child-a');
    expect(opts!.jobId).toBe('cp-automation-run:cp-auto-1:child-a:202601011000');
  });

  it('skips a device whose automation resolution comes back empty rather than assuming it wins', async () => {
    const deviceChain: any = {
      from: vi.fn(() => deviceChain),
      innerJoin: vi.fn(() => deviceChain),
      where: vi.fn(() => Promise.resolve([{ id: 'dev-1' }])),
    };
    vi.mocked(db.select)
      .mockReturnValueOnce(automationChain())
      .mockReturnValueOnce(chain([{ orgId: 'org-a', partnerId: null, status: 'active' }]))
      .mockReturnValueOnce(chain([{ id: 'fl-parent' }]))
      .mockReturnValueOnce(deviceChain);
    vi.mocked(resolveAutomationsForDeviceWithPolicy).mockResolvedValue(null);

    expect(await processTriggerConfigPolicySchedule(jobData)).toEqual({
      skipped: 'no_winning_devices',
    });
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it('falls back to the legacy policyId for a job enqueued before this deploy', async () => {
    const { configPolicyId: _dropped, ...legacyJob } = jobData;
    const ownerChain = chain([{ orgId: 'org-a', partnerId: null, status: 'active' }]);
    vi.mocked(db.select)
      .mockReturnValueOnce(automationChain())
      .mockReturnValueOnce(ownerChain)
      .mockReturnValueOnce(chain([{ id: 'fl-parent' }]))
      .mockReturnValueOnce(chain([]) as any);

    await processTriggerConfigPolicySchedule(legacyJob as any);
    expect(ownerChain.from).toHaveBeenCalledWith(configurationPolicies);
  });
});
