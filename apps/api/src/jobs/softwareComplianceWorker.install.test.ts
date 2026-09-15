import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  addMock,
  dbSelectMock,
  dbUpdateMock,
  resolveDeviceIdsMock,
  armingMock,
  upsertMock,
  inventoryMock,
  scheduleUninstallMock,
  scheduleInstallMock,
} = vi.hoisted(() => ({
  addMock: vi.fn(async () => ({ id: 'queued-job-1' })),
  dbSelectMock: vi.fn(),
  dbUpdateMock: vi.fn(() => ({ set: () => ({ where: async () => undefined }) })),
  resolveDeviceIdsMock: vi.fn(async () => ['device-1']),
  armingMock: vi.fn((_policy: unknown, _verb: string) => ({ armed: true }) as {
    armed: boolean;
    reason?: string;
    message?: string;
  }),
  upsertMock: vi.fn(async (_inputs: Array<Record<string, unknown>>) => undefined),
  inventoryMock: vi.fn(async () => new Map<string, unknown[]>([['device-1', []]])),
  scheduleUninstallMock: vi.fn(async (..._args: unknown[]) => 0),
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
  db: { select: dbSelectMock, update: dbUpdateMock },
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
vi.mock('../services/softwarePolicyService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/softwarePolicyService')>();
  return {
    ...actual,
    evaluateSoftwarePolicyArming: armingMock,
    upsertSoftwareComplianceStatuses: upsertMock,
    getSoftwareInventoryByDeviceIds: inventoryMock,
    recordSoftwarePolicyAudit: vi.fn(async () => undefined),
  };
});

import {
  decideInstallRemediation,
  installStatusForSkip,
  processCheckPolicy,
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
    // and it must stamp only the devices that actually got a job
    expect(dbUpdateMock).toHaveBeenCalled();
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
