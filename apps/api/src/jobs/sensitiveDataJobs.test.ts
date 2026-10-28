import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getJobMock, addMock, closeMock } = vi.hoisted(() => ({
  getJobMock: vi.fn(),
  addMock: vi.fn(),
  closeMock: vi.fn(),
}));

vi.mock('bullmq', () => ({
  Queue: class {
    getJob = getJobMock;
    add = addMock;
    close = closeMock;
  },
  Worker: class {
    __processor: unknown;
    constructor(_name: string, processor: unknown) {
      this.__processor = processor;
    }
  },
  Job: class {},
}));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    update: vi.fn(),
    insert: vi.fn(),
    transaction: vi.fn(),
  },
  withSystemDbAccessContext: undefined,
}));

vi.mock('../db/schema', () => ({
  deviceCommands: {},
  devices: {},
  organizations: {},
  sensitiveDataPolicies: {},
  sensitiveDataScans: {},
}));

vi.mock('../services/redis', () => ({
  getRedisConnection: vi.fn(() => ({})),
  getBullMQConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })),
  isBullMQAvailable: vi.fn(() => true),
}));

vi.mock('../services/commandQueue', () => ({
  CommandTypes: {
    SENSITIVE_DATA_SCAN: 'sensitive_data_scan',
  },
  queueCommandForExecution: vi.fn(),
}));

vi.mock('../services/auditEvents', () => ({
  writeAuditEvent: vi.fn(),
  requestLikeFromSnapshot: vi.fn(() => ({ req: { header: () => undefined } })),
}));

vi.mock('../services/cronDue', () => ({
  isCronDue: vi.fn(),
}));

import { db } from '../db';
import { queueCommandForExecution } from '../services/commandQueue';
import { writeAuditEvent } from '../services/auditEvents';
import { isCronDue } from '../services/cronDue';
import {
  createSensitiveDataWorker,
  enqueueSensitiveDataScan,
  processDispatchScan,
  shouldSchedulePolicy,
  shutdownSensitiveDataWorkers,
} from './sensitiveDataJobs';

describe('shouldSchedulePolicy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns false for disabled or manual schedules', () => {
    const now = new Date('2026-02-26T12:00:00.000Z');
    expect(shouldSchedulePolicy({ enabled: false, type: 'interval', intervalMinutes: 15 }, now)).toBe(false);
    expect(shouldSchedulePolicy({ enabled: true, type: 'manual' }, now)).toBe(false);
  });

  it('handles interval schedules with and without lastRunAt', () => {
    const now = new Date('2026-02-26T12:00:00.000Z');
    expect(shouldSchedulePolicy({ enabled: true, type: 'interval', intervalMinutes: 15 }, now)).toBe(true);
    expect(shouldSchedulePolicy({
      enabled: true,
      type: 'interval',
      intervalMinutes: 15,
      lastRunAt: '2026-02-26T11:40:00.000Z'
    }, now)).toBe(true);
    expect(shouldSchedulePolicy({
      enabled: true,
      type: 'interval',
      intervalMinutes: 15,
      lastRunAt: '2026-02-26T11:50:30.000Z'
    }, now)).toBe(false);
  });

  it('evaluates cron schedules and avoids same-minute duplicates', () => {
    const now = new Date('2026-02-26T12:00:00.000Z');
    vi.mocked(isCronDue).mockReturnValue(true);

    expect(shouldSchedulePolicy({
      enabled: true,
      type: 'cron',
      cron: '*/5 * * * *',
      timezone: 'UTC'
    }, now)).toBe(true);
    expect(isCronDue).toHaveBeenCalledTimes(1);

    expect(shouldSchedulePolicy({
      enabled: true,
      type: 'cron',
      cron: '*/5 * * * *',
      timezone: 'UTC',
      lastRunAt: '2026-02-26T12:00:25.000Z'
    }, now)).toBe(false);
    expect(isCronDue).toHaveBeenCalledTimes(1);
  });
});

describe('schedule-policies repeatable tick evaluates schedules on the wall clock (#10031)', () => {
  // BullMQ hands every repeat of a repeatable job the data it was registered
  // with, so `scanAt` is boot time forever. Due-ness must follow the clock.
  const REGISTERED = { type: 'schedule-policies', scanAt: '2026-09-18T01:58:00.000Z' } as const;
  const policy = {
    id: 'policy-1',
    orgId: 'org-1',
    partnerId: null,
    isActive: true,
    schedule: { enabled: true, type: 'cron', cron: '0 2 * * *', timezone: 'UTC' },
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    const actual = await vi.importActual<typeof import('../services/cronDue')>('../services/cronDue');
    vi.mocked(isCronDue).mockImplementation(actual.isCronDue);
    const policyRows: any = Promise.resolve([policy]);
    policyRows.from = () => policyRows;
    policyRows.where = () => policyRows;
    vi.mocked(db.select).mockReset().mockReturnValue(policyRows);
    // The occurrence claim re-checks under its own lock; null = lost the claim.
    vi.mocked(db.transaction).mockReset().mockResolvedValue(null as never);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('two ticks of the same registration across the 02:00 boundary: the second one claims the occurrence', async () => {
    const processor = (createSensitiveDataWorker() as unknown as {
      __processor: (job: unknown) => Promise<unknown>;
    }).__processor;
    const tick = () => processor({ name: 'schedule-policies', data: REGISTERED, id: 'repeat:1' });

    vi.setSystemTime(new Date('2026-09-18T01:59:30.000Z'));
    await tick();
    expect(vi.mocked(isCronDue).mock.calls[0]![2]).toEqual(new Date('2026-09-18T01:59:30.000Z'));
    expect(db.transaction).not.toHaveBeenCalled();

    vi.setSystemTime(new Date('2026-09-18T02:00:30.000Z'));
    await tick();
    expect(vi.mocked(isCronDue).mock.calls[1]![2]).toEqual(new Date('2026-09-18T02:00:30.000Z'));
    expect(db.transaction).toHaveBeenCalledTimes(1);
  });
});

describe('enqueueSensitiveDataScan', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    getJobMock.mockResolvedValue(null);
    addMock.mockResolvedValue({ id: 'queue-job-1' });
    await shutdownSensitiveDataWorkers();
  });

  it('uses a stable BullMQ job id for scan dispatch', async () => {
    await enqueueSensitiveDataScan('scan-123');

    expect(addMock).toHaveBeenCalledWith(
      'dispatch-scan',
      { type: 'dispatch-scan', scanId: 'scan-123', origin: 'manual' },
      expect.objectContaining({ jobId: 'sensitive-scan-scan-123' }),
    );
  });

  it('reuses an active scan dispatch job for the same scan id', async () => {
    getJobMock.mockResolvedValue({
      id: 'existing-job',
      getState: vi.fn().mockResolvedValue('delayed'),
    });

    const jobId = await enqueueSensitiveDataScan('scan-123');

    expect(addMock).not.toHaveBeenCalled();
    expect(jobId).toBe('existing-job');
  });
});


describe('processDispatchScan manual ownership fence', () => {
  const setMock = vi.fn();
  const scan = {
    id: 'scan-1', orgId: 'org-1', deviceId: 'device-1', deviceOrgId: 'org-1',
    status: 'queued', policyAuthorityGeneration: null, policyId: null,
    requestedBy: null, startedAt: null, summary: { request: { detectionClasses: ['credential'] } },
  };

  function chain(rows: unknown): any {
    const result: any = Promise.resolve(rows);
    for (const method of ['from', 'leftJoin', 'innerJoin', 'where', 'limit', 'for', 'returning']) {
      result[method] = () => result;
    }
    return result;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.select).mockReset().mockReturnValue(chain([{ count: 0 }]));
    setMock.mockImplementation(() => chain([{ id: scan.id }]));
    vi.mocked(db.update).mockReturnValue({ set: setMock } as any);
    vi.mocked(queueCommandForExecution).mockResolvedValue({ command: { id: 'cmd-1', status: 'pending' } } as any);
  });

  it('fails a manual scan after an org move without dispatching', async () => {
    vi.mocked(db.select).mockReturnValueOnce(chain([{ ...scan, deviceOrgId: 'org-2' }]));

    expect(await processDispatchScan({ type: 'dispatch-scan', scanId: scan.id, origin: 'manual' }))
      .toEqual({ dispatched: false, commandId: null });
    expect(queueCommandForExecution).not.toHaveBeenCalled();
    expect(setMock).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed',
      summary: expect.objectContaining({ dispatch: expect.objectContaining({ error: 'device_org_changed' }) }),
    }));
    expect(writeAuditEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      orgId: scan.orgId, result: 'failure', errorMessage: 'device_org_changed',
    }));
  });

  it('records an org move caught by the final queue fence', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(chain([scan]))
      .mockReturnValueOnce(chain([{ count: 0 }]))
      .mockReturnValueOnce(chain([{ count: 0 }]))
      .mockReturnValueOnce(chain([{ count: 0 }]))
      .mockReturnValueOnce(chain([{ orgId: 'org-2' }]));
    vi.mocked(queueCommandForExecution).mockResolvedValueOnce({ error: 'Device not found' });

    expect(await processDispatchScan({ type: 'dispatch-scan', scanId: scan.id, origin: 'manual' }))
      .toEqual({ dispatched: false, commandId: null });
    expect(setMock).toHaveBeenLastCalledWith(expect.objectContaining({
      status: 'failed',
      summary: expect.objectContaining({ dispatch: expect.objectContaining({ error: 'device_org_changed' }) }),
    }));
    expect(writeAuditEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      orgId: scan.orgId, result: 'failure', errorMessage: 'device_org_changed',
    }));
  });

  it('dispatches an unchanged manual scan with the deciding organization fence', async () => {
    vi.mocked(db.select).mockReturnValueOnce(chain([scan]));

    expect(await processDispatchScan({ type: 'dispatch-scan', scanId: scan.id, origin: 'manual' }))
      .toEqual({ dispatched: true, commandId: 'cmd-1' });
    expect(queueCommandForExecution).toHaveBeenCalledWith(scan.deviceId, 'sensitive_data_scan',
      expect.objectContaining({ scanId: scan.id }), expect.objectContaining({ expectedOrgId: scan.orgId }));
  });
});
