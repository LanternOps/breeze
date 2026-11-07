import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  addMock: vi.fn(),
  getRepeatableJobsMock: vi.fn(async () => [] as Array<{ key: string }>),
  removeRepeatableByKeyMock: vi.fn(),
  processor: { current: null as null | ((job: unknown) => Promise<unknown>) },
  candidates: [] as Array<{ deviceId: string; partnerId: string }>,
  whereArgs: [] as unknown[],
  expireMock: vi.fn(),
  decommission: vi.fn(),
  purgeRemoved: vi.fn(),
  lockDevice: vi.fn(),
  ledger: vi.fn(),
  transactionEvents: [] as string[],
  transaction: vi.fn(),
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
    transaction: h.transaction,
    select: () => ({ from: () => ({ innerJoin: () => ({ where: (arg: unknown) => {
      h.whereArgs.push(arg);
      return { orderBy: () => ({ limit: async () => h.candidates }) };
    } }) }) }),
  },
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
  runOutsideDbContext: (fn: () => unknown) => fn(),
}));
vi.mock('../services/redis', () => ({ getBullMQConnection: vi.fn(() => ({})), getRedis: vi.fn() }));
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));
vi.mock('./workerObservability', () => ({ attachWorkerObservability: vi.fn() }));
vi.mock('../services/unassignedPool/parkedExpiry', () => ({ expireParkedDevice: h.expireMock }));

import { initializeParkedDeviceExpiry, runParkedDeviceExpiryOnce, shutdownParkedDeviceExpiry } from './parkedDeviceExpiry';
import { jobSchedule } from './scheduleRegistry';
import { PARKED_DEVICE_TTL_DAYS } from '../services/unassignedPool/limits';

describe('runParkedDeviceExpiryOnce', () => {
  beforeEach(() => {
    h.candidates = [];
    h.whereArgs.length = 0;
    h.expireMock.mockReset();
  });

  it('expires each candidate with the SELECT cutoff re-applied, and one failure does not stop the sweep', async () => {
    const now = new Date('2026-10-01T00:00:00.000Z');
    h.candidates = [
      { deviceId: 'd1', partnerId: 'p1' },
      { deviceId: 'd2', partnerId: 'p1' },
      { deviceId: 'd3', partnerId: 'p2' },
    ];
    h.expireMock
      .mockResolvedValueOnce({ expired: true, deviceId: 'd1' })
      .mockRejectedValueOnce(new Error('deadlock'))
      .mockResolvedValueOnce({ expired: false, deviceId: 'd3', reason: 'NOT_PARKED' });

    const summary = await runParkedDeviceExpiryOnce(now);
    expect(summary).toMatchObject({ candidates: 3, expired: 1, failed: 1, skippedRaced: 1 });
    const cutoff = new Date(now.getTime() - PARKED_DEVICE_TTL_DAYS * 86_400_000);
    expect(h.expireMock).toHaveBeenCalledWith({ partnerId: 'p1', deviceId: 'd1', actorUserId: null, reason: 'parking_window', cutoff });
    expect(h.expireMock).toHaveBeenCalledTimes(3);
  });
});

beforeEach(() => {
  h.candidates = [];
});

describe('parkedDeviceExpiry worker registration', () => {
  it('registers on its allocated cron slot and the Worker runs the sweep', async () => {
    h.getRepeatableJobsMock.mockResolvedValueOnce([{ key: 'stale' }]);
    await initializeParkedDeviceExpiry();
    expect(h.removeRepeatableByKeyMock).toHaveBeenCalledWith('stale');
    const options = h.addMock.mock.calls[0]![2] as { repeat?: { pattern?: string; every?: number } };
    expect(options.repeat).toEqual({ pattern: jobSchedule('parked-device-expiry') });
    expect(await h.processor.current!({ data: {} })).toMatchObject({ candidates: 0 });
    await shutdownParkedDeviceExpiry();
  });
});


// Exercise the real per-device lifecycle boundary as well as the worker above.
vi.mock('../services/deviceDecommission', () => ({ decommissionDeviceInTransaction: h.decommission }));
vi.mock('../services/deviceLifecycle', () => ({
  purgeRemovedDevice: h.purgeRemoved,
  DeviceLifecycleError: class extends Error {},
}));
vi.mock('../services/unassignedPool/holdingAreaLock', () => ({ lockPartnerHoldingArea: vi.fn() }));
vi.mock('../services/unassignedPool/assignParkedDeviceSteps', () => ({ lockDeviceForAssignment: h.lockDevice }));
vi.mock('../services/deviceReattach/intentStore', () => ({
  lockOpenReattachIntentsOfDevice: vi.fn(async () => []),
  endIntentInTransaction: vi.fn(),
  revokeCertificatesAfterCommit: vi.fn(),
}));
vi.mock('../services/deviceReattach/audit', () => ({ writeReattachAudit: vi.fn() }));
vi.mock('../services/deviceReattach/sourceMarker', () => ({ clearReattachSourceMarker: vi.fn() }));
vi.mock('../services/auditService', () => ({ createAuditLog: vi.fn() }));
vi.mock('../services/agentOrgRateLimit', () => ({ invalidateOrgDeviceCount: vi.fn(async () => undefined) }));
vi.mock('../routes/agentWs', () => ({ disconnectAgent: vi.fn() }));

import { NetworkIsolationUnresolvedError } from '../services/networkIsolation/lifecycle';

describe('parked lifecycle isolation refusals', () => {
  const deviceId = '44444444-4444-4444-8444-444444444444';
  const partnerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  beforeEach(() => {
    h.transactionEvents.length = 0;
    h.ledger.mockReset();
    h.decommission.mockReset();
    h.purgeRemoved.mockReset();
    h.decommission.mockResolvedValue({ updated: { decommissionedAt: new Date() }, uninstallQueued: true });
    h.purgeRemoved.mockResolvedValue({});
    h.lockDevice.mockResolvedValue({
      id: deviceId, orgPartnerId: partnerId, orgType: 'unassigned_pool', status: 'online',
      agentId: 'agent-1', hostname: 'host-1', orgId: 'holding-org', createdAt: new Date('2026-01-01'),
    });
    h.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      try {
        const result = await fn({
          execute: async () => [{ decommissioned_at: new Date('2026-02-01') }],
          insert: () => ({ values: (row: unknown) => {
            h.ledger(row);
            return { returning: async () => [{ id: 'ledger-1' }] };
          } }),
        });
        h.transactionEvents.push('commit');
        return result;
      } catch (error) {
        h.transactionEvents.push('rollback');
        throw error;
      }
    });
  });

  it('rolls back and skips an isolated expiry, then expires the next resolved device', async () => {
    const { expireParkedDevice } = await vi.importActual<typeof import('../services/unassignedPool/parkedExpiry')>('../services/unassignedPool/parkedExpiry');
    h.decommission.mockRejectedValueOnce(new NetworkIsolationUnresolvedError('decommission', [{ deviceId, isolationId: 'isolation-1' }]));
    const input = { partnerId, deviceId, actorUserId: null, reason: 'parking_window' as const };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(await expireParkedDevice(input)).toEqual({ expired: false, deviceId, reason: 'isolation_unresolved' });
      expect(h.transactionEvents).toEqual(['rollback']);
      expect(h.ledger).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.any(String), { deviceId, isolationIds: ['isolation-1'] });
      expect(await expireParkedDevice(input)).toMatchObject({ expired: true, deviceId });
      expect(h.transactionEvents).toEqual(['rollback', 'commit']);
    } finally { warn.mockRestore(); }
  });

  it('rolls back and skips isolated purge, then purges once isolation resolves', async () => {
    const { purgeExpiredParkedDevice } = await vi.importActual<typeof import('../services/unassignedPool/parkedExpiry')>('../services/unassignedPool/parkedExpiry');
    h.lockDevice.mockResolvedValue({
      id: deviceId, orgPartnerId: partnerId, orgType: 'unassigned_pool', status: 'decommissioned',
      agentId: 'agent-1', hostname: 'host-1', orgId: 'holding-org', createdAt: new Date('2026-01-01'),
    });
    h.purgeRemoved.mockRejectedValueOnce(new NetworkIsolationUnresolvedError('delete', [{ deviceId, isolationId: 'isolation-1' }]));
    const input = { partnerId, deviceId, cutoff: new Date('2026-03-01') };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(await purgeExpiredParkedDevice(input)).toEqual({ purged: false, deviceId, reason: 'isolation_unresolved' });
      expect(h.transactionEvents).toEqual(['rollback']);
      expect(h.ledger).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.any(String), { deviceId, isolationIds: ['isolation-1'] });
      expect(await purgeExpiredParkedDevice(input)).toMatchObject({ purged: true, deviceId });
      expect(h.transactionEvents).toEqual(['rollback', 'commit']);
    } finally { warn.mockRestore(); }
  });
});
