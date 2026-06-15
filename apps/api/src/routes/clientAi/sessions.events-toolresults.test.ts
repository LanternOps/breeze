import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const {
  CLIENT_USER_ID, ORG_ID, SESSION_ID,
  policyState,
  dbSelectMock, dbInsertMock, dbUpdateMock,
  managerMock,
  writeAuditEventMock,
  recordClientUsageMock, checkClientBudgetMock, getRemainingBudgetMock,
  checkBillingCreditsMock, rateLimiterMock,
  resolveToolResultMock, failPendingMock,
  applyDlpMock,
} = vi.hoisted(() => ({
  CLIENT_USER_ID: 'beefbeef-1111-4222-8333-444455556666',
  ORG_ID: '0c0c0c0c-1111-4222-8333-444455556666',
  SESSION_ID: 'a1a1a1a1-1111-4222-8333-444455556666',
  policyState: { policy: {} as Record<string, unknown> },
  dbSelectMock: vi.fn(),
  dbInsertMock: vi.fn(),
  dbUpdateMock: vi.fn(),
  managerMock: {
    getOrCreate: vi.fn(),
    get: vi.fn(),
    remove: vi.fn(),
    tryTransitionToProcessing: vi.fn(() => true),
    startTurnTimeout: vi.fn(),
  },
  writeAuditEventMock: vi.fn(),
  recordClientUsageMock: vi.fn(() => Promise.resolve()),
  checkClientBudgetMock: vi.fn((): Promise<string | null> => Promise.resolve(null)),
  getRemainingBudgetMock: vi.fn(() => Promise.resolve(undefined)),
  checkBillingCreditsMock: vi.fn((): Promise<string | null> => Promise.resolve(null)),
  rateLimiterMock: vi.fn(() => Promise.resolve({ allowed: true, remaining: 9, resetAt: new Date() })),
  resolveToolResultMock: vi.fn(() => true),
  failPendingMock: vi.fn(() => 0),
  applyDlpMock: vi.fn(),
}));

vi.mock('../../middleware/clientAiAuth', () => ({
  clientAiAuthMiddleware: (c: any, next: any) => {
    if (!c.req.header('authorization')) return c.json({ error: 'Unauthorized' }, 401);
    c.set('clientAiAuth', {
      clientUserId: CLIENT_USER_ID, orgId: ORG_ID,
      email: 'finance.user@contoso.com', name: 'Finance User', token: 'tok',
    });
    return next();
  },
  requireClientAiEnabledMiddleware: (c: any, next: any) => {
    c.set('clientAiPolicy', policyState.policy);
    return next();
  },
}));

vi.mock('../../db', () => ({
  db: { select: dbSelectMock, insert: dbInsertMock, update: dbUpdateMock },
  withDbAccessContext: vi.fn((_ctx: unknown, fn: () => unknown) => fn()),
}));
vi.mock('../../services/streamingSessionManager', () => ({ streamingSessionManager: managerMock }));
vi.mock('../../services/auditEvents', () => ({ writeAuditEvent: writeAuditEventMock }));
vi.mock('../../services/clientAiUsage', () => ({
  recordClientUsage: recordClientUsageMock,
  checkClientBudget: checkClientBudgetMock,
  getRemainingClientBudgetUsd: getRemainingBudgetMock,
}));
vi.mock('../../services/aiCostTracker', () => ({ checkBillingCredits: checkBillingCreditsMock }));
vi.mock('../../services/rate-limit', () => ({ rateLimiter: rateLimiterMock }));
vi.mock('../../services/redis', () => ({ getRedis: vi.fn(() => ({}) as never) }));
vi.mock('../../services/clientAiToolBridge', () => ({
  resolveClientToolResult: resolveToolResultMock,
  failPendingForSession: failPendingMock,
}));
vi.mock('../../services/clientAiDlp', () => ({ applyDlp: applyDlpMock }));

import { clientAiSessionRoutes } from './sessions';
import { defaultClientAiPolicy } from '../../services/clientAiPolicy';

const SESSION_ROW = {
  id: SESSION_ID, orgId: ORG_ID, clientUserId: CLIENT_USER_ID, type: 'excel_client',
  status: 'active', title: 'Budget review', model: 'claude-sonnet-4-5-20250929',
  systemPrompt: 'P', sdkSessionId: null, maxTurns: 50, turnCount: 0,
  totalInputTokens: 10, totalOutputTokens: 20, totalCostCents: 1.5,
  createdAt: new Date(), lastActivityAt: new Date(),
};

function selectChain(rows: unknown[]) {
  const limit = vi.fn(() => Promise.resolve(rows));
  const orderBy = vi.fn(() => ({ limit }));
  const where = vi.fn(() => ({ limit, orderBy }));
  return { from: vi.fn(() => ({ where })) };
}

function buildApp() {
  const app = new Hono();
  app.route('/client-ai/sessions', clientAiSessionRoutes);
  return app;
}

const AUTHED = { Authorization: 'Bearer tok', 'Content-Type': 'application/json' };

beforeEach(() => {
  vi.clearAllMocks();
  managerMock.tryTransitionToProcessing.mockReturnValue(true);
  checkClientBudgetMock.mockResolvedValue(null);
  checkBillingCreditsMock.mockResolvedValue(null);
  rateLimiterMock.mockResolvedValue({ allowed: true, remaining: 9, resetAt: new Date() });
  resolveToolResultMock.mockReturnValue(true);
  policyState.policy = { ...defaultClientAiPolicy(ORG_ID), enabled: true };
  dbSelectMock.mockImplementation(() => selectChain([SESSION_ROW]));
  dbInsertMock.mockImplementation(() => ({
    values: vi.fn(() => ({ returning: vi.fn(() => Promise.resolve([{ id: SESSION_ID }])) })),
  }));
  dbUpdateMock.mockImplementation(() => ({
    set: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })),
  }));
});

import { AsyncEventQueue } from '../../utils/asyncQueue';

/** Minimal real-semantics bus for SSE tests (single subscriber). */
class TestEventBus {
  queue = new AsyncEventQueue<unknown>();
  published: unknown[] = [];
  subscribe(_id: string) { return this.queue; }
  unsubscribe(_id: string) { this.queue.close(); }
  publish(e: unknown) { this.published.push(e); this.queue.push(e); }
  closeAll() { this.queue.close(); }
}

function makeStreamingSession() {
  return {
    state: 'idle',
    orgId: ORG_ID,
    breezeSessionId: SESSION_ID,
    inputController: { pushMessage: vi.fn() },
    eventBus: new TestEventBus(),
    toolUseIdQueue: [],
  } as Record<string, unknown>;
}

describe('GET /client-ai/sessions/:id/events', () => {
  it('404s for an inaccessible session', async () => {
    dbSelectMock.mockImplementation(() => selectChain([]));
    const res = await buildApp().request(`/client-ai/sessions/${SESSION_ID}/events`, { headers: AUTHED });
    expect(res.status).toBe(404);
  });

  it('410s when the session is closed', async () => {
    dbSelectMock.mockImplementation(() => selectChain([{ ...SESSION_ROW, status: 'closed' }]));
    const res = await buildApp().request(`/client-ai/sessions/${SESSION_ID}/events`, { headers: AUTHED });
    expect(res.status).toBe(410);
  });

  it('streams translated client events and persists across turn_complete', async () => {
    const active = makeStreamingSession();
    managerMock.get.mockReturnValue(active);

    const res = await buildApp().request(`/client-ai/sessions/${SESSION_ID}/events`, { headers: AUTHED });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    // Give the streaming callback a tick to subscribe, then publish a full turn.
    await new Promise((r) => setTimeout(r, 20));
    const bus = active.eventBus as TestEventBus;
    bus.publish({ type: 'content_delta', delta: 'Sure — ' });
    bus.publish({ type: 'tool_request', toolUseId: 'tu-1', toolName: 'read_range', input: { address: 'A1' }, mutating: false });
    bus.publish({ type: 'tool_completed', toolUseId: 'tu-1', toolName: 'read_range', status: 'success', redactions: [] });
    bus.publish({ type: 'done', usage: { inputTokens: 10, outputTokens: 5, costCents: 1 } });
    bus.publish({ type: 'content_delta', delta: 'next turn still streams' }); // proves no break on done
    bus.publish({ type: 'message_start', messageId: 'm1' }); // internal — must be dropped
    await new Promise((r) => setTimeout(r, 20));
    bus.closeAll(); // ends the stream so res.text() resolves

    const text = await res.text();
    expect(text).toContain('event: message_delta');
    expect(text).toContain('event: tool_request');
    expect(text).toContain('event: tool_completed');
    expect(text).toContain('event: turn_complete');
    expect(text).toContain('"costCents":1');
    expect(text).toContain('next turn still streams');
    expect(text).not.toContain('message_start');
  });

  it('creates the in-memory session when absent (connect-before-first-message)', async () => {
    const active = makeStreamingSession();
    managerMock.get.mockReturnValue(undefined);
    managerMock.getOrCreate.mockResolvedValue(active);

    const res = await buildApp().request(`/client-ai/sessions/${SESSION_ID}/events`, { headers: AUTHED });
    expect(res.status).toBe(200);
    expect(managerMock.getOrCreate).toHaveBeenCalled();
    // 9th positional arg pins the client loop config
    const args = managerMock.getOrCreate.mock.calls[0]!;
    expect(args[8]).toEqual({ injectApprovalModeInstructions: false });
    // SDK toolset is the write-mode-filtered client allowlist
    expect(args[6]).toEqual(expect.arrayContaining(['mcp__excel__read_range']));
    expect(args[6]).not.toEqual(expect.arrayContaining(['mcp__breeze__query_devices']));

    await new Promise((r) => setTimeout(r, 20));
    (active.eventBus as TestEventBus).closeAll();
    await res.text();
  });
});

describe('POST /client-ai/sessions/:id/tool-results', () => {
  it('resolves a pending bridge request scoped to THIS session', async () => {
    const res = await buildApp().request(`/client-ai/sessions/${SESSION_ID}/tool-results`, {
      method: 'POST',
      headers: AUTHED,
      body: JSON.stringify({ toolUseId: 'tu-1', status: 'success', output: { cells: [['v']] } }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(resolveToolResultMock).toHaveBeenCalledWith(SESSION_ID, 'tu-1', {
      status: 'success',
      output: { cells: [['v']] },
    });
  });

  it('404s for an unknown/expired toolUseId', async () => {
    resolveToolResultMock.mockReturnValue(false);
    const res = await buildApp().request(`/client-ai/sessions/${SESSION_ID}/tool-results`, {
      method: 'POST',
      headers: AUTHED,
      body: JSON.stringify({ toolUseId: 'nope', status: 'success', output: null }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'unknown_tool_request' });
  });

  it('404s when the session is not accessible (cross-user guard before any resolution)', async () => {
    dbSelectMock.mockImplementation(() => selectChain([]));
    const res = await buildApp().request(`/client-ai/sessions/${SESSION_ID}/tool-results`, {
      method: 'POST',
      headers: AUTHED,
      body: JSON.stringify({ toolUseId: 'tu-1', status: 'success', output: null }),
    });
    expect(res.status).toBe(404);
    expect(resolveToolResultMock).not.toHaveBeenCalled();
  });

  it('400s on an invalid status value', async () => {
    const res = await buildApp().request(`/client-ai/sessions/${SESSION_ID}/tool-results`, {
      method: 'POST',
      headers: AUTHED,
      body: JSON.stringify({ toolUseId: 'tu-1', status: 'pending' }),
    });
    expect(res.status).toBe(400);
  });
});
