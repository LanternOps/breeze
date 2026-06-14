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
  policyState.policy = { ...defaultClientAiPolicy(ORG_ID), enabled: true };
  dbInsertMock.mockImplementation(() => ({
    values: vi.fn(() => ({ returning: vi.fn(() => Promise.resolve([{ id: SESSION_ID }])) })),
  }));
  dbUpdateMock.mockImplementation(() => ({
    set: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })),
  }));
});

// ── POST / with workbookName ───────────────────────────────────────────────
describe('POST /client-ai/sessions (create) — workbook tag', () => {
  it('persists the workbookName from the request body', async () => {
    const valuesSpy = vi.fn(() => ({ returning: vi.fn(() => Promise.resolve([{ id: SESSION_ID }])) }));
    dbInsertMock.mockImplementation(() => ({ values: valuesSpy }));

    const res = await buildApp().request('/client-ai/sessions', {
      method: 'POST',
      headers: AUTHED,
      body: JSON.stringify({ workbookName: 'Q3 Budget.xlsx' }),
    });
    expect(res.status).toBe(201);
    expect(valuesSpy).toHaveBeenCalledWith(
      expect.objectContaining({ workbookName: 'Q3 Budget.xlsx' }),
    );
  });

  it('stores null workbookName when omitted', async () => {
    const valuesSpy = vi.fn(() => ({ returning: vi.fn(() => Promise.resolve([{ id: SESSION_ID }])) }));
    dbInsertMock.mockImplementation(() => ({ values: valuesSpy }));

    const res = await buildApp().request('/client-ai/sessions', {
      method: 'POST',
      headers: AUTHED,
      body: '{}',
    });
    expect(res.status).toBe(201);
    expect(valuesSpy).toHaveBeenCalledWith(
      expect.objectContaining({ workbookName: null }),
    );
  });

  it('rejects an over-long workbookName (validation)', async () => {
    const res = await buildApp().request('/client-ai/sessions', {
      method: 'POST',
      headers: AUTHED,
      body: JSON.stringify({ workbookName: 'x'.repeat(501) }),
    });
    expect(res.status).toBe(400);
  });
});

// ── GET / list (per-user history) ──────────────────────────────────────────
describe('GET /client-ai/sessions (history list)', () => {
  it('rejects unauthenticated requests', async () => {
    const res = await buildApp().request('/client-ai/sessions');
    expect(res.status).toBe(401);
  });

  it("returns the caller's sessions with title, workbookName, timestamps, and messageCount", async () => {
    const ROWS = [
      {
        id: SESSION_ID,
        title: 'Budget review',
        workbookName: 'Q3 Budget.xlsx',
        status: 'active',
        createdAt: new Date('2026-06-13T10:00:00Z'),
        lastActivityAt: new Date('2026-06-13T10:05:00Z'),
        updatedAt: new Date('2026-06-13T10:05:00Z'),
        messageCount: 4,
      },
    ];
    // The list route issues a single grouped SELECT … leftJoin … where … groupBy … orderBy … limit.
    const limit = vi.fn(() => Promise.resolve(ROWS));
    const orderBy = vi.fn(() => ({ limit }));
    const groupBy = vi.fn(() => ({ orderBy }));
    const where = vi.fn(() => ({ groupBy }));
    const leftJoin = vi.fn(() => ({ where }));
    dbSelectMock.mockImplementation(() => ({ from: vi.fn(() => ({ leftJoin })) }));

    const res = await buildApp().request('/client-ai/sessions', { headers: AUTHED });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.sessions)).toBe(true);
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0]).toMatchObject({
      id: SESSION_ID,
      title: 'Budget review',
      workbookName: 'Q3 Budget.xlsx',
      status: 'active',
      messageCount: 4,
    });
  });

  it('scopes the query to the caller (clientUserId + orgId + excel_client) in the WHERE', async () => {
    const limit = vi.fn(() => Promise.resolve([]));
    const orderBy = vi.fn(() => ({ limit }));
    const groupBy = vi.fn(() => ({ orderBy }));
    const where = vi.fn((..._args: unknown[]) => ({ groupBy }));
    const leftJoin = vi.fn(() => ({ where }));
    dbSelectMock.mockImplementation(() => ({ from: vi.fn(() => ({ leftJoin })) }));

    const res = await buildApp().request('/client-ai/sessions', { headers: AUTHED });
    expect(res.status).toBe(200);
    // The WHERE clause must have been constructed (the tenancy guard).
    expect(where).toHaveBeenCalledTimes(1);
    expect(where.mock.calls[0]?.[0]).toBeDefined();
  });

  it('returns an empty list when the user has no sessions', async () => {
    const limit = vi.fn(() => Promise.resolve([]));
    const orderBy = vi.fn(() => ({ limit }));
    const groupBy = vi.fn(() => ({ orderBy }));
    const where = vi.fn(() => ({ groupBy }));
    const leftJoin = vi.fn(() => ({ where }));
    dbSelectMock.mockImplementation(() => ({ from: vi.fn(() => ({ leftJoin })) }));

    const res = await buildApp().request('/client-ai/sessions', { headers: AUTHED });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sessions: [] });
  });
});
