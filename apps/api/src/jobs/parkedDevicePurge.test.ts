import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  addMock: vi.fn(),
  getRepeatableJobsMock: vi.fn(async () => [] as Array<{ key: string }>),
  removeRepeatableByKeyMock: vi.fn(),
  processor: { current: null as null | ((job: unknown) => Promise<unknown>) },
  candidates: [] as Array<{ deviceId: string; partnerId: string; decommissionedAt: Date | null }>,
  /** #11153 — the unconfirmed-uninstall COUNT, or an Error to make it throw. */
  unconfirmed: 0 as number | Error,
  wheres: [] as unknown[],
  captureMock: vi.fn(),
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
    select: (fields?: Record<string, unknown>) => ({
      from: () => ({
        innerJoin: () => ({
          where: (cond: unknown) => {
            h.wheres.push(cond);
            if (fields && 'unconfirmedCount' in fields) {
              return h.unconfirmed instanceof Error
                ? Promise.reject(h.unconfirmed)
                : Promise.resolve([{ unconfirmedCount: h.unconfirmed }]);
            }
            return { orderBy: () => ({ limit: async () => h.candidates }) };
          },
        }),
      }),
    }),
  },
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
  runOutsideDbContext: (fn: () => unknown) => fn(),
}));
vi.mock('../services/redis', () => ({ getBullMQConnection: vi.fn(() => ({})), getRedis: vi.fn(() => null) }));
vi.mock('../services/sentry', () => ({ captureException: h.captureMock }));
vi.mock('../services/auditService', () => ({ createAuditLog: h.auditMock }));
vi.mock('../services/agentOrgRateLimit', () => ({ invalidateOrgDeviceCount: h.invalidateMock }));
vi.mock('./workerObservability', () => ({ attachWorkerObservability: vi.fn() }));
vi.mock('../services/unassignedPool/parkedExpiry', () => ({ purgeExpiredParkedDevice: h.purgeMock }));

import { initializeParkedDevicePurge, runParkedDevicePurgeOnce, shutdownParkedDevicePurge } from './parkedDevicePurge';
import { jobSchedule } from './scheduleRegistry';
import { PARKED_PURGE_AFTER_EXPIRY_DAYS } from '../services/unassignedPool/limits';
import { PgDialect } from 'drizzle-orm/pg-core';

describe('runParkedDevicePurgeOnce', () => {
  beforeEach(() => {
    h.candidates = [];
    h.unconfirmed = 0;
    h.wheres = [];
    h.captureMock.mockClear();
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

  // #11153 — parked devices whose agent never confirmed the uninstall are not
  // candidates (the list is oldest-first and capped at 500, so leaving them in
  // would stall the sweep behind them); they are counted instead.
  it('keeps unconfirmed-uninstall devices out of the candidates and counts them', async () => {
    h.unconfirmed = 4;
    h.candidates = [{ deviceId: 'd1', partnerId: 'p1', decommissionedAt: new Date('2026-10-01T00:00:00.000Z') }];
    h.purgeMock
      .mockResolvedValueOnce({ purged: true, deviceId: 'd1', hostname: 'h1', holdingOrgId: 'pool-1', uninstallState: 'completed' });

    const summary = await runParkedDevicePurgeOnce(new Date('2026-12-01T00:00:00.000Z'));

    expect(summary).toMatchObject({ purged: 1, skippedUninstallNotConfirmed: 4 });
    const candidateWhere = new PgDialect().sqlToQuery(h.wheres[0] as never);
    expect(candidateWhere.sql).toContain('device_reattachments');
    expect(candidateWhere.params).toEqual(expect.arrayContaining(['completed', 'pending']));
    const countWhere = new PgDialect().sqlToQuery(h.wheres[1] as never);
    expect(countWhere.sql).toMatch(/not\s*\(/i);
    expect(h.auditMock).toHaveBeenCalledWith(expect.objectContaining({
      resourceId: 'd1',
      details: expect.objectContaining({ uninstallState: 'completed', force: false }),
    }));
  });

  it('counts a lock-time UNINSTALL_NOT_CONFIRMED as that skip, and survives a failed count', async () => {
    h.unconfirmed = new Error('count failed');
    h.candidates = [{ deviceId: 'd1', partnerId: 'p1', decommissionedAt: new Date('2026-10-01T00:00:00.000Z') }];
    h.purgeMock.mockResolvedValueOnce({ purged: false, deviceId: 'd1', reason: 'UNINSTALL_NOT_CONFIRMED' });

    const summary = await runParkedDevicePurgeOnce(new Date('2026-12-01T00:00:00.000Z'));

    expect(summary).toMatchObject({ skippedUninstallNotConfirmed: 1, skippedOther: 0, failed: 0 });
    expect(h.captureMock).toHaveBeenCalled();
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
