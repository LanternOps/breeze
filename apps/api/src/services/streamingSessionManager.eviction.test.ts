/**
 * Eviction contract for the DEFAULT (Anthropic) session manager — issue #4514,
 * the deferred twin of #4384/#4406 (llm/openaiSessionManager.eviction.test.ts).
 *
 * Two defects are pinned here:
 *   1. Neither eviction path checked `state === 'processing'`, so under cap
 *      pressure the least-recently-*created-or-resumed* session could be the one
 *      currently streaming — `remove()` aborts its controller and closes the SDK
 *      query and the event bus mid-turn.
 *   2. Only the 24h-age branch retired the DB row; idle eviction left
 *      `ai_sessions.status = 'active'` on a session that no longer exists.
 *
 * Protection is deliberately NOT `state` alone — see PROCESSING_STALL_TIMEOUT_MS.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const {
  queryMock,
  dbUpdateMock,
  capturedExpires,
  mockState,
  contextStore,
  captureExceptionMock,
  captureMessageMock,
} = vi.hoisted(() => {
  const { AsyncLocalStorage } = require('node:async_hooks') as typeof import('node:async_hooks');
  return {
    queryMock: vi.fn(),
    dbUpdateMock: vi.fn(),
    capturedExpires: [] as {
      context: unknown;
      set: Record<string, unknown>;
      where: SQL;
    }[],
    mockState: {
      /** Context in force at the moment the UPDATE is issued. */
      effectiveContext: null as unknown,
      /** Rows the next UPDATE resolves with. Empty = the RLS-denial signature. */
      nextRows: [{ id: 'row' }] as { id: string }[],
      /** Org ids whose UPDATE should reject, to prove the loop keeps going. */
      failOrgIds: new Set<string>(),
    },
    /**
     * The REAL primitive the db module uses, not a hand-rolled stand-in. A
     * synchronous save/restore would diverge the moment the implementation
     * awaits between writes: `AsyncLocalStorage.exit()` covers the whole async
     * subtree scheduled inside it, a flag restored in a `finally` does not.
     * Using the same primitive means this mock cannot drift from the contract
     * it stands in for.
     */
    contextStore: new AsyncLocalStorage<unknown>(),
    captureExceptionMock: vi.fn(),
    captureMessageMock: vi.fn(),
  };
});

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: queryMock }));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve([{ approvalMode: 'per_step' }])),
        })),
      })),
    })),
    insert: vi.fn(() => ({ values: vi.fn(() => Promise.resolve()) })),
    update: dbUpdateMock,
  },
  withDbAccessContext: vi.fn(async (ctx: unknown, fn: () => unknown) => {
    // Real semantics (db/index.ts): an already-open context is JOINED, and the
    // caller's GUCs win over the context handed in here.
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
  withSystemDbAccessContext: vi.fn(async (fn: () => unknown) => await fn()),
  runOutsideDbContext: vi.fn(<T,>(fn: () => T): T => contextStore.exit(fn)),
}));

// `dbWriteExpectingRows` is deliberately NOT mocked: it is the code under test's
// only zero-row alarm, and stubbing it would make the RLS-signature assertion
// below prove nothing. It reaches captureMessage through this same mocked module.
vi.mock('./sentry', () => ({
  captureException: captureExceptionMock,
  captureMessage: captureMessageMock,
}));

vi.mock('./aiCostTracker', () => ({
  recordUsageFromSdkResult: vi.fn(() => Promise.resolve()),
  calculateCostCents: vi.fn(() => 0),
  calculateCatalogCostCents: vi.fn(() => 0),
  sumInputTokens: (u: Record<string, number | null | undefined> | null | undefined) =>
    (u?.input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0),
}));
vi.mock('./aiAgent', () => ({ sanitizeErrorForClient: (e: unknown) => String(e) }));
vi.mock('./aiAgentSdkTools', () => ({
  createBreezeMcpServer: vi.fn(() => ({ type: 'sdk' })),
  BREEZE_MCP_TOOL_NAMES: ['mcp__breeze__query_devices'],
}));
vi.mock('./aiAgentSdk', () => ({
  createSessionPreToolUse: vi.fn(() => vi.fn()),
  createSessionPostToolUse: vi.fn(() => vi.fn()),
  settleApprovalWaits: vi.fn(),
}));
vi.mock('./aiToolOutput', () => ({
  redactAiToolOutputText: (s: string) => s,
  redactSensitiveToolInput: (i: unknown) => i,
}));
vi.mock('./clientIp', () => ({ getTrustedClientIpOrUndefined: () => undefined }));

import {
  StreamingSessionManager,
  SessionEventBus,
  PROCESSING_STALL_TIMEOUT_MS,
  type ActiveSession,
  type SessionState,
} from './streamingSessionManager';
import type { AuthContext } from '../middleware/auth';
import type { UsableLlmConfig } from './llm/llmConfigResolver';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const MAX_ACTIVE_SESSIONS = 200;

const dialect = new PgDialect();

/** Private surface, exercised directly. */
type ManagerInternals = {
  sessions: Map<string, ActiveSession>;
  evictStaleSessions(): void;
  evictLeastRecentlyActive(): void;
};
const internals = (m: StreamingSessionManager): ManagerInternals =>
  m as unknown as ManagerInternals;

/**
 * Build a session with everything `remove()` and the eviction paths touch, and
 * register it. Direct Map injection rather than `getOrCreate()`: the real
 * constructor spawns an SDK subprocess per session, and several cases here need
 * a whole 200-session cohort. The one test that must prove the WIRING — that
 * the cap check actually reaches the protected LRU path — goes through the real
 * `getOrCreate()` instead.
 */
function seed(
  manager: StreamingSessionManager,
  id: string,
  orgId: string,
  opts: { idleFor?: number; ageFor?: number; state?: SessionState } = {},
): ActiveSession {
  const now = Date.now();
  const session = {
    breezeSessionId: id,
    orgId,
    deviceId: null,
    model: 'claude-sonnet-4-5',
    sdkSessionId: null,
    query: { close: vi.fn(), interrupt: vi.fn() },
    abortController: new AbortController(),
    inputController: { close: vi.fn() },
    eventBus: new SessionEventBus(),
    state: opts.state ?? 'idle',
    lastActivityAt: now - (opts.idleFor ?? 0),
    createdAt: now - (opts.ageFor ?? 0),
    turnTimeoutId: null,
    toolUseIdQueue: [],
    pendingApprovalWaits: 0,
    approvalWaitDeadline: null,
    approvalWaitAbort: null,
  } as unknown as ActiveSession;
  internals(manager).sessions.set(id, session);
  return session;
}

/** The expire write is fire-and-forget; let its microtasks settle. */
const flush = () => Promise.resolve();

/**
 * Drain the macrotask queue. Required wherever the assertion is about something
 * that happens AFTER the write's `await` (the row-count check, the next org in
 * the loop): the first write is issued synchronously, so any wait keyed on
 * `capturedExpires` resolves long before that code runs.
 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function expectExpiredWrite(index: number, sessionIds: string[], orgId: string) {
  const write = capturedExpires[index]!;
  expect(write.set.status).toBe('expired');
  expect(write.set.updatedAt).toBeInstanceOf(Date);
  expect(write.context).toEqual({
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
  });
  // Guarded on status='active' so a row the user already closed is never
  // re-stamped as expired.
  const { sql: whereSql, params } = dialect.sqlToQuery(write.where);
  for (const id of sessionIds) expect(params).toContain(id);
  expect(params).toContain('active');
  // Bind the params to their columns — asserting membership alone would still
  // pass if the id were compared against some other text column.
  expect(whereSql).toMatch(/"id"\s+in/i);
  expect(whereSql).toMatch(/"status"\s*=/i);
}

const capacityAlarms = () =>
  captureMessageMock.mock.calls.filter(
    (c) => (c[1] as { eventCode?: string } | undefined)?.eventCode === 'ai_session_cap_all_in_flight',
  );
const zeroRowAlarms = () =>
  captureMessageMock.mock.calls.filter(
    (c) => (c[1] as { eventCode?: string } | undefined)?.eventCode === 'db_write_expecting_rows_zero',
  );

// ── fixtures for the one test that drives the real getOrCreate path ──────────
const ORG = '0c0c0c0c-1111-4222-8333-444455556666';
const DB_SESSION = {
  orgId: ORG,
  sdkSessionId: null,
  model: 'claude-sonnet-4-5-20250929',
  maxTurns: 50,
  turnCount: 0,
  systemPrompt: null,
};
const AUTH = {
  orgId: ORG,
  scope: 'organization',
  accessibleOrgIds: [ORG],
  user: { id: 'beefbeef-1111-4222-8333-444455556666', email: 'tech@contoso.com' },
} as unknown as AuthContext;
const PLATFORM_CONFIG = {
  source: 'platform' as const,
  apiKey: 'platform-key',
  model: 'claude-sonnet-4-6',
} as unknown as UsableLlmConfig;

function mockSdkQuery(messages: unknown[], gate: Promise<void> = Promise.resolve()) {
  queryMock.mockImplementation(() => ({
    async *[Symbol.asyncIterator]() {
      // The gate lets a test back-date lastActivityAt AFTER getOrCreate returns
      // but BEFORE any stream event lands — otherwise the processor may already
      // have drained the messages and the assertion proves nothing.
      await gate;
      yield* messages as never[];
    },
    interrupt: vi.fn(),
    close: vi.fn(),
  }));
}

function gatedSdkQuery(messages: unknown[]): () => void {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  mockSdkQuery(messages, gate);
  return release;
}
const textDelta = (text: string) => ({
  type: 'stream_event',
  event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
});
const messageStart = () => ({ type: 'stream_event', event: { type: 'message_start' } });
const RESULT_MSG = {
  type: 'result',
  subtype: 'success',
  total_cost_usd: 0.01,
  usage: { input_tokens: 10, output_tokens: 5 },
  num_turns: 1,
};

describe('StreamingSessionManager eviction (#4514)', () => {
  let manager: StreamingSessionManager;

  beforeEach(() => {
    capturedExpires.length = 0;
    mockState.effectiveContext = null;
    mockState.nextRows = [{ id: 'row' }];
    mockState.failOrgIds = new Set();
    // Targeted resets, never vi.clearAllMocks(): a blanket reset would wipe the
    // dbUpdateMock implementation installed here and the hoisted context store's
    // semantics along with it.
    captureMessageMock.mockClear();
    captureExceptionMock.mockClear();
    queryMock.mockReset();
    dbUpdateMock.mockReset();
    dbUpdateMock.mockImplementation(() => ({
      set: (values: Record<string, unknown>) => ({
        where: (clause: SQL) => ({
          returning: () => {
            const ctx = mockState.effectiveContext as { orgId?: string } | null;
            capturedExpires.push({ context: ctx, set: values, where: clause });
            if (ctx?.orgId && mockState.failOrgIds.has(ctx.orgId)) {
              return Promise.reject(new Error(`write failed for ${ctx.orgId}`));
            }
            return Promise.resolve(mockState.nextRows);
          },
        }),
      }),
    }));
    manager = new StreamingSessionManager();
  });

  afterEach(() => {
    manager.shutdown();
    vi.useRealTimers();
  });

  // ==========================================================================
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

    it('the 24h age branch defers to the in-flight turn instead of killing it', async () => {
      // Past the 24h hard cap, but actively streaming right now.
      const streaming = seed(manager, 'aged-streaming', 'org-a', {
        idleFor: 10 * 1000,
        ageFor: 25 * HOUR,
        state: 'processing',
      });

      internals(manager).evictStaleSessions();
      await settle();

      expect(manager.get('aged-streaming')).toBeDefined();
      expect(streaming.abortController.signal.aborted).toBe(false);
      // And nothing was retired: the session is still live.
      expect(capturedExpires).toHaveLength(0);
    });

    it('evicts nothing when every session is mid-turn rather than corrupting a live turn', () => {
      seed(manager, 's1', 'org-a', { idleFor: 5 * MINUTE, state: 'processing' });
      seed(manager, 's2', 'org-b', { idleFor: 4 * MINUTE, state: 'processing' });

      internals(manager).evictLeastRecentlyActive();

      expect(manager.activeCount).toBe(2);
      // Overshooting the soft cap is self-correcting; corrupting a live turn is
      // not. But the breach must still reach Sentry, not just stdout.
      expect(capacityAlarms()).toHaveLength(1);
    });

    it('throttles the capacity alarm instead of firing it on every request', () => {
      seed(manager, 's1', 'org-a', { idleFor: 5 * MINUTE, state: 'processing' });

      internals(manager).evictLeastRecentlyActive();
      internals(manager).evictLeastRecentlyActive();
      internals(manager).evictLeastRecentlyActive();

      expect(capacityAlarms()).toHaveLength(1);
    });

    it('protects the in-flight turn on the REAL cap path, not just the private method', async () => {
      // Fill to the cap with live turns, then let getOrCreate trip the check at
      // `this.sessions.size >= MAX_ACTIVE_SESSIONS`. This is the wiring the
      // private-method tests above cannot see.
      for (let i = 0; i < MAX_ACTIVE_SESSIONS; i++) {
        // Staggered but all well inside PROCESSING_STALL_TIMEOUT_MS, so every
        // one of them is genuinely in flight.
        seed(manager, `live-${i}`, 'org-a', { idleFor: (i + 1) * 1000, state: 'processing' });
      }
      // Gated: the background processor removes its own session once the SDK
      // stream ends, so the assertions have to run while the turn is still open.
      const release = gatedSdkQuery([RESULT_MSG]);

      const created = await manager.getOrCreate(
        'sess-new', DB_SESSION, AUTH, undefined, 'PROMPT', undefined, PLATFORM_CONFIG,
      );

      // Not one of the 200 live turns was taken.
      for (let i = 0; i < MAX_ACTIVE_SESSIONS; i++) {
        expect(manager.get(`live-${i}`)).toBeDefined();
      }
      // The cap is deliberately overshot instead: that self-corrects as soon as
      // any turn ends, whereas a corrupted live turn does not.
      expect(manager.get('sess-new')).toBeDefined();
      expect(manager.activeCount).toBe(MAX_ACTIVE_SESSIONS + 1);
      expect(capacityAlarms()).toHaveLength(1);

      release();
      await created.processorPromise;
    });

    it('refreshes lastActivityAt when a turn starts, so a live session is not the LRU victim', () => {
      const session = seed(manager, 'starting', 'org-a', { idleFor: 90 * MINUTE, state: 'idle' });
      const before = session.lastActivityAt;

      expect(manager.tryTransitionToProcessing(session)).toBe(true);

      expect(session.lastActivityAt).toBeGreaterThan(before);
      expect(Date.now() - session.lastActivityAt).toBeLessThan(1000);
    });
  });

  // ==========================================================================
  describe('stream progress keeps a long turn alive', () => {
    it('refreshes lastActivityAt on every content delta', async () => {
      const release = gatedSdkQuery([textDelta('hello'), textDelta(' world'), RESULT_MSG]);
      const session = await manager.getOrCreate(
        'sess-delta', DB_SESSION, AUTH, undefined, 'PROMPT', undefined, PLATFORM_CONFIG,
      );
      // Back-date so only a delta keepalive can move it forward.
      session.lastActivityAt = Date.now() - 3 * HOUR;
      const before = session.lastActivityAt;

      release();
      await session.processorPromise;

      expect(session.eventBus.getReplayEvents().filter((e) => e.type === 'content_delta')).toHaveLength(2);
      expect(session.lastActivityAt).toBeGreaterThan(before);
    });

    it('refreshes lastActivityAt at message_start, so a tool-only turn is not silent', async () => {
      // A turn that emits no text delta at all still makes progress. Unlike the
      // OpenAI twin, this path can spend minutes in approval waits and tool
      // execution between message boundaries.
      const release = gatedSdkQuery([messageStart(), RESULT_MSG]);
      const session = await manager.getOrCreate(
        'sess-tool-only', DB_SESSION, AUTH, undefined, 'PROMPT', undefined, PLATFORM_CONFIG,
      );
      session.lastActivityAt = Date.now() - 3 * HOUR;
      const before = session.lastActivityAt;

      release();
      await session.processorPromise;

      expect(session.lastActivityAt).toBeGreaterThan(before);
    });
  });

  // ==========================================================================
  describe('a stalled turn stays evictable (no immortal session)', () => {
    it('evicts a processing session that has made no progress past the stall window', async () => {
      // runBackgroundProcessor can leave `state` pinned at 'processing' after a
      // throw; without the stall window that session would never be reclaimed.
      seed(manager, 'wedged', 'org-a', {
        idleFor: 3 * HOUR,
        state: 'processing',
      });

      internals(manager).evictStaleSessions();
      await settle();

      expect(manager.get('wedged')).toBeUndefined();
      expectExpiredWrite(0, ['wedged'], 'org-a');
    });

    it('protects a processing session at exactly the stall window', () => {
      // Frozen clock: seed() and the sweep both read Date.now(), so a single
      // elapsed millisecond would move an at-edge session past the window and
      // the test would assert position rather than protection.
      vi.useFakeTimers();
      // A fresh manager: each boundary case must be the SOLE candidate, so LRU
      // spares it by protection rather than by position.
      const m = new StreamingSessionManager();
      try {
        const atEdge = seed(m, 'at-edge', 'org-a', {
          idleFor: PROCESSING_STALL_TIMEOUT_MS,
          state: 'processing',
        });
        seed(m, 'newer-idle', 'org-b', { idleFor: 1000, state: 'idle' });

        internals(m).evictLeastRecentlyActive();

        expect(m.get('at-edge')).toBeDefined();
        expect(atEdge.abortController.signal.aborted).toBe(false);
        expect(m.get('newer-idle')).toBeUndefined();
      } finally {
        m.shutdown();
      }
    });

    it('releases a processing session one millisecond past the stall window', () => {
      vi.useFakeTimers();
      const m = new StreamingSessionManager();
      try {
        seed(m, 'past-edge', 'org-a', {
          idleFor: PROCESSING_STALL_TIMEOUT_MS + 1,
          state: 'processing',
        });
        seed(m, 'newer-idle', 'org-b', { idleFor: 1000, state: 'idle' });

        internals(m).evictLeastRecentlyActive();

        expect(m.get('past-edge')).toBeUndefined();
        expect(m.get('newer-idle')).toBeDefined();
      } finally {
        m.shutdown();
      }
    });

    it('LRU can reclaim a stalled processing session', () => {
      seed(manager, 'wedged', 'org-a', {
        idleFor: PROCESSING_STALL_TIMEOUT_MS + MINUTE,
        state: 'processing',
      });
      seed(manager, 'healthy', 'org-b', { idleFor: 1 * MINUTE, state: 'idle' });

      internals(manager).evictLeastRecentlyActive();

      expect(manager.get('wedged')).toBeUndefined();
      expect(manager.get('healthy')).toBeDefined();
      // Capacity eviction never expires — even for a wedged session.
      expect(capturedExpires).toHaveLength(0);
    });
  });

  // ==========================================================================
  describe('every staleness eviction path retires the row', () => {
    it('idle-timeout eviction expires the row', async () => {
      seed(manager, 'idled', 'org-a', { idleFor: 3 * HOUR, ageFor: 4 * HOUR, state: 'idle' });

      internals(manager).evictStaleSessions();
      await settle();

      expect(manager.get('idled')).toBeUndefined();
      expect(capturedExpires).toHaveLength(1);
      expectExpiredWrite(0, ['idled'], 'org-a');
    });

    it('24h age eviction still expires the row', async () => {
      seed(manager, 'aged', 'org-a', { idleFor: 1 * MINUTE, ageFor: 25 * HOUR, state: 'idle' });

      internals(manager).evictStaleSessions();
      await settle();

      expect(manager.get('aged')).toBeUndefined();
      expectExpiredWrite(0, ['aged'], 'org-a');
    });

    it('LRU eviction does NOT expire the row — a capacity drop stays resumable', async () => {
      seed(manager, 'victim', 'org-a', { idleFor: 5 * MINUTE, state: 'idle' });

      internals(manager).evictLeastRecentlyActive();
      await settle();

      expect(manager.get('victim')).toBeUndefined();
      // History lives in ai_messages and the row resumes from sdkSessionId, so
      // stamping 'expired' would turn a transient capacity condition into a hard
      // 410 for a conversation minutes old.
      expect(capturedExpires).toHaveLength(0);
    });

    it('expires the evicted session under ITS OWN org scope, escaping any request context', async () => {
      seed(manager, 'victim', 'org-victim', { idleFor: 3 * HOUR, state: 'idle' });

      // A requester's context genuinely open around the sweep. Today the timer
      // is armed at module load with no ambient context, but LRU already runs
      // from getOrCreate on the request path — this pins the escape so a future
      // caller cannot silently inherit someone else's GUCs.
      await contextStore.run(
        { scope: 'organization', orgId: 'org-requester', accessibleOrgIds: ['org-requester'] },
        async () => {
          internals(manager).evictStaleSessions();
          await flush();
        },
      );
      await settle();

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
      // The regression a single hoisted `runOutsideDbContext` produces:
      // AsyncLocalStorage.exit() covers the synchronous call and what it
      // schedules, but iteration 2+ resumes with the caller's context live.
      seed(manager, 'v-a', 'org-a', { idleFor: 3 * HOUR, state: 'idle' });
      seed(manager, 'v-b', 'org-b', { idleFor: 3 * HOUR, state: 'idle' });
      seed(manager, 'v-c', 'org-c', { idleFor: 3 * HOUR, state: 'idle' });

      await contextStore.run(
        { scope: 'organization', orgId: 'org-requester', accessibleOrgIds: ['org-requester'] },
        async () => {
          internals(manager).evictStaleSessions();
          await flush();
        },
      );
      await settle();
      await settle();

      expect(capturedExpires).toHaveLength(3);
      expect(capturedExpires.map((w) => (w.context as { orgId: string }).orgId)).toEqual([
        'org-a', 'org-b', 'org-c',
      ]);
    });

    it('surfaces a zero-row expire — the RLS-denial signature is otherwise silent', async () => {
      mockState.nextRows = [];
      seed(manager, 'victim', 'org-a', { idleFor: 3 * HOUR, state: 'idle' });

      internals(manager).evictStaleSessions();
      await settle();
      await settle();

      // An UPDATE under the wrong tenant's GUCs does not raise under forced RLS
      // — it matches zero rows and reports success.
      expect(zeroRowAlarms()).toHaveLength(1);
    });

    it('stays quiet when the expire actually lands', async () => {
      seed(manager, 'victim', 'org-a', { idleFor: 3 * HOUR, state: 'idle' });

      internals(manager).evictStaleSessions();
      await settle();
      await settle();

      expect(zeroRowAlarms()).toHaveLength(0);
    });

    it('batches a whole idle cohort into ONE statement per org', async () => {
      for (const id of ['a1', 'a2', 'a3']) {
        seed(manager, id, 'org-a', { idleFor: 3 * HOUR, state: 'idle' });
      }
      seed(manager, 'b1', 'org-b', { idleFor: 3 * HOUR, state: 'idle' });

      internals(manager).evictStaleSessions();
      await settle();
      await settle();

      // One transaction per session would put up to MAX_ACTIVE_SESSIONS of them
      // against a pool of DB_POOL_MAX shared with live request traffic.
      expect(capturedExpires).toHaveLength(2);
      expectExpiredWrite(0, ['a1', 'a2', 'a3'], 'org-a');
      expectExpiredWrite(1, ['b1'], 'org-b');
    });

    it('keeps expiring later orgs when one org write fails', async () => {
      mockState.failOrgIds = new Set(['org-a']);
      seed(manager, 'v-a', 'org-a', { idleFor: 3 * HOUR, state: 'idle' });
      seed(manager, 'v-b', 'org-b', { idleFor: 3 * HOUR, state: 'idle' });

      internals(manager).evictStaleSessions();
      await settle();
      await settle();

      expect(captureExceptionMock).toHaveBeenCalled();
      // org-b must still be retired — abandoning the loop strands exactly the
      // 'active' rows this helper exists to clean up.
      expect(capturedExpires).toHaveLength(2);
      expect((capturedExpires[1]!.context as { orgId: string }).orgId).toBe('org-b');
    });

    it('still retires the sessions already dropped when the sweep throws mid-way', async () => {
      const first = seed(manager, 'first', 'org-a', { idleFor: 3 * HOUR, state: 'idle' });
      seed(manager, 'second', 'org-b', { idleFor: 3 * HOUR, state: 'idle' });
      // Blow up on the SECOND session, after the first has been removed.
      const second = manager.get('second')!;
      (second as unknown as { eventBus: unknown }).eventBus = {
        publish: () => { throw new Error('bus exploded'); },
        closeAll: () => {},
      };

      expect(() => internals(manager).evictStaleSessions()).toThrow('bus exploded');
      await settle();
      await settle();

      expect(first.state).toBe('closed');
      expect(capturedExpires).toHaveLength(1);
      expectExpiredWrite(0, ['first'], 'org-a');
    });

    it('does not expire rows for sessions it leaves in place', async () => {
      seed(manager, 'fresh', 'org-a', { idleFor: 1 * MINUTE, ageFor: 1 * HOUR, state: 'idle' });

      internals(manager).evictStaleSessions();
      await settle();

      expect(manager.get('fresh')).toBeDefined();
      expect(capturedExpires).toHaveLength(0);
    });

    it('still notifies the client on the stale-eviction path', async () => {
      const session = seed(manager, 'idled', 'org-a', { idleFor: 3 * HOUR, state: 'idle' });
      const events = session.eventBus.getReplayEvents();

      internals(manager).evictStaleSessions();
      await settle();

      const published = session.eventBus.getReplayEvents().slice(events.length);
      expect(published.some((e) => e.type === 'error')).toBe(true);
      expect(published.some((e) => e.type === 'done')).toBe(true);
    });

    it('still notifies the client on the LRU path', async () => {
      const session = seed(manager, 'victim', 'org-a', { idleFor: 5 * MINUTE, state: 'idle' });

      internals(manager).evictLeastRecentlyActive();
      await settle();

      const published = session.eventBus.getReplayEvents();
      expect(published.some((e) => e.type === 'error')).toBe(true);
      expect(published.some((e) => e.type === 'done')).toBe(true);
    });

    it('does not expire rows on shutdown — sessions stay resumable across a deploy', async () => {
      seed(manager, 's1', 'org-a', { idleFor: 3 * HOUR, state: 'idle' });
      seed(manager, 's2', 'org-b', { idleFor: 3 * HOUR, state: 'idle' });

      manager.shutdown();
      await settle();

      expect(manager.activeCount).toBe(0);
      expect(capturedExpires).toHaveLength(0);
    });
  });
});
