import { beforeEach, describe, expect, it, vi } from 'vitest';

// #6960 W02: a software policy GENERATED from a security_agents link must not
// report (or try to install) an agent a device cannot receive — its org is not
// mapped in the vendor integration, its platform is unsupported, and so on.
// Those (device, rule) pairs are NOT APPLICABLE: filtered out of the stored
// violations, never queued, and never charged an install attempt.

const {
  dbSelectMock,
  dbUpdateSetMock,
  resolveDeviceIdsMock,
  upsertMock,
  inventoryMock,
  scheduleInstallMock,
  applicabilityMock,
  repairMock,
  recordCoverageMock,
  pruneAllMock,
} = vi.hoisted(() => ({
  pruneAllMock: vi.fn(async (..._args: unknown[]) => ({ upserted: 0, pruned: 0 })),
  recordCoverageMock: vi.fn(async (..._args: unknown[]) => ({ upserted: 0, pruned: 0 })),
  repairMock: vi.fn(async () => ({ links: 0, changed: 0, failed: 0 })),
  dbSelectMock: vi.fn(),
  dbUpdateSetMock: vi.fn((_values: Record<string, unknown>) => ({ where: async () => undefined })),
  resolveDeviceIdsMock: vi.fn(async () => ['device-1']),
  upsertMock: vi.fn(async (_inputs: Array<Record<string, unknown>>) => undefined),
  inventoryMock: vi.fn(async () => new Map<string, unknown[]>()),
  scheduleInstallMock: vi.fn(async (..._args: unknown[]) => [] as string[]),
  applicabilityMock: vi.fn(),
}));

vi.mock('bullmq', () => ({
  Queue: class { add = vi.fn(); addBulk = vi.fn(); getRepeatableJobs = vi.fn(async () => []); },
  Worker: class { on = vi.fn(); close = vi.fn(); },
  Job: class {},
}));
vi.mock('../services/redis', () => ({ getBullMQConnection: vi.fn(() => ({})) }));
vi.mock('../db', () => ({
  db: { select: dbSelectMock, update: () => ({ set: dbUpdateSetMock }) },
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));
vi.mock('../services/featureConfigResolver', () => ({
  resolveDeviceIdsForSoftwarePolicy: resolveDeviceIdsMock,
}));
vi.mock('./softwareRemediationWorker', () => ({
  scheduleSoftwareRemediation: vi.fn(async () => 0),
  scheduleSoftwareInstallRemediation: scheduleInstallMock,
}));
vi.mock('../services/softwarePolicyInstallRemediation', () => ({
  readLatestPolicyOwnedInstallByDevice: vi.fn(async () => new Map()),
}));
vi.mock('../services/securityAgents/managedRuleApplicability', () => ({
  loadManagedRuleApplicability: applicabilityMock,
}));
vi.mock('../services/securityAgents/coverageStatusStore', () => ({
  recordManagedPolicyApplicability: recordCoverageMock,
  pruneAllForPolicy: pruneAllMock,
}));
vi.mock('../services/securityAgents/managedPolicyGenerator', () => ({
  repairManagedSoftwarePolicies: repairMock,
}));
vi.mock('../services/softwarePolicyService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/softwarePolicyService')>();
  return {
    ...actual,
    evaluateSoftwarePolicyArming: vi.fn(() => ({ armed: true })),
    upsertSoftwareComplianceStatuses: upsertMock,
    getSoftwareInventoryByDeviceIds: inventoryMock,
    recordSoftwarePolicyAudit: vi.fn(async () => undefined),
  };
});

import { processCheckPolicy, processScanPolicies } from './softwareComplianceWorker';

const POLICY_ID = 'policy-managed';
const HUNTRESS = 'catalog-huntress';
const OTHER = 'catalog-other';

const MANAGED_POLICY = {
  id: POLICY_ID,
  orgId: null,
  partnerId: 'partner-1',
  name: 'Security agents: Baseline',
  isActive: true,
  approvalGeneration: 4,
  mode: 'allowlist',
  enforceMode: true,
  remediationOptions: { autoInstall: true, autoUninstall: false },
  rules: {
    allowUnknown: true,
    software: [
      { name: 'Huntress Agent*', catalogId: HUNTRESS },
      { name: 'Other Agent*', catalogId: OTHER },
    ],
  },
  managedByLinkId: 'link-1',
};

function primeSelects(rows: unknown[][]) {
  for (const result of rows) {
    const terminal = () => Object.assign(Promise.resolve(result), { limit: () => Promise.resolve(result) });
    dbSelectMock.mockReturnValueOnce({ from: () => ({ where: terminal, limit: () => Promise.resolve(result) }) });
  }
}

/** Not applicable for every (device, catalogId) listed; applicable otherwise. */
const VENDOR_BY_CATALOG: Record<string, string> = { [HUNTRESS]: 'huntress', [OTHER]: 'sentinelone' };

function applicability(notReady: Record<string, Record<string, string>>) {
  return {
    vendors: () => [VENDOR_BY_CATALOG[HUNTRESS], VENDOR_BY_CATALOG[OTHER]],
    evaluateDevice: (deviceId: string) => [HUNTRESS, OTHER].map((catalogId) => {
      const reason = notReady[deviceId]?.[catalogId];
      return { catalogId, vendor: VENDOR_BY_CATALOG[catalogId], result: reason ? { ok: false, reason } : { ok: true } };
    }),
    filterViolations: (deviceId: string, violations: Array<{ type: string; rule?: { catalogId?: string } }>) => {
      const kept: typeof violations = [];
      const notApplicable: Array<{ catalogId: string; reason: string }> = [];
      for (const violation of violations) {
        const catalogId = violation.rule?.catalogId;
        const reason = violation.type === 'missing' && catalogId ? notReady[deviceId]?.[catalogId] : undefined;
        if (reason) notApplicable.push({ catalogId: catalogId!, reason });
        else kept.push(violation);
      }
      return { violations: kept, notApplicable };
    },
  };
}

function primePass(policy: Record<string, unknown>, deviceIds: string[], existing: Record<string, unknown>[] = []) {
  resolveDeviceIdsMock.mockResolvedValueOnce(deviceIds);
  primeSelects([
    [policy],
    deviceIds.map((id) => ({ id, orgId: `org-of-${id}`, osType: 'windows' })),
    existing,
  ]);
  inventoryMock.mockResolvedValueOnce(new Map(deviceIds.map((id) => [id, []])));
}

function upserted(): Array<Record<string, unknown>> {
  return upsertMock.mock.calls[0]![0] as Array<Record<string, unknown>>;
}

describe('processCheckPolicy — managed (security agents) policy applicability', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    scheduleInstallMock.mockResolvedValue([]);
  });

  it('loads applicability once per pass for the evaluated devices (device org + os)', async () => {
    applicabilityMock.mockResolvedValueOnce(applicability({}));
    primePass(MANAGED_POLICY, ['device-1', 'device-2']);
    await processCheckPolicy({ type: 'check-policy', policyId: POLICY_ID });
    expect(applicabilityMock).toHaveBeenCalledTimes(1);
    expect(applicabilityMock.mock.calls[0]![1]).toEqual([
      { deviceId: 'device-1', orgId: 'org-of-device-1', osType: 'windows' },
      { deviceId: 'device-2', orgId: 'org-of-device-2', osType: 'windows' },
    ]);
  });

  it('(a) a not-ready rule is filtered out: the device is compliant, nothing queued, attempts untouched', async () => {
    applicabilityMock.mockResolvedValueOnce(applicability({
      'device-1': { [HUNTRESS]: 'org_not_mapped', [OTHER]: 'org_not_mapped' },
    }));
    primePass(MANAGED_POLICY, ['device-1']);

    const result = await processCheckPolicy({ type: 'check-policy', policyId: POLICY_ID });

    expect(upserted()[0]).toMatchObject({ deviceId: 'device-1', status: 'compliant', violations: [] });
    expect(result.violations).toBe(0);
    expect(scheduleInstallMock).not.toHaveBeenCalled();
    expect(dbUpdateSetMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ notApplicable: 1, notApplicableByReason: { org_not_mapped: 2 } });
  });

  it('(b) two vendors, one not ready: only the ready one is queued, at attempt 1', async () => {
    applicabilityMock.mockResolvedValueOnce(applicability({ 'device-1': { [OTHER]: 'org_key_missing' } }));
    primePass(MANAGED_POLICY, ['device-1']);
    scheduleInstallMock.mockResolvedValueOnce(['device-1']);

    await processCheckPolicy({ type: 'check-policy', policyId: POLICY_ID });

    expect(scheduleInstallMock).toHaveBeenCalledWith(
      POLICY_ID,
      [{ deviceId: 'device-1', catalogIds: [HUNTRESS], attempt: 1 }],
      4,
    );
    const row = upserted()[0]!;
    expect((row.violations as Array<{ rule?: { catalogId?: string } }>).map((v) => v.rule?.catalogId)).toEqual([HUNTRESS]);
  });

  it('(b) the not-ready vendor never moves a gave_up/attempt state: an exhausted device with only not-ready rules settles', async () => {
    applicabilityMock.mockResolvedValueOnce(applicability({
      'device-1': { [HUNTRESS]: 'integration_inactive', [OTHER]: 'integration_inactive' },
    }));
    primePass(MANAGED_POLICY, ['device-1'], [{
      deviceId: 'device-1',
      status: 'violation',
      violations: [],
      installRemediationStatus: 'gave_up',
      installRemediationAttempts: 3,
    }]);

    await processCheckPolicy({ type: 'check-policy', policyId: POLICY_ID });

    expect(scheduleInstallMock).not.toHaveBeenCalled();
    expect(upserted()[0]).toMatchObject({ status: 'compliant', installRemediationAttempts: 0 });
  });

  it('(d) recovery: once the org is ready the same pass queues the install', async () => {
    applicabilityMock.mockResolvedValueOnce(applicability({}));
    primePass(MANAGED_POLICY, ['device-1']);
    scheduleInstallMock.mockResolvedValueOnce(['device-1']);

    await processCheckPolicy({ type: 'check-policy', policyId: POLICY_ID });

    expect(scheduleInstallMock).toHaveBeenCalledWith(
      POLICY_ID,
      [{ deviceId: 'device-1', catalogIds: [HUNTRESS, OTHER], attempt: 1 }],
      4,
    );
  });

  // #6960 W03: not-applicable reasons are durable, not log-only.
  it('persists per-(device, vendor) applicability under the DEVICE org, pruning on a full pass', async () => {
    applicabilityMock.mockResolvedValueOnce(applicability({ 'device-1': { [OTHER]: 'org_not_mapped' } }));
    primePass(MANAGED_POLICY, ['device-1', 'device-2']);

    await processCheckPolicy({ type: 'check-policy', policyId: POLICY_ID });

    expect(recordCoverageMock).toHaveBeenCalledTimes(1);
    expect(recordCoverageMock).toHaveBeenCalledWith({
      policyId: POLICY_ID,
      entries: [
        { deviceId: 'device-1', orgId: 'org-of-device-1', vendor: 'huntress', notApplicableReason: null },
        { deviceId: 'device-1', orgId: 'org-of-device-1', vendor: 'sentinelone', notApplicableReason: 'org_not_mapped' },
        { deviceId: 'device-2', orgId: 'org-of-device-2', vendor: 'huntress', notApplicableReason: null },
        { deviceId: 'device-2', orgId: 'org-of-device-2', vendor: 'sentinelone', notApplicableReason: null },
      ],
      prune: { deviceIds: ['device-1', 'device-2'], vendors: ['huntress', 'sentinelone'] },
    });
  });

  it('a device-filtered pass records its devices but never prunes the others', async () => {
    applicabilityMock.mockResolvedValueOnce(applicability({}));
    primePass(MANAGED_POLICY, ['device-1']);

    await processCheckPolicy({ type: 'check-policy', policyId: POLICY_ID, deviceIds: ['device-1'] });

    expect(recordCoverageMock.mock.calls[0]![0]).toMatchObject({ prune: null });
  });

  it('a full pass that reaches no device drops every coverage row the policy owned', async () => {
    resolveDeviceIdsMock.mockResolvedValueOnce([]);
    primeSelects([[MANAGED_POLICY]]);

    await processCheckPolicy({ type: 'check-policy', policyId: POLICY_ID });

    expect(pruneAllMock).toHaveBeenCalledWith(POLICY_ID);
    expect(recordCoverageMock).not.toHaveBeenCalled();
  });

  it('a coverage-store failure is reported but never fails the compliance pass', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    applicabilityMock.mockResolvedValueOnce(applicability({}));
    primePass(MANAGED_POLICY, ['device-1']);
    recordCoverageMock.mockRejectedValueOnce(new Error('db down'));

    await expect(processCheckPolicy({ type: 'check-policy', policyId: POLICY_ID })).resolves.toMatchObject({ devicesEvaluated: 1 });
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it('an ordinary (customer-authored) policy never consults applicability', async () => {
    primePass({ ...MANAGED_POLICY, managedByLinkId: null }, ['device-1']);
    scheduleInstallMock.mockResolvedValueOnce(['device-1']);

    await processCheckPolicy({ type: 'check-policy', policyId: POLICY_ID });

    expect(applicabilityMock).not.toHaveBeenCalled();
    expect(scheduleInstallMock).toHaveBeenCalled();
    expect(recordCoverageMock).not.toHaveBeenCalled();
  });
});

describe('processScanPolicies — generated-policy repair sweep', () => {
  beforeEach(() => vi.clearAllMocks());

  it('repairs generated policies BEFORE listing active policies, so a just-activated one is scanned', async () => {
    const order: string[] = [];
    repairMock.mockImplementationOnce(async () => { order.push('repair'); return { links: 1, changed: 1, failed: 0 }; });
    dbSelectMock.mockImplementationOnce(() => { order.push('list'); return { from: () => ({ where: async () => [] }) }; });
    await processScanPolicies();
    expect(order).toEqual(['repair', 'list']);
  });

  it('a failing sweep never blocks the compliance scan', async () => {
    repairMock.mockRejectedValueOnce(new Error('sweep down'));
    dbSelectMock.mockImplementationOnce(() => ({ from: () => ({ where: async () => [] }) }));
    await expect(processScanPolicies()).resolves.toEqual({ queued: 0 });
  });
});
