import { beforeEach, describe, expect, it, vi } from 'vitest';

const { selectMock } = vi.hoisted(() => ({ selectMock: vi.fn() }));

const queueMock = {
  add: vi.fn(),
  getJob: vi.fn(),
  getRepeatableJobs: vi.fn(),
  removeRepeatableByKey: vi.fn(),
};

vi.mock('bullmq', () => ({
  Queue: vi.fn(function QueueMock() { return queueMock; }),
  Worker: vi.fn(function WorkerMock() { return { on: vi.fn(), close: vi.fn() }; }),
  Job: class {},
}));
vi.mock('../services/redis', () => ({
  getRedisConnection: vi.fn(() => ({})),
  getBullMQConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })),
  isBullMQAvailable: vi.fn(() => true),
}));
vi.mock('../db', () => ({
  db: { select: selectMock },
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));
vi.mock('../db/schema', () => ({
  deviceGroupMemberships: { deviceId: 'membership.deviceId', groupId: 'membership.groupId' },
  devices: {
    id: 'device.id',
    orgId: 'device.orgId',
    siteId: 'device.siteId',
    isEphemeral: 'device.isEphemeral',
    peripheralPolicyProtocolVersion: 'device.peripheralPolicyProtocolVersion',
  },
  organizations: { id: 'organization.id', partnerId: 'organization.partnerId', type: 'organization.type' },
  peripheralEvents: {},
  peripheralPolicies: {},
}));
vi.mock('../services/eventBus', () => ({ publishEvent: vi.fn() }));
vi.mock('../services/commandQueue', () => ({
  CommandTypes: {},
  queueCommand: vi.fn(),
  queueCommandForExecution: vi.fn(),
}));
vi.mock('../services/peripheralPolicyState', () => ({
  reconcilePeripheralPolicyDevice: vi.fn(),
}));

import {
  processPeripheralPolicyReconciliationSweep,
  resolvePeripheralPolicyDeviceIds,
  schedulePeripheralPolicyDevice,
  schedulePeripheralPolicyReconciliationSweep,
} from './peripheralJobs';

describe('schedulePeripheralPolicyDevice', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queueMock.add.mockResolvedValue({ id: 'new-job' });
    queueMock.getRepeatableJobs.mockResolvedValue([]);
    selectMock.mockReset();
  });

  it('uses one stable device-keyed job and coalesces a newer reason', async () => {
    const updateData = vi.fn().mockResolvedValue(undefined);
    queueMock.getJob.mockResolvedValue({
      id: 'existing-job',
      data: {
        type: 'policy-reconciliation',
        deviceId: 'device-1',
        reason: 'policy_changed',
        queuedAt: '2026-08-25T00:00:00.000Z',
      },
      getState: vi.fn().mockResolvedValue('waiting'),
      updateData,
    });

    await expect(schedulePeripheralPolicyDevice('device-1', 'membership_changed'))
      .resolves.toBe('existing-job');
    expect(updateData).toHaveBeenCalledWith(expect.objectContaining({
      deviceId: 'device-1',
      reason: 'membership_changed',
    }));
    expect(queueMock.add).not.toHaveBeenCalled();
  });

  it('creates a retryable job with a stable device id when none exists', async () => {
    queueMock.getJob.mockResolvedValue(null);

    await expect(schedulePeripheralPolicyDevice('device-2', 'policy_changed'))
      .resolves.toBe('new-job');
    expect(queueMock.add).toHaveBeenCalledWith(
      'policy-reconciliation',
      expect.objectContaining({ deviceId: 'device-2', reason: 'policy_changed' }),
      expect.objectContaining({ jobId: 'policy-reconciliation-device-2', attempts: 6 }),
    );
  });

  it('enqueues a follow-up instead of mutating an already active job', async () => {
    const updateData = vi.fn();
    queueMock.getJob.mockResolvedValue({
      id: 'policy-reconciliation-device-3',
      data: {
        type: 'policy-reconciliation',
        deviceId: 'device-3',
        reason: 'policy_changed',
        queuedAt: '2026-08-25T00:00:00.000Z',
      },
      getState: vi.fn().mockResolvedValue('active'),
      updateData,
    });
    queueMock.add.mockResolvedValue({ id: 'follow-up-job' });

    await expect(schedulePeripheralPolicyDevice('device-3', 'membership_changed'))
      .resolves.toBe('follow-up-job');
    expect(updateData).not.toHaveBeenCalled();
    expect(queueMock.add).toHaveBeenCalledWith(
      'policy-reconciliation',
      expect.objectContaining({ deviceId: 'device-3', reason: 'membership_changed' }),
      expect.objectContaining({
        jobId: expect.stringMatching(/^policy-reconciliation-device-3-follow-up-/),
      }),
    );
  });

  it('keyset-pages the fleet and lets reconciliation coalesce non-drifted devices', async () => {
    const loadPage = vi.fn()
      .mockResolvedValueOnce([{ id: 'device-1' }, { id: 'device-2' }])
      .mockResolvedValueOnce([{ id: 'device-3' }]);
    const reconcile = vi.fn()
      .mockResolvedValueOnce('coalesced')
      .mockResolvedValueOnce('queued')
      .mockResolvedValueOnce('incompatible');

    await expect(processPeripheralPolicyReconciliationSweep({
      pageSize: 2,
      loadPage,
      reconcile,
    })).resolves.toEqual({ scanned: 3, queued: 1, coalesced: 1, incompatible: 1 });
    expect(loadPage.mock.calls).toEqual([[null, 2], ['device-2', 2]]);
    expect(reconcile.mock.calls).toEqual([
      ['device-1', 'periodic_drift'],
      ['device-2', 'periodic_drift'],
      ['device-3', 'periodic_drift'],
    ]);
  });

  it('installs one jittered recurring sweep instead of synchronized fleet work', async () => {
    await schedulePeripheralPolicyReconciliationSweep(() => 0.5);

    expect(queueMock.add).toHaveBeenCalledWith(
      'policy-reconciliation-sweep',
      expect.objectContaining({ type: 'policy-reconciliation-sweep' }),
      expect.objectContaining({
        jobId: 'policy-reconciliation-sweep',
        repeat: { every: expect.any(Number) },
        delay: expect.any(Number),
      }),
    );
    const options = queueMock.add.mock.calls[0]?.[2];
    expect(options.delay).toBeGreaterThan(0);
    expect(options.delay).toBeLessThan(options.repeat.every);
  });

  it('resolves and deduplicates the exact devices targeted through group membership', async () => {
    selectMock.mockReturnValue({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            { id: 'device-2' },
            { id: 'device-1' },
            { id: 'device-2' },
          ]),
        }),
      }),
    });

    await expect(resolvePeripheralPolicyDeviceIds({
      orgId: 'org-1',
      partnerId: null,
      targetType: 'group',
      targetIds: { groupIds: ['group-1'] },
      isActive: true,
    })).resolves.toEqual(['device-1', 'device-2']);
  });

  it('does not scan or enqueue targets for an inactive policy snapshot', async () => {
    await expect(resolvePeripheralPolicyDeviceIds({
      orgId: 'org-1',
      partnerId: null,
      targetType: 'organization',
      targetIds: {},
      isActive: false,
    })).resolves.toEqual([]);
    expect(selectMock).not.toHaveBeenCalled();
  });
});
