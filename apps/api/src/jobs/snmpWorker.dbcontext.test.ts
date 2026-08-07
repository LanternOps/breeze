/**
 * snmpWorker DB-context scoping (#1105 class, issue #3215).
 *
 * The regression these tests lock down: `createSnmpWorker` used to wrap the
 * ENTIRE job body in `withSystemDbAccessContext`, so the scheduler's Redis
 * fan-out and the poll-device agent WebSocket dispatch ran while a pooled
 * Postgres connection sat idle-in-transaction (observed: 51 seconds).
 *
 * An identity `fn => fn()` mock of the context helper can never catch that, so
 * the mock below tracks real enter/exit depth and the tests assert WHICH depth
 * each DB read, each enqueue and each WS send happened at.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockDb, ctxState, queueMock, agentWsMock } = vi.hoisted(() => ({
  mockDb: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  },
  // DB-access-context depth + an ordered event log, so a test can prove which
  // work runs inside a held transaction and which runs after it closes.
  ctxState: { depth: 0, events: [] as string[] },
  queueMock: {
    getJob: vi.fn(async () => null),
    add: vi.fn(async () => ({ id: 'job-1' })),
    addBulk: vi.fn(async () => []),
    getRepeatableJobs: vi.fn(async () => []),
    removeRepeatableByKey: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  },
  agentWsMock: {
    isAgentConnected: vi.fn(() => true),
    sendCommandToAgent: vi.fn(() => true),
  },
}));

const workerProcessors: Array<(job: { data: unknown }) => Promise<unknown>> = [];

vi.mock('bullmq', () => ({
  Queue: class {
    getJob = queueMock.getJob;
    add = queueMock.add;
    addBulk = queueMock.addBulk;
    getRepeatableJobs = queueMock.getRepeatableJobs;
    removeRepeatableByKey = queueMock.removeRepeatableByKey;
    close = queueMock.close;
  },
  Worker: class {
    constructor(_name: string, processor: (job: { data: unknown }) => Promise<unknown>) {
      workerProcessors.push(processor);
    }

    close = vi.fn();
    on = vi.fn();
  },
  Job: class {},
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
  // #1105 tripwire wired into createInstrumentedQueue's add(). Mirror prod
  // semantics: record a violation if an enqueue runs while a context is held.
  assertOutsideHeldDbContext: (op: string) => {
    if (ctxState.depth > 0) ctxState.events.push(`tripwire-violation:${op}`);
  },
}));

vi.mock('../db/schema', () => ({
  snmpDevices: {
    id: 'snmpDevices.id',
    orgId: 'snmpDevices.orgId',
    isActive: 'snmpDevices.isActive',
    lastPolled: 'snmpDevices.lastPolled',
    pollingInterval: 'snmpDevices.pollingInterval',
  },
  snmpMetrics: { deviceId: 'snmpMetrics.deviceId' },
  snmpTemplates: {
    id: 'snmpTemplates.id',
    oids: 'snmpTemplates.oids',
    isBuiltIn: 'snmpTemplates.isBuiltIn',
    orgId: 'snmpTemplates.orgId',
  },
  devices: {
    agentId: 'devices.agentId',
    orgId: 'devices.orgId',
    isEphemeral: 'devices.isEphemeral',
    status: 'devices.status',
  },
}));

vi.mock('../services/redis', () => ({
  getBullMQConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })),
}));

vi.mock('../routes/agentWs', () => ({
  isAgentConnected: agentWsMock.isAgentConnected,
  sendCommandToAgent: agentWsMock.sendCommandToAgent,
}));

vi.mock('../services/snmpSecrets', () => ({
  decryptSnmpSecret: vi.fn((v: string | null) => v),
}));

vi.mock('./workerObservability', () => ({
  attachWorkerObservability: vi.fn(),
}));

import { createSnmpWorker } from './snmpWorker';

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

/** A `.select().from().where()` chain (no limit) that logs its depth. */
function selectWhereChain(rows: unknown[], label: string) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockImplementation(async () => {
        ctxState.events.push(`${label}@depth${ctxState.depth}`);
        return rows;
      }),
    }),
  };
}

function runJob(data: unknown): Promise<unknown> {
  const processor = workerProcessors[0];
  if (!processor) throw new Error('worker processor was not registered');
  return processor({ data });
}

describe('snmpWorker DB-context scoping (#3215)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workerProcessors.length = 0;
    ctxState.depth = 0;
    ctxState.events = [];

    queueMock.getJob.mockResolvedValue(null);
    queueMock.add.mockImplementation(async () => {
      ctxState.events.push(`enqueue@depth${ctxState.depth}`);
      return { id: 'job-1' };
    });
    agentWsMock.isAgentConnected.mockImplementation(() => {
      ctxState.events.push(`isAgentConnected@depth${ctxState.depth}`);
      return true;
    });
    agentWsMock.sendCommandToAgent.mockImplementation(() => {
      ctxState.events.push(`wsDispatch@depth${ctxState.depth}`);
      return true;
    });

    createSnmpWorker();
  });

  it('poll-scheduler reads due devices in-context but enqueues OUTSIDE it', async () => {
    mockDb.select.mockReturnValueOnce(
      selectWhereChain(
        [
          { id: 'd1', orgId: 'o1', pollingInterval: 60, lastPolled: null },
          { id: 'd2', orgId: 'o2', pollingInterval: 60, lastPolled: null },
        ],
        'dueSelect'
      ) as never
    );

    const result = await runJob({ type: 'poll-scheduler' });

    expect(result).toEqual({ enqueued: 2 });
    // The SELECT runs in-context (depth 1), the context CLOSES, then both
    // enqueues run with no transaction held (depth 0). This is the #1105 fix.
    expect(ctxState.events).toEqual([
      'ctx:enter',
      'dueSelect@depth1',
      'ctx:exit',
      'enqueue@depth0',
      'enqueue@depth0',
    ]);
    expect(ctxState.events.some((e) => e.startsWith('tripwire-violation'))).toBe(false);
  });

  it('poll-scheduler opens no second context when nothing is due', async () => {
    mockDb.select.mockReturnValueOnce(selectWhereChain([], 'dueSelect') as never);

    const result = await runJob({ type: 'poll-scheduler' });

    expect(result).toEqual({ enqueued: 0 });
    expect(queueMock.add).not.toHaveBeenCalled();
    expect(ctxState.events).toEqual(['ctx:enter', 'dueSelect@depth1', 'ctx:exit']);
  });

  it('poll-device reads config in-context but dispatches to the agent OUTSIDE it', async () => {
    mockDb.select
      .mockReturnValueOnce(
        selectLimitChain(
          [
            {
              id: 'd1',
              orgId: 'o1',
              templateId: 't1',
              ipAddress: '10.0.0.1',
              port: 161,
              snmpVersion: 'v2c',
              community: 'public',
              username: null,
              authProtocol: null,
              authPassword: null,
              privProtocol: null,
              privPassword: null,
            },
          ],
          'deviceSelect'
        ) as never
      )
      .mockReturnValueOnce(
        selectLimitChain([{ oids: [{ oid: '1.3.6.1.2.1.1.1.0' }] }], 'templateSelect') as never
      )
      .mockReturnValueOnce(selectLimitChain([{ agentId: 'agent-1' }], 'agentSelect') as never);

    const result = await runJob({ type: 'poll-device', deviceId: 'd1', orgId: 'o1' });

    expect(result).toEqual({ dispatched: true, agentId: 'agent-1' });
    // All three reads share ONE context; the WS connectivity check and the
    // socket write happen only after it closes.
    expect(ctxState.events).toEqual([
      'ctx:enter',
      'deviceSelect@depth1',
      'templateSelect@depth1',
      'agentSelect@depth1',
      'ctx:exit',
      'isAgentConnected@depth0',
      'wsDispatch@depth0',
    ]);
  });

  it('poll-device does not dispatch — and holds no context — when the device is missing', async () => {
    mockDb.select.mockReturnValueOnce(selectLimitChain([], 'deviceSelect') as never);

    const result = await runJob({ type: 'poll-device', deviceId: 'gone', orgId: 'o1' });

    expect(result).toEqual({ dispatched: false, agentId: null });
    expect(agentWsMock.sendCommandToAgent).not.toHaveBeenCalled();
    expect(ctxState.events).toEqual(['ctx:enter', 'deviceSelect@depth1', 'ctx:exit']);
  });

  it('process-poll-results parses metrics between two short contexts, writes inside one', async () => {
    mockDb.select.mockReturnValueOnce(selectLimitChain([{ orgId: 'o1' }], 'orgSelect') as never);

    const valuesMock = vi.fn().mockImplementation(async () => {
      ctxState.events.push(`insert@depth${ctxState.depth}`);
    });
    mockDb.insert.mockReturnValue({ values: valuesMock } as never);
    mockDb.update.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockImplementation(async () => {
          ctxState.events.push(`update@depth${ctxState.depth}`);
        }),
      }),
    } as never);

    const result = await runJob({
      type: 'process-poll-results',
      deviceId: 'd1',
      metrics: [
        { oid: '1.3.6.1.2.1.1.1.0', name: 'sysDescr', value: 'router', timestamp: '2026-08-07T00:00:00.000Z' },
      ],
    });

    expect(result).toEqual({ metricsWritten: 1 });
    // Two separate short contexts — the lookup, then the writes. The metric
    // mapping in between happens with no transaction held, and the insert +
    // status stamp still share one context so they commit together.
    expect(ctxState.events).toEqual([
      'ctx:enter',
      'orgSelect@depth1',
      'ctx:exit',
      'ctx:enter',
      'insert@depth1',
      'update@depth1',
      'ctx:exit',
    ]);
  });

  it('process-poll-results skips the write context entirely when the device is unknown', async () => {
    mockDb.select.mockReturnValueOnce(selectLimitChain([], 'orgSelect') as never);

    const result = await runJob({ type: 'process-poll-results', deviceId: 'gone', metrics: [] });

    expect(result).toEqual({ metricsWritten: 0 });
    expect(mockDb.insert).not.toHaveBeenCalled();
    expect(mockDb.update).not.toHaveBeenCalled();
    expect(ctxState.events).toEqual(['ctx:enter', 'orgSelect@depth1', 'ctx:exit']);
  });

  it('the worker handler does not wrap job bodies in an outer context', async () => {
    // Guard against reintroducing the outer runWithSystemDbAccess: because
    // withDbAccessContext re-entry is a no-op, an outer wrap would make the
    // scheduler's enqueues run at depth 1 and never emit a second ctx:enter.
    mockDb.select.mockReturnValueOnce(
      selectWhereChain([{ id: 'd1', orgId: 'o1', pollingInterval: 60, lastPolled: null }], 'dueSelect') as never
    );

    await runJob({ type: 'poll-scheduler' });

    expect(ctxState.events[0]).toBe('ctx:enter');
    expect(ctxState.events.filter((e) => e === 'ctx:enter')).toHaveLength(1);
    expect(ctxState.events.at(-1)).toBe('enqueue@depth0');
  });

  it('rejects an unknown job type', async () => {
    await expect(runJob({ type: 'nope' })).rejects.toThrow('Unknown job type: nope');
  });
});
