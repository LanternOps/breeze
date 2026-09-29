import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  addMock: vi.fn(),
  getRepeatableJobsMock: vi.fn(async () => [] as Array<{ key: string }>),
  removeRepeatableByKeyMock: vi.fn(),
  processor: { current: null as null | ((job: unknown) => Promise<unknown>) },
  candidates: [] as Array<{ deviceId: string; partnerId: string; decommissionedAt: Date | null }>,
  purgeMock: vi.fn(),
  auditMock: vi.fn(async () => undefined),
  invalidateMock: vi.fn(async () => undefined),
}));

vi.mock('bullmq', () => ({
  Queue: class {
    add = (...args: unknown[]) => h.addMock(...args);
    getRepeatableJobs = () => h.getRepeatableJobsMock();
    removeRepeatableByKey = (...args: unknown[]) => h.removeRepeatableByKeyMock(...args);
    close = vi.fn();
  },
  Worker: class {
    constructor(_name: string, processor: (job: unknown) => Promise<unknown>) { h.processor.current = processor; }
    on = vi.fn();
    close = vi.fn();
  },
}));
vi.mock('../db', () => ({
  db: {
    select: () => ({ from: () => ({ innerJoin: () => ({ where: () => ({ orderBy: () => ({ limit: async () => h.candidates }) }) }) }) }),
  },
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
  runOutsideDbContext: (fn: () => unknown) => fn(),
}));
vi.mock('../services/redis', () => ({ getBullMQConnection: vi.fn(() => ({})), getRedis: vi.fn(() => null) }));
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../services/auditService', () => ({ createAuditLog: h.auditMock }));
vi.mock('../services/agentOrgRateLimit', () => ({ invalidateOrgDeviceCount: h.invalidateMock }));
vi.mock('./workerObservability', () => ({ attachWorkerObservability: vi.fn() }));
vi.mock('../services/unassignedPool/parkedExpiry', () => ({ purgeExpiredParkedDevice: h.purgeMock }));

import { initializeParkedDevicePurge, runParkedDevicePurgeOnce, shutdownParkedDevicePurge } from './parkedDevicePurge';
import { jobSchedule } from './scheduleRegistry';
import { PARKED_PURGE_AFTER_EXPIRY_DAYS } from '../services/unassignedPool/limits';

describe('runParkedDevicePurgeOnce', () => {
  beforeEach(() => {
    h.candidates = [];
    h.purgeMock.mockReset();
    h.auditMock.mockClear();
    h.invalidateMock.mockClear();
  });

  it('purges with the SELECT cutoff re-applied, audits each deletion, and isolates failures', async () => {
    const now = new Date('2026-12-01T00:00:00.000Z');
    const at = new Date('2026-10-01T00:00:00.000Z');
    h.candidates = [
      { deviceId: 'd1', partnerId: 'p1', decommissionedAt: at },
      { deviceId: 'd2', partnerId: 'p1', decommissionedAt: at },
      { deviceId: 'd3', partnerId: 'p1', decommissionedAt: at },
    ];
    h.purgeMock
      .mockResolvedValueOnce({ purged: true, deviceId: 'd1', hostname: 'h1', holdingOrgId: 'pool-1' })
      .mockRejectedValueOnce(new Error('lock timeout'))
      .mockResolvedValueOnce({ purged: false, deviceId: 'd3', reason: 'UNINSTALL_PENDING' });

    const summary = await runParkedDevicePurgeOnce(now);
    expect(summary).toMatchObject({ candidates: 3, purged: 1, failed: 1, skippedUninstallPending: 1 });
    const cutoff = new Date(now.getTime() - PARKED_PURGE_AFTER_EXPIRY_DAYS * 86_400_000);
    expect(h.purgeMock).toHaveBeenCalledWith({ partnerId: 'p1', deviceId: 'd1', cutoff });
    expect(h.auditMock).toHaveBeenCalledTimes(1);
    expect(h.auditMock).toHaveBeenCalledWith(expect.objectContaining({
      orgId: 'pool-1', action: 'device.permanent_delete', resourceId: 'd1', initiatedBy: 'schedule',
    }));
    expect(h.invalidateMock).toHaveBeenCalledWith(null, 'pool-1');
  });
});

beforeEach(() => {
  h.candidates = [];
});

describe('parkedDevicePurge worker registration', () => {
  it('registers on its allocated cron slot and the Worker runs the sweep', async () => {
    await initializeParkedDevicePurge();
    const options = h.addMock.mock.calls[0]![2] as { repeat?: { pattern?: string; every?: number } };
    expect(options.repeat).toEqual({ pattern: jobSchedule('parked-device-purge') });
    expect(await h.processor.current!({ data: {} })).toMatchObject({ candidates: 0 });
    await shutdownParkedDevicePurge();
  });
});
