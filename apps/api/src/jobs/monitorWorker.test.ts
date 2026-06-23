import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockDb, ctxState, queueMock } = vi.hoisted(() => ({
  mockDb: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    transaction: vi.fn()
  },
  // Tracks DB-access-context depth + an ordered event log so a test can prove
  // the monitor scheduler READS inside a context but ENQUEUES outside one (#1105).
  ctxState: { depth: 0, events: [] as string[] },
  queueMock: {
    getJob: vi.fn(async () => null),
    add: vi.fn(async () => ({ id: 'job-1' })),
    getRepeatableJobs: vi.fn(async () => []),
    removeRepeatableByKey: vi.fn(async () => undefined),
  },
}));

vi.mock('bullmq', () => ({
  Queue: class {
    getJob = queueMock.getJob;
    add = queueMock.add;
    getRepeatableJobs = queueMock.getRepeatableJobs;
    removeRepeatableByKey = queueMock.removeRepeatableByKey;
  },
  Worker: class {},
  Job: class {},
  UnrecoverableError: class extends Error {},
}));

vi.mock('../db', () => ({
  db: mockDb,
  // Real-ish context wrapper: tracks depth around fn so the scheduler test can
  // assert which work runs inside the context vs after it closes.
  withSystemDbAccessContext: async (fn: () => unknown) => {
    ctxState.depth++;
    ctxState.events.push('ctx:enter');
    try {
      return await fn();
    } finally {
      ctxState.depth--;
      ctxState.events.push('ctx:exit');
    }
  },
  // #1105 tripwire wired into createInstrumentedQueue's add(). Mirror prod
  // semantics: record a violation if an enqueue runs while a context is held.
  assertOutsideHeldDbContext: (op: string) => {
    if (ctxState.depth > 0) ctxState.events.push(`tripwire-violation:${op}`);
  }
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

const { recordMonitorCheckResult, processScheduler } = await import('./monitorWorker');

describe('processScheduler (#1105 connection-hold)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ctxState.depth = 0;
    ctxState.events = [];
    queueMock.getJob.mockResolvedValue(null);
    queueMock.add.mockImplementation(async () => {
      ctxState.events.push(`enqueue@depth${ctxState.depth}`);
      return { id: 'job-1' };
    });
  });

  function mockDueMonitors(rows: unknown[]) {
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockImplementation(async () => {
          ctxState.events.push(`select@depth${ctxState.depth}`);
          return rows;
        })
      })
    } as any);
  }

  it('reads due monitors inside a DB context but enqueues OUTSIDE it', async () => {
    mockDueMonitors([
      { id: 'm1', orgId: 'o1', pollingInterval: 60, lastChecked: null },
      { id: 'm2', orgId: 'o2', pollingInterval: 60, lastChecked: null },
    ]);

    const result = await processScheduler();

    expect(result).toEqual({ enqueued: 2 });
    // SELECT runs in-context (depth 1); the context CLOSES; then both enqueues
    // run with no transaction held (depth 0). This is the #1105 fix.
    expect(ctxState.events).toEqual([
      'ctx:enter',
      'select@depth1',
      'ctx:exit',
      'enqueue@depth0',
      'enqueue@depth0',
    ]);
    // The prod held-context tripwire never fires for the enqueue path.
    expect(ctxState.events.some((e) => e.startsWith('tripwire-violation'))).toBe(false);
  });

  it('returns early without enqueuing when no monitors are due', async () => {
    mockDueMonitors([]);

    const result = await processScheduler();

    expect(result).toEqual({ enqueued: 0 });
    expect(queueMock.add).not.toHaveBeenCalled();
    expect(ctxState.events).toEqual(['ctx:enter', 'select@depth1', 'ctx:exit']);
  });
});

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
