import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  addMock,
  dbSelectMock,
  dbUpdateSetMock,
  auditMock,
  resolveDeviceIdsMock,
  armingMock,
  upsertMock,
  inventoryMock,
  scheduleUninstallMock,
  scheduleInstallMock,
  latestPolicyOwnedInstallMock,
} = vi.hoisted(() => ({
  addMock: vi.fn(async () => ({ id: 'queued-job-1' })),
  dbSelectMock: vi.fn(),
  // Captures the `.set()` payload so the SQL attempt-counter increment is
  // actually assertable. A mock that swallowed it would make
  // `expect(dbUpdateMock).toHaveBeenCalled()` pass against a wrong column, a
  // wrong expression, or no increment at all.
  dbUpdateSetMock: vi.fn((_values: Record<string, unknown>) => ({ where: async () => undefined })),
  resolveDeviceIdsMock: vi.fn(async () => ['device-1']),
  auditMock: vi.fn(async (_input: Record<string, unknown>) => undefined),
  armingMock: vi.fn((_policy: unknown, _verb: string) => ({ armed: true }) as {
    armed: boolean;
    reason?: string;
    message?: string;
  }),
  upsertMock: vi.fn(async (_inputs: Array<Record<string, unknown>>) => undefined),
  inventoryMock: vi.fn(async () => new Map<string, unknown[]>([['device-1', []]])),
  scheduleUninstallMock: vi.fn(async (..._args: unknown[]) => 0),
  latestPolicyOwnedInstallMock: vi.fn(async (
    _policyId: string,
    _deviceIds: string[],
  ) => new Map<string, Date>()),
  scheduleInstallMock: vi.fn(async (
    _policyId: string,
    _targets: Array<{ deviceId: string; catalogIds: string[]; attempt: number }>,
    _generation: number,
  ) => [] as string[]),
}));

vi.mock('bullmq', () => ({
  Queue: class { add = addMock; addBulk = vi.fn(); getRepeatableJobs = vi.fn(async () => []); },
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
  scheduleSoftwareRemediation: scheduleUninstallMock,
  scheduleSoftwareInstallRemediation: scheduleInstallMock,
}));
vi.mock('../services/softwarePolicyInstallRemediation', () => ({
  readLatestPolicyOwnedInstallByDevice: latestPolicyOwnedInstallMock,
}));
vi.mock('../services/softwarePolicyService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/softwarePolicyService')>();
  return {
    ...actual,
    evaluateSoftwarePolicyArming: armingMock,
    upsertSoftwareComplianceStatuses: upsertMock,
    getSoftwareInventoryByDeviceIds: inventoryMock,
    recordSoftwarePolicyAudit: auditMock,
  };
});

import {
  decideInstallRemediation,
  installStatusForSkip,
  processCheckPolicy,
  reconcileOrphanedInstallRemediation,
} from './softwareComplianceWorker';
import type { SoftwarePolicyViolation } from '../db/schema';

const POLICY_ID = 'policy-1';

/**
 * A policy that is armed for BOTH verbs by every inline criterion the worker
 * used to check for itself: mode allowlist, enforceMode true, autoUninstall
 * true, autoInstall true.
 */
const FULLY_ARMED_POLICY = {
  id: POLICY_ID,
  orgId: 'org-1',
  partnerId: null,
  name: 'Desired state policy',
  isActive: true,
  approvalGeneration: 1,
  mode: 'allowlist',
  enforceMode: true,
  remediationOptions: { autoUninstall: true, autoInstall: true },
  rules: { software: [{ name: 'Google Chrome', catalogId: 'catalog-abc' }] },
};

/**
 * FIFO for db.select(): policy reload → devices(orgByDevice) → compliance state.
 *
 * The three call sites end differently — the policy reload finishes with
 * `.limit(1)`, the other two are awaited straight off `.where(...)` — so the
 * object `.where()` returns has to be BOTH a thenable and carry `.limit`.
 */
function primeSelects(rows: unknown[][]) {
  for (const result of rows) {
    const terminal = () => Object.assign(
      Promise.resolve(result),
      { limit: () => Promise.resolve(result) },
    );
    dbSelectMock.mockReturnValueOnce({
      from: () => ({
        where: terminal,
        limit: () => Promise.resolve(result),
      }),
    });
  }
}

function primeStandardPass() {
  primeSelects([
    [FULLY_ARMED_POLICY],                                   // policy reload
    [{ id: 'device-1', orgId: 'org-1' }],                   // orgByDevice
    [],                                                     // readComplianceStateByDevice
  ]);
  inventoryMock.mockResolvedValueOnce(new Map([['device-1', []]]));
}

describe('processCheckPolicy — arming comes from the shared helper only (contract D11)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    armingMock.mockReturnValue({ armed: true });
    resolveDeviceIdsMock.mockResolvedValue(['device-1']);
    scheduleUninstallMock.mockResolvedValue(0);
    scheduleInstallMock.mockResolvedValue([]);
  });

  it('asks evaluateSoftwarePolicyArming for BOTH verbs, once each', async () => {
    primeStandardPass();

    await processCheckPolicy({ type: 'check-policy', policyId: POLICY_ID });

    const verbs = armingMock.mock.calls.map((call) => call[1]);
    expect(verbs).toContain('uninstall');
    expect(verbs).toContain('install');
  });

  /**
   * THE DIVERGENCE GUARD. The policy row below satisfies every criterion the
   * worker's old inline gate checked, but the shared helper says NOT ARMED. If
   * the worker re-derives arming for itself — today, or after some future edit
   * re-inlines it — it queues anyway and this fails. There is exactly one
   * arming truth.
   */
  it('queues NOTHING when the shared helper says unarmed, even on a policy the old inline gate would have passed', async () => {
    armingMock.mockReturnValue({
      armed: false,
      reason: 'enforce_mode_off',
      message: 'test double: unarmed',
    });
    primeSelects([
      [FULLY_ARMED_POLICY],
      [{ id: 'device-1', orgId: 'org-1' }],
      [],
    ]);
    inventoryMock.mockResolvedValueOnce(new Map([['device-1', [
      { name: 'Some Unapproved App', version: '1.0', vendor: 'Acme', catalogId: null },
    ]]]));

    const result = await processCheckPolicy({ type: 'check-policy', policyId: POLICY_ID });

    expect(result.violations).toBeGreaterThan(0);        // it DID detect
    expect(scheduleUninstallMock).not.toHaveBeenCalled(); // and refused to act
    expect(scheduleInstallMock).not.toHaveBeenCalled();
  });
});

const DECIDE_NOW = new Date('2026-09-10T12:00:00.000Z');

function missing(catalogId?: string, detectedAt = '2026-01-01T00:00:00.000Z'): SoftwarePolicyViolation {
  return {
    type: 'missing',
    rule: { name: 'Google Chrome', ...(catalogId ? { catalogId } : {}) },
    severity: 'high',
    detectedAt,
  };
}

function unauthorized(detectedAt = '2026-01-01T00:00:00.000Z'): SoftwarePolicyViolation {
  return {
    type: 'unauthorized',
    software: { name: 'Bad App', version: '1.0', vendor: 'Acme' },
    severity: 'medium',
    detectedAt,
  };
}

function decideWith(overrides: Partial<Parameters<typeof decideInstallRemediation>[0]> = {}) {
  return decideInstallRemediation({
    violations: [missing('catalog-abc')],
    previousInstallStatus: null,
    lastInstallAttempt: null,
    attempts: 0,
    now: DECIDE_NOW,
    gracePeriodHours: 0,
    cooldownMinutes: 120,
    maxAttempts: 3,
    capRemaining: 10,
    ...overrides,
  });
}

describe('decideInstallRemediation', () => {
  it('queues with the deduped catalog ids and a 1-based attempt number', () => {
    expect(decideWith({
      violations: [missing('catalog-abc'), missing('catalog-def'), missing('catalog-abc')],
    })).toEqual({ queue: true, catalogIds: ['catalog-abc', 'catalog-def'], attempt: 1 });
  });

  it('reports the next attempt number from the stored counter', () => {
    expect(decideWith({ attempts: 2, maxAttempts: 5 }))
      .toEqual({ queue: true, catalogIds: ['catalog-abc'], attempt: 3 });
  });

  it('ignores unauthorized violations entirely', () => {
    expect(decideWith({ violations: [unauthorized()] }))
      .toEqual({ queue: false, reason: 'no_missing_violations' });
  });

  it('refuses a missing violation whose rule carries no catalogId', () => {
    expect(decideWith({ violations: [missing()] }))
      .toEqual({ queue: false, reason: 'no_catalog_id' });
  });

  it('ignores blank and whitespace-only catalog ids', () => {
    expect(decideWith({ violations: [missing('   ')] }))
      .toEqual({ queue: false, reason: 'no_catalog_id' });
  });

  it('still queues when SOME missing rules have a catalogId and others do not', () => {
    expect(decideWith({ violations: [missing(), missing('catalog-abc')] }))
      .toEqual({ queue: true, catalogIds: ['catalog-abc'], attempt: 1 });
  });

  it('gives up once the consecutive counter reaches maxAttempts', () => {
    expect(decideWith({ attempts: 3, maxAttempts: 3 }))
      .toEqual({ queue: false, reason: 'attempts_exhausted' });
  });

  it('gives up on a counter that somehow exceeded maxAttempts', () => {
    expect(decideWith({ attempts: 99, maxAttempts: 3 }))
      .toEqual({ queue: false, reason: 'attempts_exhausted' });
  });

  // Ordering: attempts BEFORE timing, so an exhausted device reports the honest
  // terminal reason instead of hiding behind an incidental cooldown.
  it('reports attempts_exhausted rather than cooldown when both apply', () => {
    expect(decideWith({
      attempts: 3,
      maxAttempts: 3,
      lastInstallAttempt: new Date(DECIDE_NOW.getTime() - 60_000),
    })).toEqual({ queue: false, reason: 'attempts_exhausted' });
  });

  it('defers while an install is already pending', () => {
    expect(decideWith({ previousInstallStatus: 'pending' }))
      .toEqual({ queue: false, reason: 'in_progress' });
  });

  it('defers inside the grace window, measured on the MISSING clock', () => {
    expect(decideWith({
      violations: [missing('catalog-abc', '2026-09-10T11:00:00.000Z')],
      gracePeriodHours: 24,
    })).toEqual({ queue: false, reason: 'grace_period' });
  });

  it('defers inside the cooldown window', () => {
    expect(decideWith({
      lastInstallAttempt: new Date(DECIDE_NOW.getTime() - 60 * 1000),
      cooldownMinutes: 120,
    })).toEqual({ queue: false, reason: 'cooldown' });
  });

  // Ordering: cap LAST, so the pass budget is only consumed by devices that
  // would genuinely have queued. Checking it first would let devices already in
  // cooldown eat the cap and starve devices that are actually ready.
  it('applies the per-pass cap only after every other gate has passed', () => {
    expect(decideWith({ capRemaining: 0 }))
      .toEqual({ queue: false, reason: 'pass_cap' });

    expect(decideWith({ capRemaining: 0, previousInstallStatus: 'in_progress' }))
      .toEqual({ queue: false, reason: 'in_progress' });
  });

  it('treats a negative or non-finite stored counter as zero rather than throwing', () => {
    expect(decideWith({ attempts: -5 }))
      .toEqual({ queue: true, catalogIds: ['catalog-abc'], attempt: 1 });
    expect(decideWith({ attempts: Number.NaN }))
      .toEqual({ queue: true, catalogIds: ['catalog-abc'], attempt: 1 });
  });
});

describe('installStatusForSkip', () => {
  it('records a terminal give-up', () => {
    expect(installStatusForSkip('attempts_exhausted')).toBe('gave_up');
  });

  it('records the two "nothing attempted, nothing wrong with the device" cases as skipped', () => {
    expect(installStatusForSkip('no_catalog_id')).toBe('skipped');
    expect(installStatusForSkip('pass_cap')).toBe('skipped');
  });

  // Timing deferrals write NOTHING, mirroring the uninstall path: a device in
  // grace or cooldown has no new status to report, and overwriting a live
  // 'pending' with 'skipped' would tell a technician the install was abandoned.
  it('writes no status for a timing deferral or a device with nothing missing', () => {
    expect(installStatusForSkip('in_progress')).toBeUndefined();
    expect(installStatusForSkip('grace_period')).toBeUndefined();
    expect(installStatusForSkip('cooldown')).toBeUndefined();
    expect(installStatusForSkip('no_missing_violations')).toBeUndefined();
  });
});

describe('processCheckPolicy — install remediation wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    armingMock.mockReturnValue({ armed: true });
    scheduleUninstallMock.mockResolvedValue(0);
    scheduleInstallMock.mockResolvedValue([]);
    delete process.env.SOFTWARE_INSTALL_REMEDIATION_MAX_PER_PASS;
    delete process.env.SOFTWARE_INSTALL_REMEDIATION_MAX_ATTEMPTS;
  });

  function primePass(deviceIds: string[], existingRows: Record<string, unknown>[]) {
    resolveDeviceIdsMock.mockResolvedValueOnce(deviceIds);
    primeSelects([
      [FULLY_ARMED_POLICY],
      deviceIds.map((id) => ({ id, orgId: 'org-1' })),
      existingRows,
    ]);
    // Inventory is EMPTY for every device, so the allowlist rule
    // { name: 'Google Chrome', catalogId: 'catalog-abc' } produces exactly one
    // `missing` violation per device.
    inventoryMock.mockResolvedValueOnce(new Map(deviceIds.map((id) => [id, []])));
  }

  function upsertedRows(): Array<Record<string, unknown>> {
    const call = upsertMock.mock.calls[0];
    if (!call) throw new Error('upsertSoftwareComplianceStatuses was never called');
    return call[0] as unknown as Array<Record<string, unknown>>;
  }

  it('queues an install for a device whose allowlist rule is missing', async () => {
    primePass(['device-1'], []);
    scheduleInstallMock.mockResolvedValueOnce(['device-1']);

    const result = await processCheckPolicy({ type: 'check-policy', policyId: POLICY_ID });

    expect(result.installRemediationQueued).toBe(1);
    expect(scheduleInstallMock).toHaveBeenCalledWith(
      POLICY_ID,
      [{ deviceId: 'device-1', catalogIds: ['catalog-abc'], attempt: 1 }],
      1,
    );
    // and it must stamp only the devices that actually got a job, incrementing
    // the counter IN SQL rather than writing back the value read at the top of
    // the pass. Asserting the captured `.set()` payload, not merely that update
    // was called: the latter cannot fail against a wrong column or no increment.
    const setPayload = dbUpdateSetMock.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(setPayload?.installRemediationStatus).toBe('pending');
    expect(setPayload?.lastInstallRemediationAttempt).toBeInstanceOf(Date);
    // An SQL fragment, not a number read at the top of the pass. Inspect the
    // fragment's own chunks (it is self-referential, so it cannot be
    // JSON.stringify'd) for the increment and the column it increments.
    const attempts = setPayload?.installRemediationAttempts as { queryChunks?: unknown[] } | undefined;
    expect(attempts?.queryChunks).toBeInstanceOf(Array);
    const chunkText = (attempts?.queryChunks ?? [])
      .map((chunk) => (typeof chunk === 'string' ? chunk : (chunk as { value?: unknown })?.value))
      .filter((value) => typeof value === 'string' || Array.isArray(value))
      .flat()
      .join('');
    expect(chunkText).toContain('+ 1');
    expect(
      (attempts?.queryChunks ?? []).some(
        (chunk) => (chunk as { name?: string })?.name === 'install_remediation_attempts',
      ),
    ).toBe(true);
  });

  /**
   * The two verbs are INDEPENDENT gates over the same violation set, and both
   * results are merged into ONE complianceUpserts row. Without this case a
   * regression where the install branch clobbers `remediationStatus` (or the
   * uninstall branch clobbers the install columns) passes every other test —
   * they are separate local variables joined at a single push.
   */
  it('queues BOTH verbs for one device in a single pass without either clobbering the other', async () => {
    resolveDeviceIdsMock.mockResolvedValueOnce(['device-1']);
    primeSelects([
      [FULLY_ARMED_POLICY],
      [{ id: 'device-1', orgId: 'org-1' }],
      [],
    ]);
    // Chrome absent → `missing`; an unapproved app present → `unauthorized`.
    inventoryMock.mockResolvedValueOnce(new Map([['device-1', [
      { name: 'Some Unapproved App', version: '1.0', vendor: 'Acme', catalogId: null },
    ]]]));
    scheduleUninstallMock.mockResolvedValueOnce(1);
    scheduleInstallMock.mockResolvedValueOnce(['device-1']);

    const result = await processCheckPolicy({ type: 'check-policy', policyId: POLICY_ID });

    expect(scheduleUninstallMock).toHaveBeenCalledWith(POLICY_ID, ['device-1']);
    expect(scheduleInstallMock).toHaveBeenCalledWith(
      POLICY_ID,
      [{ deviceId: 'device-1', catalogIds: ['catalog-abc'], attempt: 1 }],
      1,
    );
    expect(result.remediationQueued).toBe(1);
    expect(result.installRemediationQueued).toBe(1);

    // ONE row for the device, and neither verb erased the other's field.
    const rows = upsertedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.deviceId).toBe('device-1');
    expect(rows[0]?.status).toBe('violation');
    // Neither verb had a prior status to transition, so both stay unstated —
    // the post-schedule UPDATEs own 'pending', not this upsert.
    expect(rows[0]?.remediationStatus).toBeUndefined();
    expect(rows[0]?.installRemediationStatus).toBeUndefined();
  });

  /**
   * The clobber guard, and it only discriminates because the two axes carry
   * DIFFERENT values in the same pass. With both undefined (as in the case
   * above) a bug that writes one field's value into the other is invisible.
   *
   * Prior state: uninstall was 'completed' and the device is in violation again
   * → uninstall transitions to 'none'. Install previously 'failed' with the
   * attempt budget exhausted → install terminates at 'gave_up'. One row, two
   * independently-derived values.
   */
  it('keeps the uninstall and install status axes distinct in the shared upsert row', async () => {
    process.env.SOFTWARE_INSTALL_REMEDIATION_MAX_ATTEMPTS = '3';
    resolveDeviceIdsMock.mockResolvedValueOnce(['device-1']);
    primeSelects([
      [FULLY_ARMED_POLICY],
      [{ id: 'device-1', orgId: 'org-1' }],
      [{
        deviceId: 'device-1',
        status: 'violation',
        violations: [],
        remediationStatus: 'completed',
        lastRemediationAttempt: null,
        installRemediationStatus: 'failed',
        lastInstallRemediationAttempt: null,
        installRemediationAttempts: 3,
      }],
    ]);
    inventoryMock.mockResolvedValueOnce(new Map([['device-1', [
      { name: 'Some Unapproved App', version: '1.0', vendor: 'Acme', catalogId: null },
    ]]]));

    await processCheckPolicy({ type: 'check-policy', policyId: POLICY_ID });

    const rows = upsertedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.remediationStatus).toBe('none');
    expect(rows[0]?.installRemediationStatus).toBe('gave_up');
  });

  it('does not queue an install when only the install verb is unarmed', async () => {
    armingMock.mockImplementation((_policy: unknown, verb: string) => (
      verb === 'install'
        ? { armed: false, reason: 'auto_install_off', message: 'unarmed' }
        : { armed: true }
    ));
    primePass(['device-1'], []);

    const result = await processCheckPolicy({ type: 'check-policy', policyId: POLICY_ID });

    expect(result.installRemediationQueued).toBe(0);
    expect(scheduleInstallMock).not.toHaveBeenCalled();
  });

  it('caps installs per pass and records the overflow devices as skipped', async () => {
    process.env.SOFTWARE_INSTALL_REMEDIATION_MAX_PER_PASS = '2';
    primePass(['device-1', 'device-2', 'device-3'], []);
    scheduleInstallMock.mockResolvedValueOnce(['device-1', 'device-2']);

    await processCheckPolicy({ type: 'check-policy', policyId: POLICY_ID });

    expect(scheduleInstallMock.mock.calls[0]?.[1]).toHaveLength(2);
    const third = upsertedRows().find((row) => row.deviceId === 'device-3');
    expect(third?.installRemediationStatus).toBe('skipped');
  });

  it('gives up on a device whose consecutive attempts are exhausted', async () => {
    process.env.SOFTWARE_INSTALL_REMEDIATION_MAX_ATTEMPTS = '3';
    primePass(['device-1'], [{
      deviceId: 'device-1',
      status: 'violation',
      violations: [],
      remediationStatus: null,
      lastRemediationAttempt: null,
      installRemediationStatus: 'failed',
      lastInstallRemediationAttempt: null,
      installRemediationAttempts: 3,
    }]);

    await processCheckPolicy({ type: 'check-policy', policyId: POLICY_ID });

    expect(scheduleInstallMock).not.toHaveBeenCalled();
    expect(upsertedRows()[0]?.installRemediationStatus).toBe('gave_up');
    // The give-up is the loop terminator, so its forensic trail is part of the
    // contract, not decoration: assert the audit action VALUE (locked by D6),
    // never just that some audit fired.
    const gaveUp = auditMock.mock.calls
      .map((call) => call[0])
      .filter((input) => input?.action === 'install_gave_up');
    expect(gaveUp).toHaveLength(1);
    expect(gaveUp[0]).toMatchObject({
      deviceId: 'device-1',
      policyId: POLICY_ID,
      actor: 'system',
      details: { attempts: 3, maxAttempts: 3 },
    });
  });

  /**
   * The once-only guard. Firing this every pass would write one audit row per
   * device per 15 minutes for as long as the policy stays armed. A device that
   * is ALREADY 'gave_up' must re-derive the same status without re-auditing.
   */
  it('does not re-fire the give-up audit on a later pass for a device already gave_up', async () => {
    process.env.SOFTWARE_INSTALL_REMEDIATION_MAX_ATTEMPTS = '3';
    primePass(['device-1'], [{
      deviceId: 'device-1',
      status: 'violation',
      violations: [],
      remediationStatus: null,
      lastRemediationAttempt: null,
      installRemediationStatus: 'gave_up',
      lastInstallRemediationAttempt: null,
      installRemediationAttempts: 3,
    }]);

    await processCheckPolicy({ type: 'check-policy', policyId: POLICY_ID });

    // still terminal, still not queued — but silent this time
    expect(scheduleInstallMock).not.toHaveBeenCalled();
    expect(upsertedRows()[0]?.installRemediationStatus).toBe('gave_up');
    expect(
      auditMock.mock.calls.filter((call) => call[0]?.action === 'install_gave_up'),
    ).toHaveLength(0);
  });

  it('audits the queued installs once per pass with the locked install_queued action', async () => {
    primePass(['device-1'], []);
    scheduleInstallMock.mockResolvedValueOnce(['device-1']);

    await processCheckPolicy({ type: 'check-policy', policyId: POLICY_ID });

    const queued = auditMock.mock.calls
      .map((call) => call[0])
      .filter((input) => input?.action === 'install_queued');
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      policyId: POLICY_ID,
      actor: 'system',
      details: { targetCount: 1, queuedCount: 1, deferredCount: 0 },
    });
  });

  it('resets the consecutive counter once the device has no missing violation left', async () => {
    resolveDeviceIdsMock.mockResolvedValueOnce(['device-1']);
    primeSelects([
      [FULLY_ARMED_POLICY],
      [{ id: 'device-1', orgId: 'org-1' }],
      [{
        deviceId: 'device-1',
        status: 'violation',
        violations: [],
        remediationStatus: null,
        lastRemediationAttempt: null,
        installRemediationStatus: 'pending',
        lastInstallRemediationAttempt: null,
        installRemediationAttempts: 2,
      }],
    ]);
    // Chrome is now installed, so the allowlist rule matches and nothing is missing.
    inventoryMock.mockResolvedValueOnce(new Map([['device-1', [
      { name: 'Google Chrome', version: '121.0', vendor: 'Google', catalogId: 'catalog-abc' },
    ]]]));

    await processCheckPolicy({ type: 'check-policy', policyId: POLICY_ID });

    expect(upsertedRows()[0]?.installRemediationAttempts).toBe(0);
    expect(upsertedRows()[0]?.installRemediationStatus).toBe('completed');
    expect(scheduleInstallMock).not.toHaveBeenCalled();
  });

  it('says nothing about the install columns for a device with no missing violation and no install history', async () => {
    resolveDeviceIdsMock.mockResolvedValueOnce(['device-1']);
    primeSelects([
      [FULLY_ARMED_POLICY],
      [{ id: 'device-1', orgId: 'org-1' }],
      [],
    ]);
    inventoryMock.mockResolvedValueOnce(new Map([['device-1', [
      { name: 'Google Chrome', version: '121.0', vendor: 'Google', catalogId: 'catalog-abc' },
    ]]]));

    await processCheckPolicy({ type: 'check-policy', policyId: POLICY_ID });

    expect(upsertedRows()[0]?.installRemediationStatus).toBeUndefined();
    expect(upsertedRows()[0]?.installRemediationAttempts).toBeUndefined();
  });
});

/**
 * #5505 W03 — the orphaned-install reconcile sweep.
 *
 * W02 (#5917) shipped the producer ahead of the processor. Every install job it
 * enqueued hit the parking branch in createSoftwareRemediationWorker, COMPLETED
 * as a no-op, and left its compliance row at
 * `install_remediation_status = 'pending'` with `last_install_remediation_attempt`
 * stamped and `install_remediation_attempts` incremented.
 *
 * Those rows do not drain from installing a processor alone. The next pass runs
 * decideInstallRemediation, whose timing gate is shouldQueueAutoRemediation,
 * whose FIRST branch is `previousRemediationStatus === 'pending' → in_progress`
 * — with no staleness escape. installStatusForSkip writes nothing for a timing
 * deferral, so the row is stuck at 'pending' forever and the device never gets
 * its software. The parked job itself is gone from Redis (removeOnComplete), so
 * nothing will ever move it.
 *
 * This is the explicit, idempotent sweep that unsticks them.
 */
describe('reconcileOrphanedInstallRemediation — #5505 W03', () => {
  const ATTEMPT_AT = new Date('2026-09-15T10:00:00Z');

  function reconcile(overrides: Record<string, unknown> = {}) {
    return reconcileOrphanedInstallRemediation({
      installRemediationStatus: 'pending',
      lastInstallRemediationAttempt: ATTEMPT_AT,
      installRemediationAttempts: 1,
      latestPolicyOwnedDeploymentAt: null,
      ...overrides,
    } as any);
  }

  it('resets a W02-parked row: live status, an attempt stamped, and no deployment to show for it', () => {
    expect(reconcile()).toEqual({
      installRemediationStatus: 'none',
      installRemediationAttempts: 0,
      lastInstallRemediationAttempt: null,
    });
  });

  it('also reclaims an in_progress row abandoned by a hard-killed worker', () => {
    expect(reconcile({ installRemediationStatus: 'in_progress', installRemediationAttempts: 3 })).toEqual({
      installRemediationStatus: 'none',
      installRemediationAttempts: 2,
      lastInstallRemediationAttempt: null,
    });
  });

  it('leaves a genuinely in-flight row alone — a deployment exists for this attempt', () => {
    expect(
      reconcile({ latestPolicyOwnedDeploymentAt: new Date(ATTEMPT_AT.getTime() + 1000) })
    ).toBeUndefined();
  });

  it('still reconciles when the only deployment PREDATES this attempt', () => {
    // A previous cycle installed successfully; THIS enqueue produced nothing.
    // Membership alone would wrongly read that old row as proof of live work.
    expect(
      reconcile({ latestPolicyOwnedDeploymentAt: new Date(ATTEMPT_AT.getTime() - 60_000) })
    ).toEqual({
      installRemediationStatus: 'none',
      installRemediationAttempts: 0,
      lastInstallRemediationAttempt: null,
    });
  });

  it('is idempotent: a row it already reset is not touched again', () => {
    expect(reconcile({ installRemediationStatus: 'none', installRemediationAttempts: 0 })).toBeUndefined();
  });

  it('never touches a terminal status', () => {
    for (const status of ['completed', 'failed', 'skipped', 'gave_up', null]) {
      expect(reconcile({ installRemediationStatus: status })).toBeUndefined();
    }
  });

  it('floors the attempt counter at zero', () => {
    expect(reconcile({ installRemediationAttempts: 0 })).toEqual({
      installRemediationStatus: 'none',
      installRemediationAttempts: 0,
      lastInstallRemediationAttempt: null,
    });
  });

  it('reconciles a live row that never recorded an attempt timestamp at all', () => {
    expect(reconcile({ lastInstallRemediationAttempt: null })).toEqual({
      installRemediationStatus: 'none',
      installRemediationAttempts: 0,
      lastInstallRemediationAttempt: null,
    });
  });
});

/**
 * The sweep has to actually RUN inside a compliance pass, and the row it
 * unsticks has to be re-queued by that SAME pass — otherwise a device parked by
 * W02 waits an extra cycle for no reason, and a sweep that is merely exported
 * but never called is dead code that a unit test of the pure function would
 * happily pass.
 */
describe('processCheckPolicy — orphaned-install reconcile sweep (#5505 W03)', () => {
  const PARKED_ROW = {
    deviceId: 'device-1',
    status: 'violation',
    violations: [{ type: 'missing', rule: { name: 'Chrome', catalogId: 'cat-1' }, detectedAt: '2026-09-01T00:00:00Z' }],
    remediationStatus: null,
    lastRemediationAttempt: null,
    installRemediationStatus: 'pending',
    lastInstallRemediationAttempt: new Date('2026-09-15T10:00:00Z'),
    installRemediationAttempts: 2,
  };

  function upsertedRows(): Array<Record<string, unknown>> {
    const call = upsertMock.mock.calls[0];
    if (!call) throw new Error('upsertSoftwareComplianceStatuses was never called');
    return call[0] as unknown as Array<Record<string, unknown>>;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    armingMock.mockReturnValue({ armed: true });
    resolveDeviceIdsMock.mockResolvedValue(['device-1']);
    scheduleUninstallMock.mockResolvedValue(0);
    scheduleInstallMock.mockResolvedValue(['device-1']);
    latestPolicyOwnedInstallMock.mockResolvedValue(new Map<string, Date>());
  });

  it('resets a W02-parked row and re-queues the device in the same pass', async () => {
    primeSelects([
      [FULLY_ARMED_POLICY],
      [{ id: 'device-1', orgId: 'org-1' }],
      [PARKED_ROW],
    ]);
    inventoryMock.mockResolvedValueOnce(new Map([['device-1', []]]));

    await processCheckPolicy({ type: 'check-policy', policyId: POLICY_ID });

    // The corrected values ride out on the compliance upsert, not a bespoke UPDATE.
    expect(upsertedRows()[0]?.installRemediationStatus).toBe('none');
    // One unearned increment given back — not a reset to zero.
    expect(upsertedRows()[0]?.installRemediationAttempts).toBe(1);
    // And the pass that unstuck it also acted on it, rather than deferring a cycle.
    expect(scheduleInstallMock).toHaveBeenCalled();
  });

  it('leaves a genuinely in-flight row parked and queues nothing for it', async () => {
    latestPolicyOwnedInstallMock.mockResolvedValue(
      new Map([['device-1', new Date('2026-09-15T10:00:30Z')]])
    );
    primeSelects([
      [FULLY_ARMED_POLICY],
      [{ id: 'device-1', orgId: 'org-1' }],
      [PARKED_ROW],
    ]);
    inventoryMock.mockResolvedValueOnce(new Map([['device-1', []]]));

    await processCheckPolicy({ type: 'check-policy', policyId: POLICY_ID });

    expect(upsertedRows()[0]?.installRemediationStatus).not.toBe('none');
    expect(scheduleInstallMock).not.toHaveBeenCalled();
  });

  it('issues no reconcile UPDATE at all when nothing is parked — the drained steady state', async () => {
    primeSelects([
      [FULLY_ARMED_POLICY],
      [{ id: 'device-1', orgId: 'org-1' }],
      [{ ...PARKED_ROW, installRemediationStatus: 'completed' }],
    ]);
    inventoryMock.mockResolvedValueOnce(new Map([['device-1', []]]));

    await processCheckPolicy({ type: 'check-policy', policyId: POLICY_ID });

    // Not even the prefetch fires — no live status means nothing to reconcile.
    expect(latestPolicyOwnedInstallMock).not.toHaveBeenCalled();
    // The 'none' the upsert writes here is W02's own "it came back" transition
    // off a stale 'completed', NOT a reconcile: the counter is left untouched.
    expect(upsertedRows()[0]?.installRemediationAttempts).toBeUndefined();
  });

  it('prefetches for the LIVE devices only, not the whole pass', async () => {
    // The all-or-nothing case (0 live -> no prefetch) is covered above; this
    // pins the filter itself, which that case cannot discriminate.
    resolveDeviceIdsMock.mockResolvedValue(['device-1', 'device-2']);
    primeSelects([
      [FULLY_ARMED_POLICY],
      [
        { id: 'device-1', orgId: 'org-1' },
        { id: 'device-2', orgId: 'org-1' },
      ],
      [PARKED_ROW, { ...PARKED_ROW, deviceId: 'device-2', installRemediationStatus: 'completed' }],
    ]);
    inventoryMock.mockResolvedValueOnce(new Map([['device-1', []], ['device-2', []]]));

    await processCheckPolicy({ type: 'check-policy', policyId: POLICY_ID });

    expect(latestPolicyOwnedInstallMock).toHaveBeenCalledTimes(1);
    expect(latestPolicyOwnedInstallMock).toHaveBeenCalledWith(POLICY_ID, ['device-1']);
  });
});
