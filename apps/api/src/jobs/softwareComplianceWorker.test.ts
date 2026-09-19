import { beforeEach, describe, expect, it, vi } from 'vitest';

const { addMock } = vi.hoisted(() => ({
  addMock: vi.fn(async () => ({ id: 'queued-job-1' })),
}));

vi.mock('bullmq', () => ({
  Queue: class {
    add = addMock;
  },
  Worker: class {
    on = vi.fn();
    close = vi.fn();
  },
  Job: class {},
}));

vi.mock('../services/redis', () => ({
  getBullMQConnection: vi.fn(() => ({})),
}));

const { dbSelectMock, resolveDeviceIdsMock } = vi.hoisted(() => ({
  dbSelectMock: vi.fn(),
  resolveDeviceIdsMock: vi.fn(async () => []),
}));
vi.mock('../db', () => ({
  db: { select: dbSelectMock },
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));
vi.mock('../services/featureConfigResolver', () => ({
  resolveDeviceIdsForSoftwarePolicy: resolveDeviceIdsMock,
}));

import {
  processCheckPolicy,
  readEarliestViolationDetection,
  scheduleSoftwareComplianceCheck,
  shouldQueueAutoRemediation,
} from './softwareComplianceWorker';

const POLICY_ID = 'policy-1';

function mockPolicyReload(row: Record<string, unknown> | undefined) {
  dbSelectMock.mockReturnValueOnce({
    from: () => ({ where: () => ({ limit: () => Promise.resolve(row ? [row] : []) }) }),
  });
}

describe('processCheckPolicy — approval_generation mismatch (site-ceiling gate contract §3)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('skips (does not evaluate any device) when the job generation does not match the reloaded row', async () => {
    mockPolicyReload({ id: POLICY_ID, isActive: true, approvalGeneration: 3 });

    const result = await processCheckPolicy({ type: 'check-policy', policyId: POLICY_ID, generation: 2 });

    expect(result.devicesEvaluated).toBe(0);
    expect(result.violations).toBe(0);
    expect(resolveDeviceIdsMock).not.toHaveBeenCalled();
  });

  it('proceeds past the generation check (reaches device resolution) when the job generation matches', async () => {
    mockPolicyReload({ id: POLICY_ID, isActive: true, approvalGeneration: 3 });
    resolveDeviceIdsMock.mockRejectedValueOnce(new Error('stop-here-marker'));

    await expect(
      processCheckPolicy({ type: 'check-policy', policyId: POLICY_ID, generation: 3 })
    ).rejects.toThrow('stop-here-marker');

    expect(resolveDeviceIdsMock).toHaveBeenCalledWith(POLICY_ID);
  });

  it('proceeds when the job carries no generation (existing behavior, opt-in only)', async () => {
    mockPolicyReload({ id: POLICY_ID, isActive: true, approvalGeneration: 3 });
    resolveDeviceIdsMock.mockRejectedValueOnce(new Error('stop-here-marker'));

    await expect(
      processCheckPolicy({ type: 'check-policy', policyId: POLICY_ID })
    ).rejects.toThrow('stop-here-marker');
  });
});

const NOW = new Date('2025-01-15T12:00:00Z');
const PAST_VIOLATION = [{ type: 'unauthorized', detectedAt: '2025-01-01T00:00:00Z' }];
const RECENT_VIOLATION = [{ type: 'unauthorized', detectedAt: '2025-01-15T11:00:00Z' }];

describe('shouldQueueAutoRemediation', () => {
  it('returns queue:false when status is in_progress', () => {
    const result = shouldQueueAutoRemediation({
      violations: PAST_VIOLATION,
      violationType: 'unauthorized',
      previousRemediationStatus: 'in_progress',
      lastRemediationAttempt: null,
      now: NOW,
      gracePeriodHours: 0,
      cooldownMinutes: 120,
    });
    expect(result).toEqual({ queue: false, reason: 'in_progress' });
  });

  it('returns queue:false when status is pending', () => {
    const result = shouldQueueAutoRemediation({
      violations: PAST_VIOLATION,
      violationType: 'unauthorized',
      previousRemediationStatus: 'pending',
      lastRemediationAttempt: null,
      now: NOW,
      gracePeriodHours: 0,
      cooldownMinutes: 120,
    });
    expect(result).toEqual({ queue: false, reason: 'in_progress' });
  });

  it('returns queue:false when inside grace period', () => {
    const result = shouldQueueAutoRemediation({
      violations: RECENT_VIOLATION,
      violationType: 'unauthorized',
      previousRemediationStatus: null,
      lastRemediationAttempt: null,
      now: NOW,
      gracePeriodHours: 24,
      cooldownMinutes: 120,
    });
    expect(result).toEqual({ queue: false, reason: 'grace_period' });
  });

  it('returns queue:true when outside grace period', () => {
    const result = shouldQueueAutoRemediation({
      violations: PAST_VIOLATION,
      violationType: 'unauthorized',
      previousRemediationStatus: null,
      lastRemediationAttempt: null,
      now: NOW,
      gracePeriodHours: 24,
      cooldownMinutes: 120,
    });
    expect(result).toEqual({ queue: true });
  });

  it('returns queue:false when inside cooldown window', () => {
    const lastAttempt = new Date(NOW.getTime() - 30 * 60 * 1000);
    const result = shouldQueueAutoRemediation({
      violations: PAST_VIOLATION,
      violationType: 'unauthorized',
      previousRemediationStatus: null,
      lastRemediationAttempt: lastAttempt,
      now: NOW,
      gracePeriodHours: 0,
      cooldownMinutes: 120,
    });
    expect(result).toEqual({ queue: false, reason: 'cooldown' });
  });

  it('returns queue:true when past cooldown window', () => {
    const lastAttempt = new Date(NOW.getTime() - 200 * 60 * 1000);
    const result = shouldQueueAutoRemediation({
      violations: PAST_VIOLATION,
      violationType: 'unauthorized',
      previousRemediationStatus: null,
      lastRemediationAttempt: lastAttempt,
      now: NOW,
      gracePeriodHours: 0,
      cooldownMinutes: 120,
    });
    expect(result).toEqual({ queue: true });
  });

  it('returns queue:true with no previous state and no grace/cooldown', () => {
    const result = shouldQueueAutoRemediation({
      violations: PAST_VIOLATION,
      violationType: 'unauthorized',
      previousRemediationStatus: null,
      lastRemediationAttempt: null,
      now: NOW,
      gracePeriodHours: 0,
      cooldownMinutes: 120,
    });
    expect(result).toEqual({ queue: true });
  });

  it('skips grace period check when gracePeriodHours is 0', () => {
    const result = shouldQueueAutoRemediation({
      violations: RECENT_VIOLATION,
      violationType: 'unauthorized',
      previousRemediationStatus: null,
      lastRemediationAttempt: null,
      now: NOW,
      gracePeriodHours: 0,
      cooldownMinutes: 120,
    });
    expect(result).toEqual({ queue: true });
  });
});

describe('readEarliestViolationDetection', () => {
  it('returns null for non-array input', () => {
    expect(readEarliestViolationDetection(null, 'unauthorized')).toBeNull();
    expect(readEarliestViolationDetection('string', 'unauthorized')).toBeNull();
    expect(readEarliestViolationDetection({}, 'unauthorized')).toBeNull();
  });

  it('returns null for empty array', () => {
    expect(readEarliestViolationDetection([], 'unauthorized')).toBeNull();
  });

  it('returns null when no unauthorized violations', () => {
    const violations = [{ type: 'missing', detectedAt: '2025-01-01T00:00:00Z' }];
    expect(readEarliestViolationDetection(violations, 'unauthorized')).toBeNull();
  });

  it('returns the earliest unauthorized detection date', () => {
    const violations = [
      { type: 'unauthorized', detectedAt: '2025-01-10T00:00:00Z' },
      { type: 'unauthorized', detectedAt: '2025-01-01T00:00:00Z' },
      { type: 'unauthorized', detectedAt: '2025-01-15T00:00:00Z' },
    ];
    const result = readEarliestViolationDetection(violations, 'unauthorized');
    expect(result?.toISOString()).toBe('2025-01-01T00:00:00.000Z');
  });

  it('skips violations with invalid detectedAt strings', () => {
    const violations = [
      { type: 'unauthorized', detectedAt: 'not-a-date' },
      { type: 'unauthorized', detectedAt: '2025-01-05T00:00:00Z' },
    ];
    const result = readEarliestViolationDetection(violations, 'unauthorized');
    expect(result?.toISOString()).toBe('2025-01-05T00:00:00.000Z');
  });
});

describe('scheduleSoftwareComplianceCheck jobId', () => {
  beforeEach(() => {
    addMock.mockClear();
    addMock.mockResolvedValue({ id: 'queued-job-1' });
    mockPolicyReload({ id: POLICY_ID, approvalGeneration: 7 });
  });

  // Regression for "Custom Id cannot contain :" — BullMQ rejects a custom
  // jobId whose colon-split length !== 3. The per-policy id is 4 parts and
  // would throw, silently dropping the compliance-check enqueue.
  it('does not use a colon in the per-policy BullMQ job id', async () => {
    await scheduleSoftwareComplianceCheck('policy-1', ['device-1']);

    expect(addMock).toHaveBeenCalled();
    const [, , opts] = addMock.mock.calls[0] as unknown as [string, unknown, { jobId?: string }];
    expect(opts.jobId).toBeDefined();
    expect(String(opts.jobId)).not.toContain(':');
    expect(String(opts.jobId)).toMatch(/^software-compliance-policy-1-[a-z0-9]+-[a-z0-9]+$/);
  });
});

// Finding 3 (site-ceiling gate contract §3): only the PATCH caller
// (routes/softwarePolicies.ts) passes a generation explicitly today — create,
// /check, agents/helpers.ts, and aiToolsCompliance.ts all call this scheduler
// without one, which meant the worker's generation comparison was silently
// skipped (`data.generation !== undefined` never true) for every one of
// those enqueue paths. Backfilling from the current row here fixes all of
// them at once without touching every call site.
describe('scheduleSoftwareComplianceCheck approval_generation backfill (site-ceiling gate contract §3)', () => {
  beforeEach(() => {
    addMock.mockClear();
    addMock.mockResolvedValue({ id: 'queued-job-1' });
    dbSelectMock.mockClear();
  });

  it('backfills the policy current approvalGeneration when the caller does not pass one', async () => {
    mockPolicyReload({ id: POLICY_ID, approvalGeneration: 7 });

    await scheduleSoftwareComplianceCheck(POLICY_ID, ['device-1']);

    const [, data] = addMock.mock.calls[0] as unknown as [string, { generation?: number }];
    expect(data.generation).toBe(7);
  });

  it('keeps the caller-supplied generation and does not query the row', async () => {
    await scheduleSoftwareComplianceCheck(POLICY_ID, ['device-1'], 3);

    expect(dbSelectMock).not.toHaveBeenCalled();
    const [, data] = addMock.mock.calls[0] as unknown as [string, { generation?: number }];
    expect(data.generation).toBe(3);
  });

  it('does not query the row for a scan-policies job (no policyId)', async () => {
    await scheduleSoftwareComplianceCheck();

    expect(dbSelectMock).not.toHaveBeenCalled();
  });

  it('leaves generation undefined when the policy row cannot be found', async () => {
    mockPolicyReload(undefined);

    await scheduleSoftwareComplianceCheck(POLICY_ID, ['device-1']);

    const [, data] = addMock.mock.calls[0] as unknown as [string, { generation?: number }];
    expect(data.generation).toBeUndefined();
  });
});

describe('readEarliestViolationDetection — verb awareness (contract D10)', () => {
  const MIXED = [
    { type: 'unauthorized', detectedAt: '2025-01-10T00:00:00Z' },
    { type: 'missing', detectedAt: '2025-01-02T00:00:00Z' },
    { type: 'unauthorized', detectedAt: '2025-01-05T00:00:00Z' },
    { type: 'missing', detectedAt: '2025-01-20T00:00:00Z' },
  ];

  it('measures only unauthorized violations when asked for unauthorized', () => {
    expect(readEarliestViolationDetection(MIXED, 'unauthorized')?.toISOString())
      .toBe('2025-01-05T00:00:00.000Z');
  });

  it('measures only missing violations when asked for missing', () => {
    expect(readEarliestViolationDetection(MIXED, 'missing')?.toISOString())
      .toBe('2025-01-02T00:00:00.000Z');
  });

  it('returns null when the requested type is absent', () => {
    expect(readEarliestViolationDetection(
      [{ type: 'unauthorized', detectedAt: '2025-01-10T00:00:00Z' }],
      'missing',
    )).toBeNull();
  });
});

describe('shouldQueueAutoRemediation — grace measured against the requested verb', () => {
  const NOW_D10 = new Date('2025-01-10T00:00:00Z');

  // A device with a fresh `missing` violation and a long-stale `unauthorized`
  // one. Before D10 the grace clock read the unauthorized timestamp for BOTH
  // verbs, so the install verb would queue immediately, ignoring its own grace.
  const MIXED_AGES = [
    { type: 'unauthorized', detectedAt: '2024-01-01T00:00:00Z' },
    { type: 'missing', detectedAt: '2025-01-09T23:00:00Z' },
  ];

  it('defers the install verb inside ITS grace window even though an unauthorized violation is ancient', () => {
    expect(shouldQueueAutoRemediation({
      violations: MIXED_AGES,
      violationType: 'missing',
      previousRemediationStatus: null,
      lastRemediationAttempt: null,
      now: NOW_D10,
      gracePeriodHours: 24,
      cooldownMinutes: 120,
    })).toEqual({ queue: false, reason: 'grace_period' });
  });

  it('still queues the uninstall verb against the same violation set', () => {
    expect(shouldQueueAutoRemediation({
      violations: MIXED_AGES,
      violationType: 'unauthorized',
      previousRemediationStatus: null,
      lastRemediationAttempt: null,
      now: NOW_D10,
      gracePeriodHours: 24,
      cooldownMinutes: 120,
    })).toEqual({ queue: true });
  });
});
