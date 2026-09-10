/**
 * SEC-2026-09-05-146 — the recurring-dispatch gate.
 *
 * These controls assert the NEGATIVE space that the finding is about: when the
 * authority that armed a recurring schedule no longer resolves, the worker must
 * produce no discovery job, no auto-created discovery profile and no queue
 * effect — and must not throw the whole tick either.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { addMock, resolveAuthorityMock, createDiscoveryJobMock, enqueueDiscoveryScanMock } = vi.hoisted(() => ({
  addMock: vi.fn(async () => ({ id: 'queued-job-1' })),
  resolveAuthorityMock: vi.fn(),
  createDiscoveryJobMock: vi.fn(),
  enqueueDiscoveryScanMock: vi.fn(),
}));

vi.mock('bullmq', () => ({
  Queue: class {
    add = addMock;
    getRepeatableJobs = vi.fn(async () => []);
    removeRepeatableByKey = vi.fn(async () => undefined);
  },
  Worker: class {
    on = vi.fn();
    close = vi.fn();
  },
  Job: class {},
}));

vi.mock('../services/redis', () => ({ getBullMQConnection: vi.fn(() => ({})) }));

const updateCalls: Array<Record<string, unknown>> = [];
const selectQueue: unknown[][] = [];

function selectChain(): any {
  const rows = selectQueue.shift() ?? [];
  const result: any = Promise.resolve(rows);
  for (const method of ['from', 'where', 'limit', 'for', 'innerJoin', 'orderBy']) {
    result[method] = vi.fn(() => result);
  }
  return result;
}

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => selectChain()),
    update: vi.fn(() => ({
      set: vi.fn((values: Record<string, unknown>) => {
        updateCalls.push(values);
        return { where: vi.fn(async () => []) };
      }),
    })),
    insert: vi.fn(() => {
      throw new Error('insert must not be reached when authority is denied');
    }),
  },
  withSystemDbAccessContext: vi.fn(),
}));

vi.mock('../db/schema', () => ({
  discoveryJobs: {},
  discoveryProfiles: {},
  networkBaselines: { id: 'id' },
  networkChangeEvents: {},
}));

vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../services/networkBaseline', () => ({
  compareBaselineScan: vi.fn(),
  normalizeBaselineScanSchedule: vi.fn((s: unknown) => (s ?? { enabled: true, intervalHours: 4 })),
}));
vi.mock('./discoveryWorker', () => ({ enqueueDiscoveryScan: enqueueDiscoveryScanMock }));
vi.mock('../services/discoveryJobCreation', () => ({ createDiscoveryJobIfIdle: createDiscoveryJobMock }));
vi.mock('../services/networkBaselineAuthority', async () => {
  const actual = await vi.importActual<typeof import('../services/networkBaselineAuthority')>(
    '../services/networkBaselineAuthority',
  );
  return { ...actual, resolveBaselineDispatchAuthority: resolveAuthorityMock };
});

import { processExecuteScan } from './networkBaselineWorker';
import { BASELINE_BLOCKED_REASON } from '../services/networkBaselineAuthority';

const BASELINE = {
  id: 'baseline-1',
  orgId: 'org-1',
  siteId: 'site-1',
  subnet: '10.0.0.0/24',
  scanSchedule: { enabled: true, intervalHours: 4 },
  authorityUserId: 'user-1',
  authoritySiteIds: null,
  authorityPermissionsEpoch: 1,
  authorityMfaEpoch: 1,
  authorityFingerprint: 'fp',
  authorityGeneration: 3,
};

const JOB = {
  type: 'execute-baseline-scan' as const,
  baselineId: 'baseline-1',
  orgId: 'org-1',
  siteId: 'site-1',
  subnet: '10.0.0.0/24',
  trigger: 'schedule' as const,
  authorityGeneration: 3,
};

beforeEach(() => {
  addMock.mockClear();
  updateCalls.length = 0;
  selectQueue.length = 0;
  createDiscoveryJobMock.mockReset();
  enqueueDiscoveryScanMock.mockReset();
  resolveAuthorityMock.mockReset();
});

describe('processExecuteScan authority gate', () => {
  it('POSITIVE CONTROL: dispatches when authority resolves', async () => {
    selectQueue.push([BASELINE], [{ id: 'profile-1', subnets: ['10.0.0.0/24'] }]);
    resolveAuthorityMock.mockResolvedValue({ allowed: true });
    createDiscoveryJobMock.mockResolvedValue({ job: { id: 'discovery-1' }, created: true });
    enqueueDiscoveryScanMock.mockResolvedValue(undefined);

    const result = await processExecuteScan(JOB);

    expect(result).toEqual({ queued: true, discoveryJobId: 'discovery-1' });
    expect(createDiscoveryJobMock).toHaveBeenCalledTimes(1);
    expect(enqueueDiscoveryScanMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    BASELINE_BLOCKED_REASON.AUTHORITY_REVOKED,
    BASELINE_BLOCKED_REASON.PERMISSION_REVOKED,
    BASELINE_BLOCKED_REASON.SITE_OUT_OF_SCOPE,
    BASELINE_BLOCKED_REASON.EPOCH_CHANGED,
    BASELINE_BLOCKED_REASON.EFFECT_CHANGED,
    BASELINE_BLOCKED_REASON.STALE_GENERATION,
    BASELINE_BLOCKED_REASON.REAPPROVAL_REQUIRED,
    BASELINE_BLOCKED_REASON.SCHEDULE_DISABLED,
  ])('denies dispatch and records "%s" with no job, no profile and no queue effect', async (reason) => {
    selectQueue.push([BASELINE]);
    resolveAuthorityMock.mockResolvedValue({ allowed: false, reason });

    const result = await processExecuteScan(JOB);

    expect(result).toEqual({ queued: false, discoveryJobId: null, blockedReason: reason });
    expect(createDiscoveryJobMock).not.toHaveBeenCalled();
    expect(enqueueDiscoveryScanMock).not.toHaveBeenCalled();
    expect(addMock).not.toHaveBeenCalled();
    expect(updateCalls).toEqual([expect.objectContaining({ scheduleBlockedReason: reason })]);
  });

  it('passes the tick generation to the gate so a re-armed row invalidates it', async () => {
    selectQueue.push([BASELINE]);
    resolveAuthorityMock.mockResolvedValue({ allowed: false, reason: BASELINE_BLOCKED_REASON.STALE_GENERATION });

    await processExecuteScan(JOB);

    expect(resolveAuthorityMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'baseline-1' }),
      { expectedGeneration: 3 },
    );
  });

  it('treats a legacy queue payload with no trigger as a scheduled dispatch (fail closed)', async () => {
    selectQueue.push([{ ...BASELINE, authorityUserId: null }]);
    resolveAuthorityMock.mockResolvedValue({
      allowed: false,
      reason: BASELINE_BLOCKED_REASON.REAPPROVAL_REQUIRED,
    });

    const legacy = { ...JOB } as Record<string, unknown>;
    delete legacy.trigger;
    delete legacy.authorityGeneration;

    const result = await processExecuteScan(legacy as never);

    expect(result).toMatchObject({ queued: false, discoveryJobId: null });
    expect(resolveAuthorityMock).toHaveBeenCalledWith(expect.anything(), { expectedGeneration: null });
    expect(createDiscoveryJobMock).not.toHaveBeenCalled();
  });

  it('an interactive (manual) dispatch still runs the gate but carries no generation', async () => {
    selectQueue.push([BASELINE], [{ id: 'profile-1', subnets: ['10.0.0.0/24'] }]);
    resolveAuthorityMock.mockResolvedValue({ allowed: true });
    createDiscoveryJobMock.mockResolvedValue({ job: { id: 'discovery-2' }, created: false });

    await processExecuteScan({ ...JOB, trigger: 'manual', authorityGeneration: undefined } as never);

    expect(resolveAuthorityMock).toHaveBeenCalledWith(expect.anything(), { expectedGeneration: null });
  });
});
