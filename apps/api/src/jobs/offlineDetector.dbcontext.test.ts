/**
 * offlineDetector DB-context scoping (#1105 class, issue #3233).
 *
 * The regression these tests lock down: `createOfflineWorker` used to wrap the
 * ENTIRE job body in `withSystemDbAccessContext`, so every sweep's Redis
 * fan-out (`queue.addBulk`) and the uninstall reaper's per-row writes ran while
 * a pooled Postgres connection sat idle-in-transaction for the whole chunked
 * loop. Observed on a local stack: 13 held-context warnings in ~15 minutes at
 * 5-10s each, from `detect-offline` alone — which runs every 30s and whose hold
 * grows with fleet size.
 *
 * Same shape already fixed for alertWorker `evaluate-all` (#3216) and
 * snmpWorker `poll-scheduler` (#3215).
 *
 * An identity `fn => fn()` mock of the context helper can never catch that, so
 * the mock below tracks real enter/exit depth and the tests assert WHICH depth
 * each DB read, each enqueue and each write happened at.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockDb, ctxState, queueMock } = vi.hoisted(() => ({
  mockDb: {
    select: vi.fn(),
    update: vi.fn(),
  },
  // DB-access-context depth + an ordered event log, so a test can prove which
  // work runs inside a held transaction and which runs after it closes.
  ctxState: { depth: 0, events: [] as string[] },
  queueMock: {
    add: vi.fn(async () => ({ id: 'job-1' })),
    // Declared with the jobs parameter so the per-test mockImplementation that
    // inspects the batch size still typechecks.
    addBulk: vi.fn(async (_jobs: unknown) => []),
    getRepeatableJobs: vi.fn(async () => []),
    removeRepeatableByKey: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  },
}));

const workerProcessors: Array<(job: { data: unknown }) => Promise<unknown>> = [];

vi.mock('bullmq', () => ({
  Queue: class {
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
}));

vi.mock('../db/schema', () => ({
  devices: {
    id: 'devices.id',
    orgId: 'devices.orgId',
    status: 'devices.status',
    hostname: 'devices.hostname',
    displayName: 'devices.displayName',
    lastSeenAt: 'devices.lastSeenAt',
    isEphemeral: 'devices.isEphemeral',
    uninstallIntentAt: 'devices.uninstallIntentAt',
    possibleReplacementOfDeviceId: 'devices.possibleReplacementOfDeviceId',
    updatedAt: 'devices.updatedAt',
  },
  alertRules: { id: 'alertRules.id', orgId: 'alertRules.orgId' },
  alertTemplates: { id: 'alertTemplates.id' },
  alerts: { id: 'alerts.id' },
}));

// drizzle operators are stubbed so the mocked string "columns" above never
// reach real SQL generation. These tests assert context depth, not SQL shape.
vi.mock('drizzle-orm', () => ({
  eq: (...a: unknown[]) => ({ op: 'eq', a }),
  and: (...a: unknown[]) => ({ op: 'and', a }),
  or: (...a: unknown[]) => ({ op: 'or', a }),
  lt: (...a: unknown[]) => ({ op: 'lt', a }),
  gt: (...a: unknown[]) => ({ op: 'gt', a }),
  gte: (...a: unknown[]) => ({ op: 'gte', a }),
  asc: (...a: unknown[]) => ({ op: 'asc', a }),
  inArray: (...a: unknown[]) => ({ op: 'inArray', a }),
  notInArray: (...a: unknown[]) => ({ op: 'notInArray', a }),
  isNull: (...a: unknown[]) => ({ op: 'isNull', a }),
}));

vi.mock('../services/redis', () => ({
  getBullMQConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })),
}));

vi.mock('../services/eventBus', () => ({
  publishEvent: vi.fn(async () => {
    ctxState.events.push(`publishEvent@depth${ctxState.depth}`);
  }),
}));

vi.mock('../services/alertService', () => ({
  createAlert: vi.fn(async () => null),
  evaluateDeviceAlertsFromPolicy: vi.fn(async () => {
    ctxState.events.push(`alertEvaluation@depth${ctxState.depth}`);
    return [];
  }),
  alertRuleOwnershipConditionForOrg: vi.fn(() => ({ op: 'ownership' })),
}));

vi.mock('../services/alertConditions', () => ({
  interpolateTemplate: vi.fn((s: string) => s),
}));

vi.mock('../services/alertConditions/offlineDuration', () => ({
  resolveReevalHorizonMinutes: vi.fn(() => 1440),
}));

vi.mock('../services/bullmqUtils', () => ({
  isReusableState: vi.fn(() => false),
}));

vi.mock('./workerObservability', () => ({
  attachWorkerObservability: vi.fn(),
}));

vi.mock('../services/auditService', () => ({
  createAuditLogAsync: vi.fn(() => {
    ctxState.events.push(`audit@depth${ctxState.depth}`);
  }),
}));

vi.mock('../services/auditEvents', () => ({
  ANONYMOUS_ACTOR_ID: '00000000-0000-0000-0000-000000000000',
}));

import { createOfflineWorker, offlineTransitionId } from './offlineDetector';

/**
 * A `.select().from().where().orderBy().limit()` chain that logs the depth its
 * terminal await ran at. This is the shape every sweep page read uses.
 */
function selectPageChain(rows: unknown[], label: string) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        orderBy: vi.fn().mockReturnValue({
          limit: vi.fn().mockImplementation(async () => {
            ctxState.events.push(`${label}@depth${ctxState.depth}`);
            return rows;
          }),
        }),
      }),
    }),
  };
}

/**
 * A `.update().set().where()` chain that logs the depth it ran at, labelled by
 * WHICH write it is — both reaper writes target `devices`, so the table cannot
 * tell them apart, but the `set` payload can:
 *
 *   decommission   — status -> 'decommissioned' (has .returning())
 *   clearReplLink  — possibleReplacementOfDeviceId -> null (awaited directly)
 */
function updateChain(returningRows: unknown[]) {
  return () => ({
    set: (payload: Record<string, unknown>) => {
      const label = payload.status === 'offline'
        ? 'markOfflineCas'
        : 'status' in payload
          ? 'decommission'
          : 'clearReplLink';
      const record = () => {
        ctxState.events.push(`${label}@depth${ctxState.depth}`);
      };
      // The decommission write is consumed via `.returning()`; the linkage
      // clear is awaited directly. Support both off one object.
      return {
        where: () =>
          ({
            returning: async () => {
              record();
              return returningRows;
            },
            then: (resolve: (v: unknown) => unknown) => {
              record();
              return Promise.resolve(undefined).then(resolve);
            },
          }) as never,
      };
    },
  });
}

function selectRulesChain(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockImplementation(async () => {
        ctxState.events.push(`alertRulesSelect@depth${ctxState.depth}`);
        if (ctxState.depth === 0) throw new Error('alert rules read without RLS context');
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

describe('offlineDetector DB-context scoping (#3233)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // mockReset (not just clear) — a leftover `mockReturnValueOnce` from a
    // previous test would otherwise be consumed by the next one and silently
    // shift every assertion.
    mockDb.select.mockReset();
    mockDb.update.mockReset();
    workerProcessors.length = 0;
    ctxState.depth = 0;
    ctxState.events = [];

    queueMock.addBulk.mockImplementation(async (jobs: unknown) => {
      const n = Array.isArray(jobs) ? jobs.length : 0;
      ctxState.events.push(`addBulk(${n})@depth${ctxState.depth}`);
      return [];
    });

    createOfflineWorker();
  });

  it('detect-offline reads each page in-context but fans out OUTSIDE it', async () => {
    mockDb.select.mockReturnValueOnce(
      selectPageChain(
        [
          { id: '00000000-0000-4000-8000-000000000001', orgId: '10000000-0000-4000-8000-000000000001', hostname: 'h1', displayName: 'D1', lastSeenAt: new Date() },
          { id: '00000000-0000-4000-8000-000000000002', orgId: '10000000-0000-4000-8000-000000000001', hostname: 'h2', displayName: 'D2', lastSeenAt: new Date() },
        ],
        'detectSelect'
      ) as never
    );

    const result = (await runJob({ type: 'detect-offline' })) as { detected: number };

    expect(result.detected).toBe(2);
    // The SELECT runs in-context (depth 1), the context CLOSES, then the Redis
    // fan-out runs with no transaction held (depth 0). This is the #1105 fix.
    // A short page (2 < limit) ends the sweep, so there is exactly one page.
    expect(ctxState.events).toEqual([
      'ctx:enter',
      'detectSelect@depth1',
      'ctx:exit',
      'addBulk(2)@depth0',
    ]);
  });

  it('detect-offline opens no second context and enqueues nothing when nothing is stale', async () => {
    mockDb.select.mockReturnValueOnce(selectPageChain([], 'detectSelect') as never);

    const result = (await runJob({ type: 'detect-offline' })) as { detected: number };

    expect(result.detected).toBe(0);
    expect(queueMock.addBulk).not.toHaveBeenCalled();
    expect(ctxState.events).toEqual(['ctx:enter', 'detectSelect@depth1', 'ctx:exit']);
  });

  it('mark-offline commits CAS before publication and opens a separate context for alert DB access', async () => {
    const device = {
      id: '00000000-0000-4000-8000-000000000001',
      orgId: '10000000-0000-4000-8000-000000000001',
      siteId: '20000000-0000-4000-8000-000000000001',
      hostname: 'h1',
      displayName: 'D1',
      status: 'offline',
      lastSeenAt: new Date('2026-05-17T00:00:00.000Z'),
      isEphemeral: false,
    };
    mockDb.update.mockImplementation(updateChain([device]) as never);
    mockDb.select.mockReturnValueOnce(selectRulesChain([]) as never);

    const result = await runJob({
      type: 'mark-offline',
      transitionId: offlineTransitionId(device.orgId, device.id, device.lastSeenAt.toISOString()),
      deviceId: device.id,
      orgId: device.orgId,
      observedLastSeenAt: device.lastSeenAt.toISOString(),
    }) as { transitioned: boolean; alertCreated: boolean };

    expect(result).toEqual({ transitioned: true, alertCreated: false });
    expect(mockDb.update).toHaveBeenCalledTimes(1);
    expect(ctxState.events).toEqual([
      'ctx:enter',
      'markOfflineCas@depth1',
      'ctx:exit',
      'publishEvent@depth0',
      'ctx:enter',
      'alertEvaluation@depth1',
      'alertRulesSelect@depth1',
      'ctx:exit',
    ]);
  });

  it('duplicate or stale mark-offline work loses the CAS and emits nothing', async () => {
    mockDb.update.mockImplementation(updateChain([]) as never);

    const result = await runJob({
      type: 'mark-offline',
      transitionId: offlineTransitionId(
        '10000000-0000-4000-8000-000000000001',
        '00000000-0000-4000-8000-000000000001',
        '2026-05-17T00:00:00.000Z',
      ),
      deviceId: '00000000-0000-4000-8000-000000000001',
      orgId: '10000000-0000-4000-8000-000000000001',
      observedLastSeenAt: '2026-05-17T00:00:00.000Z',
    }) as { transitioned: boolean; alertCreated: boolean };

    expect(result).toEqual({ transitioned: false, alertCreated: false });
    expect(ctxState.events).toEqual(['ctx:enter', 'markOfflineCas@depth1', 'ctx:exit']);
  });

  it('reevaluate-offline-sweep reads in-context but fans out OUTSIDE it', async () => {
    mockDb.select.mockReturnValueOnce(
      selectPageChain([{ id: 'd1', orgId: 'o1' }], 'reevalSelect') as never
    );

    const result = (await runJob({ type: 'reevaluate-offline-sweep' })) as { queued: number };

    expect(result.queued).toBe(1);
    expect(ctxState.events).toEqual([
      'ctx:enter',
      'reevalSelect@depth1',
      'ctx:exit',
      'addBulk(1)@depth0',
    ]);
  });

  it('reap-uninstall-intent closes the page context before the per-row writes', async () => {
    mockDb.select.mockReturnValueOnce(
      selectPageChain(
        [{ id: 'd1', orgId: 'o1', hostname: 'h1', displayName: 'D1' }],
        'reapSelect'
      ) as never
    );
    mockDb.update.mockImplementation(updateChain([{ id: 'd1' }]) as never);

    const result = (await runJob({ type: 'reap-uninstall-intent' })) as {
      decommissioned: number;
    };

    expect(result.decommissioned).toBe(1);
    // The page SELECT gets its own context which CLOSES; each candidate's two
    // writes then share ONE short context of their own, so no connection is
    // held across the whole chunk. Both writes stay in the same context so the
    // decommission and the replacement-linkage clear still commit together.
    // The audit call lands after that context closes.
    expect(ctxState.events).toEqual([
      'ctx:enter',
      'reapSelect@depth1',
      'ctx:exit',
      'ctx:enter',
      'decommission@depth1',
      'clearReplLink@depth1',
      'ctx:exit',
      'audit@depth0',
    ]);
  });

  it('reap-uninstall-intent skips a candidate that re-heartbeated, holding no context after', async () => {
    mockDb.select.mockReturnValueOnce(
      selectPageChain(
        [{ id: 'd1', orgId: 'o1', hostname: 'h1', displayName: 'D1' }],
        'reapSelect'
      ) as never
    );
    // Empty .returning() => the row was re-heartbeated between SELECT and UPDATE.
    mockDb.update.mockImplementation(updateChain([]) as never);

    const result = (await runJob({ type: 'reap-uninstall-intent' })) as {
      decommissioned: number;
    };

    expect(result.decommissioned).toBe(0);
    // No linkage clear, no audit — and the write context still closes.
    expect(ctxState.events).toEqual([
      'ctx:enter',
      'reapSelect@depth1',
      'ctx:exit',
      'ctx:enter',
      'decommission@depth1',
      'ctx:exit',
    ]);
    expect(ctxState.events).not.toContain('clearReplLink@depth1');
  });

  it('never enqueues while a DB context is held, across all three sweeps', async () => {
    for (const type of ['detect-offline', 'reevaluate-offline-sweep']) {
      ctxState.events = [];
      mockDb.select.mockReset();
      mockDb.select.mockReturnValueOnce(
        selectPageChain(
          [{ id: '00000000-0000-4000-8000-000000000001', orgId: '10000000-0000-4000-8000-000000000001', hostname: 'h', displayName: 'D', lastSeenAt: new Date() }],
          'sel'
        ) as never
      );

      await runJob({ type });

      const enqueues = ctxState.events.filter((e) => e.startsWith('addBulk'));
      expect(enqueues.length).toBeGreaterThan(0);
      for (const e of enqueues) {
        expect(e).toContain('@depth0');
      }
    }
  });
});
