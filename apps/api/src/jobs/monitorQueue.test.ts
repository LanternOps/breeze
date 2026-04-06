import { beforeEach, describe, expect, it, vi } from 'vitest';

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
  Worker: class {},
  Job: class {},
  UnrecoverableError: class extends Error {},
}));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    transaction: vi.fn(),
  },
  withSystemDbAccessContext: undefined,
}));

vi.mock('../db/schema', () => ({
  networkMonitors: {
    id: 'networkMonitors.id',
    orgId: 'networkMonitors.orgId',
    assetId: 'networkMonitors.assetId',
    consecutiveFailures: 'networkMonitors.consecutiveFailures',
    pollingInterval: 'networkMonitors.pollingInterval',
    isActive: 'networkMonitors.isActive',
    lastChecked: 'networkMonitors.lastChecked',
  },
  networkMonitorResults: {
    monitorId: 'networkMonitorResults.monitorId',
  },
  devices: {
    id: 'devices.id',
    orgId: 'devices.orgId',
    siteId: 'devices.siteId',
    status: 'devices.status',
    lastSeenAt: 'devices.lastSeenAt',
    enrolledAt: 'devices.enrolledAt',
    agentId: 'devices.agentId',
  },
  networkMonitorAlertRules: {
    monitorId: 'networkMonitorAlertRules.monitorId',
    isActive: 'networkMonitorAlertRules.isActive',
    $inferSelect: {},
  },
  alerts: {
    id: 'alerts.id',
    orgId: 'alerts.orgId',
    deviceId: 'alerts.deviceId',
    status: 'alerts.status',
    context: 'alerts.context',
  },
  discoveredAssets: {
    id: 'discoveredAssets.id',
    orgId: 'discoveredAssets.orgId',
    linkedDeviceId: 'discoveredAssets.linkedDeviceId',
    siteId: 'discoveredAssets.siteId',
  },
}));

vi.mock('../services/redis', () => ({
  getRedisConnection: vi.fn(() => ({})),
}));

vi.mock('../routes/agentWs', () => ({
  sendCommandToAgent: vi.fn(),
  isAgentConnected: vi.fn(),
}));

vi.mock('../routes/monitors', () => ({
  buildMonitorCommand: vi.fn(),
}));

vi.mock('../services/alertCooldown', () => ({
  isCooldownActive: vi.fn(async () => false),
  setCooldown: vi.fn(async () => undefined),
}));

vi.mock('../services/alertService', () => ({
  resolveAlert: vi.fn(async () => undefined),
}));

import { enqueueMonitorCheckResult, shutdownMonitorWorker } from './monitorWorker';

describe('monitor queue helpers', () => {
  beforeEach(async () => {
    getJobMock.mockReset();
    addMock.mockReset();
    closeMock.mockReset();
    addMock.mockResolvedValue({ id: 'job-1' });
    await shutdownMonitorWorker();
  });

  it('uses a stable BullMQ job id for monitor result processing', async () => {
    getJobMock.mockResolvedValue(null);

    await enqueueMonitorCheckResult('monitor-1', {
      monitorId: 'monitor-1',
      checkId: 'mon-monitor-1-123',
      status: 'online',
      responseMs: 12,
    });

    expect(addMock).toHaveBeenCalledWith(
      'process-check-result',
      expect.objectContaining({
        monitorId: 'monitor-1',
        result: expect.objectContaining({ checkId: 'mon-monitor-1-123' }),
      }),
      expect.objectContaining({ jobId: 'monitor-result:mon-monitor-1-123' }),
    );
  });

  it('reuses an active monitor result job for the same check id', async () => {
    getJobMock.mockResolvedValue({
      id: 'existing-job',
      getState: vi.fn().mockResolvedValue('active'),
    });

    const jobId = await enqueueMonitorCheckResult('monitor-1', {
      monitorId: 'monitor-1',
      checkId: 'mon-monitor-1-123',
      status: 'online',
      responseMs: 12,
    });

    expect(addMock).not.toHaveBeenCalled();
    expect(jobId).toBe('existing-job');
  });

  it('rejects malformed monitor result payloads before enqueueing', async () => {
    getJobMock.mockResolvedValue(null);

    await expect(
      enqueueMonitorCheckResult('monitor-1', {
        monitorId: 'monitor-1',
        checkId: 'mon-monitor-1-123',
        status: 'online',
        responseMs: -1,
      } as any),
    ).rejects.toThrow();

    expect(addMock).not.toHaveBeenCalled();
  });
});
