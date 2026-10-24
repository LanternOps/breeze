import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { is, SQL } from 'drizzle-orm';

const { getJobMock, addMock, addBulkMock, closeMock, getRepeatableJobsMock, removeRepeatableByKeyMock, claimMock, pumpMock } = vi.hoisted(() => ({
  getJobMock: vi.fn(),
  addMock: vi.fn(),
  addBulkMock: vi.fn(),
  closeMock: vi.fn(),
  getRepeatableJobsMock: vi.fn(() => Promise.resolve([] as Array<{ name: string; key: string }>)),
  removeRepeatableByKeyMock: vi.fn(),
  claimMock: vi.fn(),
  pumpMock: vi.fn(),
}));

vi.mock('bullmq', () => ({
  Queue: class {
    getJob = getJobMock;
    add = addMock;
    addBulk = addBulkMock;
    close = closeMock;
    getRepeatableJobs = getRepeatableJobsMock;
    removeRepeatableByKey = removeRepeatableByKeyMock;
  },
  Worker: class {
    on = vi.fn();
    close = vi.fn();
  },
  Job: class {},
  DelayedError: class DelayedError extends Error {},
}));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    update: vi.fn(),
    insert: vi.fn(),
  },
  withSystemDbAccessContext: undefined,
  withDbAccessContext: undefined,
  runOutsideDbContext: (fn: () => unknown) => fn(),
  runAfterDbContextExit: vi.fn(),
  runAfterDbContextCommit: vi.fn(),
  getCurrentDbAccessContext: () => undefined,
}));

vi.mock('../services/redis', () => ({
  getRedisConnection: vi.fn(() => ({})),
  getBullMQConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })),
  isBullMQAvailable: vi.fn(() => true),
}));

vi.mock('../services/cronDue', () => ({
  isCronDue: vi.fn(),
}));

vi.mock('../services/featureConfigResolver', () => ({
  resolveSecurityScanSettingsForDevice: vi.fn(),
  resolveSecurityScanPolicyForDevice: vi.fn(),
  resolveAllSecurityScanScheduledDevices: vi.fn(),
  resolvePartnerTimezoneForOrg: vi.fn(),
}));

vi.mock('./securityScanClaim', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./securityScanClaim')>();
  return { ...actual, claimAndDispatchScan: (...a: unknown[]) => claimMock(...a) };
});
vi.mock('./securityScanSweepPump', () => ({ pumpSweeps: (...a: unknown[]) => pumpMock(...a) }));
vi.mock('./workerObservability', () => ({ attachWorkerObservability: vi.fn() }));

import { DelayedError } from 'bullmq';
import { db } from '../db';
import { isCronDue } from '../services/cronDue';
import {
  buildSecurityScanPayload,
  enqueueSweepDispatches,
  enqueueSweepPump,
  initializeSecurityScanWorkers,
  processDispatchScan,
  shouldScheduleSecurityScan,
  schedulePolicyScans,
  shutdownSecurityScanWorkers,
} from './securityScanJobs';
import { SECURITY_SCAN_SETTINGS_DEFAULTS } from '@breeze/shared';

const dialect = new PgDialect();
const renderSql = (value: unknown) => (is(value, SQL) ? dialect.sqlToQuery(value).sql.toLowerCase() : '');

function chain(rows: unknown, onWhere?: (where: unknown) => void): any {
  const result: any = Promise.resolve(rows);
  for (const method of ['from', 'leftJoin', 'innerJoin', 'limit', 'for', 'returning', 'orderBy']) {
    result[method] = () => result;
  }
  result.where = (where: unknown) => {
    onWhere?.(where);
    return result;
  };
  return result;
}

const SCAN = '22222222-2222-4222-8222-222222222222';
const SWEEP = '33333333-3333-4333-8333-333333333333';

describe('processDispatchScan (#6263 W05: locked claim + throttle retry)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    claimMock.mockReset();
  });

  it('throttled → moveToDelayed + DelayedError, job retried (regression for the self-reuse defect)', async () => {
    // Before W05 a throttled scan called addUniqueDispatchJob from INSIDE its
    // own running job: queue.getJob(stable id) returned that same active job,
    // isReusableState('active') was true, and nothing was ever scheduled — the
    // scan sat `queued` forever. The fix re-delays the running job itself.
    claimMock.mockResolvedValue({ outcome: 'throttled', commandId: null, throttleReason: 'org cap 40' });
    getJobMock.mockResolvedValue({ getState: async () => 'active' });
    const job = { moveToDelayed: vi.fn().mockResolvedValue(undefined) };
    const before = Date.now();

    await expect(
      processDispatchScan({ type: 'dispatch-scan', scanId: SCAN, origin: 'manual' }, job as never, 'lock-token'),
    ).rejects.toBeInstanceOf(DelayedError);

    expect(job.moveToDelayed).toHaveBeenCalledTimes(1);
    const [timestamp, token] = job.moveToDelayed.mock.calls[0]!;
    expect(token).toBe('lock-token');
    expect(timestamp).toBeGreaterThanOrEqual(before + 20_000);
    expect(timestamp).toBeLessThanOrEqual(Date.now() + 20_000);
    // The self-reuse path is gone: no lookup of its own job id, no add.
    expect(getJobMock).not.toHaveBeenCalled();
    expect(addMock).not.toHaveBeenCalled();
  });

  it('a scheduled scan is retried the same way', async () => {
    claimMock.mockResolvedValue({ outcome: 'throttled', commandId: null, throttleReason: 'device cap 1' });
    const job = { moveToDelayed: vi.fn().mockResolvedValue(undefined) };
    await expect(
      processDispatchScan(
        { type: 'dispatch-scan', scanId: SCAN, origin: 'policy_scheduler', configPolicyId: SWEEP, occurrenceIso: 'x' },
        job as never,
        'tok',
      ),
    ).rejects.toBeInstanceOf(DelayedError);
    expect(job.moveToDelayed).toHaveBeenCalledTimes(1);
  });

  it('without a lock token, a throttled scan is re-queued as a fresh delayed job (never dropped)', async () => {
    claimMock.mockResolvedValue({ outcome: 'throttled', commandId: null, throttleReason: 'org cap 40' });
    addMock.mockResolvedValue({ id: 'retry' });
    const result = await processDispatchScan({ type: 'dispatch-scan', scanId: SCAN, origin: 'manual' });
    expect(result.outcome).toBe('throttled');
    expect(addMock).toHaveBeenCalledTimes(1);
    const [name, data, opts] = addMock.mock.calls[0]!;
    expect(name).toBe('dispatch-scan');
    expect(data).toEqual({ type: 'dispatch-scan', scanId: SCAN, origin: 'manual' });
    expect(opts.delay).toBe(20_000);
    expect(opts.jobId).not.toBe(`security-scan-${SCAN}`);
  });

  it('a throttled sweep scan stays queued for the pump to re-admit (no delayed loop)', async () => {
    claimMock.mockResolvedValue({ outcome: 'throttled', commandId: null, throttleReason: 'device cap 1' });
    const job = { moveToDelayed: vi.fn() };
    const result = await processDispatchScan(
      { type: 'dispatch-scan', scanId: SCAN, origin: 'sweep', sweepId: SWEEP },
      job as never,
      'tok',
    );
    expect(result).toEqual({ outcome: 'throttled', commandId: null, throttleReason: 'device cap 1' });
    expect(job.moveToDelayed).not.toHaveBeenCalled();
    expect(addMock).not.toHaveBeenCalled();
  });

  it('every other outcome passes straight through', async () => {
    for (const outcome of ['dispatched', 'skipped', 'failed', 'cancelled'] as const) {
      claimMock.mockResolvedValue({ outcome, commandId: outcome === 'dispatched' ? 'cmd-1' : null });
      const job = { moveToDelayed: vi.fn() };
      const result = await processDispatchScan({ type: 'dispatch-scan', scanId: SCAN, origin: 'manual' }, job as never, 'tok');
      expect(result.outcome).toBe(outcome);
      expect(job.moveToDelayed).not.toHaveBeenCalled();
    }
  });
});

describe('sweep pump wiring (#6263 W05)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getRepeatableJobsMock.mockResolvedValue([]);
  });

  it('enqueueSweepPump adds ONE coalescing immediate job', async () => {
    await enqueueSweepPump();
    expect(addMock).toHaveBeenCalledWith(
      'pump-sweeps',
      { type: 'pump-sweeps', tickAt: expect.any(String) },
      { jobId: 'security-sweep-pump-now', removeOnComplete: true, removeOnFail: true },
    );
  });

  it('enqueueSweepDispatches uses the stable per-scan job id and reuses a live job (idempotent)', async () => {
    getJobMock.mockImplementation(async (id: string) =>
      id === `security-scan-${SCAN}` ? { getState: async () => 'waiting' } : null,
    );
    const other = '44444444-4444-4444-8444-444444444444';
    await enqueueSweepDispatches([
      { type: 'dispatch-scan', scanId: SCAN, origin: 'sweep', sweepId: SWEEP },
      { type: 'dispatch-scan', scanId: other, origin: 'sweep', sweepId: SWEEP },
    ]);
    expect(addMock).toHaveBeenCalledTimes(1);
    expect(addMock.mock.calls[0]![2]).toMatchObject({ jobId: `security-scan-${other}` });
  });

  it('initializeSecurityScanWorkers registers the pump-sweeps repeatable, removing a stale one first', async () => {
    getRepeatableJobsMock.mockResolvedValue([
      { name: 'pump-sweeps', key: 'stale-pump' },
      { name: 'schedule-policies', key: 'stale-policies' },
      { name: 'other', key: 'keep' },
    ]);
    await initializeSecurityScanWorkers();
    expect(removeRepeatableByKeyMock).toHaveBeenCalledWith('stale-pump');
    expect(removeRepeatableByKeyMock).toHaveBeenCalledWith('stale-policies');
    expect(removeRepeatableByKeyMock).not.toHaveBeenCalledWith('keep');
    expect(addMock).toHaveBeenCalledWith(
      'pump-sweeps',
      { type: 'pump-sweeps', tickAt: expect.any(String) },
      expect.objectContaining({ repeat: { every: 30_000 } }),
    );
    await shutdownSecurityScanWorkers();
  });
});

describe('scheduler predicates exclude queued sweep scans (#6263 W05-2)', () => {
  const entry = {
    configPolicyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    orgId: null,
    partnerId: 'pppppppp-pppp-4ppp-8ppp-pppppppppppp',
    settings: { ...SECURITY_SCAN_SETTINGS_DEFAULTS },
    deviceIds: ['d1'],
  };

  it('queued sweep scans excluded from getOrgQueuedScans and from the whole busy predicate, including the started_at >= occurrence branch', async () => {
    const wheres: string[] = [];
    vi.mocked(db.select).mockReset();
    vi.mocked(db.insert).mockReset().mockReturnValue({ values: vi.fn().mockReturnValue(chain([])) } as any);
    vi.mocked(db.select)
      .mockReturnValueOnce(chain([{ id: 'd1', orgId: 'org-1' }]))
      .mockReturnValueOnce(chain([{ count: 0 }], (w) => wheres.push(renderSql(w))))
      .mockReturnValueOnce(chain([{ deviceId: 'd1' }], (w) => wheres.push(renderSql(w))));

    await schedulePolicyScans(entry as any, new Date('2026-09-18T02:00:00Z'));

    const [backpressure, busy] = wheres;
    expect(backpressure).toContain('"security_scans"."status" = $');
    expect(backpressure).toContain('"security_scans"."sweep_id" is null');
    // The exclusion wraps the WHOLE busy predicate: a sweep row inserted with
    // started_at = now() must not block this cron minute either.
    expect(busy).toMatch(
      /not \("security_scans"\."sweep_id" is not null and "security_scans"\."status" = 'queued'\) and \("security_scans"\."status" in \('queued','running'\) or "security_scans"\."started_at" >= \$\d+\)/,
    );
  });
});

describe('shouldScheduleSecurityScan', () => {
  beforeEach(() => vi.clearAllMocks());

  it('is false when scheduling is off', () => {
    expect(shouldScheduleSecurityScan(
      { ...SECURITY_SCAN_SETTINGS_DEFAULTS, scheduledScans: false },
      'UTC',
      new Date('2026-09-18T02:00:00Z'),
    )).toBe(false);
    expect(isCronDue).not.toHaveBeenCalled();
  });

  it('delegates to isCronDue with the five-field cron and timezone', () => {
    vi.mocked(isCronDue).mockReturnValue(true);
    const settings = { ...SECURITY_SCAN_SETTINGS_DEFAULTS, scanMinute: '0', scanHour: '2' };
    expect(shouldScheduleSecurityScan(settings, 'America/New_York', new Date('2026-09-18T06:00:00Z'))).toBe(true);
    expect(isCronDue).toHaveBeenCalledWith('0 2 * * *', 'America/New_York', new Date('2026-09-18T06:00:00Z'));
  });
});

describe('schedulePolicyScans', () => {
  const entry = {
    configPolicyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    orgId: null,
    partnerId: 'pppppppp-pppp-4ppp-8ppp-pppppppppppp',
    settings: { ...SECURITY_SCAN_SETTINGS_DEFAULTS },
    deviceIds: ['d1', 'd2'],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.select).mockReset();
    vi.mocked(db.insert).mockReset();
    addBulkMock.mockResolvedValue(undefined);
  });

  it('creates one scan row per device, each taking the DEVICE org, not the policy org', async () => {
    const insertValuesMock = vi.fn().mockReturnValue(chain([{ id: 'scan-d1' }, { id: 'scan-d2' }]));
    vi.mocked(db.insert).mockReturnValue({ values: insertValuesMock } as any);

    vi.mocked(db.select)
      .mockReturnValueOnce(chain([{ id: 'd1', orgId: 'org-of-d1' }, { id: 'd2', orgId: 'org-of-d2' }])) // device rows
      .mockReturnValueOnce(chain([{ count: 0 }])) // getOrgQueuedScans org-of-d1
      .mockReturnValueOnce(chain([{ count: 0 }])) // getOrgQueuedScans org-of-d2
      .mockReturnValueOnce(chain([])); // busy query

    const created = await schedulePolicyScans(entry as any, new Date('2026-09-18T02:00:00Z'));

    expect(created).toBe(2);
    expect(insertValuesMock).toHaveBeenCalledWith([
      expect.objectContaining({ deviceId: 'd1', orgId: 'org-of-d1', initiatedBy: null }),
      expect.objectContaining({ deviceId: 'd2', orgId: 'org-of-d2', initiatedBy: null }),
    ]);
    expect(addBulkMock).toHaveBeenCalledWith([
      expect.objectContaining({
        name: 'dispatch-scan',
        data: expect.objectContaining({ origin: 'policy_scheduler', occurrenceIso: '2026-09-18T02:00:00.000Z' }),
      }),
      expect.objectContaining({
        name: 'dispatch-scan',
        data: expect.objectContaining({ origin: 'policy_scheduler', occurrenceIso: '2026-09-18T02:00:00.000Z' }),
      }),
    ]);
  });

  it('skips a device that already has a queued or running scan', async () => {
    const insertValuesMock = vi.fn().mockReturnValue(chain([]));
    vi.mocked(db.insert).mockReturnValue({ values: insertValuesMock } as any);

    vi.mocked(db.select)
      .mockReturnValueOnce(chain([{ id: 'd1', orgId: 'org-of-d1' }]))
      .mockReturnValueOnce(chain([{ count: 0 }]))
      .mockReturnValueOnce(chain([{ deviceId: 'd1' }])); // busy: d1 already running

    const created = await schedulePolicyScans(
      { ...entry, deviceIds: ['d1'] } as any,
      new Date('2026-09-18T02:00:00Z'),
    );
    expect(created).toBe(0);
    expect(insertValuesMock).not.toHaveBeenCalled();
  });

  it('skips backpressured orgs but still schedules the rest', async () => {
    const insertValuesMock = vi.fn().mockReturnValue(chain([{ id: 'scan-d2' }]));
    vi.mocked(db.insert).mockReturnValue({ values: insertValuesMock } as any);

    vi.mocked(db.select)
      .mockReturnValueOnce(chain([{ id: 'd1', orgId: 'org-a' }, { id: 'd2', orgId: 'org-b' }]))
      .mockReturnValueOnce(chain([{ count: 500 }])) // org-a backpressured
      .mockReturnValueOnce(chain([{ count: 0 }])) // org-b admitted
      .mockReturnValueOnce(chain([])); // busy query

    const created = await schedulePolicyScans(entry as any, new Date('2026-09-18T02:00:00Z'));
    expect(created).toBe(1);
    expect(insertValuesMock).toHaveBeenCalledWith([
      expect.objectContaining({ deviceId: 'd2', orgId: 'org-b' }),
    ]);
  });

  it('returns 0 without touching the DB when the entry has no devices', async () => {
    const created = await schedulePolicyScans({ ...entry, deviceIds: [] } as any, new Date());
    expect(created).toBe(0);
    expect(db.select).not.toHaveBeenCalled();
  });
});

describe('buildSecurityScanPayload ruleSets (#6263 W03, W02 C1)', () => {
  const settings = { ...SECURITY_SCAN_SETTINGS_DEFAULTS, ruleSetIds: ['aaaaaaaa-0000-4000-8000-00000000000a'] };

  it('emits no ruleSets key when there are no refs, so the W01 payload shape is unchanged', () => {
    const withoutRefs = buildSecurityScanPayload('scan-1', 'quick', settings);
    const emptyRefs = buildSecurityScanPayload('scan-1', 'quick', settings, undefined, []);
    expect(withoutRefs).toEqual(emptyRefs);
    expect(Object.keys(withoutRefs).sort()).toEqual([
      'autoQuarantine', 'exclusions', 'maxFileSizeMb', 'scanRecordId', 'scanType', 'timeoutMinutes', 'triggerDefender',
    ]);
  });

  it('emits each ref with exactly the four C1 keys', () => {
    const ref = { id: 'a', version: 1, sha256: 'f'.repeat(64), url: '/api/v1/agents/x/yara/rule-sets/a/1', extra: 'nope' };
    const payload = buildSecurityScanPayload('scan-1', 'quick', settings, undefined, [ref as never]);
    expect(payload.ruleSets).toEqual([{ id: 'a', version: 1, sha256: 'f'.repeat(64), url: '/api/v1/agents/x/yara/rule-sets/a/1' }]);
  });
});
