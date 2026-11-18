import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { AiStreamEvent } from '@breeze/shared/types/ai';

/**
 * #9427 W1 T4 — `GET /ai/sessions/:id/stream` attaches the caller to the
 * CURRENT turn of a session it owns.
 *
 * Security contract (Rigor HIGH): this is the same ownership surface as
 * `GET /ai/sessions/:id`. Ownership is decided by `getSession(id, auth)` — the
 * owner + accessible-org + topology-site filtered DB read, never with
 * `allowAnyOwnerInOrg` — and never by the in-memory session. Every refusal
 * before the stream is the same 404 body as a missing id.
 */

const mocks = vi.hoisted(() => ({
  auth: null as unknown as Record<string, unknown>,
  permissions: new Set<string>(['ai_sessions:use']),
  dbContextCalls: 0,
}));

vi.mock('../middleware/auth', () => ({
  // Enforcing doubles, so the route's own middleware is under test.
  requireScope: vi.fn((...scopes: string[]) => async (c: any, next: any) => (
    scopes.includes(c.get('auth')?.scope) ? next() : c.json({ error: 'Insufficient scope' }, 403)
  )),
  requirePermission: vi.fn((resource: string, action: string) => async (c: any, next: any) => (
    mocks.permissions.has(`${resource}:${action}`) ? next() : c.json({ error: 'Permission denied' }, 403)
  )),
  withAuthDbAccessContext: vi.fn(async (_auth: unknown, fn: () => Promise<unknown>) => {
    mocks.dbContextCalls += 1;
    return fn();
  }),
}));

vi.mock('../services/permissions', () => ({
  PERMISSIONS: { AI_SESSIONS_USE: { resource: 'ai_sessions', action: 'use' } },
}));

vi.mock('../services/aiAgent', () => ({
  getSession: vi.fn(),
}));

vi.mock('../services/streamingSessionManager', () => ({
  streamingSessionManager: {
    get: vi.fn(),
    getOrCreate: vi.fn(),
    remove: vi.fn(),
    interrupt: vi.fn(),
    tryTransitionToProcessing: vi.fn(),
  },
}));

// Any DB use inside the stream would show up here.
vi.mock('../db', () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), execute: vi.fn() },
  withDbAccessContext: vi.fn(),
  withSystemDbAccessContext: vi.fn(),
}));

import { ATTACH_MAX_SUBSCRIBERS, registerAiAttachRoute } from './aiAttach';
import { getSession } from '../services/aiAgent';
import { streamingSessionManager } from '../services/streamingSessionManager';
import { withAuthDbAccessContext } from '../middleware/auth';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../db';
import { SessionEventBus } from '../services/sessionEventBus';
import { publishPendingCard, resolvePendingCard } from '../services/sessionPendingCards';
import { CLIENT_AI_SSE_PING_INTERVAL_MS } from './clientAi/sse';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const ORG_A = 'org-aaaa';
const ORG_B = 'org-bbbb';
const USER_A = 'user-a';
const USER_B = 'user-b';

function authFor(userId: string, orgId: string, scope = 'organization') {
  return {
    user: { id: userId, email: `${userId}@example.test`, name: userId },
    scope,
    orgId,
    partnerId: null,
    accessibleOrgIds: [orgId],
  };
}

function sessionRow(overrides: Record<string, unknown> = {}) {
  return { id: SESSION_ID, orgId: ORG_A, userId: USER_A, type: 'general', status: 'active', ...overrides };
}

function activeSession(overrides: Record<string, unknown> = {}) {
  return {
    breezeSessionId: SESSION_ID,
    orgId: ORG_A,
    auth: authFor(USER_A, ORG_A),
    state: 'processing',
    turnId: 'turn-1',
    turnUserMessageId: 'u1',
    eventBus: new SessionEventBus(),
    pendingCards: new Map(),
    inputController: { pushMessage: vi.fn() },
    ...overrides,
  } as any;
}

function makeApp() {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth' as never, mocks.auth as never);
    return next();
  });
  const ai = new Hono();
  registerAiAttachRoute(ai);
  app.route('/ai', ai);
  return app;
}

function attach(app: Hono, id = SESSION_ID) {
  return app.request(`/ai/sessions/${id}/stream`, { headers: { Authorization: 'Bearer t' } });
}

interface Frame { event: string; id?: string; data: any }

function parseFrames(text: string): Frame[] {
  return text
    .split('\n\n')
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const frame: Frame = { event: 'message', data: undefined };
      for (const line of block.split('\n')) {
        const idx = line.indexOf(':');
        const key = line.slice(0, idx);
        const value = line.slice(idx + 1).replace(/^ /, '');
        if (key === 'event') frame.event = value;
        else if (key === 'id') frame.id = value;
        else if (key === 'data') frame.data = JSON.parse(value);
      }
      return frame;
    });
}

/** Incremental SSE reader over a live response body. */
function frameReader(res: Response) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const queue: Frame[] = [];
  let ended = false;
  return {
    reader,
    async next(): Promise<Frame | null> {
      while (queue.length === 0 && !ended) {
        const idx = buffer.indexOf('\n\n');
        if (idx >= 0) {
          queue.push(...parseFrames(buffer.slice(0, idx + 2)));
          buffer = buffer.slice(idx + 2);
          continue;
        }
        const { done, value } = await reader.read();
        if (done) { ended = true; break; }
        buffer += decoder.decode(value, { stream: true });
      }
      return queue.shift() ?? null;
    },
    async rest(): Promise<Frame[]> {
      const out: Frame[] = [];
      for (;;) {
        const f = await this.next();
        if (!f) return out;
        out.push(f);
      }
    },
  };
}

async function until(fn: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error('until(): condition not met in time');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const NOT_FOUND = { error: 'Session not found' };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth = authFor(USER_A, ORG_A);
  mocks.permissions = new Set(['ai_sessions:use']);
  mocks.dbContextCalls = 0;
  vi.mocked(getSession).mockResolvedValue(sessionRow() as any);
  vi.mocked(streamingSessionManager.get).mockReturnValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

// ============================================
// Ownership — the same surface as GET /ai/sessions/:id
// ============================================

describe('attach — ownership (404 indistinguishable from a missing id)', () => {
  it('reads ownership through getSession(id, auth) with NO allowAnyOwnerInOrg, in one short auth DB context', async () => {
    const res = await attach(makeApp());
    await res.text();
    expect(getSession).toHaveBeenCalledTimes(1);
    const call = vi.mocked(getSession).mock.calls[0]!;
    expect(call[0]).toBe(SESSION_ID);
    expect(call[1]).toBe(mocks.auth);
    // No options object at all — so allowAnyOwnerInOrg cannot be set.
    expect(call).toHaveLength(2);
    expect(withAuthDbAccessContext).toHaveBeenCalledTimes(1);
    expect(vi.mocked(withAuthDbAccessContext).mock.calls[0]![0]).toBe(mocks.auth);
  });

  it('a missing id → 404', async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    const res = await attach(makeApp());
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(NOT_FOUND);
  });

  it("another user's session → 404 (getSession is owner-bound)", async () => {
    mocks.auth = authFor(USER_B, ORG_A);
    vi.mocked(getSession).mockResolvedValue(null); // the owner filter excludes it
    const res = await attach(makeApp());
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(NOT_FOUND);
  });

  it('a session in an org outside accessibleOrgIds → 404', async () => {
    mocks.auth = authFor(USER_A, ORG_B);
    vi.mocked(getSession).mockResolvedValue(null); // the org filter excludes it
    const res = await attach(makeApp());
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(NOT_FOUND);
  });

  it('a topology session pinned to a site the caller cannot read → 404', async () => {
    vi.mocked(getSession).mockResolvedValue(null); // the topology-site filter excludes it
    const res = await attach(makeApp());
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(NOT_FOUND);
  });

  it.each(['script_builder', 'mcp', 'helper', '', null])('a non-chat session type (%s) → the same 404', async (type) => {
    vi.mocked(getSession).mockResolvedValue(sessionRow({ type }) as any);
    const active = activeSession();
    vi.mocked(streamingSessionManager.get).mockReturnValue(active);
    const res = await attach(makeApp());
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(NOT_FOUND);
    expect(active.eventBus.subscriberCount).toBe(0);
  });

  it('a malformed id → the same 404, with no DB read', async () => {
    const res = await attach(makeApp(), 'not-a-uuid');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(NOT_FOUND);
    expect(getSession).not.toHaveBeenCalled();
  });

  it("a session LIVE in memory for user A is a 404 for user B, and B is never subscribed", async () => {
    const active = activeSession();
    active.eventBus.publish({ type: 'message_start', messageId: 'm1' });
    active.eventBus.publish({ type: 'content_delta', delta: 'secret tool output' });
    vi.mocked(streamingSessionManager.get).mockReturnValue(active);
    mocks.auth = authFor(USER_B, ORG_B);
    vi.mocked(getSession).mockResolvedValue(null);

    const res = await attach(makeApp());

    expect(res.status).toBe(404);
    const body = await res.text();
    expect(JSON.parse(body)).toEqual(NOT_FOUND);
    expect(body).not.toContain('secret');
    expect(active.eventBus.subscriberCount).toBe(0);
  });

  it('defense in depth: an in-memory session whose owner is not the caller reads as unavailable', async () => {
    const active = activeSession({ auth: authFor('someone-else', ORG_A) });
    active.eventBus.publish({ type: 'content_delta', delta: 'secret' });
    vi.mocked(streamingSessionManager.get).mockReturnValue(active);
    const text = await (await attach(makeApp())).text();
    expect(text).not.toContain('secret');
    expect(parseFrames(text)[1]!.data).toMatchObject({ type: 'attach_state', turn: 'unavailable' });
    expect(active.eventBus.subscriberCount).toBe(0);
  });

  it('requires ai_sessions:use (403 before any DB read)', async () => {
    mocks.permissions = new Set();
    const res = await attach(makeApp());
    expect(res.status).toBe(403);
    expect(getSession).not.toHaveBeenCalled();
  });

  it.each(['organization', 'partner', 'system'])('admits scope %s', async (scope) => {
    mocks.auth = authFor(USER_A, ORG_A, scope);
    expect((await attach(makeApp())).status).toBe(200);
  });

  it('refuses any other scope', async () => {
    mocks.auth = authFor(USER_A, ORG_A, 'portal');
    expect((await attach(makeApp())).status).toBe(403);
    expect(getSession).not.toHaveBeenCalled();
  });
});

// ============================================
// Snapshot and live tail
// ============================================

describe('attach — snapshot and live tail', () => {
  it('not in memory → ping, attach_state{unavailable}, end; never creates a session', async () => {
    const res = await attach(makeApp());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const frames = parseFrames(await res.text());
    expect(frames.map((f) => f.event)).toEqual(['ping', 'attach_state']);
    expect(frames[1]!.data).toEqual({
      type: 'attach_state', turn: 'unavailable', turnId: null, lastSeq: 0, turnUserMessageId: null,
      replay: [], partial: false, pendingCards: [], activePlan: null, turnModel: null,
    });
    expect(streamingSessionManager.getOrCreate).not.toHaveBeenCalled();
  });

  it.each(['initializing', 'ready'])('a replacement session not yet claimed for a turn (state %s) → unavailable, so a re-attach cycle retries', async (state) => {
    const active = activeSession({ state });
    vi.mocked(streamingSessionManager.get).mockReturnValue(active);
    const frames = parseFrames(await (await attach(makeApp())).text());
    expect(frames.map((f) => f.event)).toEqual(['ping', 'attach_state']);
    expect(frames[1]!.data.turn).toBe('unavailable');
    expect(active.eventBus.subscriberCount).toBe(0);
  });

  it('a closing session with a full bus is unavailable, not 429', async () => {
    const active = activeSession({ state: 'closing' });
    for (let i = 0; i < 8; i++) active.eventBus.subscribeSequenced(`stale-${i}`);
    vi.mocked(streamingSessionManager.get).mockReturnValue(active);
    const res = await attach(makeApp());
    expect(res.status).toBe(200);
    expect(parseFrames(await res.text())[1]!.data.turn).toBe('unavailable');
    expect(active.eventBus.subscriberCount).toBe(8);
  });

  it.each(['closing', 'closed'])('a session in state %s → unavailable', async (state) => {
    vi.mocked(streamingSessionManager.get).mockReturnValue(activeSession({ state }));
    const frames = parseFrames(await (await attach(makeApp())).text());
    expect(frames[1]!.data.turn).toBe('unavailable');
  });

  it('a closed bus (the turn was replaced) → unavailable, no subscriber left behind', async () => {
    const active = activeSession();
    active.eventBus.closeAll();
    vi.mocked(streamingSessionManager.get).mockReturnValue(active);
    const frames = parseFrames(await (await attach(makeApp())).text());
    expect(frames[1]!.data.turn).toBe('unavailable');
    expect(active.eventBus.subscriberCount).toBe(0);
  });

  it('idle (in memory, no turn running) → exactly two frames, then end', async () => {
    const active = activeSession({ state: 'idle' });
    vi.mocked(streamingSessionManager.get).mockReturnValue(active);
    const frames = parseFrames(await (await attach(makeApp())).text());
    expect(frames.map((f) => f.event)).toEqual(['ping', 'attach_state']);
    expect(frames[1]!.data).toMatchObject({ turn: 'idle', turnId: 'turn-1', pendingCards: [] });
    expect(active.eventBus.subscriberCount).toBe(0);
  });

  it.each([false, true])('done already published while state is still processing → idle, two frames (overflowed=%s)', async (overflow) => {
    const active = activeSession();
    if (overflow) active.eventBus.publish({ type: 'content_delta', delta: 'x'.repeat(300 * 1024) });
    publishPendingCard(active, 'approval:e1', { type: 'approval_required', executionId: 'e1', toolName: 't', input: {}, description: 'd' });
    active.eventBus.publish({ type: 'done' });
    vi.mocked(streamingSessionManager.get).mockReturnValue(active);
    const frames = parseFrames(await (await attach(makeApp())).text());
    expect(frames.map((f) => f.event)).toEqual(['ping', 'attach_state']);
    expect(frames[1]!.data).toMatchObject({ turn: 'idle', pendingCards: [] });
    expect(active.eventBus.subscriberCount).toBe(0);
  });

  it('running: replays the turn, then forwards exactly seq > lastSeq (no duplicate, no gap), ends at done', async () => {
    const active = activeSession();
    const bus: SessionEventBus = active.eventBus;
    bus.publish({ type: 'message_start', messageId: 'm1' });
    bus.publish({ type: 'content_delta', delta: 'a' });
    bus.publish({ type: 'content_delta', delta: 'b' });
    vi.mocked(streamingSessionManager.get).mockReturnValue(active);

    const res = await attach(makeApp());
    // Published after subscribe — the synchronous prefix of the stream
    // callback has already captured the snapshot by the time we get here.
    bus.publish({ type: 'content_delta', delta: 'c' });
    bus.publish({ type: 'done' });
    const frames = parseFrames(await res.text());

    expect(frames.map((f) => f.event)).toEqual(['ping', 'attach_state', 'content_delta', 'done']);
    const state = frames[1]!.data;
    expect(state).toMatchObject({ type: 'attach_state', turn: 'running', turnId: 'turn-1', lastSeq: 3, turnUserMessageId: 'u1', partial: false });
    expect(state.replay).toEqual([
      { type: 'message_start', messageId: 'm1' },
      { type: 'content_delta', delta: 'a' },
      { type: 'content_delta', delta: 'b' },
    ]);
    expect(frames.slice(2).map((f) => [f.id, f.data.seq])).toEqual([['4', 4], ['5', 5]]);
    expect(frames[2]!.data).toEqual({ type: 'content_delta', delta: 'c', seq: 4 });
    expect(bus.subscriberCount).toBe(0);
  });

  it('seq boundary: an event published in the same tick as the attach lands exactly once', async () => {
    const active = activeSession();
    const bus: SessionEventBus = active.eventBus;
    bus.publish({ type: 'content_delta', delta: '1' });
    vi.mocked(streamingSessionManager.get).mockReturnValue(active);
    const responsePromise = attach(makeApp());
    // Still the same macrotask turn as the request: whichever side of the
    // capture this lands on, it must appear once — in replay or live.
    bus.publish({ type: 'content_delta', delta: '2' });
    const res = await responsePromise;
    bus.publish({ type: 'done' });
    const frames = parseFrames(await res.text());
    const state = frames[1]!.data;
    const replayed = (state.replay as Array<{ delta?: string }>).map((e) => e.delta);
    const live = frames.slice(2).map((f) => f.data.delta ?? f.event);
    expect([...replayed, ...live]).toEqual(['1', '2', 'done']);
    for (const f of frames.slice(2)) expect(f.data.seq).toBeGreaterThan(state.lastSeq);
  });

  it('seq boundary: an event published between subscribe and snapshot is delivered once (in replay, not again live)', async () => {
    const active = activeSession();
    const bus: SessionEventBus = active.eventBus;
    bus.publish({ type: 'content_delta', delta: '1' });
    const realSubscribe = bus.subscribeSequenced.bind(bus);
    vi.spyOn(bus, 'subscribeSequenced').mockImplementation((id: string) => {
      const iterable = realSubscribe(id);
      // Lands on the new subscription AND in the snapshot taken next.
      bus.publish({ type: 'content_delta', delta: '2' });
      return iterable;
    });
    vi.mocked(streamingSessionManager.get).mockReturnValue(active);
    const res = await attach(makeApp());
    bus.publish({ type: 'done' });
    const frames = parseFrames(await res.text());
    expect(frames[1]!.data.lastSeq).toBe(2);
    expect((frames[1]!.data.replay as Array<{ delta: string }>).map((e) => e.delta)).toEqual(['1', '2']);
    expect(frames.slice(2).map((f) => [f.event, f.data.seq])).toEqual([['done', 3]]);
  });

  it('seq boundary: the subscription is open before the snapshot — an event right after the snapshot is not lost', async () => {
    const active = activeSession();
    const bus: SessionEventBus = active.eventBus;
    const realSnapshot = bus.snapshot.bind(bus);
    vi.spyOn(bus, 'snapshot').mockImplementation(() => {
      // Fires at the first await after the snapshot. If the subscription were
      // only opened after that await, this event would be in neither.
      queueMicrotask(() => bus.publish({ type: 'content_delta', delta: 'race' }));
      return realSnapshot();
    });
    vi.mocked(streamingSessionManager.get).mockReturnValue(active);
    const res = await attach(makeApp());
    bus.publish({ type: 'done' });
    const frames = parseFrames(await res.text());
    expect(frames[1]!.data.lastSeq).toBe(0);
    expect(frames.slice(2).map((f) => [f.data.delta ?? f.event, f.data.seq])).toEqual([['race', 1], ['done', 2]]);
  });

  it('a turn whose bus is closed mid-attach (a new POST /messages) ends the stream without done', async () => {
    const active = activeSession();
    vi.mocked(streamingSessionManager.get).mockReturnValue(active);
    const res = await attach(makeApp());
    const r = frameReader(res);
    expect((await r.next())!.event).toBe('ping');
    expect((await r.next())!.event).toBe('attach_state');
    active.eventBus.closeAll(); // remove() → closeAll()
    expect(await r.rest()).toEqual([]);
  });

  it('the in-memory session replaced between the ownership check and the stream → unavailable', async () => {
    const first = activeSession();
    const second = activeSession({ turnId: 'turn-2' });
    vi.mocked(streamingSessionManager.get).mockReturnValueOnce(first).mockReturnValue(second);
    const frames = parseFrames(await (await attach(makeApp())).text());
    expect(frames[1]!.data.turn).toBe('unavailable');
    expect(first.eventBus.subscriberCount).toBe(0);
    expect(second.eventBus.subscriberCount).toBe(0);
  });

  it('attach between the processing claim and the user-row insert → running with a null anchor', async () => {
    const active = activeSession({ turnUserMessageId: null });
    vi.mocked(streamingSessionManager.get).mockReturnValue(active);
    const res = await attach(makeApp());
    active.eventBus.publish({ type: 'done' });
    const frames = parseFrames(await res.text());
    expect(frames[1]!.data).toMatchObject({ turn: 'running', turnUserMessageId: null });
  });

  it('pending cards: verbatim with original deadlines; a decided card is absent', async () => {
    const active = activeSession();
    const pending = {
      type: 'approval_required' as const, executionId: 'e-pending', toolName: 'run_script', input: { a: 1 },
      description: 'Run it', approvalExpiresAt: '2026-10-23T10:00:00.000Z', intentBacked: true,
    };
    publishPendingCard(active, 'approval:e-decided', { type: 'approval_required', executionId: 'e-decided', toolName: 't', input: {}, description: 'd' });
    publishPendingCard(active, 'approval:e-pending', pending);
    resolvePendingCard(active, 'approval:e-decided');
    vi.mocked(streamingSessionManager.get).mockReturnValue(active);

    const res = await attach(makeApp());
    active.eventBus.publish({ type: 'done' });
    const state = parseFrames(await res.text())[1]!.data;
    expect(state.pendingCards).toEqual([pending]);
  });

  it('active plan comes from the bus at lastSeq', async () => {
    const active = activeSession();
    const steps = [{ toolName: 'a', input: {}, reasoning: 'r', status: 'pending' }];
    active.eventBus.publish({ type: 'plan_approval_required', planId: 'p1', steps } as AiStreamEvent);
    active.eventBus.publish({ type: 'plan_step_start', planId: 'p1', stepIndex: 0, toolName: 'a' });
    vi.mocked(streamingSessionManager.get).mockReturnValue(active);
    const res = await attach(makeApp());
    active.eventBus.publish({ type: 'done' });
    const state = parseFrames(await res.text())[1]!.data;
    expect(state.activePlan).toEqual({ planId: 'p1', steps, currentStepIndex: 0, status: 'executing' });
  });

  it('an overflowed turn → partial:true, replay:[], live events still follow', async () => {
    const active = activeSession();
    active.eventBus.publish({ type: 'content_delta', delta: 'x'.repeat(300 * 1024) });
    vi.mocked(streamingSessionManager.get).mockReturnValue(active);
    const res = await attach(makeApp());
    active.eventBus.publish({ type: 'content_delta', delta: 'y' });
    active.eventBus.publish({ type: 'done' });
    const frames = parseFrames(await res.text());
    expect(frames[1]!.data).toMatchObject({ turn: 'running', partial: true, replay: [], lastSeq: 1 });
    expect(frames.slice(2).map((f) => f.data.seq)).toEqual([2, 3]);
  });

  it(`the ${ATTACH_MAX_SUBSCRIBERS + 1}th subscriber (sender + 7 attaches + 1) → 429 attach_limit`, async () => {
    expect(ATTACH_MAX_SUBSCRIBERS).toBe(8);
    const active = activeSession();
    active.eventBus.subscribe('sender'); // the /messages subscriber
    for (let i = 0; i < 6; i++) active.eventBus.subscribeSequenced(`attach-${i}`);
    vi.mocked(streamingSessionManager.get).mockReturnValue(active);

    // 7th attach: the 8th subscriber — admitted.
    const seventh = await attach(makeApp());
    expect(seventh.status).toBe(200);
    expect(active.eventBus.subscriberCount).toBe(8);

    const subscribeSpy = vi.spyOn(active.eventBus, 'subscribeSequenced');
    const ninth = await attach(makeApp());
    expect(ninth.status).toBe(429);
    expect(subscribeSpy).not.toHaveBeenCalled();
    expect(await ninth.json()).toEqual({ error: 'Too many viewers', code: 'attach_limit' });
    expect(active.eventBus.subscriberCount).toBe(8);

    active.eventBus.publish({ type: 'done' });
    await seventh.text();
  });

  it('a client abort unsubscribes at once; the turn is never interrupted or sent to', async () => {
    const active = activeSession();
    vi.mocked(streamingSessionManager.get).mockReturnValue(active);
    const res = await attach(makeApp());
    const r = frameReader(res);
    await r.next();
    await r.next();
    expect(active.eventBus.subscriberCount).toBe(1);

    await r.reader.cancel();

    await until(() => active.eventBus.subscriberCount === 0);
    expect(active.eventBus.closed).toBe(false);
    expect(active.state).toBe('processing');
    expect(streamingSessionManager.interrupt).not.toHaveBeenCalled();
    expect(streamingSessionManager.remove).not.toHaveBeenCalled();
    expect(streamingSessionManager.getOrCreate).not.toHaveBeenCalled();
    expect(active.inputController.pushMessage).not.toHaveBeenCalled();
  });

  it('no DB work after the ownership read — none inside the stream', async () => {
    const active = activeSession();
    vi.mocked(streamingSessionManager.get).mockReturnValue(active);
    const res = await attach(makeApp());
    active.eventBus.publish({ type: 'content_delta', delta: 'x' });
    active.eventBus.publish({ type: 'done' });
    await res.text();
    expect(mocks.dbContextCalls).toBe(1);
    expect(withDbAccessContext).not.toHaveBeenCalled();
    expect(withSystemDbAccessContext).not.toHaveBeenCalled();
    expect(db.select).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it(`pings every ${CLIENT_AI_SSE_PING_INTERVAL_MS} ms while a turn runs, and stops on abort`, async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const active = activeSession();
    vi.mocked(streamingSessionManager.get).mockReturnValue(active);
    const res = await attach(makeApp());
    const r = frameReader(res);
    expect((await r.next())!.event).toBe('ping');
    expect((await r.next())!.event).toBe('attach_state');
    // The interval starts once the attach_state write has been taken.
    await until(() => vi.getTimerCount() === 1);
    vi.advanceTimersByTime(CLIENT_AI_SSE_PING_INTERVAL_MS - 1);
    vi.advanceTimersByTime(1);
    expect((await r.next())!.event).toBe('ping');
    await r.reader.cancel();
    await until(() => active.eventBus.subscriberCount === 0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a client that aborts before reading anything leaves no subscriber and no error log', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const active = activeSession();
    vi.mocked(streamingSessionManager.get).mockReturnValue(active);
    const res = await attach(makeApp());
    await res.body!.cancel();
    await until(() => active.eventBus.subscriberCount === 0);
    expect(active.eventBus.closed).toBe(false);
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('the ping interval is cleared when the turn ends with done', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const active = activeSession();
    vi.mocked(streamingSessionManager.get).mockReturnValue(active);
    const res = await attach(makeApp());
    const r = frameReader(res);
    await r.next();
    await r.next();
    await until(() => vi.getTimerCount() === 1);
    active.eventBus.publish({ type: 'done' });
    expect((await r.rest()).map((f) => f.event)).toEqual(['done']);
    expect(vi.getTimerCount()).toBe(0);
    expect(active.eventBus.subscriberCount).toBe(0);
  });
});
