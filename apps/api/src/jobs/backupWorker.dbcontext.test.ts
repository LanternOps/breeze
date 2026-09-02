/**
 * backupWorker DB-context scoping (#1105 class, final-review fix for wave
 * 3.5b #4084).
 *
 * The regression this locks down: the ENTIRE worker-handler switch — every
 * job type, including `dispatch-backup` — used to run inside one blanket
 * `runWithSystemDbAccess` wrap. `dispatch-backup`'s per-target loop then
 * called `recordDispatchedExpectation` (Redis SET) and `dispatchCommandToAgent`
 * (Redis/WS I/O via the agentCommandRelay facade, with an ack-wait poll loop
 * up to RELAY_DELIVERY_DEADLINE_MS) once PER TARGET, so a pooled Postgres
 * connection sat idle-in-transaction for up to `targets.length *
 * RELAY_DELIVERY_DEADLINE_MS`.
 *
 * An identity `fn => fn()` mock of the context helper (what
 * backupWorker.test.ts uses, since it isn't asserting context depth) can
 * never catch that, so the mock below tracks real enter/exit depth and the
 * tests assert WHICH depth each DB read/write and each facade call happened
 * at — mirroring snmpWorker.dbcontext.test.ts's harness. Exercised directly
 * against `__testOnly.processDispatchBackup`, same as backupWorker.test.ts's
 * existing facade-dispatch suite (single-target case only — the fix's own
 * comment documents that a cancellation flag flipped mid-Phase-4 no longer
 * aborts remaining sends early, which this file does not re-litigate).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DispatchOutcome } from '../services/agentCommandRelay';

const { mockDb, ctxState } = vi.hoisted(() => ({
  mockDb: {
    select: vi.fn(),
    update: vi.fn(),
    insert: vi.fn(),
  },
  // DB-access-context depth + an ordered event log, so a test can prove which
  // work runs inside a held transaction and which runs after it closes.
  ctxState: { depth: 0, events: [] as string[] },
}));

vi.mock('../db', () => ({
  db: mockDb,
  // Real-ish context wrapper: tracks depth around fn so the tests can assert
  // what runs inside the context vs after it closes. Unlike
  // backupWorker.test.ts (which sets this to `undefined` for an identity
  // fallback), this is the whole point of this file.
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
  runOutsideDbContext: <T>(fn: () => T): T => fn(),
  SYSTEM_DB_ACCESS_CONTEXT: { scope: 'system', orgId: null, partnerId: null },
}));

vi.mock('./backupRetention', () => ({
  cleanupExpiredSnapshots: vi.fn(),
  sweepUnreferencedBackupObjects: vi.fn(),
}));

vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));

vi.mock('../services/backupResultPersistence', () => ({
  applyBackupCommandResultToJob: vi.fn(async () => ({ applied: true, snapshotDbId: null, providerSnapshotId: null })),
  markBackupJobFailedIfInFlight: vi.fn(),
}));

const recordDispatchedExpectationMock = vi.fn(async () => {
  ctxState.events.push(`recordExpectation@depth${ctxState.depth}`);
});
vi.mock('../services/agentWorkExpectation', () => ({
  recordDispatchedExpectation: recordDispatchedExpectationMock,
}));

const agentRelayMock = {
  isAgentConnectedAnywhere: vi.fn(async () => true),
  dispatchCommandToAgent: vi.fn(async (): Promise<DispatchOutcome> => ({ status: 'sent', via: 'local' })),
};
vi.mock('../services/agentCommandRelay', () => ({
  isAgentConnectedAnywhere: agentRelayMock.isAgentConnectedAnywhere,
  dispatchCommandToAgent: agentRelayMock.dispatchCommandToAgent,
}));

const { __testOnly } = await import('./backupWorker');

describe('processDispatchBackup DB-context scoping (final-review fix, #4084/#1105)', () => {
  const DATA = { type: 'dispatch-backup' as const, jobId: 'job-1', configId: 'config-1', orgId: 'org-1', deviceId: 'device-1' };
  const CONFIG_ROW = { id: 'config-1', provider: 'local', providerConfig: {}, encryption: false };
  const JOB_ROW = { featureLinkId: null, backupMode: 'file', modeTargets: { paths: ['/data'] } };

  // Route every db.select() call by the shape of its column-selector argument
  // (mirrors backupWorker.test.ts's wireSelects), logging the depth each read
  // ran at. `cancelled` is a live flag so a test can flip mid-run if needed;
  // none currently do.
  function wireSelects(opts: { cancelled?: boolean; configFound?: boolean } = {}) {
    const cancelled = opts.cancelled ?? false;
    const configFound = opts.configFound ?? true;
    mockDb.select.mockImplementation(((cols?: Record<string, unknown>) => {
      const keys = cols ? Object.keys(cols) : [];
      let rows: unknown[];
      let label: string;
      if (keys.length === 0) {
        rows = configFound ? [CONFIG_ROW] : []; label = 'configSelect'; // config load: db.select() with no arg
      } else if (keys.length === 1 && keys[0] === 'status') {
        rows = cancelled ? [{ status: 'cancelled' }] : []; label = 'cancelledSelect'; // isBackupJobCancelled
      } else if (keys.length === 1 && keys[0] === 'agentId') {
        rows = [{ agentId: 'agent-1' }]; label = 'deviceSelect'; // device -> agent lookup
      } else if (keys.includes('featureLinkId')) {
        rows = [JOB_ROW]; label = 'jobSelect'; // job mode lookup
      } else {
        throw new Error(`unexpected select shape: ${JSON.stringify(keys)}`);
      }
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
    }) as never);
  }

  function wireUpdates() {
    mockDb.update.mockImplementation((() => ({
      set: (payload: Record<string, unknown>) => ({
        where: async () => {
          const label =
            payload.status === 'running' ? 'statusRunning'
            : payload.status === 'failed' ? 'markFailed'
            : 'errorLog' in payload ? 'partialErrorLog'
            : 'update';
          ctxState.events.push(`${label}@depth${ctxState.depth}`);
        },
      }),
    })) as never);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    ctxState.depth = 0;
    ctxState.events = [];
    wireSelects();
    wireUpdates();
    agentRelayMock.isAgentConnectedAnywhere.mockImplementation(async () => {
      ctxState.events.push(`isAgentConnected@depth${ctxState.depth}`);
      return true;
    });
    agentRelayMock.dispatchCommandToAgent.mockImplementation(async () => {
      ctxState.events.push(`wsDispatch@depth${ctxState.depth}`);
      return { status: 'sent', via: 'local' };
    });
  });

  it('runs precheck reads, prepare reads/writes and the final settle in short contexts, with connectivity + dispatch OUTSIDE all of them', async () => {
    const result = await __testOnly.processDispatchBackup(DATA as any);

    expect(result).toEqual({ dispatched: true });
    expect(ctxState.events).toEqual([
      // Phase 1 (precheck): cancellation guard, config load, cancellation
      // guard again, agent lookup — ONE short context.
      'ctx:enter',
      'cancelledSelect@depth1',
      'configSelect@depth1',
      'cancelledSelect@depth1',
      'deviceSelect@depth1',
      'ctx:exit',
      // Phase 2: connectivity check, NO context held.
      'isAgentConnected@depth0',
      // Phase 3 (prepare): mode resolution, cancellation guards, the
      // single-target loop's own cancellation check and
      // recordDispatchedExpectation — ONE short context, closed before any
      // send.
      'ctx:enter',
      'cancelledSelect@depth1',
      'jobSelect@depth1',
      'cancelledSelect@depth1',
      'cancelledSelect@depth1',
      'recordExpectation@depth1',
      'ctx:exit',
      // Phase 4: the actual send, NO context held. This is the #1105 fix —
      // this call used to run at depth1, pinning a pooled connection across
      // dispatchCommandToAgent's ack-wait poll.
      'wsDispatch@depth0',
      // Phase 5 (settle): final cancellation guard + status flip — ONE short
      // context.
      'ctx:enter',
      'cancelledSelect@depth1',
      'statusRunning@depth1',
      'ctx:exit',
    ]);
  });

  it('marks the job failed with "Agent not connected" inside its own short context when no agent is connected anywhere, without dispatching', async () => {
    agentRelayMock.isAgentConnectedAnywhere.mockImplementation(async () => {
      ctxState.events.push(`isAgentConnected@depth${ctxState.depth}`);
      return false;
    });

    const result = await __testOnly.processDispatchBackup(DATA as any);

    expect(result).toEqual({ dispatched: false });
    expect(agentRelayMock.dispatchCommandToAgent).not.toHaveBeenCalled();
    expect(recordDispatchedExpectationMock).not.toHaveBeenCalled();
    expect(ctxState.events).toEqual([
      'ctx:enter',
      'cancelledSelect@depth1',
      'configSelect@depth1',
      'cancelledSelect@depth1',
      'deviceSelect@depth1',
      'ctx:exit',
      'isAgentConnected@depth0',
      // markJobFailed reopens its own short context — it must NOT run inside
      // Phase 1's (already-closed) context.
      'ctx:enter',
      'markFailed@depth1',
      'ctx:exit',
    ]);
  });

  it('holds no context past Phase 1 when the config is missing', async () => {
    wireSelects({ configFound: false });

    const result = await __testOnly.processDispatchBackup(DATA as any);

    expect(result).toEqual({ dispatched: false });
    expect(agentRelayMock.isAgentConnectedAnywhere).not.toHaveBeenCalled();
    expect(agentRelayMock.dispatchCommandToAgent).not.toHaveBeenCalled();
    expect(ctxState.events).toEqual([
      'ctx:enter',
      'cancelledSelect@depth1',
      'configSelect@depth1',
      'markFailed@depth1',
      'ctx:exit',
    ]);
  });

  it('marks the job failed in Phase 5 (its own short context) when the outcome is offline', async () => {
    agentRelayMock.dispatchCommandToAgent.mockImplementation(async () => {
      ctxState.events.push(`wsDispatch@depth${ctxState.depth}`);
      return { status: 'offline' };
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await __testOnly.processDispatchBackup(DATA as any);

    expect(result).toEqual({ dispatched: false });
    expect(ctxState.events).toEqual([
      'ctx:enter',
      'cancelledSelect@depth1',
      'configSelect@depth1',
      'cancelledSelect@depth1',
      'deviceSelect@depth1',
      'ctx:exit',
      'isAgentConnected@depth0',
      'ctx:enter',
      'cancelledSelect@depth1',
      'jobSelect@depth1',
      'cancelledSelect@depth1',
      'cancelledSelect@depth1',
      'recordExpectation@depth1',
      'ctx:exit',
      'wsDispatch@depth0',
      'ctx:enter',
      'cancelledSelect@depth1',
      'markFailed@depth1',
      'ctx:exit',
    ]);
    warn.mockRestore();
  });
});
