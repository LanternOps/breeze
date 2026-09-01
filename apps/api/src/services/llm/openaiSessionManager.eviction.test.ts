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

const { dbUpdateMock, capturedExpires, mockState, captureExceptionMock } = vi.hoisted(() => ({
  dbUpdateMock: vi.fn(),
  capturedExpires: [] as {
    context: unknown;
    set: Record<string, unknown>;
    where: SQL;
  }[],
  mockState: {
    /** Simulates an already-open request-scoped DB context (the ALS store). */
    ambientContext: null as unknown,
    /** Context in force at the moment the UPDATE is issued. */
    effectiveContext: null as unknown,
  },
  captureExceptionMock: vi.fn(),
}));

vi.mock('../../db', () => ({
  db: { update: dbUpdateMock },
  withDbAccessContext: vi.fn(async (ctx: unknown, fn: () => unknown) => {
    // Real semantics: an already-open context is JOINED, not replaced.
    mockState.effectiveContext = mockState.ambientContext ?? ctx;
    return await fn();
  }),
  runOutsideDbContext: vi.fn(<T,>(fn: () => T): T => {
    const saved = mockState.ambientContext;
    mockState.ambientContext = null; // real impl exits the ALS store
    try {
      return fn();
    } finally {
      mockState.ambientContext = saved;
    }
  }),
  withSystemDbAccessContext: vi.fn((fn: () => unknown) => fn()),
}));

vi.mock('../sentry', () => ({
  captureException: captureExceptionMock,
  captureMessage: vi.fn(),
}));

import { OpenAISessionManager } from './openaiSessionManager';
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

describe('OpenAISessionManager eviction (#4384)', () => {
  let manager: OpenAISessionManager;

  beforeEach(() => {
    capturedExpires.length = 0;
    mockState.ambientContext = null;
    mockState.effectiveContext = null;
    captureExceptionMock.mockClear();
    dbUpdateMock.mockReset();
    dbUpdateMock.mockImplementation(() => ({
      set: (values: Record<string, unknown>) => ({
        where: (clause: SQL) => {
          capturedExpires.push({
            context: mockState.effectiveContext,
            set: values,
            where: clause,
          });
          return Promise.resolve([]);
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
      const { params } = dialect.sqlToQuery(write.where);
      expect(params).toContain(sessionId);
      expect(params).toContain('active');
    }

    it('idle-timeout eviction expires the row', async () => {
      seed(manager, 'idled-out', 'org-idle', { idleFor: 3 * HOUR, state: 'idle' });

      internals(manager).evictStaleSessions();
      await flush();

      expect(manager.get('idled-out')).toBeUndefined();
      expect(capturedExpires).toHaveLength(1);
      expectExpiredWrite(0, 'idled-out', 'org-idle');
    });

    it('LRU eviction expires the row', async () => {
      seed(manager, 'lru-victim', 'org-lru', { idleFor: 10 * MINUTE, state: 'idle' });
      seed(manager, 'survivor', 'org-keep', { idleFor: 1 * MINUTE, state: 'idle' });

      internals(manager).evictLeastRecentlyActive();
      await flush();

      expect(manager.get('lru-victim')).toBeUndefined();
      expect(capturedExpires).toHaveLength(1);
      expectExpiredWrite(0, 'lru-victim', 'org-lru');
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
      seed(manager, 'victim', 'org-victim', { idleFor: 10 * MINUTE, state: 'idle' });
      mockState.ambientContext = {
        scope: 'organization',
        orgId: 'org-requester',
        accessibleOrgIds: ['org-requester'],
      };

      internals(manager).evictLeastRecentlyActive();
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

    it('does not expire rows for sessions it leaves in place', async () => {
      seed(manager, 'healthy', 'org-a', { idleFor: 1 * MINUTE, state: 'idle' });

      internals(manager).evictStaleSessions();
      await flush();

      expect(manager.get('healthy')).toBeDefined();
      expect(capturedExpires).toHaveLength(0);
    });

    it('still notifies the client on every eviction path', async () => {
      const session = seed(manager, 'notified', 'org-a', { idleFor: 3 * HOUR, state: 'idle' });
      const events = session.eventBus.getReplayEvents();

      internals(manager).evictStaleSessions();
      await flush();

      const published = session.eventBus.getReplayEvents(events.length);
      expect(published.map((e) => e.type)).toEqual(['error', 'done']);
    });
  });
});
