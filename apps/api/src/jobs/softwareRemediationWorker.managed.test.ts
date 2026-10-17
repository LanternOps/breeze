/**
 * #6960 W02 — install remediation of a software policy GENERATED from a
 * security_agents link re-checks, immediately before dispatch:
 *  - that the device still resolves to the policy's link (an assignment was
 *    removed, or a closer opt-out link now wins → cancel), and
 *  - installer readiness for the device (org mapped, keys present, platform)
 *    → a not-ready vendor creates NO deployment.
 * Removing one vendor while another stays enabled is covered by the
 * generator's approval_generation bump (the existing generation gate).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { recordPolicyAuditMock, resolveLinkMock, applicabilityMock } = vi.hoisted(() => ({
  recordPolicyAuditMock: vi.fn(async (..._args: any[]) => {}),
  resolveLinkMock: vi.fn(),
  applicabilityMock: vi.fn(),
}));

vi.mock('bullmq', () => ({
  Queue: class { add = vi.fn(); getJob = vi.fn(); close = vi.fn(); },
  Worker: class { on = vi.fn(); close = vi.fn(); },
  Job: class {},
}));
vi.mock('../services/redis', () => ({ getBullMQConnection: vi.fn(() => ({})) }));
vi.mock('../routes/metrics', () => ({ recordSoftwareRemediationDecision: vi.fn() }));
vi.mock('../services/commandQueue', () => ({ queueCommand: vi.fn(), CommandTypes: { SOFTWARE_UNINSTALL: 'software_uninstall' } }));
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../services/bullmqUtils', () => ({ isReusableState: vi.fn(() => false) }));
vi.mock('../services/softwarePolicyService', async (orig) => {
  const actual = await orig<typeof import('../services/softwarePolicyService')>();
  return {
    evaluateSoftwarePolicyArming: actual.evaluateSoftwarePolicyArming,
    SOFTWARE_POLICY_INSTALL_AUDIT_ACTIONS: actual.SOFTWARE_POLICY_INSTALL_AUDIT_ACTIONS,
    normalizeSoftwarePolicyRules: actual.normalizeSoftwarePolicyRules,
    recordSoftwarePolicyAudit: recordPolicyAuditMock,
  };
});
const { resolveTargetMock, createPolicyDeploymentMock } = vi.hoisted(() => ({
  resolveTargetMock: vi.fn(),
  createPolicyDeploymentMock: vi.fn(async () => ({ deploymentId: 'dep-1', status: 'pending' as const })),
}));
vi.mock('../services/softwarePolicyInstallRemediation', () => ({
  resolvePolicyInstallTarget: resolveTargetMock,
  hasUnfinishedPolicyOwnedInstall: vi.fn(async () => false),
  createPolicyOwnedInstallDeployment: createPolicyDeploymentMock,
}));
vi.mock('../services/featureConfigResolver', () => ({
  resolveSecurityAgentsLinkForDevice: resolveLinkMock,
}));
vi.mock('../services/securityAgents/managedRuleApplicability', () => ({
  loadManagedRuleApplicability: applicabilityMock,
}));

const { selectMock, updateMock } = vi.hoisted(() => ({ selectMock: vi.fn(), updateMock: vi.fn() }));
vi.mock('../db', () => ({
  db: { select: selectMock, update: updateMock, insert: vi.fn() },
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

import { processRemediateDeviceInstall } from './softwareRemediationWorker';

const POLICY_ID = 'pol-managed';
const DEVICE_ID = 'dev-1';
const ORG_ID = 'org-1';
const LINK_ID = 'link-1';
const CATALOG = 'cat-huntress';

function chain(result: unknown): any {
  const p: any = Promise.resolve(result);
  for (const m of ['from', 'innerJoin', 'where', 'limit', 'orderBy', 'returning', 'values', 'for']) p[m] = () => p;
  return p;
}

let setSpy: ReturnType<typeof vi.fn>;

const MANAGED_POLICY = {
  id: POLICY_ID,
  orgId: null,
  partnerId: 'partner-1',
  name: 'Security agents: Baseline',
  isActive: true,
  mode: 'allowlist',
  enforceMode: true,
  remediationOptions: { autoInstall: true, autoUninstall: false },
  approvalGeneration: 5,
  rules: { allowUnknown: true, software: [{ name: 'Huntress Agent*', catalogId: CATALOG }] },
  managedByLinkId: LINK_ID,
};

const COMPLIANCE = {
  id: 'cs-1',
  policyId: POLICY_ID,
  deviceId: DEVICE_ID,
  violations: [{ type: 'missing', rule: { name: 'Huntress Agent*', catalogId: CATALOG }, severity: 'high' }],
  installRemediationStatus: 'pending',
};

/** policy → device → compliance → organizations (partner-owned ownership check). */
function primeDb(policy: Record<string, unknown> = MANAGED_POLICY) {
  const results = [
    [policy],
    [{ orgId: ORG_ID, osType: 'windows', isEphemeral: false, parked: false }],
    [COMPLIANCE],
    [{ partnerId: 'partner-1' }],
  ];
  let call = 0;
  selectMock.mockImplementation(() => chain(results[Math.min(call++, results.length - 1)]));
  setSpy = vi.fn(() => chain([]));
  updateMock.mockImplementation(() => ({ set: setSpy }));
}

function job() {
  return { type: 'install-remediate-device' as const, policyId: POLICY_ID, deviceId: DEVICE_ID, catalogIds: [CATALOG], generation: 5, attempt: 1 };
}

function ready() {
  return { filterViolations: (_d: string, v: unknown[]) => ({ violations: v, notApplicable: [] }) };
}

function notReady(reason: string) {
  return {
    filterViolations: (_d: string, v: Array<{ rule?: { catalogId?: string } }>) => ({
      violations: [],
      notApplicable: v.map((x) => ({ catalogId: x.rule?.catalogId, vendor: 'huntress', reason })),
    }),
  };
}

function lastAudit(): Record<string, any> {
  return recordPolicyAuditMock.mock.calls.at(-1)![0];
}

describe('processRemediateDeviceInstall — managed (security agents) policy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveTargetMock.mockResolvedValue({ ok: true, target: { kind: 'version', catalogId: CATALOG, softwareVersionId: 'v-1' } });
    resolveLinkMock.mockResolvedValue({ linkId: LINK_ID, configPolicyId: 'cp-1', assignedPolicyId: 'cp-1', inlineSettings: { version: 1, agents: [] } });
    applicabilityMock.mockResolvedValue(ready());
  });

  it('dispatches when the device still resolves to the link and the vendor is ready', async () => {
    primeDb();
    const result = await processRemediateDeviceInstall(job());
    expect(resolveLinkMock).toHaveBeenCalledWith(DEVICE_ID);
    expect(result.deploymentsCreated).toBe(1);
  });

  it('(a) the device no longer resolves to any security_agents link (assignment removed): no deployment', async () => {
    primeDb();
    resolveLinkMock.mockResolvedValueOnce(null);
    const result = await processRemediateDeviceInstall(job());
    expect(createPolicyDeploymentMock).not.toHaveBeenCalled();
    expect(result.deploymentsCreated).toBe(0);
    expect(setSpy.mock.calls.at(-1)![0].installRemediationStatus).toBe('skipped');
    expect(lastAudit()).toMatchObject({ action: 'install_skipped', details: { reason: 'no_longer_targeted' } });
  });

  it('(b) a closer security_agents link (e.g. an opt-out) now wins: no deployment', async () => {
    primeDb();
    resolveLinkMock.mockResolvedValueOnce({ linkId: 'closer-link', configPolicyId: 'cp-2', assignedPolicyId: 'cp-2', inlineSettings: { version: 1, agents: [] } });
    const result = await processRemediateDeviceInstall(job());
    expect(createPolicyDeploymentMock).not.toHaveBeenCalled();
    expect(result.deploymentsCreated).toBe(0);
  });

  it('(c) a superseded job (vendor removed → generation bumped) is refused before re-resolving', async () => {
    primeDb({ ...MANAGED_POLICY, approvalGeneration: 6 });
    const result = await processRemediateDeviceInstall(job());
    expect(createPolicyDeploymentMock).not.toHaveBeenCalled();
    expect(result.deploymentsCreated).toBe(0);
  });

  it('second-line readiness: a vendor that is not ready for the device creates no deployment and says why', async () => {
    primeDb();
    applicabilityMock.mockResolvedValueOnce(notReady('org_key_missing'));
    const result = await processRemediateDeviceInstall(job());
    expect(createPolicyDeploymentMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ deploymentsCreated: 0, skipped: 1, errors: 0 });
    expect(lastAudit().details.skipped).toEqual([
      expect.objectContaining({ catalogId: CATALOG, reason: 'installer_not_ready', readiness: 'org_key_missing' }),
    ]);
    expect(setSpy.mock.calls.at(-1)![0].installRemediationStatus).toBe('skipped');
  });

  it('readiness is evaluated for the DEVICE (its org and os)', async () => {
    primeDb();
    await processRemediateDeviceInstall(job());
    expect(applicabilityMock.mock.calls[0]![1]).toEqual([{ deviceId: DEVICE_ID, orgId: ORG_ID, osType: 'windows' }]);
  });

  it('an ordinary policy is never re-resolved through the security_agents dimension', async () => {
    primeDb({ ...MANAGED_POLICY, orgId: ORG_ID, partnerId: null, managedByLinkId: null });
    const result = await processRemediateDeviceInstall(job());
    expect(resolveLinkMock).not.toHaveBeenCalled();
    expect(applicabilityMock).not.toHaveBeenCalled();
    expect(result.deploymentsCreated).toBe(1);
  });
});
