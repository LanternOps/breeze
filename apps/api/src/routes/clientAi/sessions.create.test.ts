import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// Mirrors the sessions.*.test.ts harness/mocks. Focuses on the HOST routing:
// the create handler stores `${host}_client`, rejects an unsupported host with
// 400, and the use path (ensureActiveClientSession) refuses to start a stored
// session whose host has no tool registry/prompt. Phase 6 flips Outlook to a
// fully supported host (registry + prompt) — so every REAL Office host is now
// served, and the still-unpopulated fail-loud host is a SYNTHETIC keynote
// (out-of-vocab on the create schema; → null host on the stored use path).

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

vi.mock('../../services/aiAgentSdk', () => ({
  settleBlockedTurnForNewMessage: vi.fn(() => Promise.resolve('not_blocked_on_approvals')),
}));

vi.mock('../../middleware/clientAiAuth', () => ({
  clientAiDbAccessContext: (orgId: string) => ({
    scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId: null,
  }),
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
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  db: { select: dbSelectMock, insert: dbInsertMock, update: dbUpdateMock },
  withDbAccessContext: vi.fn((_ctx: unknown, fn: () => unknown) => fn()),
  withSystemDbAccessContext: vi.fn((fn: () => unknown) => fn()),
}));
vi.mock('../../services/effectiveSettings', () => ({
  getEffectiveAiBudget: vi.fn().mockResolvedValue({ maxTurnsPerSession: 50 }),
}));
vi.mock('../../services/streamingSessionManager', () => ({ streamingSessionManager: managerMock }));
vi.mock('../../services/auditEvents', () => ({ writeAuditEvent: writeAuditEventMock }));
vi.mock('../../services/clientAiUsage', () => ({
  recordClientUsage: recordClientUsageMock,
  checkClientBudget: checkClientBudgetMock,
  getRemainingClientBudgetUsd: getRemainingBudgetMock,
}));
vi.mock('../../services/aiCostTracker', () => ({ checkBillingCredits: checkBillingCreditsMock }));
// #5557: /messages now takes an atomic budget reservation before dispatch.
// This suite is about the host guard, not budgeting, so admit unconditionally.
vi.mock('../../services/aiBudgetReservations', () => ({
  reserveAiBudget: vi.fn(async () => ({
    kind: 'unlimited' as const,
    reservationId: '99999999-9999-4999-8999-999999999999',
    dailyPeriodKey: '2026-09-10',
    monthlyPeriodKey: '2026-09',
    status: 'active' as const,
  })),
  releaseUnusedAiBudgetReservation: vi.fn(async () => undefined),
  isAiBudgetLockTimeout: vi.fn(() => false),
}));
vi.mock('../../services/rate-limit', () => ({ rateLimiter: rateLimiterMock }));
vi.mock('../../services/redis', () => ({ getRedis: vi.fn(() => ({}) as never) }));
vi.mock('../../services/clientAiToolBridge', () => ({
  resolveClientToolResult: resolveToolResultMock,
  failPendingForSession: failPendingMock,
}));
vi.mock('../../services/clientAiDlp', () => ({ applyDlp: applyDlpMock }));
const { resolveSessionTurnMock, chooseSessionModelMock, readOrgPartnerIdMock } = vi.hoisted(() => ({
  resolveSessionTurnMock: vi.fn(),
  chooseSessionModelMock: vi.fn(),
  readOrgPartnerIdMock: vi.fn(),
}));
// W03: office_chat turns + the /events reattach (Task 7) and session create
// (Task 9) resolve through the registry.
vi.mock('../../services/aiModels/sessionModel', async (importOriginal) => ({
  InvalidSessionModelError: (await importOriginal<typeof import('../../services/aiModels/sessionModel')>()).InvalidSessionModelError,
  resolveSessionTurn: (...args: unknown[]) => resolveSessionTurnMock(...args),
  chooseSessionModel: (...args: unknown[]) => chooseSessionModelMock(...args),
}));
vi.mock('../../services/aiModels/candidateLoader', () => ({
  readOrgPartnerId: (...args: unknown[]) => readOrgPartnerIdMock(...args),
}));

import { clientAiSessionRoutes } from './sessions';
import { LlmUnavailableError } from '../../services/llm/llmUnavailableError';
import { makeResolvedModel } from '../../services/aiModels/__fixtures__/resolvedModel';
import { defaultClientAiPolicy } from '../../services/clientAiPolicy';
import {
  WORD_CLIENT_SYSTEM_PROMPT,
  POWERPOINT_CLIENT_SYSTEM_PROMPT,
  OUTLOOK_CLIENT_SYSTEM_PROMPT,
} from '../../services/clientAiSessions';

const EXCEL_SESSION_ROW = {
  id: SESSION_ID, orgId: ORG_ID, clientUserId: CLIENT_USER_ID, type: 'excel_client',
  status: 'active', title: 'Budget review', model: 'claude-sonnet-4-5-20250929',
  systemPrompt: null, sdkSessionId: null, maxTurns: 50, turnCount: 0,
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
  resolveSessionTurnMock.mockResolvedValue(makeResolvedModel('anthropic_byok', { surface: 'office_chat' }));
  managerMock.tryTransitionToProcessing.mockReturnValue(true);
  managerMock.get.mockReturnValue(undefined);
  checkClientBudgetMock.mockResolvedValue(null);
  checkBillingCreditsMock.mockResolvedValue(null);
  rateLimiterMock.mockResolvedValue({ allowed: true, remaining: 9, resetAt: new Date() });
  readOrgPartnerIdMock.mockResolvedValue('partner-from-org');
  chooseSessionModelMock.mockResolvedValue({
    resolved: makeResolvedModel('anthropic_byok', { surface: 'office_chat', partnerId: 'partner-from-org' }),
    offeringId: 'off-1',
    offeringPartnerId: 'partner-from-org',
    options: null,
    model: 'claude-sonnet-5-5',
    billingSource: 'partner_key',
  });
  policyState.policy = { ...defaultClientAiPolicy(ORG_ID), enabled: true };
  dbSelectMock.mockImplementation(() => selectChain([EXCEL_SESSION_ROW]));
  dbInsertMock.mockImplementation(() => ({
    values: vi.fn(() => ({ returning: vi.fn(() => Promise.resolve([{ id: SESSION_ID }])) })),
  }));
  dbUpdateMock.mockImplementation(() => ({
    set: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })),
  }));
});

describe('POST /client-ai/sessions (create) — host routing', () => {
  it('creates an excel_client session by default (no host in body)', async () => {
    const valuesSpy = vi.fn(() => ({ returning: vi.fn(() => Promise.resolve([{ id: SESSION_ID }])) }));
    dbInsertMock.mockImplementation(() => ({ values: valuesSpy }));

    const res = await buildApp().request('/client-ai/sessions', {
      method: 'POST', body: JSON.stringify({}), headers: AUTHED,
    });
    expect(res.status).toBe(201);
    // W03 Task 9: created on the registry's office_chat offering for the org's partner.
    expect(valuesSpy).toHaveBeenCalledWith(expect.objectContaining({
      type: 'excel_client',
      offeringId: 'off-1',
      offeringPartnerId: 'partner-from-org',
      options: null,
      model: 'claude-sonnet-5-5',
      billingSource: 'partner_key',
    }));
    expect(readOrgPartnerIdMock).toHaveBeenCalledWith(ORG_ID);
    expect(chooseSessionModelMock).toHaveBeenCalledWith({
      partnerId: 'partner-from-org', orgId: ORG_ID, userId: null, surface: 'office_chat',
    });
    expect(checkBillingCreditsMock).toHaveBeenCalledWith(ORG_ID, 'partner_key');
    // The create audit records the resolved host.
    expect(writeAuditEventMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'ai.client_session.create',
        details: expect.objectContaining({ host: 'excel' }),
      }),
    );
  });

  it('runs the rate limit before provider resolution', async () => {
    rateLimiterMock.mockResolvedValueOnce({ allowed: false, remaining: 0, resetAt: new Date() });

    const res = await buildApp().request('/client-ai/sessions', {
      method: 'POST', body: JSON.stringify({}), headers: AUTHED,
    });

    expect(res.status).toBe(429);
    expect(chooseSessionModelMock).not.toHaveBeenCalled();
    expect(dbInsertMock).not.toHaveBeenCalled();
  });

  it('rejects a request-supplied partner id before provider resolution', async () => {
    const res = await buildApp().request('/client-ai/sessions', {
      method: 'POST', body: JSON.stringify({ partnerId: 'attacker-partner' }), headers: AUTHED,
    });

    expect(res.status).toBe(400);
    expect(chooseSessionModelMock).not.toHaveBeenCalled();
    expect(dbInsertMock).not.toHaveBeenCalled();
  });

  it('returns ai_unavailable as 503 before inserting a session', async () => {
    chooseSessionModelMock.mockRejectedValue(new LlmUnavailableError());

    const res = await buildApp().request('/client-ai/sessions', {
      method: 'POST', body: JSON.stringify({}), headers: AUTHED,
    });

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'ai_unavailable' });
    expect(dbInsertMock).not.toHaveBeenCalled();
  });

  it('no longer reads policy.allowedModels: the stored model is the offering\'s, not allowedModels[0]', async () => {
    policyState.policy = { ...defaultClientAiPolicy(ORG_ID), enabled: true, allowedModels: ['claude-opus-4-6'] };
    const valuesSpy = vi.fn(() => ({ returning: vi.fn(() => Promise.resolve([{ id: SESSION_ID }])) }));
    dbInsertMock.mockImplementation(() => ({ values: valuesSpy }));

    const res = await buildApp().request('/client-ai/sessions', {
      method: 'POST', body: JSON.stringify({}), headers: AUTHED,
    });

    expect(res.status).toBe(201);
    const inserted = (valuesSpy.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(inserted.model).toBe('claude-sonnet-5-5');
    expect(inserted.model).not.toBe('claude-opus-4-6');
  });

  it('an org with no partner is ai_unavailable before any resolution or insert', async () => {
    readOrgPartnerIdMock.mockResolvedValue(null);

    const res = await buildApp().request('/client-ai/sessions', {
      method: 'POST', body: JSON.stringify({}), headers: AUTHED,
    });

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'ai_unavailable' });
    expect(chooseSessionModelMock).not.toHaveBeenCalled();
    expect(dbInsertMock).not.toHaveBeenCalled();
  });

  it('runs the credit preflight on the resolved offering\'s funding before inserting', async () => {
    checkBillingCreditsMock.mockResolvedValueOnce('Insufficient credits');

    const res = await buildApp().request('/client-ai/sessions', {
      method: 'POST', body: JSON.stringify({}), headers: AUTHED,
    });

    expect(res.status).toBe(402);
    expect(checkBillingCreditsMock).toHaveBeenCalledWith(ORG_ID, 'partner_key');
    expect(dbInsertMock).not.toHaveBeenCalled();
  });

  it('creates an excel_client session when host:"excel" is explicit', async () => {
    const valuesSpy = vi.fn(() => ({ returning: vi.fn(() => Promise.resolve([{ id: SESSION_ID }])) }));
    dbInsertMock.mockImplementation(() => ({ values: valuesSpy }));

    const res = await buildApp().request('/client-ai/sessions', {
      method: 'POST', body: JSON.stringify({ host: 'excel' }), headers: AUTHED,
    });
    expect(res.status).toBe(201);
    expect(valuesSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'excel_client' }));
  });

  it('rejects an out-of-vocab host with 400 (schema strict)', async () => {
    const res = await buildApp().request('/client-ai/sessions', {
      method: 'POST', body: JSON.stringify({ host: 'keynote' }), headers: AUTHED,
    });
    expect(res.status).toBe(400);
    // Schema-level rejection (not the unsupported_host guard); no row inserted.
    expect(dbInsertMock).not.toHaveBeenCalled();
  });

  it('creates a word_client session for host:"word" (Phase 4 seam) with the Word prompt', async () => {
    const valuesSpy = vi.fn(() => ({ returning: vi.fn(() => Promise.resolve([{ id: SESSION_ID }])) }));
    dbInsertMock.mockImplementation(() => ({ values: valuesSpy }));

    const res = await buildApp().request('/client-ai/sessions', {
      method: 'POST', body: JSON.stringify({ host: 'word' }), headers: AUTHED,
    });
    expect(res.status).toBe(201);
    // Stored type encodes the host; the stored prompt is the Word system prompt
    // (default writeMode 'readwrite' ⇒ no readonly addendum).
    expect(valuesSpy).toHaveBeenCalledWith(expect.objectContaining({
      type: 'word_client',
      systemPrompt: WORD_CLIENT_SYSTEM_PROMPT,
    }));
    // The create audit records the resolved host.
    expect(writeAuditEventMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'ai.client_session.create',
        details: expect.objectContaining({ host: 'word' }),
      }),
    );
  });

  it('creates a powerpoint_client session for host:"powerpoint" (Phase 5 seam) with the PowerPoint prompt', async () => {
    const valuesSpy = vi.fn(() => ({ returning: vi.fn(() => Promise.resolve([{ id: SESSION_ID }])) }));
    dbInsertMock.mockImplementation(() => ({ values: valuesSpy }));

    const res = await buildApp().request('/client-ai/sessions', {
      method: 'POST', body: JSON.stringify({ host: 'powerpoint' }), headers: AUTHED,
    });
    expect(res.status).toBe(201);
    // Stored type encodes the host; the stored prompt is the PowerPoint system
    // prompt (default writeMode 'readwrite' ⇒ no readonly addendum).
    expect(valuesSpy).toHaveBeenCalledWith(expect.objectContaining({
      type: 'powerpoint_client',
      systemPrompt: POWERPOINT_CLIENT_SYSTEM_PROMPT,
    }));
    // The create audit records the resolved host.
    expect(writeAuditEventMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'ai.client_session.create',
        details: expect.objectContaining({ host: 'powerpoint' }),
      }),
    );
  });

  it('creates an outlook_client session for host:"outlook" (Phase 6 seam) with the Outlook prompt', async () => {
    const valuesSpy = vi.fn(() => ({ returning: vi.fn(() => Promise.resolve([{ id: SESSION_ID }])) }));
    dbInsertMock.mockImplementation(() => ({ values: valuesSpy }));

    const res = await buildApp().request('/client-ai/sessions', {
      method: 'POST', body: JSON.stringify({ host: 'outlook' }), headers: AUTHED,
    });
    expect(res.status).toBe(201);
    // Stored type encodes the host; the stored prompt is the Outlook system
    // prompt (default writeMode 'readwrite' ⇒ no readonly addendum). Outlook is
    // the mail-model host — no more real unsupported host remains.
    expect(valuesSpy).toHaveBeenCalledWith(expect.objectContaining({
      type: 'outlook_client',
      systemPrompt: OUTLOOK_CLIENT_SYSTEM_PROMPT,
    }));
    // The create audit records the resolved host.
    expect(writeAuditEventMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'ai.client_session.create',
        details: expect.objectContaining({ host: 'outlook' }),
      }),
    );
  });
});

describe('use-path host guard (ensureActiveClientSession)', () => {
  it('rate limits a turn before resolving its provider or checking an unsupported stored host', async () => {
    dbSelectMock.mockImplementation(() => selectChain([{ ...EXCEL_SESSION_ROW, type: 'keynote_client' }]));
    rateLimiterMock.mockResolvedValueOnce({ allowed: false, remaining: 0, resetAt: new Date() });

    const res = await buildApp().request(`/client-ai/sessions/${SESSION_ID}/messages`, {
      method: 'POST', headers: AUTHED, body: JSON.stringify({ content: 'hi' }),
    });

    expect(res.status).toBe(429);
    expect(chooseSessionModelMock).not.toHaveBeenCalled();
    expect(managerMock.getOrCreate).not.toHaveBeenCalled();
  });

  it('refuses to start a stored keynote_client session (400 on /messages)', async () => {
    // Every REAL Office host (excel/word/powerpoint/outlook) is now fully
    // supported, so the fail-loud baton moves to a SYNTHETIC keynote_client row:
    // clientHostFromType('keynote_client') → null (not in CLIENT_HOSTS) → the
    // use path must still fail loud, never building a zero-tool MCP server.
    dbSelectMock.mockImplementation(() => selectChain([{ ...EXCEL_SESSION_ROW, type: 'keynote_client' }]));
    applyDlpMock.mockImplementation(async (input: { text?: string; cells?: unknown[][] }) => ({
      action: 'allow',
      ...(input.text !== undefined ? { text: input.text } : {}),
      redactions: [],
    }));

    const res = await buildApp().request(`/client-ai/sessions/${SESSION_ID}/messages`, {
      method: 'POST', headers: AUTHED, body: JSON.stringify({ content: 'hi' }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('unsupported_host');
    // The SDK session was never created.
    expect(managerMock.getOrCreate).not.toHaveBeenCalled();
  });

  it('refuses to open the SSE channel for a stored keynote_client session (400 on /events)', async () => {
    dbSelectMock.mockImplementation(() => selectChain([{ ...EXCEL_SESSION_ROW, type: 'keynote_client' }]));

    const res = await buildApp().request(`/client-ai/sessions/${SESSION_ID}/events`, { headers: AUTHED });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('unsupported_host');
    expect(managerMock.getOrCreate).not.toHaveBeenCalled();
  });
});

describe('GET /client-ai/sessions (history) — host query param', () => {
  it('defaults to excel and filters the WHERE by excel_client', async () => {
    const limit = vi.fn(() => Promise.resolve([]));
    const orderBy = vi.fn(() => ({ limit }));
    const groupBy = vi.fn(() => ({ orderBy }));
    const where = vi.fn(() => ({ groupBy }));
    const leftJoin = vi.fn(() => ({ where }));
    dbSelectMock.mockImplementation(() => ({ from: vi.fn(() => ({ leftJoin })) }));

    const res = await buildApp().request('/client-ai/sessions', { headers: AUTHED });
    expect(res.status).toBe(200);
    expect(where).toHaveBeenCalledTimes(1);
  });

  it('accepts ?host=excel', async () => {
    const limit = vi.fn(() => Promise.resolve([]));
    const orderBy = vi.fn(() => ({ limit }));
    const groupBy = vi.fn(() => ({ orderBy }));
    const where = vi.fn(() => ({ groupBy }));
    const leftJoin = vi.fn(() => ({ where }));
    dbSelectMock.mockImplementation(() => ({ from: vi.fn(() => ({ leftJoin })) }));

    const res = await buildApp().request('/client-ai/sessions?host=excel', { headers: AUTHED });
    expect(res.status).toBe(200);
  });

  it('400s on an out-of-vocab ?host= value (does not silently empty-list)', async () => {
    const res = await buildApp().request('/client-ai/sessions?host=keynote', { headers: AUTHED });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('unsupported_host');
  });
});
