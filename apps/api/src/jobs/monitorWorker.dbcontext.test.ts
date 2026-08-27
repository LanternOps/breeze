/**
 * monitorWorker DB-context scoping (#1105 class, final-review fix for wave
 * 3.5b #4084).
 *
 * The regression this locks down: the `check-monitor` job type was wrapped in
 * `runWithSystemDbAccess` at the worker-handler level, so
 * `isAgentConnectedAnywhere` and `dispatchCommandToAgent` (Redis/WS I/O via the
 * agentCommandRelay facade — the latter with an ack-wait poll loop up to
 * RELAY_DELIVERY_DEADLINE_MS) ran with a pooled Postgres connection pinned
 * idle-in-transaction.
 *
 * An identity `fn => fn()` mock of the context helper can never catch that, so
 * the mock below tracks real enter/exit depth and the tests assert WHICH depth
 * each DB read and each facade call happened at — mirroring
 * snmpWorker.dbcontext.test.ts's harness. Exercised directly against
 * `processCheckMonitor` (as monitorWorker.test.ts already does): the
 * worker-handler switch is a one-line passthrough onto it with no wrapping of
 * its own left to assert.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockDb, ctxState, agentRelayMock } = vi.hoisted(() => ({
  mockDb: {
    select: vi.fn(),
  },
  // DB-access-context depth + an ordered event log, so a test can prove which
  // work runs inside a held transaction and which runs after it closes.
  ctxState: { depth: 0, events: [] as string[] },
  agentRelayMock: {
    isAgentConnectedAnywhere: vi.fn(async () => true),
    dispatchCommandToAgent: vi.fn(async () => ({ status: 'sent', via: 'local' })),
  },
}));

vi.mock('bullmq', () => ({
  Queue: class {},
  Worker: class {},
  Job: class {},
  UnrecoverableError: class extends Error {},
}));

vi.mock('../db', () => ({
  db: mockDb,
  // Real-ish context wrapper: tracks depth around fn so the tests can assert
  // what runs inside the context vs after it closes.
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
}));

vi.mock('../db/schema', () => ({
  networkMonitors: {
    id: 'networkMonitors.id',
    orgId: 'networkMonitors.orgId',
    assetId: 'networkMonitors.assetId',
    consecutiveFailures: 'networkMonitors.consecutiveFailures',
  },
  networkMonitorResults: { monitorId: 'networkMonitorResults.monitorId' },
  devices: {
    id: 'devices.id',
    orgId: 'devices.orgId',
    siteId: 'devices.siteId',
    lastSeenAt: 'devices.lastSeenAt',
    enrolledAt: 'devices.enrolledAt',
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
  getBullMQConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })),
  isBullMQAvailable: vi.fn(() => true),
}));

vi.mock('../services/agentCommandRelay', () => ({
  isAgentConnectedAnywhere: agentRelayMock.isAgentConnectedAnywhere,
  dispatchCommandToAgent: agentRelayMock.dispatchCommandToAgent,
}));

vi.mock('../routes/monitors', () => ({
  buildMonitorCommand: vi.fn(() => ({ id: 'cmd-1', type: 'network_check', payload: {} })),
}));

vi.mock('../services/alertCooldown', () => ({
  isCooldownActive: vi.fn(async () => false),
  setCooldown: vi.fn(async () => undefined),
}));

vi.mock('../services/alertService', () => ({
  resolveAlert: vi.fn(async () => undefined),
}));

vi.mock('./workerObservability', () => ({
  attachWorkerObservability: vi.fn(),
}));

import { processCheckMonitor } from './monitorWorker';

/** A `.select().from().where().limit()` chain that logs the depth it ran at. */
function selectLimitChain(rows: unknown[], label: string) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockImplementation(async () => {
          ctxState.events.push(`${label}@depth${ctxState.depth}`);
          return rows;
        }),
      }),
    }),
  };
}

describe('processCheckMonitor DB-context scoping (final-review fix, #4084/#1105)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ctxState.depth = 0;
    ctxState.events = [];

    agentRelayMock.isAgentConnectedAnywhere.mockImplementation(async () => {
      ctxState.events.push(`isAgentConnected@depth${ctxState.depth}`);
      return true;
    });
    agentRelayMock.dispatchCommandToAgent.mockImplementation(async () => {
      ctxState.events.push(`wsDispatch@depth${ctxState.depth}`);
      return { status: 'sent', via: 'local' };
    });
  });

  it('reads the monitor + agent selection in-context, but checks connectivity and dispatches OUTSIDE it', async () => {
    mockDb.select
      .mockReturnValueOnce(
        selectLimitChain(
          [{ id: 'monitor-1', orgId: 'org-1', assetId: null, isActive: true, name: 'Edge Ping', target: '8.8.8.8', monitorType: 'icmp_ping' }],
          'monitorSelect'
        ) as never
      )
      // selectExecutionAgentForMonitor: unbound monitor → org-wide online agent lookup
      .mockReturnValueOnce(selectLimitChain([{ agentId: 'agent-1' }], 'agentSelect') as never);

    const result = await processCheckMonitor({ type: 'check-monitor', monitorId: 'monitor-1', orgId: 'org-1' });

    expect(result).toEqual({ dispatched: true, agentId: 'agent-1' });
    // The monitor read and the agent-selection read share ONE context; the
    // connectivity check and the socket write happen only after it closes.
    // This is the #1105 fix: a blanket wrap here used to hold a pooled
    // connection idle-in-transaction across both of those facade calls.
    expect(ctxState.events).toEqual([
      'ctx:enter',
      'monitorSelect@depth1',
      'agentSelect@depth1',
      'ctx:exit',
      'isAgentConnected@depth0',
      'wsDispatch@depth0',
    ]);
  });

  it('does not dispatch — and holds no context open past the read — when the monitor is missing', async () => {
    mockDb.select.mockReturnValueOnce(selectLimitChain([], 'monitorSelect') as never);

    const result = await processCheckMonitor({ type: 'check-monitor', monitorId: 'gone', orgId: 'org-1' });

    expect(result).toEqual({ dispatched: false, agentId: null });
    expect(agentRelayMock.isAgentConnectedAnywhere).not.toHaveBeenCalled();
    expect(agentRelayMock.dispatchCommandToAgent).not.toHaveBeenCalled();
    expect(ctxState.events).toEqual(['ctx:enter', 'monitorSelect@depth1', 'ctx:exit']);
  });

  it('checks connectivity OUTSIDE any context when no agent is selected, and never dispatches', async () => {
    mockDb.select
      .mockReturnValueOnce(
        selectLimitChain(
          [{ id: 'monitor-1', orgId: 'org-1', assetId: null, isActive: true, name: 'Edge Ping', target: '8.8.8.8', monitorType: 'icmp_ping' }],
          'monitorSelect'
        ) as never
      )
      .mockReturnValueOnce(selectLimitChain([], 'agentSelect') as never);

    const result = await processCheckMonitor({ type: 'check-monitor', monitorId: 'monitor-1', orgId: 'org-1' });

    expect(result).toEqual({ dispatched: false, agentId: null });
    // agentId is null here, so the `!agentId ||` short-circuit means
    // isAgentConnectedAnywhere is never actually called — but critically, no
    // context is held open into the (skipped) connectivity check either way.
    expect(agentRelayMock.isAgentConnectedAnywhere).not.toHaveBeenCalled();
    expect(agentRelayMock.dispatchCommandToAgent).not.toHaveBeenCalled();
    expect(ctxState.events).toEqual(['ctx:enter', 'monitorSelect@depth1', 'agentSelect@depth1', 'ctx:exit']);
  });
});
