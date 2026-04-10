import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    transaction: vi.fn()
  }
}));

vi.mock('bullmq', () => ({
  Queue: class {},
  Worker: class {},
  Job: class {},
  UnrecoverableError: class extends Error {},
}));

vi.mock('../db', () => ({
  db: mockDb,
  withSystemDbAccessContext: undefined
}));

vi.mock('../db/schema', () => ({
  networkMonitors: {
    id: 'networkMonitors.id',
    orgId: 'networkMonitors.orgId',
    assetId: 'networkMonitors.assetId',
    consecutiveFailures: 'networkMonitors.consecutiveFailures'
  },
  networkMonitorResults: {
    monitorId: 'networkMonitorResults.monitorId'
  },
  devices: {
    id: 'devices.id',
    orgId: 'devices.orgId',
    siteId: 'devices.siteId',
    lastSeenAt: 'devices.lastSeenAt',
    enrolledAt: 'devices.enrolledAt'
  },
  networkMonitorAlertRules: {
    monitorId: 'networkMonitorAlertRules.monitorId',
    isActive: 'networkMonitorAlertRules.isActive',
    $inferSelect: {}
  },
  alerts: {
    id: 'alerts.id',
    orgId: 'alerts.orgId',
    deviceId: 'alerts.deviceId',
    status: 'alerts.status',
    context: 'alerts.context'
  },
  discoveredAssets: {
    id: 'discoveredAssets.id',
    orgId: 'discoveredAssets.orgId',
    linkedDeviceId: 'discoveredAssets.linkedDeviceId',
    siteId: 'discoveredAssets.siteId'
  }
}));

vi.mock('../services/redis', () => ({
  getRedisConnection: vi.fn(() => ({})),
  getBullMQConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })),
  isBullMQAvailable: vi.fn(() => true),
}));

vi.mock('../routes/agentWs', () => ({
  sendCommandToAgent: vi.fn(),
  isAgentConnected: vi.fn()
}));

vi.mock('../routes/monitors', () => ({
  buildMonitorCommand: vi.fn()
}));

vi.mock('../services/alertCooldown', () => ({
  isCooldownActive: vi.fn(async () => false),
  setCooldown: vi.fn(async () => undefined)
}));

vi.mock('../services/alertService', () => ({
  resolveAlert: vi.fn(async () => undefined)
}));

import { db } from '../db';
import { isCooldownActive, setCooldown } from '../services/alertCooldown';
import { resolveAlert } from '../services/alertService';

function selectLimitResolved(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(rows)
      })
    })
  };
}

function selectWhereResolved(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(rows)
    })
  };
}

function selectWhereOrderLimitResolved(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        orderBy: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(rows)
        })
      })
    })
  };
}

const { recordMonitorCheckResult } = await import('./monitorWorker');

describe('recordMonitorCheckResult', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.transaction).mockImplementation(async (callback: any) => callback({
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockResolvedValue(undefined)
      }),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined)
        })
      })
    }));
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockResolvedValue(undefined)
    } as any);
  });

  it('creates a monitor alert when an active rule matches', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(selectLimitResolved([{
        id: 'monitor-1',
        orgId: 'org-1',
        assetId: null,
        name: 'Edge Ping',
        target: '8.8.8.8',
        monitorType: 'icmp_ping',
        consecutiveFailures: 3
      }]) as any)
      .mockReturnValueOnce(selectWhereResolved([{
        id: 'rule-1',
        monitorId: 'monitor-1',
        condition: 'offline',
        threshold: null,
        severity: 'high',
        message: null,
        isActive: true
      }]) as any)
      .mockReturnValueOnce(selectWhereOrderLimitResolved([{ id: 'device-1' }]) as any)
      .mockReturnValueOnce(selectWhereResolved([]) as any);

    await recordMonitorCheckResult('monitor-1', {
      monitorId: 'monitor-1',
      status: 'offline',
      responseMs: 250,
      error: 'timeout'
    });

    expect(vi.mocked(db.insert)).toHaveBeenCalledWith(expect.anything());
    expect(vi.mocked(isCooldownActive)).toHaveBeenCalledWith('rule-1', 'device-1');
    expect(vi.mocked(setCooldown)).toHaveBeenCalledWith('rule-1', 'device-1', 5);
    expect(vi.mocked(resolveAlert)).not.toHaveBeenCalled();
  });

  it('auto-resolves matching alerts when the monitor recovers', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(selectLimitResolved([{
        id: 'monitor-1',
        orgId: 'org-1',
        assetId: null,
        name: 'Edge Ping',
        target: '8.8.8.8',
        monitorType: 'icmp_ping',
        consecutiveFailures: 0
      }]) as any)
      .mockReturnValueOnce(selectWhereResolved([{
        id: 'rule-1',
        monitorId: 'monitor-1',
        condition: 'offline',
        threshold: null,
        severity: 'high',
        message: null,
        isActive: true
      }]) as any)
      .mockReturnValueOnce(selectWhereOrderLimitResolved([{ id: 'device-1' }]) as any)
      .mockReturnValueOnce(selectWhereResolved([{ id: 'alert-1' }]) as any);

    await recordMonitorCheckResult('monitor-1', {
      monitorId: 'monitor-1',
      status: 'online',
      responseMs: 22
    });

    expect(vi.mocked(resolveAlert)).toHaveBeenCalledWith(
      'alert-1',
      expect.stringContaining('recovered from offline')
    );
    expect(vi.mocked(db.insert)).not.toHaveBeenCalled();
    expect(vi.mocked(setCooldown)).not.toHaveBeenCalled();
  });
});
