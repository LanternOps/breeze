/**
 * #3543 — defense-in-depth arming gate in the remediation worker.
 *
 * This worker is the last hop before `software_uninstall` commands reach real
 * machines. Before #3543 it uninstalled whatever it was handed: the gate
 * (`enforceMode` + non-audit mode + `remediationOptions.autoUninstall`) existed
 * only in the compliance evaluator that produces automatic jobs, so a stale,
 * replayed or hand-enqueued job could still uninstall software from a policy
 * that had since been disarmed (incident #3381: 259 devices mass-uninstalled).
 *
 * An explicit operator remediation (`trigger: 'manual'`, stamped server-side by
 * the MFA-gated route) is deliberately exempt — `enforceMode`/`autoUninstall`
 * authorise UNATTENDED remediation — but is loudly audited when the policy is
 * unarmed. Anything that is not exactly 'manual' is treated as automatic and
 * gated, so provenance fails closed.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { addMock, getJobMock, queueCommandMock, recordDecisionMock, recordPolicyAuditMock } = vi.hoisted(() => ({
  addMock: vi.fn(async (..._args: any[]) => ({ id: 'queued-job-1' })),
  getJobMock: vi.fn(async () => null),
  queueCommandMock: vi.fn(async (..._args: any[]) => ({ id: 'cmd-1' })),
  recordDecisionMock: vi.fn((..._args: any[]) => {}),
  recordPolicyAuditMock: vi.fn(async (..._args: any[]) => {}),
}));

vi.mock('bullmq', () => ({
  Queue: class { add = addMock; getJob = getJobMock; close = vi.fn(); },
  Worker: class { on = vi.fn(); close = vi.fn(); },
  Job: class {},
}));
vi.mock('../services/redis', () => ({ getBullMQConnection: vi.fn(() => ({})) }));
vi.mock('../routes/metrics', () => ({ recordSoftwareRemediationDecision: recordDecisionMock }));
vi.mock('../services/commandQueue', () => ({
  queueCommand: queueCommandMock,
  CommandTypes: { SOFTWARE_UNINSTALL: 'software_uninstall' },
}));
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../services/bullmqUtils', () => ({ isReusableState: vi.fn(() => false) }));
vi.mock('../services/softwarePolicyService', async (orig) => {
  // Keep the REAL arming evaluator — the whole point of the suite is that the
  // gate itself is correct, not that a stubbed gate was consulted. The audit
  // action constants are likewise the REAL ones (#5505 W01's D6 set), so a
  // renamed member fails here rather than silently asserting a stale literal.
  const actual = await orig<typeof import('../services/softwarePolicyService')>();
  return {
    evaluateSoftwarePolicyArming: actual.evaluateSoftwarePolicyArming,
    SOFTWARE_POLICY_INSTALL_AUDIT_ACTIONS: actual.SOFTWARE_POLICY_INSTALL_AUDIT_ACTIONS,
    recordSoftwarePolicyAudit: recordPolicyAuditMock,
  };
});

const { resolveTargetMock, hasUnfinishedMock, createPolicyDeploymentMock } = vi.hoisted(() => ({
  resolveTargetMock: vi.fn(),
  hasUnfinishedMock: vi.fn(async () => false),
  createPolicyDeploymentMock: vi.fn(async () => ({ deploymentId: 'dep-1', status: 'pending' as const })),
}));
vi.mock('../services/softwarePolicyInstallRemediation', () => ({
  resolvePolicyInstallTarget: resolveTargetMock,
  hasUnfinishedPolicyOwnedInstall: hasUnfinishedMock,
  createPolicyOwnedInstallDeployment: createPolicyDeploymentMock,
}));

const { selectMock, updateMock, insertMock } = vi.hoisted(() => ({
  selectMock: vi.fn(),
  updateMock: vi.fn(),
  insertMock: vi.fn(),
}));
vi.mock('../db', () => ({
  db: { select: selectMock, update: updateMock, insert: insertMock },
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

import { isReusableState } from '../services/bullmqUtils';
import {
  createSoftwareRemediationWorker,
  processRemediateDevice,
  processRemediateDeviceInstall,
  scheduleSoftwareInstallRemediation,
  scheduleSoftwareRemediation,
} from './softwareRemediationWorker';

const POLICY_ID = 'pol-1';
const DEVICE_ID = 'dev-1';
const ORG_ID = 'org-1';

function chain(result: unknown): any {
  const p: any = Promise.resolve(result);
  for (const m of ['from', 'innerJoin', 'where', 'limit', 'orderBy', 'returning', 'values', 'for']) p[m] = () => p;
  return p;
}

/** Captures the payload passed to `db.update(...).set(...)`. */
let setSpy: ReturnType<typeof vi.fn>;

function policyRow(overrides: Record<string, unknown> = {}) {
  return {
    id: POLICY_ID,
    orgId: ORG_ID,
    partnerId: null,
    name: 'Blocklist policy',
    isActive: true,
    mode: 'blocklist',
    enforceMode: false,
    remediationOptions: null,
    approvalGeneration: 7,
    ...overrides,
  };
}

const ARMED = { enforceMode: true, remediationOptions: { autoUninstall: true } };

const COMPLIANCE_ROW = {
  id: 'cs-1',
  policyId: POLICY_ID,
  deviceId: DEVICE_ID,
  lastRemediationAttempt: null,
  violations: [{ type: 'unauthorized', software: { name: 'Unwanted App', version: '1.0' } }],
  remediationStatus: 'pending',
};

/**
 * Drives db.select() through the worker's fixed call order:
 * policy → device → compliance → in-flight uninstall commands.
 */
function primeDb(policy: unknown, opts: { compliance?: unknown; consumeResult?: unknown[]; deviceOrgId?: string; partnerId?: string } = {}) {
  const results = [
    [policy],
    [{ orgId: opts.deviceOrgId ?? ORG_ID, isEphemeral: false }],
    [opts.compliance ?? COMPLIANCE_ROW],
    ...(opts.partnerId !== undefined ? [[{ partnerId: opts.partnerId }]] : []),
    [], // readInFlightUninstallKeys
  ];
  let call = 0;
  selectMock.mockImplementation(() => chain(results[Math.min(call++, results.length - 1)]));
  // #3553: db.update() serves BOTH the manual-authorization consume
  // (.set().where().returning() -> consumeResult) and the compliance-status
  // writes (.set().where(), return ignored). An org-scoped policy (the default
  // policyRow) needs no organizations SELECT in the consume path.
  setSpy = vi.fn(() => chain(opts.consumeResult ?? []));
  updateMock.mockImplementation(() => ({ set: setSpy }));
  insertMock.mockImplementation(() => chain([{ id: 'req-1', deviceId: DEVICE_ID }]));
}

function policyAuditActions(): string[] {
  return recordPolicyAuditMock.mock.calls.map((c: any[]) => c[0].action);
}

beforeEach(() => vi.clearAllMocks());

describe('processRemediateDevice — arming gate for automatic jobs (#3543)', () => {
  it('skips an unarmed (detect-only) policy and queues NO uninstall command', async () => {
    primeDb(policyRow({ enforceMode: false }));

    const result = await processRemediateDevice({ type: 'remediate-device', policyId: POLICY_ID, deviceId: DEVICE_ID, trigger: 'auto' });

    expect(result.commandsQueued).toBe(0);
    expect(queueCommandMock).not.toHaveBeenCalled();
    expect(recordDecisionMock).toHaveBeenCalledWith('policy_not_armed');
    expect(policyAuditActions()).toContain('remediation_skipped_unarmed');
    const audit = recordPolicyAuditMock.mock.calls[0]![0] as any;
    expect(audit).toMatchObject({ orgId: ORG_ID, policyId: POLICY_ID, deviceId: DEVICE_ID, actor: 'system' });
    expect(audit.details).toMatchObject({ reason: 'enforce_mode_off', trigger: 'auto' });

    // The refusal must be reflected on the compliance row: leaving it at the
    // enqueue-time 'pending' would later be rewritten to 'completed' by the
    // compliance worker, falsely claiming the uninstall succeeded.
    expect(updateMock).toHaveBeenCalledTimes(1);
    const written = setSpy.mock.calls[0]![0];
    expect(written.remediationStatus).toBe('failed');
    expect(written.remediationErrors[0].message).toMatch(/not armed/i);
    expect(written.remediationErrors[0].message).toContain('enforce_mode_off');
    // Crucially it must NOT be left pending, and must not be flipped to in_progress.
    expect(written.remediationStatus).not.toBe('pending');
    expect(written.remediationStatus).not.toBe('in_progress');
  });

  it('skips when enforceMode is on but autoUninstall is not armed', async () => {
    primeDb(policyRow({ enforceMode: true, remediationOptions: { autoUninstall: false } }));

    const result = await processRemediateDevice({ type: 'remediate-device', policyId: POLICY_ID, deviceId: DEVICE_ID, trigger: 'auto' });

    expect(result.commandsQueued).toBe(0);
    expect(queueCommandMock).not.toHaveBeenCalled();
    expect((recordPolicyAuditMock.mock.calls[0]![0] as any).details.reason).toBe('auto_uninstall_off');
  });

  it('skips an audit-mode policy even when otherwise armed', async () => {
    primeDb(policyRow({ mode: 'audit', ...ARMED }));

    await processRemediateDevice({ type: 'remediate-device', policyId: POLICY_ID, deviceId: DEVICE_ID, trigger: 'auto' });

    expect(queueCommandMock).not.toHaveBeenCalled();
    expect((recordPolicyAuditMock.mock.calls[0]![0] as any).details.reason).toBe('audit_mode');
  });

  it('treats a job with NO trigger field (enqueued before #3543) as automatic and gates it', async () => {
    primeDb(policyRow({ enforceMode: false }));

    await processRemediateDevice({ type: 'remediate-device', policyId: POLICY_ID, deviceId: DEVICE_ID });

    expect(queueCommandMock).not.toHaveBeenCalled();
    expect(recordDecisionMock).toHaveBeenCalledWith('policy_not_armed');
  });

  it('does not accept a forged/unknown trigger value as a manual override', async () => {
    for (const forged of ['Manual', 'MANUAL', 'manual ', 'user', true, 1, null]) {
      vi.clearAllMocks();
      primeDb(policyRow({ enforceMode: false }));

      await processRemediateDevice({
        type: 'remediate-device', policyId: POLICY_ID, deviceId: DEVICE_ID, trigger: forged as any,
      });

      expect(queueCommandMock, `trigger ${String(forged)} must not bypass the gate`).not.toHaveBeenCalled();
    }
  });

  it('proceeds normally for an armed policy (no regression)', async () => {
    primeDb(policyRow(ARMED));

    const result = await processRemediateDevice({ type: 'remediate-device', policyId: POLICY_ID, deviceId: DEVICE_ID, trigger: 'auto' });

    expect(result.commandsQueued).toBe(1);
    expect(queueCommandMock).toHaveBeenCalledTimes(1);
    expect(queueCommandMock).toHaveBeenCalledWith(
      DEVICE_ID,
      'software_uninstall',
      expect.objectContaining({ name: 'Unwanted App', policyId: POLICY_ID, source: 'software_policy' }),
      undefined, { submittedOrgId: ORG_ID },
    );
    expect(policyAuditActions()).toContain('remediation_queued');
    expect(policyAuditActions()).not.toContain('remediation_skipped_unarmed');
  });
});

describe('processRemediateDevice — current device ownership (#5567)', () => {
  it.each(['auto', 'manual'] as const)('refuses a moved device for a %s job even when the old policy is armed', async (trigger) => {
    primeDb(policyRow(ARMED), { deviceOrgId: 'org-new' });

    const result = await processRemediateDevice({
      type: 'remediate-device', policyId: POLICY_ID, deviceId: DEVICE_ID, trigger,
    });

    expect(queueCommandMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ commandsQueued: 0, errors: 1 });
    expect(setSpy).toHaveBeenCalledWith({
      remediationStatus: 'failed',
      remediationErrors: [{ message: 'device_org_changed' }],
    });
    expect(recordPolicyAuditMock).toHaveBeenCalledWith(expect.objectContaining({
      orgId: ORG_ID,
      action: 'remediation_failed',
      details: expect.objectContaining({ reason: 'device_org_changed' }),
    }));
  });

  it('preserves automatic remediation for a device still owned by a partner-wide policy', async () => {
    primeDb(policyRow({ ...ARMED, orgId: null, partnerId: 'partner-1' }), { partnerId: 'partner-1' });

    const result = await processRemediateDevice({
      type: 'remediate-device', policyId: POLICY_ID, deviceId: DEVICE_ID, trigger: 'auto',
    });

    expect(result.commandsQueued).toBe(1);
    expect(queueCommandMock).toHaveBeenCalledWith(
      DEVICE_ID, 'software_uninstall', expect.any(Object), undefined, { submittedOrgId: ORG_ID },
    );
  });

  it('refuses a device moved outside the partner-wide policy owner', async () => {
    primeDb(policyRow({ ...ARMED, orgId: null, partnerId: 'partner-1' }), { partnerId: 'partner-new' });

    await processRemediateDevice({
      type: 'remediate-device', policyId: POLICY_ID, deviceId: DEVICE_ID, trigger: 'auto',
    });

    expect(queueCommandMock).not.toHaveBeenCalled();
    expect(setSpy).toHaveBeenCalledWith(expect.objectContaining({
      remediationStatus: 'failed', remediationErrors: [{ message: 'device_org_changed' }],
    }));
  });
});

describe('processRemediateDevice — explicit manual remediation (#3543, verified #3553)', () => {
  // The consume returns the TRUSTED requester from the row (#3553); the audit
  // actor comes from here, not job data.
  const AUTHORIZED = { consumeResult: [{ requestedByUserId: 'admin-9' }] };

  it('overrides an unarmed (enforce-off) policy when the manual claim has a valid authorization record, auditing the TRUSTED requester (not job data)', async () => {
    // Record says admin-9; job data claims a forged requester. The audit must use
    // the record's value (#3553 finding 3).
    primeDb(policyRow({ enforceMode: false }), { consumeResult: [{ requestedByUserId: 'admin-9' }] });

    const result = await processRemediateDevice({
      type: 'remediate-device', policyId: POLICY_ID, deviceId: DEVICE_ID,
      trigger: 'manual', requestedByUserId: 'forged-attacker', manualRequestId: 'req-1',
    });

    expect(result.commandsQueued).toBe(1);
    expect(queueCommandMock).toHaveBeenCalledTimes(1);
    expect(recordDecisionMock).toHaveBeenCalledWith('manual_override');

    const override = recordPolicyAuditMock.mock.calls
      .map((c: any[]) => c[0])
      .find((a: any) => a.action === 'remediation_manual_override');
    expect(override).toBeDefined();
    // Trusted requester from the row, NOT the forged job-data field.
    expect(override).toMatchObject({ actor: 'user', actorId: 'admin-9', policyId: POLICY_ID, deviceId: DEVICE_ID });
    expect(override.details).toMatchObject({ reason: 'enforce_mode_off' });
  });

  // #3553 finding 2: a verified manual action bypasses the auto-cooldown — a
  // deliberate override must not be silently deferred (and its single-use token
  // must not be burned by a cooldown skip).
  it('bypasses the cooldown for a verified manual override', async () => {
    primeDb(policyRow({ enforceMode: false }), {
      compliance: { ...COMPLIANCE_ROW, lastRemediationAttempt: new Date() }, // within cooldown
      consumeResult: [{ requestedByUserId: 'admin-9' }],
    });

    const result = await processRemediateDevice({
      type: 'remediate-device', policyId: POLICY_ID, deviceId: DEVICE_ID,
      trigger: 'manual', requestedByUserId: 'admin-9', manualRequestId: 'req-1',
    });

    expect(result.commandsQueued).toBe(1);
    expect(recordDecisionMock).not.toHaveBeenCalledWith('cooldown');
  });

  it('does not record a manual_override when the policy is armed anyway', async () => {
    primeDb(policyRow(ARMED), AUTHORIZED);

    await processRemediateDevice({
      type: 'remediate-device', policyId: POLICY_ID, deviceId: DEVICE_ID,
      trigger: 'manual', requestedByUserId: 'admin-9', manualRequestId: 'req-1',
    });

    expect(policyAuditActions()).not.toContain('remediation_manual_override');
    expect(recordDecisionMock).not.toHaveBeenCalledWith('manual_override');
  });

  // #3553: a forged `trigger:'manual'` (no authorization record) must NOT skip
  // the arming gate — it is downgraded to `auto` and refused on an unarmed policy.
  it('downgrades an UNVERIFIED manual claim (no authorization record) to auto and refuses on an unarmed policy', async () => {
    primeDb(policyRow({ enforceMode: false }));

    const result = await processRemediateDevice({
      type: 'remediate-device', policyId: POLICY_ID, deviceId: DEVICE_ID,
      trigger: 'manual', requestedByUserId: 'attacker', /* no manualRequestId */
    });

    expect(result.commandsQueued).toBe(0);
    expect(queueCommandMock).not.toHaveBeenCalled();
    expect(recordDecisionMock).not.toHaveBeenCalledWith('manual_override');
    expect(recordDecisionMock).toHaveBeenCalledWith('policy_not_armed');
  });

  // #3553: a record that fails to consume (already used / expired / foreign /
  // device moved out of policy scope) is not authorization either.
  it('downgrades a manual claim whose record does not consume to auto (refused on an unarmed policy)', async () => {
    primeDb(policyRow({ enforceMode: false }), { consumeResult: [] });

    const result = await processRemediateDevice({
      type: 'remediate-device', policyId: POLICY_ID, deviceId: DEVICE_ID,
      // Well-formed but nonexistent UUID (real Postgres would 22P02 on a
      // malformed one); the consume returns no row -> downgrade to auto.
      trigger: 'manual', requestedByUserId: 'admin-9', manualRequestId: '00000000-0000-4000-8000-000000000000',
    });

    expect(result.commandsQueued).toBe(0);
    expect(recordDecisionMock).not.toHaveBeenCalledWith('manual_override');
    expect(recordDecisionMock).toHaveBeenCalledWith('policy_not_armed');
  });

  // #3553: manual NEVER overrides audit_mode, even with a valid record — a policy
  // flipped to audit mode after authorization must not be bypassed.
  it('never overrides audit_mode, even with a valid authorization record', async () => {
    primeDb(policyRow({ mode: 'audit' }), AUTHORIZED);

    const result = await processRemediateDevice({
      type: 'remediate-device', policyId: POLICY_ID, deviceId: DEVICE_ID,
      trigger: 'manual', requestedByUserId: 'admin-9', manualRequestId: 'req-1',
    });

    expect(result.commandsQueued).toBe(0);
    expect(queueCommandMock).not.toHaveBeenCalled();
    expect(recordDecisionMock).not.toHaveBeenCalledWith('manual_override');
  });
});

describe('scheduleSoftwareRemediation — trigger propagation (#3543)', () => {
  it('defaults to the gated automatic trigger when the caller passes no options', async () => {
    await scheduleSoftwareRemediation(POLICY_ID, [DEVICE_ID]);

    expect(addMock).toHaveBeenCalledTimes(1);
    expect(addMock.mock.calls[0]![1]).toMatchObject({ trigger: 'auto', requestedByUserId: null });
  });

  it('propagates an explicit manual trigger + its authorization id, keyed on a manual-specific job id', async () => {
    // createManualRemediationAuthorizations: policy tenancy -> devices -> insert.
    const selectResults = [
      [{ orgId: ORG_ID, partnerId: null }],
      [{ id: DEVICE_ID, orgId: ORG_ID }],
    ];
    let call = 0;
    selectMock.mockImplementation(() => chain(selectResults[Math.min(call++, selectResults.length - 1)]));
    insertMock.mockImplementation(() => chain([{ id: 'req-77', deviceId: DEVICE_ID }]));

    await scheduleSoftwareRemediation(POLICY_ID, [DEVICE_ID], { trigger: 'manual', requestedByUserId: 'admin-9' });

    expect(addMock.mock.calls[0]![1]).toMatchObject({
      trigger: 'manual',
      requestedByUserId: 'admin-9',
      manualRequestId: 'req-77',
    });
    // Manual jobs key on the authorization id, not (policy, device) — no auto dedup.
    expect(addMock.mock.calls[0]![2]).toMatchObject({ jobId: 'software-remediation-manual-req-77' });
  });

  it('never stamps a requester onto an automatic job', async () => {
    await scheduleSoftwareRemediation(POLICY_ID, [DEVICE_ID], { trigger: 'auto', requestedByUserId: 'admin-9' });

    expect(addMock.mock.calls[0]![1]).toMatchObject({ trigger: 'auto', requestedByUserId: null });
  });
});

describe('scheduleSoftwareInstallRemediation (feature #5505 W02)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getJobMock.mockResolvedValue(null);
    vi.mocked(isReusableState).mockReturnValue(false);
  });

  it('enqueues one job per target with the full payload and returns the enqueued deviceIds', async () => {
    const enqueued = await scheduleSoftwareInstallRemediation(
      'policy-1',
      [
        { deviceId: 'device-1', catalogIds: ['catalog-abc'], attempt: 1 },
        { deviceId: 'device-2', catalogIds: ['catalog-abc', 'catalog-def'], attempt: 2 },
      ],
      7,
    );

    expect(enqueued).toEqual(['device-1', 'device-2']);
    expect(addMock).toHaveBeenCalledTimes(2);
    expect(addMock.mock.calls[1]![0]).toBe('install-remediate-device');
    expect(addMock.mock.calls[1]![1]).toEqual({
      type: 'install-remediate-device',
      policyId: 'policy-1',
      deviceId: 'device-2',
      catalogIds: ['catalog-abc', 'catalog-def'],
      generation: 7,
      attempt: 2,
    });
  });

  /**
   * The reason this is a sibling type and not a widened RemediateDeviceJobData:
   * a device may legitimately be queued for BOTH verbs in one compliance pass
   * (spec §2), and a shared jobId would make one silently dedupe into the other.
   */
  it('uses a jobId namespace disjoint from the uninstall path', async () => {
    await scheduleSoftwareInstallRemediation(
      'policy-1',
      [{ deviceId: 'device-1', catalogIds: ['catalog-abc'], attempt: 1 }],
      1,
    );

    const installJobId = (addMock.mock.calls[0]![2] as { jobId: string }).jobId;
    expect(installJobId).toBe('software-install-remediation-policy-1-device-1');
    expect(installJobId).not.toBe('software-remediation-policy-1-device-1');
  });

  it('dedupes against a reusable in-flight job instead of enqueuing a second', async () => {
    getJobMock.mockResolvedValue({ getState: async () => 'waiting', remove: vi.fn() } as never);
    vi.mocked(isReusableState).mockReturnValue(true);

    const enqueued = await scheduleSoftwareInstallRemediation(
      'policy-1',
      [{ deviceId: 'device-1', catalogIds: ['catalog-abc'], attempt: 1 }],
      1,
    );

    expect(enqueued).toEqual([]);
    expect(addMock).not.toHaveBeenCalled();
  });

  it('refuses a target with no usable catalogIds rather than shipping an empty payload', async () => {
    const enqueued = await scheduleSoftwareInstallRemediation(
      'policy-1',
      [
        { deviceId: 'device-1', catalogIds: [], attempt: 1 },
        { deviceId: 'device-2', catalogIds: ['  '], attempt: 1 },
        { deviceId: '', catalogIds: ['catalog-abc'], attempt: 1 },
      ],
      1,
    );

    expect(enqueued).toEqual([]);
    expect(addMock).not.toHaveBeenCalled();
  });

  it('deduplicates repeated deviceIds and repeated catalogIds', async () => {
    const enqueued = await scheduleSoftwareInstallRemediation(
      'policy-1',
      [
        { deviceId: 'device-1', catalogIds: ['catalog-abc', 'catalog-abc'], attempt: 1 },
        { deviceId: 'device-1', catalogIds: ['catalog-def'], attempt: 1 },
      ],
      1,
    );

    expect(enqueued).toEqual(['device-1']);
    expect(addMock).toHaveBeenCalledTimes(1);
    expect((addMock.mock.calls[0]![1] as { catalogIds: string[] }).catalogIds).toEqual(['catalog-abc']);
  });
});

/**
 * #5505 W03 — processRemediateDeviceInstall.
 *
 * W02 (#5917) landed a RICHER payload than W03's plan anticipated:
 * `{ policyId, deviceId, catalogIds, generation, attempt }` rather than
 * `{ policyId, deviceId }`. The catalogIds are already derived from the
 * device's `missing` violations and deduped by the producer, and `generation`
 * carries an explicit W03 obligation ("W03 re-reads the policy and skips a job
 * whose premise was edited away").
 *
 * The processor therefore does NOT simply trust `data.catalogIds`. BullMQ
 * payloads live in Redis and carry no authentication of their own (the same
 * reasoning as `readTrigger`), so a forged or replayed job could name an
 * in-tenant catalog item the policy never asked for. The processor intersects
 * the payload with the catalogIds the compliance row says are STILL missing —
 * which simultaneously closes that gap and makes a stale job install only what
 * the policy currently still wants.
 */
describe('processRemediateDeviceInstall — #5505 W03', () => {
  const INSTALL_ARMED = {
    enforceMode: true,
    remediationOptions: { autoUninstall: false, autoInstall: true },
  };

  const MISSING_COMPLIANCE = {
    id: 'cs-1',
    policyId: POLICY_ID,
    deviceId: DEVICE_ID,
    lastInstallRemediationAttempt: null,
    violations: [{ type: 'missing', rule: { name: 'Chrome', catalogId: 'cat-1' }, severity: 'high' }],
    installRemediationStatus: 'pending',
  };

  function installJob(overrides: Record<string, unknown> = {}) {
    return {
      type: 'install-remediate-device' as const,
      policyId: POLICY_ID,
      deviceId: DEVICE_ID,
      catalogIds: ['cat-1'],
      generation: 7,
      attempt: 1,
      ...overrides,
    };
  }

  /** db.select() order for the install processor: policy -> device -> compliance. */
  function primeInstallDb(
    policy: unknown,
    compliance: unknown = MISSING_COMPLIANCE,
    opts: { deviceOrgId?: string; organization?: { partnerId: string } | null } = {},
  ) {
    const results = [
      policy === null ? [] : [policy],
      [{ orgId: opts.deviceOrgId ?? ORG_ID, osType: 'windows', isEphemeral: false }],
      [compliance],
      ...(opts.organization !== undefined ? [opts.organization ? [opts.organization] : []] : []),
    ];
    let call = 0;
    selectMock.mockImplementation(() => chain(results[Math.min(call++, results.length - 1)]));
    setSpy = vi.fn(() => chain([]));
    updateMock.mockImplementation(() => ({ set: setSpy }));
  }

  beforeEach(() => {
    hasUnfinishedMock.mockResolvedValue(false);
    resolveTargetMock.mockResolvedValue({
      ok: true,
      target: { kind: 'install_method', catalogId: 'cat-1', installMethodId: 'im-1' },
    });
    createPolicyDeploymentMock.mockResolvedValue({ deploymentId: 'dep-1', status: 'pending' });
  });

  it('creates a policy-owned deployment for an armed policy and a missing violation', async () => {
    primeInstallDb(policyRow({ mode: 'allowlist', ...INSTALL_ARMED }));

    const result = await processRemediateDeviceInstall(installJob());

    expect(result.deploymentsCreated).toBe(1);
    expect(createPolicyDeploymentMock).toHaveBeenCalledWith(
      expect.objectContaining({ policyId: POLICY_ID, deviceId: DEVICE_ID, orgId: ORG_ID })
    );
    expect(policyAuditActions()).toContain('install_queued');
    expect(setSpy.mock.calls.at(-1)![0].installRemediationStatus).toBe('pending');
  });

  it.each([
    ['organization-owned', { orgId: ORG_ID, partnerId: null }, undefined],
    ['partner-owned', { orgId: null, partnerId: 'partner-1' }, { partnerId: 'partner-2' }],
    ['partner-owned with missing organization', { orgId: null, partnerId: 'partner-1' }, null],
  ])('refuses a moved device for a %s install policy before dispatch', async (_name, owner, organization) => {
    primeInstallDb(policyRow({ mode: 'allowlist', ...INSTALL_ARMED, ...owner }), MISSING_COMPLIANCE, {
      deviceOrgId: 'org-moved', organization,
    });

    const result = await processRemediateDeviceInstall(installJob());

    expect(result).toMatchObject({ deploymentsCreated: 0, errors: 1 });
    expect(createPolicyDeploymentMock).not.toHaveBeenCalled();
    expect(queueCommandMock).not.toHaveBeenCalled();
    expect(resolveTargetMock).not.toHaveBeenCalled();
    expect(setSpy).toHaveBeenCalledWith({ installRemediationStatus: 'failed' });
    expect(recordDecisionMock).toHaveBeenCalledWith('device_org_changed');
    expect(recordPolicyAuditMock).toHaveBeenCalledWith(expect.objectContaining({
      ...owner,
      policyId: POLICY_ID,
      deviceId: DEVICE_ID,
      action: 'install_failed',
      details: expect.objectContaining({ reason: 'device_org_changed' }),
    }));
  });

  it('allows a moved device still owned by the partner-wide install policy', async () => {
    primeInstallDb(
      policyRow({ mode: 'allowlist', ...INSTALL_ARMED, orgId: null, partnerId: 'partner-1' }),
      MISSING_COMPLIANCE,
      { deviceOrgId: 'org-moved', organization: { partnerId: 'partner-1' } },
    );

    const result = await processRemediateDeviceInstall(installJob());

    expect(result).toMatchObject({ deploymentsCreated: 1, errors: 0 });
    expect(createPolicyDeploymentMock).toHaveBeenCalledWith(expect.objectContaining({ orgId: 'org-moved' }));
  });

  it('refuses a policy that is armed for uninstall but NOT for install', async () => {
    primeInstallDb(
      policyRow({ mode: 'allowlist', enforceMode: true, remediationOptions: { autoUninstall: true } })
    );

    const result = await processRemediateDeviceInstall(installJob());

    expect(result.deploymentsCreated).toBe(0);
    expect(createPolicyDeploymentMock).not.toHaveBeenCalled();
    expect(policyAuditActions()).toContain('remediation_skipped_unarmed');
    // The refusal must land on the INSTALL column, never on the uninstall one —
    // a shared column would make a refused install look like a refused uninstall.
    const written = setSpy.mock.calls[0]![0];
    expect(written.installRemediationStatus).toBe('failed');
    expect(written.remediationStatus).toBeUndefined();
  });

  it('skips a job whose generation no longer matches the policy — the superseded-premise gate', async () => {
    primeInstallDb(policyRow({ mode: 'allowlist', approvalGeneration: 9, ...INSTALL_ARMED }));

    const result = await processRemediateDeviceInstall(installJob({ generation: 7 }));

    expect(result.deploymentsCreated).toBe(0);
    expect(createPolicyDeploymentMock).not.toHaveBeenCalled();
    expect(recordDecisionMock).toHaveBeenCalledWith('install_generation_mismatch');
  });

  it('records skipped, not failed, for a rule with no catalogId', async () => {
    resolveTargetMock.mockResolvedValue({ ok: false, reason: 'no_catalog_id' });
    primeInstallDb(policyRow({ mode: 'allowlist', ...INSTALL_ARMED }));

    const result = await processRemediateDeviceInstall(installJob());

    expect(result.deploymentsCreated).toBe(0);
    expect(result.skipped).toBe(1);
    const written = setSpy.mock.calls.at(-1)![0];
    expect(written.installRemediationStatus).toBe('skipped');
    // "Never fail silently": the reason has to be greppable in the audit trail.
    const audit = recordPolicyAuditMock.mock.calls.at(-1)![0] as any;
    expect(JSON.stringify(audit.details)).toContain('no_catalog_id');
  });

  it('skips a platform mismatch instead of creating a guaranteed-failing deployment', async () => {
    resolveTargetMock.mockResolvedValue({ ok: false, reason: 'no_install_target_for_platform' });
    primeInstallDb(policyRow({ mode: 'allowlist', ...INSTALL_ARMED }));

    const result = await processRemediateDeviceInstall(installJob());

    expect(createPolicyDeploymentMock).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
    expect(setSpy.mock.calls.at(-1)![0].installRemediationStatus).toBe('skipped');
  });

  it('does not queue a second deployment while one is unfinished', async () => {
    hasUnfinishedMock.mockResolvedValue(true);
    primeInstallDb(policyRow({ mode: 'allowlist', ...INSTALL_ARMED }));

    const result = await processRemediateDeviceInstall(installJob());

    expect(result.deploymentsCreated).toBe(0);
    expect(createPolicyDeploymentMock).not.toHaveBeenCalled();
    expect(recordDecisionMock).toHaveBeenCalledWith('command_deduped');
  });

  it('never installs onto an ephemeral Quick Support device', async () => {
    const results = [
      [policyRow({ mode: 'allowlist', ...INSTALL_ARMED })],
      [{ orgId: ORG_ID, osType: 'windows', isEphemeral: true }],
    ];
    let call = 0;
    selectMock.mockImplementation(() => chain(results[Math.min(call++, results.length - 1)]));

    const result = await processRemediateDeviceInstall(installJob());

    expect(result.deploymentsCreated).toBe(0);
    expect(createPolicyDeploymentMock).not.toHaveBeenCalled();
  });

  it('deduplicates two rules that name the same catalogId into one deployment', async () => {
    primeInstallDb(policyRow({ mode: 'allowlist', ...INSTALL_ARMED }), {
      ...MISSING_COMPLIANCE,
      violations: [
        { type: 'missing', rule: { name: 'Chrome', catalogId: 'cat-1' }, severity: 'high' },
        { type: 'missing', rule: { name: 'Chrome (alias)', catalogId: 'cat-1' }, severity: 'high' },
      ],
    });

    const result = await processRemediateDeviceInstall(installJob({ catalogIds: ['cat-1', 'cat-1'] }));

    expect(result.deploymentsCreated).toBe(1);
    expect(createPolicyDeploymentMock).toHaveBeenCalledTimes(1);
  });

  it('ignores unauthorized violations entirely — the install verb never uninstalls', async () => {
    primeInstallDb(policyRow({ mode: 'allowlist', ...INSTALL_ARMED }), {
      ...MISSING_COMPLIANCE,
      violations: [{ type: 'unauthorized', software: { name: 'Unwanted App', version: '1.0' } }],
    });

    const result = await processRemediateDeviceInstall(installJob());

    expect(result.deploymentsCreated).toBe(0);
    expect(queueCommandMock).not.toHaveBeenCalled();
    expect(createPolicyDeploymentMock).not.toHaveBeenCalled();
  });

  it('installs ONLY the intersection of the payload and the still-missing catalogIds', async () => {
    // A replayed or forged job naming an in-tenant catalog item the policy
    // never asked for must install nothing for that item. The tenancy guard in
    // resolvePolicyInstallTarget cannot see this: cat-99 may be perfectly
    // reachable from the device's own org.
    primeInstallDb(policyRow({ mode: 'allowlist', ...INSTALL_ARMED }));

    const result = await processRemediateDeviceInstall(
      installJob({ catalogIds: ['cat-1', 'cat-99'] })
    );

    expect(result.deploymentsCreated).toBe(1);
    expect(resolveTargetMock).toHaveBeenCalledTimes(1);
    expect(resolveTargetMock).toHaveBeenCalledWith(expect.objectContaining({ catalogId: 'cat-1' }));
  });

  it('skips when the compliance row no longer reports any of the payload catalogIds missing', async () => {
    primeInstallDb(policyRow({ mode: 'allowlist', ...INSTALL_ARMED }), {
      ...MISSING_COMPLIANCE,
      violations: [{ type: 'missing', rule: { name: 'Firefox', catalogId: 'cat-other' }, severity: 'high' }],
    });

    const result = await processRemediateDeviceInstall(installJob());

    expect(result.deploymentsCreated).toBe(0);
    expect(createPolicyDeploymentMock).not.toHaveBeenCalled();
    expect(setSpy.mock.calls.at(-1)![0].installRemediationStatus).toBe('skipped');
  });

  it('never touches installRemediationAttempts — that counter belongs to the compliance worker', async () => {
    primeInstallDb(policyRow({ mode: 'allowlist', ...INSTALL_ARMED }));

    await processRemediateDeviceInstall(installJob());

    for (const call of setSpy.mock.calls) {
      expect(call[0]).not.toHaveProperty('installRemediationAttempts');
    }
  });


  it('audits an all-skipped pass as install_skipped, never install_queued', async () => {
    // Review finding (silent-failure-hunter, CRITICAL): the audit `action` is
    // the queryable dimension a technician filters on to answer "did Breeze
    // actually try to install anything here?". Reporting install_queued for a
    // pass that created zero deployments is a durable lie in the forensic
    // trail — the contradiction is buried in details.deploymentsCreated.
    resolveTargetMock.mockResolvedValue({ ok: false, reason: 'catalog_item_not_reachable' });
    primeInstallDb(policyRow({ mode: 'allowlist', ...INSTALL_ARMED }));

    const result = await processRemediateDeviceInstall(installJob());

    expect(result.deploymentsCreated).toBe(0);
    expect(result.errors).toBe(0);
    expect(policyAuditActions()).toContain('install_skipped');
    expect(policyAuditActions()).not.toContain('install_queued');
  });

  it('audits install_failed and writes failed when every deployment creation throws', async () => {
    createPolicyDeploymentMock.mockRejectedValue(new Error('boom'));
    primeInstallDb(policyRow({ mode: 'allowlist', ...INSTALL_ARMED }));

    const result = await processRemediateDeviceInstall(installJob());

    expect(result.deploymentsCreated).toBe(0);
    expect(result.errors).toBe(1);
    expect(setSpy.mock.calls.at(-1)![0].installRemediationStatus).toBe('failed');
    expect(policyAuditActions()).toContain('install_failed');
    expect(recordDecisionMock).toHaveBeenCalledWith('command_failed');
    const audit = recordPolicyAuditMock.mock.calls.at(-1)![0] as any;
    expect(JSON.stringify(audit.details)).toContain('boom');
  });

  it('a PARTIAL failure still reports pending and install_queued — one real install did happen', async () => {
    createPolicyDeploymentMock
      .mockResolvedValueOnce({ deploymentId: 'dep-ok', status: 'pending' })
      .mockRejectedValueOnce(new Error('second one failed'));
    resolveTargetMock
      .mockResolvedValueOnce({
        ok: true,
        target: { kind: 'install_method', catalogId: 'cat-1', installMethodId: 'im-1' },
      })
      .mockResolvedValueOnce({
        ok: true,
        target: { kind: 'install_method', catalogId: 'cat-2', installMethodId: 'im-2' },
      });
    primeInstallDb(policyRow({ mode: 'allowlist', ...INSTALL_ARMED }), {
      ...MISSING_COMPLIANCE,
      violations: [
        { type: 'missing', rule: { name: 'Chrome', catalogId: 'cat-1' }, severity: 'high' },
        { type: 'missing', rule: { name: 'Slack', catalogId: 'cat-2' }, severity: 'high' },
      ],
    });

    const result = await processRemediateDeviceInstall(installJob({ catalogIds: ['cat-1', 'cat-2'] }));

    expect(result.deploymentsCreated).toBe(1);
    expect(result.errors).toBe(1);
    expect(setSpy.mock.calls.at(-1)![0].installRemediationStatus).toBe('pending');
    expect(policyAuditActions()).toContain('install_queued');
  });

  it('names a dropped payload catalogId in the audit instead of discarding it silently', async () => {
    // Review finding (HIGH): the intersection used to `continue` with no record
    // at all, so a stale or forged id left the trail only as an implicit gap
    // between requestedCatalogIds and resolvedCatalogIds — with no reason.
    primeInstallDb(policyRow({ mode: 'allowlist', ...INSTALL_ARMED }));

    const result = await processRemediateDeviceInstall(
      installJob({ catalogIds: ['cat-1', 'cat-99'] })
    );

    expect(result.skipped).toBe(1);
    const audit = recordPolicyAuditMock.mock.calls.at(-1)![0] as any;
    const details = JSON.stringify(audit.details);
    expect(details).toContain('not_currently_missing');
    expect(details).toContain('cat-99');
  });

  it('settles a converged device to completed, not skipped — a discriminating assertion', async () => {
    // Without asserting the status/decision this case is satisfied identically
    // by the fall-through 'skipped' outcome, so deleting the convergence branch
    // would not fail it.
    primeInstallDb(policyRow({ mode: 'allowlist', ...INSTALL_ARMED }), {
      ...MISSING_COMPLIANCE,
      violations: [{ type: 'unauthorized', software: { name: 'Unwanted App', version: '1.0' } }],
    });

    await processRemediateDeviceInstall(installJob());

    expect(setSpy.mock.calls.at(-1)![0].installRemediationStatus).toBe('completed');
    expect(recordDecisionMock).toHaveBeenCalledWith('no_violations');
  });

  it('rethrows an unexpected error after resetting the row to failed, so BullMQ retries', async () => {
    resolveTargetMock.mockRejectedValue(new Error('pg exploded'));
    primeInstallDb(policyRow({ mode: 'allowlist', ...INSTALL_ARMED }));

    await expect(processRemediateDeviceInstall(installJob())).rejects.toThrow('pg exploded');
    // Swallowing it would complete the job, drop the device, and never retry.
    expect(setSpy.mock.calls.at(-1)![0].installRemediationStatus).toBe('failed');
  });

  it('records a metric for every invisible early return', async () => {
    // Review finding (HIGH): these three returns produced no metric and no
    // audit row, and because they do not throw they never reach the worker's
    // Sentry safety net either — a job dropped here was invisible everywhere.
    primeInstallDb(null);
    await processRemediateDeviceInstall(installJob());
    expect(recordDecisionMock).toHaveBeenCalledWith('install_policy_not_found');

    vi.clearAllMocks();
    const ephemeral = [
      [policyRow({ mode: 'allowlist', ...INSTALL_ARMED })],
      [{ orgId: ORG_ID, osType: 'windows', isEphemeral: true }],
    ];
    let call = 0;
    selectMock.mockImplementation(() => chain(ephemeral[Math.min(call++, ephemeral.length - 1)]));
    await processRemediateDeviceInstall(installJob());
    expect(recordDecisionMock).toHaveBeenCalledWith('install_ephemeral_device');

    vi.clearAllMocks();
    const noCompliance = [
      [policyRow({ mode: 'allowlist', ...INSTALL_ARMED })],
      [{ orgId: ORG_ID, osType: 'windows', isEphemeral: false }],
      [],
    ];
    call = 0;
    selectMock.mockImplementation(() =>
      chain(noCompliance[Math.min(call++, noCompliance.length - 1)])
    );
    await processRemediateDeviceInstall(installJob());
    expect(recordDecisionMock).toHaveBeenCalledWith('install_compliance_row_missing');
  });

  it('leaves a per-device audit trail for a superseded job, not just a fleet-wide counter', async () => {
    primeInstallDb(policyRow({ mode: 'allowlist', approvalGeneration: 9, ...INSTALL_ARMED }));

    await processRemediateDeviceInstall(installJob({ generation: 7 }));

    const audit = recordPolicyAuditMock.mock.calls.at(-1)?.[0] as any;
    expect(audit).toBeDefined();
    expect(audit.deviceId).toBe(DEVICE_ID);
    expect(JSON.stringify(audit.details)).toContain('generation');
  });

  it('routes install-remediate-device to the install processor and leaves uninstall alone', async () => {
    // Replaces W02's parking branch. The bullmq mock at the top of this file
    // replaces Worker with a class that ignores its processor, so capture the
    // processor argument directly.
    const captured: Array<(job: any) => Promise<unknown>> = [];
    const bullmq = await import('bullmq');
    const OriginalWorker = (bullmq as any).Worker;
    (bullmq as any).Worker = class {
      constructor(_name: string, processor: (job: any) => Promise<unknown>) {
        captured.push(processor);
      }
      on = vi.fn();
      close = vi.fn();
    };

    createSoftwareRemediationWorker();
    (bullmq as any).Worker = OriginalWorker;

    const processor = captured[0]!;

    primeInstallDb(policyRow({ mode: 'allowlist', ...INSTALL_ARMED }));
    const installResult: any = await processor({ data: installJob() });
    expect(installResult).toHaveProperty('deploymentsCreated');
    expect(installResult).not.toHaveProperty('commandsQueued');

    primeDb(policyRow({ enforceMode: false }));
    const uninstallResult: any = await processor({
      data: { type: 'remediate-device', policyId: POLICY_ID, deviceId: DEVICE_ID },
    });
    expect(uninstallResult).toHaveProperty('commandsQueued');
    expect(uninstallResult).not.toHaveProperty('deploymentsCreated');
  });
});
