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
  // gate itself is correct, not that a stubbed gate was consulted.
  const actual = await orig<typeof import('../services/softwarePolicyService')>();
  return {
    evaluateSoftwarePolicyArming: actual.evaluateSoftwarePolicyArming,
    recordSoftwarePolicyAudit: recordPolicyAuditMock,
  };
});

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

import { processRemediateDevice, scheduleSoftwareRemediation } from './softwareRemediationWorker';

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
function primeDb(policy: unknown, opts: { compliance?: unknown; consumeResult?: unknown[] } = {}) {
  const results = [
    [policy],
    [{ orgId: ORG_ID, isEphemeral: false }],
    [opts.compliance ?? COMPLIANCE_ROW],
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
    );
    expect(policyAuditActions()).toContain('remediation_queued');
    expect(policyAuditActions()).not.toContain('remediation_skipped_unarmed');
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
