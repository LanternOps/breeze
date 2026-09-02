/**
 * Eviction-path contract for the openai-compatible session manager (#4384).
 *
 * Two defects this suite pins:
 *
 * 1. Neither eviction path checked `state === 'processing'`, so under cap
 *    pressure the LRU victim could be the session currently streaming a
 *    response. `remove()` aborts its controller and closes its event bus
 *    mid-turn; the provider swallows the user-kind abort, so the partial
 *    `assistantText` is persisted as a COMPLETE assistant message and the
 *    terminal `done` publish lands on a closed bus.
 *
 * 2. Only the 24h-age branch wrote `status: 'expired'`. The idle branch and
 *    `evictLeastRecentlyActive()` dropped the session from memory but left
 *    `ai_sessions.status = 'active'` forever, so anything keyed on
 *    `status = 'active'` overcounts — worst under exactly the load that
 *    triggers LRU.
 *
 * The db mock deliberately reproduces the JOIN-if-already-open semantics of the
 * real `withDbAccessContext` (apps/api/src/db/index.ts:529-531): when a context
 * is already open it IGNORES the context it was handed and runs under the
 * caller's GUCs. `evictLeastRecentlyActive()` is reached from `getOrCreate()`
 * on the request path, which the auth middleware has already wrapped in the
 * REQUESTER's context — so an expire-write that forgets `runOutsideDbContext`
 * evaluates against the requester's org, matches zero rows under RLS, and is a
 * silent no-op in production while looking perfectly green against a naive
 * mock. `expires the evicted session under ITS OWN org scope` is the test that
 * catches that.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const {
  dbUpdateMock,
  capturedExpires,
  mockState,
  contextStore,
  captureExceptionMock,
  captureMessageMock,
} =
  vi.hoisted(() => {
    const { AsyncLocalStorage } = require('node:async_hooks') as typeof import('node:async_hooks');
    return {
      dbUpdateMock: vi.fn(),
      capturedExpires: [] as {
        table: unknown;
        context: unknown;
        set: Record<string, unknown>;
        where: SQL;
      }[],
      mockState: {
        /** Context in force at the moment the UPDATE is issued. */
        effectiveContext: null as unknown,
        /** Row count the next UPDATE resolves with (0 = the RLS signature). */
        nextRowCount: 1,
      },
      /**
       * The REAL primitive the db module uses, not a hand-rolled stand-in. A
       * synchronous save/restore would diverge the moment the implementation
       * awaits between writes: `AsyncLocalStorage.exit()` covers the whole async
       * subtree scheduled inside it, a flag restored in a `finally` does not.
       * Using the same primitive means this mock cannot drift from the contract.
       */
      contextStore: new AsyncLocalStorage<unknown>(),
      captureExceptionMock: vi.fn(),
      captureMessageMock: vi.fn(),
    };
  });

vi.mock('../../db', () => ({
  db: {
    update: dbUpdateMock,
    insert: vi.fn(() => ({ values: () => Promise.resolve([]) })),
  },
  withDbAccessContext: vi.fn(async (ctx: unknown, fn: () => unknown) => {
    // Real semantics (db/index.ts:529-531): an already-open context is JOINED,
    // and the caller's GUCs win over the context handed in here.
    const ambient = contextStore.getStore();
    if (ambient !== undefined) {
      mockState.effectiveContext = ambient;
      return await fn();
    }
    return await contextStore.run(ctx, async () => {
      mockState.effectiveContext = ctx;
      return await fn();
    });
  }),
  runOutsideDbContext: vi.fn(<T,>(fn: () => T): T => contextStore.exit(fn)),
  withSystemDbAccessContext: vi.fn((fn: () => unknown) => fn()),
}));

vi.mock('./historyBuilder', () => ({
  buildMessagesFromHistory: vi.fn(async () => []),
  ToolUseInHistoryError: class ToolUseInHistoryError extends Error {},
}));
vi.mock('../../config/validate', () => ({
  getConfig: () => ({ MCP_LLM_MODEL: 'test-model' }),
}));
vi.mock('../aiCostTracker', () => ({ recordOpenAIUsage: vi.fn(async () => undefined) }));
vi.mock('../aiAgent', () => ({ sanitizeErrorForClient: (e: unknown) => String(e) }));

vi.mock('../sentry', () => ({
  captureException: captureExceptionMock,
  captureMessage: captureMessageMock,
}));

import { OpenAISessionManager, PROCESSING_STALL_TIMEOUT_MS } from './openaiSessionManager';
import { aiSessions } from '../../db/schema';
import type { OpenAICompatibleProvider } from './openaiCompatibleProvider';
import type { AuthContext } from '../../middleware/auth';
import type { OpenAISession } from './types';

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;
const MAX_ACTIVE_SESSIONS = 200;

const dialect = new PgDialect();

/** Private eviction entry points, exercised directly. */
type EvictionInternals = {
  evictStaleSessions(): void;
  evictLeastRecentlyActive(): void;
};
const internals = (m: OpenAISessionManager): EvictionInternals =>
  m as unknown as EvictionInternals;

/** `createdAt` is readonly in the type but writable at runtime. */
type MutableSession = {
  lastActivityAt: number;
  createdAt: number;
  state: OpenAISession['state'];
};

function seed(
  manager: OpenAISessionManager,
  id: string,
  orgId: string,
  opts: { idleFor?: number; ageFor?: number; state?: OpenAISession['state'] } = {},
): OpenAISession {
  const session = manager.getOrCreate(id, orgId, {} as AuthContext, undefined);
  const now = Date.now();
  const mutable = session as unknown as MutableSession;
  if (opts.idleFor !== undefined) mutable.lastActivityAt = now - opts.idleFor;
  if (opts.ageFor !== undefined) mutable.createdAt = now - opts.ageFor;
  if (opts.state !== undefined) mutable.state = opts.state;
  return session;
}

/** The expire-write is fire-and-forget; let its microtasks settle. */
const flush = () => Promise.resolve();

/**
 * Drain the macrotask queue. Required wherever the assertion is about something
 * that happens AFTER the write's `await` (the row-count check): the first write
 * itself is issued synchronously, so any wait keyed on `capturedExpires`
 * resolves long before that code runs.
 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('OpenAISessionManager eviction (#4384)', () => {
  let manager: OpenAISessionManager;

  beforeEach(() => {
    capturedExpires.length = 0;
    mockState.effectiveContext = null;
    mockState.nextRowCount = 1;
    captureMessageMock.mockClear();
    captureExceptionMock.mockClear();
    dbUpdateMock.mockReset();
    dbUpdateMock.mockImplementation((table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: (clause: SQL) => {
          capturedExpires.push({
            table,
            context: mockState.effectiveContext,
            set: values,
            where: clause,
          });
          return Promise.resolve({ count: mockState.nextRowCount });
        },
      }),
    }));
    manager = new OpenAISessionManager({} as OpenAICompatibleProvider);
  });

  afterEach(() => {
    manager.shutdown();
  });

  // ----------------------------------------------------------------------
  // Defect 1 — an in-flight turn must never be evicted
  // ----------------------------------------------------------------------

  describe('a turn in flight is never aborted by eviction', () => {
    it('LRU skips the least-recently-active session when it is mid-turn', () => {
      // The streaming session is the LRU victim by lastActivityAt precisely
      // because the pre-fix code refreshed that stamp only in getOrCreate().
      const streaming = seed(manager, 'streaming', 'org-a', {
        idleFor: 5 * MINUTE,
        state: 'processing',
      });
      seed(manager, 'idle-older', 'org-b', { idleFor: 2 * MINUTE, state: 'idle' });
      seed(manager, 'idle-newer', 'org-c', { idleFor: 1 * MINUTE, state: 'idle' });

      internals(manager).evictLeastRecentlyActive();

      expect(manager.get('streaming')).toBeDefined();
      expect(streaming.abortController.signal.aborted).toBe(false);
      expect(streaming.state).toBe('processing');
      // The oldest *evictable* session is the victim instead.
      expect(manager.get('idle-older')).toBeUndefined();
      expect(manager.get('idle-newer')).toBeDefined();
    });

    it('the 24h age branch defers to the in-flight turn instead of killing it', () => {
      const streaming = seed(manager, 'old-but-streaming', 'org-a', {
        ageFor: 25 * HOUR,
        idleFor: 0,
        state: 'processing',
      });

      internals(manager).evictStaleSessions();

      expect(manager.get('old-but-streaming')).toBeDefined();
      expect(streaming.abortController.signal.aborted).toBe(false);
      expect(capturedExpires).toHaveLength(0);
    });

    it('evicts nothing when every session is mid-turn rather than corrupting a live turn', () => {
      seed(manager, 's1', 'org-a', { idleFor: 5 * MINUTE, state: 'processing' });
      seed(manager, 's2', 'org-b', { idleFor: 4 * MINUTE, state: 'processing' });
      seed(manager, 's3', 'org-c', { idleFor: 3 * MINUTE, state: 'processing' });

      internals(manager).evictLeastRecentlyActive();

      expect(manager.activeCount).toBe(3);
      for (const id of ['s1', 's2', 's3']) {
        expect(manager.get(id)!.abortController.signal.aborted).toBe(false);
      }
      // The cap is genuinely breached here — the operator's only signal.
      expect(captureMessageMock).toHaveBeenCalledTimes(1);
      expect(captureMessageMock.mock.calls[0]![1]).toMatchObject({
        eventCode: 'ai_session_cap_all_in_flight',
      });
    });

    it('throttles the capacity alarm instead of firing it every request', () => {
      seed(manager, 's1', 'org-a', { idleFor: 5 * MINUTE, state: 'processing' });
      seed(manager, 's2', 'org-b', { idleFor: 4 * MINUTE, state: 'processing' });

      internals(manager).evictLeastRecentlyActive();
      internals(manager).evictLeastRecentlyActive();
      internals(manager).evictLeastRecentlyActive();

      // Under sustained pressure this runs once per request; unthrottled it
      // would flood the Sentry quota and drown the signal it exists to give.
      expect(captureMessageMock).toHaveBeenCalledTimes(1);
    });

    it('protects the in-flight turn on the real cap path, not just the private method', () => {
      // Oldest lastActivityAt of the whole pool, but still streaming: exactly
      // the victim the pre-fix LRU scan would have picked.
      const streaming = seed(manager, 'streaming', 'org-live', {
        idleFor: 5 * MINUTE,
        state: 'processing',
      });
      for (let i = 1; i < MAX_ACTIVE_SESSIONS; i++) {
        seed(manager, `filler-${i}`, 'org-filler', { idleFor: 1 * MINUTE, state: 'idle' });
      }
      expect(manager.activeCount).toBe(MAX_ACTIVE_SESSIONS);

      // Crossing the cap runs evictLeastRecentlyActive() for real.
      manager.getOrCreate('newcomer', 'org-new', {} as AuthContext, undefined);

      expect(manager.get('streaming')).toBeDefined();
      expect(streaming.abortController.signal.aborted).toBe(false);
      expect(manager.get('newcomer')).toBeDefined();
      // An idle filler took the hit instead — eviction still did its job.
      expect(manager.activeCount).toBe(MAX_ACTIVE_SESSIONS);
    });

    it('refreshes lastActivityAt when a turn starts so a live session is not the LRU victim', () => {
      const session = seed(manager, 'starting', 'org-a', { idleFor: 90 * MINUTE });
      const before = session.lastActivityAt;

      expect(manager.tryTransitionToProcessing(session)).toBe(true);

      expect(session.lastActivityAt).toBeGreaterThan(before);
    });
  });

  describe('stream progress keeps a long turn alive', () => {
    function streamingProvider(): OpenAICompatibleProvider {
      return {
        chatStream: async function* () {
          yield { type: 'content_delta', delta: 'partial ' };
          yield { type: 'content_delta', delta: 'answer' };
          yield { type: 'message_end', inputTokens: 1, outputTokens: 2 };
        },
        computeCostUsd: () => 0,
      } as unknown as OpenAICompatibleProvider;
    }

    it('refreshes lastActivityAt on every content delta', async () => {
      // The ONLY thing keeping a long stream alive past the stall window. Drop
      // that line and isTurnInFlight goes false ten minutes into any slow turn,
      // eviction aborts mid-stream, and the partial text is persisted as a
      // complete answer — this PR's own defect, reintroduced for exactly the
      // turns most expensive to lose. Nothing else in this file drives runTurn.
      const streaming = new OpenAISessionManager(streamingProvider());
      try {
        const session = streaming.getOrCreate('s', 'org-a', {} as AuthContext, undefined);
        expect(streaming.tryTransitionToProcessing(session)).toBe(true);
        // Back-date AFTER the transition stamp, so only a delta can refresh it.
        (session as unknown as MutableSession).lastActivityAt =
          Date.now() - 3 * HOUR;

        streaming.startTurn(session, 'm', 'sys', 'hello');
        await vi.waitFor(() => expect(session.state).toBe('idle'));

        expect(Date.now() - session.lastActivityAt).toBeLessThan(5 * MINUTE);
      } finally {
        streaming.shutdown();
      }
    });

    it('leaves a session that streamed recently unevictable by the stale sweep', async () => {
      const streaming = new OpenAISessionManager(streamingProvider());
      try {
        const session = streaming.getOrCreate('s', 'org-a', {} as AuthContext, undefined);
        streaming.tryTransitionToProcessing(session);
        (session as unknown as MutableSession).lastActivityAt =
          Date.now() - 3 * HOUR;

        streaming.startTurn(session, 'm', 'sys', 'hello');
        await vi.waitFor(() => expect(session.state).toBe('idle'));

        // Idle-timeout sweep: the refreshed stamp is what saves it.
        internals(streaming).evictStaleSessions();

        expect(streaming.get('s')).toBeDefined();
      } finally {
        streaming.shutdown();
      }
    });
  });

  describe('a stalled turn stays evictable (no immortal session)', () => {
    it('evicts a processing session that has made no progress past the stall window', async () => {
      // runTurn can throw before resetting state to 'idle', and a hung provider
      // never emits another delta. Blanket-protecting `processing` would pin
      // such a session in memory forever.
      const stalled = seed(manager, 'stalled', 'org-a', {
        idleFor: 3 * HOUR,
        state: 'processing',
      });

      internals(manager).evictStaleSessions();
      await flush();

      expect(manager.get('stalled')).toBeUndefined();
      expect(stalled.abortController.signal.aborted).toBe(true);
      expect(capturedExpires).toHaveLength(1);
    });

    // Frozen clock: with the real one, seed() and the eviction read Date.now()
    // milliseconds apart, so "exactly at the edge" drifts past it. Each case
    // also makes the boundary session the SOLE candidate — LRU takes only one
    // victim, so a second stalled session would spare it by position rather
    // than by protection, which is how the first draft of this test passed
    // against a flipped comparison.
    it('protects a processing session at exactly the stall window', () => {
      vi.useFakeTimers();
      const m = new OpenAISessionManager({} as OpenAICompatibleProvider);
      try {
        const atEdge = seed(m, 'at-edge', 'org-a', {
          idleFor: PROCESSING_STALL_TIMEOUT_MS,
          state: 'processing',
        });
        seed(m, 'newer-idle', 'org-b', { idleFor: 1000, state: 'idle' });

        internals(m).evictLeastRecentlyActive();

        // at-edge has the oldest stamp, so only protection can spare it.
        expect(m.get('at-edge')).toBeDefined();
        expect(atEdge.abortController.signal.aborted).toBe(false);
        expect(m.get('newer-idle')).toBeUndefined();
      } finally {
        m.shutdown();
        vi.useRealTimers();
      }
    });

    it('releases a processing session one millisecond past the stall window', () => {
      vi.useFakeTimers();
      const m = new OpenAISessionManager({} as OpenAICompatibleProvider);
      try {
        const pastEdge = seed(m, 'past-edge', 'org-a', {
          idleFor: PROCESSING_STALL_TIMEOUT_MS + 1,
          state: 'processing',
        });
        seed(m, 'newer-idle', 'org-b', { idleFor: 1000, state: 'idle' });

        internals(m).evictLeastRecentlyActive();

        expect(m.get('past-edge')).toBeUndefined();
        expect(pastEdge.abortController.signal.aborted).toBe(true);
        expect(m.get('newer-idle')).toBeDefined();
      } finally {
        m.shutdown();
        vi.useRealTimers();
      }
    });

    it('LRU can reclaim a stalled processing session', () => {
      seed(manager, 'stalled', 'org-a', { idleFor: 45 * MINUTE, state: 'processing' });
      seed(manager, 'fresh-idle', 'org-b', { idleFor: 1 * MINUTE, state: 'idle' });

      internals(manager).evictLeastRecentlyActive();

      expect(manager.get('stalled')).toBeUndefined();
      expect(manager.get('fresh-idle')).toBeDefined();
    });
  });

  // ----------------------------------------------------------------------
  // Defect 2 — every eviction path retires the DB row
  // ----------------------------------------------------------------------

  describe('every eviction path marks the row non-active', () => {
    function expectExpiredWrite(index: number, sessionId: string, orgId: string) {
      const write = capturedExpires[index]!;
      expect(write.set.status).toBe('expired');
      expect(write.set.updatedAt).toBeInstanceOf(Date);
      expect(write.context).toEqual({
        scope: 'organization',
        orgId,
        accessibleOrgIds: [orgId],
      });
      // Guarded on status='active' so a row already closed is never re-stamped.
      const { sql: whereSql, params } = dialect.sqlToQuery(write.where);
      expect(params).toContain(sessionId);
      expect(params).toContain('active');
      // Bind the params to their columns — asserting membership alone would
      // still pass if the id were compared against some other text column.
      expect(whereSql).toMatch(/"id"\s+in/i);
      expect(whereSql).toMatch(/"status"\s*=/i);
    }

    it('idle-timeout eviction expires the row', async () => {
      seed(manager, 'idled-out', 'org-idle', { idleFor: 3 * HOUR, state: 'idle' });

      internals(manager).evictStaleSessions();
      await flush();

      expect(manager.get('idled-out')).toBeUndefined();
      expect(capturedExpires).toHaveLength(1);
      expectExpiredWrite(0, 'idled-out', 'org-idle');
    });

    it('LRU eviction does NOT expire the row — a capacity drop stays resumable', async () => {
      // History lives in ai_messages, so the user's next message rebuilds the
      // session transparently. Stamping 'expired' would turn a transient server
      // capacity condition into a hard 410 for a live conversation, since
      // runPreFlightChecks rejects on status before getOrCreate ever runs.
      seed(manager, 'lru-victim', 'org-lru', { idleFor: 10 * MINUTE, state: 'idle' });
      seed(manager, 'survivor', 'org-keep', { idleFor: 1 * MINUTE, state: 'idle' });

      internals(manager).evictLeastRecentlyActive();
      await flush();

      expect(manager.get('lru-victim')).toBeUndefined();
      expect(capturedExpires).toHaveLength(0);
    });

    it('24h age eviction still expires the row', async () => {
      seed(manager, 'aged-out', 'org-age', { ageFor: 25 * HOUR, idleFor: 0, state: 'idle' });

      internals(manager).evictStaleSessions();
      await flush();

      expect(manager.get('aged-out')).toBeUndefined();
      expect(capturedExpires).toHaveLength(1);
      expectExpiredWrite(0, 'aged-out', 'org-age');
    });

    it('expires the evicted session under ITS OWN org scope, escaping the request context', async () => {
      // Reproduces the production shape: getOrCreate() runs inside the
      // REQUESTER's context, while the LRU victim belongs to another tenant.
      seed(manager, 'victim', 'org-victim', { idleFor: 3 * HOUR, state: 'idle' });

      // A requester context is genuinely open around the sweep. That is not
      // hypothetical: the manager is a lazy singleton built inside an AI
      // request, so its eviction timer inherits that request's context on every
      // tick unless the constructor escapes it.
      contextStore.run(
        { scope: 'organization', orgId: 'org-requester', accessibleOrgIds: ['org-requester'] },
        () => internals(manager).evictStaleSessions(),
      );
      await flush();

      expect(capturedExpires).toHaveLength(1);
      // Joining the requester's context would make this UPDATE match zero rows
      // under RLS — green mock, dead code in production.
      expect(capturedExpires[0]!.context).toEqual({
        scope: 'organization',
        orgId: 'org-victim',
        accessibleOrgIds: ['org-victim'],
      });
    });

    it('keeps every org in a cohort on its OWN scope, including after the first await', async () => {
      // The writes are serialized, so orgs 2..N resume in a continuation
      // scheduled inside runOutsideDbContext rather than running synchronously
      // within it. If AsyncLocalStorage.exit() did not cover the whole async
      // subtree, the ambient requester context would leak back in for exactly
      // those later iterations and their UPDATEs would match zero rows under
      // RLS — the single-session cross-tenant test above cannot see this.
      seed(manager, 'a1', 'org-a', { idleFor: 3 * HOUR, state: 'idle' });
      seed(manager, 'b1', 'org-b', { idleFor: 3 * HOUR, state: 'idle' });
      seed(manager, 'c1', 'org-c', { idleFor: 3 * HOUR, state: 'idle' });

      contextStore.run(
        { scope: 'organization', orgId: 'org-requester', accessibleOrgIds: ['org-requester'] },
        () => internals(manager).evictStaleSessions(),
      );
      await vi.waitFor(() => expect(capturedExpires).toHaveLength(3));

      const orgs = capturedExpires.map((w) => (w.context as { orgId: string }).orgId).sort();
      expect(orgs).toEqual(['org-a', 'org-b', 'org-c']);
      expect(orgs).not.toContain('org-requester');
    });

    it('surfaces a zero-row expire — the RLS-denial signature is otherwise silent', async () => {
      // A cross-tenant UPDATE does not raise under forced RLS; it matches zero
      // rows and reports success. If nothing reads the count, a regression that
      // reinstates the context leak is invisible in production.
      mockState.nextRowCount = 0;
      seed(manager, 'ghost', 'org-a', { idleFor: 3 * HOUR, state: 'idle' });

      internals(manager).evictStaleSessions();
      await settle();

      expect(captureMessageMock).toHaveBeenCalledTimes(1);
      expect(captureMessageMock.mock.calls[0]![1]).toMatchObject({
        eventCode: 'db_write_expecting_rows_zero',
      });
    });

    it('stays quiet when the expire actually lands', async () => {
      seed(manager, 'real', 'org-a', { idleFor: 3 * HOUR, state: 'idle' });

      internals(manager).evictStaleSessions();
      // A real settle, not vi.waitFor: the first write is pushed SYNCHRONOUSLY,
      // so waiting on capturedExpires resolves several ticks before the
      // post-await row-count check runs — which made this pass in both worlds.
      await settle();

      expect(capturedExpires).toHaveLength(1);
      expect(captureMessageMock).not.toHaveBeenCalled();
    });

    it('still retires the sessions already dropped when the sweep throws mid-way', async () => {
      // The `finally` exists so a throw cannot strand the rows for sessions
      // already removed from the Map — the exact defect being fixed, minus any
      // record of which ones.
      seed(manager, 'first', 'org-a', { idleFor: 3 * HOUR, state: 'idle' });
      const exploding = seed(manager, 'second', 'org-b', { idleFor: 3 * HOUR, state: 'idle' });
      seed(manager, 'third', 'org-c', { idleFor: 3 * HOUR, state: 'idle' });
      exploding.eventBus.publish = () => {
        throw new Error('bus exploded');
      };

      expect(() => internals(manager).evictStaleSessions()).toThrow('bus exploded');
      await settle();

      // 'first' was already removed from the Map, so its row must be retired.
      expect(manager.get('first')).toBeUndefined();
      expect(capturedExpires).toHaveLength(1);
      expect((capturedExpires[0]!.context as { orgId: string }).orgId).toBe('org-a');
    });

    it('does not expire rows for sessions it leaves in place', async () => {
      seed(manager, 'healthy', 'org-a', { idleFor: 1 * MINUTE, state: 'idle' });

      internals(manager).evictStaleSessions();
      await flush();

      expect(manager.get('healthy')).toBeDefined();
      expect(capturedExpires).toHaveLength(0);
    });

    it('still notifies the client on the stale-eviction path', async () => {
      const session = seed(manager, 'notified', 'org-a', { idleFor: 3 * HOUR, state: 'idle' });
      const events = session.eventBus.getReplayEvents();

      internals(manager).evictStaleSessions();
      await flush();

      const published = session.eventBus.getReplayEvents(events.length);
      expect(published.map((e) => e.type)).toEqual(['error', 'done']);
    });

    it('still notifies the client on the LRU path', async () => {
      const victim = seed(manager, 'lru-notified', 'org-a', { idleFor: 10 * MINUTE, state: 'idle' });
      seed(manager, 'keeper', 'org-b', { idleFor: 1 * MINUTE, state: 'idle' });
      const before = victim.eventBus.getReplayEvents().length;

      internals(manager).evictLeastRecentlyActive();
      await flush();

      const published = victim.eventBus.getReplayEvents(before);
      expect(published.map((e) => e.type)).toEqual(['error', 'done']);
    });

    it('batches a whole idle cohort into one statement per org', async () => {
      // A load spike creates sessions that idle out together; one transaction
      // per session would contend with live traffic for the connection pool.
      seed(manager, 'a1', 'org-a', { idleFor: 3 * HOUR, state: 'idle' });
      seed(manager, 'a2', 'org-a', { idleFor: 3 * HOUR, state: 'idle' });
      seed(manager, 'a3', 'org-a', { idleFor: 3 * HOUR, state: 'idle' });
      seed(manager, 'b1', 'org-b', { idleFor: 3 * HOUR, state: 'idle' });

      internals(manager).evictStaleSessions();
      // The writes are serialized, so poll rather than guessing a microtask depth.
      await vi.waitFor(() => expect(capturedExpires).toHaveLength(2));

      expect(manager.activeCount).toBe(0);
      const orgs = capturedExpires.map(
        (w) => (w.context as { orgId: string }).orgId,
      );
      expect(orgs.sort()).toEqual(['org-a', 'org-b']);
      // Exact sets, not arrayContaining: an implementation that put EVERY id in
      // EVERY org's batch would satisfy a containment check, and under RLS the
      // stray ids match zero rows — surfacing as a Sentry flood rather than a
      // clean failure.
      const idsFor = (org: string) => {
        const write = capturedExpires.find(
          (w) => (w.context as { orgId: string }).orgId === org,
        )!;
        return dialect
          .sqlToQuery(write.where)
          .params.filter((p): p is string => typeof p === 'string' && p !== 'active')
          .sort();
      };
      expect(idsFor('org-a')).toEqual(['a1', 'a2', 'a3']);
      expect(idsFor('org-b')).toEqual(['b1']);
    });

    it('keeps expiring later orgs when one org\'s write fails', async () => {
      // A stranded 'active' row is the exact defect being fixed, so one bad
      // org must not abandon the rest of the cohort.
      dbUpdateMock.mockImplementationOnce(() => ({
        set: () => ({ where: () => Promise.reject(new Error('pool exhausted')) }),
      }));
      seed(manager, 'a1', 'org-a', { idleFor: 3 * HOUR, state: 'idle' });
      seed(manager, 'b1', 'org-b', { idleFor: 3 * HOUR, state: 'idle' });

      internals(manager).evictStaleSessions();
      await vi.waitFor(() => expect(capturedExpires).toHaveLength(1));

      expect(captureExceptionMock).toHaveBeenCalledTimes(1);
      // org-b still got its write despite org-a blowing up.
      expect((capturedExpires[0]!.context as { orgId: string }).orgId).toBe('org-b');
    });

    it('does not expire rows on shutdown — sessions stay resumable across a deploy', async () => {
      // Sessions are rehydrated from ai_messages on the next request, so a
      // restart must NOT terminate them. Pinned because afterEach calls
      // shutdown() everywhere and would otherwise mask a regression here.
      seed(manager, 'survives-restart', 'org-a', { idleFor: 1 * MINUTE, state: 'idle' });

      manager.shutdown();
      await flush();

      expect(manager.get('survives-restart')).toBeUndefined();
      expect(capturedExpires).toHaveLength(0);
    });
  });
});
