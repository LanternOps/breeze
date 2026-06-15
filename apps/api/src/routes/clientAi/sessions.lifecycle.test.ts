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
  policyState.policy = { ...defaultClientAiPolicy(ORG_ID), enabled: true };
  dbSelectMock.mockImplementation(() => selectChain([SESSION_ROW]));
  dbInsertMock.mockImplementation(() => ({
    values: vi.fn(() => ({ returning: vi.fn(() => Promise.resolve([{ id: SESSION_ID }])) })),
  }));
  dbUpdateMock.mockImplementation(() => ({
    set: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })),
  }));
});

describe('POST /client-ai/sessions (create)', () => {
  it('rejects unauthenticated requests', async () => {
    const res = await buildApp().request('/client-ai/sessions', { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('creates an excel_client session with the client principal, bumps sessionCount, audits', async () => {
    const valuesSpy = vi.fn(() => ({ returning: vi.fn(() => Promise.resolve([{ id: SESSION_ID }])) }));
    dbInsertMock.mockImplementation(() => ({ values: valuesSpy }));

    const res = await buildApp().request('/client-ai/sessions', { method: 'POST', headers: AUTHED });
    expect(res.status).toBe(201);
    // The pane needs the effective write governance to render the Auto/Ask toggle.
    expect(await res.json()).toEqual({
      sessionId: SESSION_ID,
      writeMode: 'readwrite',
      writeApproval: 'ask',
    });

    expect(valuesSpy).toHaveBeenCalledWith(expect.objectContaining({
      orgId: ORG_ID,
      userId: null,
      clientUserId: CLIENT_USER_ID,
      type: 'excel_client',
      model: 'claude-sonnet-4-5-20250929',
      systemPrompt: expect.stringContaining('spreadsheet assistant'),
    }));
    expect(recordClientUsageMock).toHaveBeenCalledWith(ORG_ID, CLIENT_USER_ID, { sessionCount: 1 });
    expect(writeAuditEventMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'ai.client_session.create',
        actorType: 'user',
        actorId: CLIENT_USER_ID,
        orgId: ORG_ID,
        details: expect.objectContaining({ principalType: 'portal_user' }),
      }),
    );
  });

  it('uses the policy allowedModels[0] when configured', async () => {
    policyState.policy = {
      ...defaultClientAiPolicy(ORG_ID), enabled: true,
      allowedModels: ['claude-haiku-4-5-20251001'],
    };
    const valuesSpy = vi.fn(() => ({ returning: vi.fn(() => Promise.resolve([{ id: SESSION_ID }])) }));
    dbInsertMock.mockImplementation(() => ({ values: valuesSpy }));
    await buildApp().request('/client-ai/sessions', { method: 'POST', headers: AUTHED });
    expect(valuesSpy).toHaveBeenCalledWith(expect.objectContaining({ model: 'claude-haiku-4-5-20251001' }));
  });

  it('appends the read-only addendum to the stored system prompt under writeMode readonly', async () => {
    policyState.policy = { ...defaultClientAiPolicy(ORG_ID), enabled: true, writeMode: 'readonly' };
    const valuesSpy = vi.fn(() => ({ returning: vi.fn(() => Promise.resolve([{ id: SESSION_ID }])) }));
    dbInsertMock.mockImplementation(() => ({ values: valuesSpy }));
    await buildApp().request('/client-ai/sessions', { method: 'POST', headers: AUTHED });
    expect(valuesSpy).toHaveBeenCalledWith(expect.objectContaining({
      systemPrompt: expect.stringContaining('READ-ONLY'),
    }));
  });

  it('exposes the effective writeApproval=allow_auto when the org policy opts in', async () => {
    policyState.policy = {
      ...defaultClientAiPolicy(ORG_ID),
      enabled: true,
      writeApproval: 'allow_auto',
    };
    const res = await buildApp().request('/client-ai/sessions', { method: 'POST', headers: AUTHED });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      sessionId: SESSION_ID,
      writeMode: 'readwrite',
      writeApproval: 'allow_auto',
    });
  });

  it('402s when the org budget is exhausted', async () => {
    checkClientBudgetMock.mockResolvedValue('Daily AI budget for your organization has been reached ($5.00).');
    const res = await buildApp().request('/client-ai/sessions', { method: 'POST', headers: AUTHED });
    expect(res.status).toBe(402);
  });

  it('402s when partner AI credits are exhausted', async () => {
    checkBillingCreditsMock.mockResolvedValue('You are out of AI credits. Purchase more credits to continue.');
    const res = await buildApp().request('/client-ai/sessions', { method: 'POST', headers: AUTHED });
    expect(res.status).toBe(402);
  });

  it('429s when rate limited', async () => {
    rateLimiterMock.mockResolvedValue({ allowed: false, remaining: 0, resetAt: new Date() });
    const res = await buildApp().request('/client-ai/sessions', { method: 'POST', headers: AUTHED });
    expect(res.status).toBe(429);
  });
});

describe('GET /client-ai/sessions/:id', () => {
  it('404s when the session belongs to another client user (access check)', async () => {
    dbSelectMock.mockImplementation(() => selectChain([]));
    const res = await buildApp().request(`/client-ai/sessions/${SESSION_ID}`, { headers: AUTHED });
    expect(res.status).toBe(404);
  });

  it('returns the session plus its (already-redacted) message history', async () => {
    const MESSAGES = [
      { id: 'm1', role: 'user', content: 'card [REDACTED:creditCard]', contentBlocks: null, toolName: null, toolInput: null, toolOutput: null, toolUseId: null, createdAt: new Date() },
    ];
    let call = 0;
    dbSelectMock.mockImplementation(() => {
      call++;
      return selectChain(call === 1 ? [SESSION_ROW] : MESSAGES);
    });

    const res = await buildApp().request(`/client-ai/sessions/${SESSION_ID}`, { headers: AUTHED });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.session).toMatchObject({ id: SESSION_ID, status: 'active', title: 'Budget review' });
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].content).toContain('[REDACTED:creditCard]');
  });
});

describe('POST /client-ai/sessions/:id/close', () => {
  it('closes the session, fails pending tool requests, evicts the active session, audits', async () => {
    const res = await buildApp().request(`/client-ai/sessions/${SESSION_ID}/close`, {
      method: 'POST', headers: AUTHED,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });

    expect(failPendingMock).toHaveBeenCalledWith(SESSION_ID, 'session_closed');
    expect(managerMock.remove).toHaveBeenCalledWith(SESSION_ID);
    expect(dbUpdateMock).toHaveBeenCalled();
    expect(writeAuditEventMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'ai.client_session.close', resourceId: SESSION_ID }),
    );
  });

  it('404s for an inaccessible session', async () => {
    dbSelectMock.mockImplementation(() => selectChain([]));
    const res = await buildApp().request(`/client-ai/sessions/${SESSION_ID}/close`, {
      method: 'POST', headers: AUTHED,
    });
    expect(res.status).toBe(404);
  });
});

describe('POST /client-ai/sessions/:id/flag (end-user flag)', () => {
  it('flags the session with the portal-user principal, stores the reason, audits', async () => {
    const setSpy = vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) }));
    dbUpdateMock.mockImplementation(() => ({ set: setSpy }));

    const res = await buildApp().request(`/client-ai/sessions/${SESSION_ID}/flag`, {
      method: 'POST',
      headers: AUTHED,
      body: JSON.stringify({ reason: 'wrong total' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });

    // flaggedBy must be NULL (the flagger is a portal user, not a Breeze user;
    // flagged_by FKs users.id). The reason is persisted; flaggedAt is set.
    expect(setSpy).toHaveBeenCalledWith(
      expect.objectContaining({ flagReason: 'wrong total', flaggedBy: null }),
    );
    expect(writeAuditEventMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'ai.client_session.flag',
        resourceId: SESSION_ID,
        actorType: 'user',
        actorId: CLIENT_USER_ID,
      }),
    );
  });

  it('accepts a missing/empty body (reason is optional)', async () => {
    const res = await buildApp().request(`/client-ai/sessions/${SESSION_ID}/flag`, {
      method: 'POST', headers: AUTHED,
    });
    expect(res.status).toBe(200);
  });

  it('rejects an over-long reason (400)', async () => {
    const res = await buildApp().request(`/client-ai/sessions/${SESSION_ID}/flag`, {
      method: 'POST',
      headers: AUTHED,
      body: JSON.stringify({ reason: 'x'.repeat(1001) }),
    });
    expect(res.status).toBe(400);
  });

  it('404s for an inaccessible session', async () => {
    dbSelectMock.mockImplementation(() => selectChain([]));
    const res = await buildApp().request(`/client-ai/sessions/${SESSION_ID}/flag`, {
      method: 'POST', headers: AUTHED,
    });
    expect(res.status).toBe(404);
  });
});
