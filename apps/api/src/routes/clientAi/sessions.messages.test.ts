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

function passthroughDlp() {
  applyDlpMock.mockImplementation(async (input: { text?: string; cells?: unknown[][] }) => ({
    action: 'allow',
    ...(input.text !== undefined ? { text: input.text } : {}),
    ...(input.cells !== undefined ? { cells: input.cells.map((r: unknown[]) => [...r]) } : {}),
    redactions: [],
  }));
}

function makeActiveSession() {
  return {
    state: 'idle',
    orgId: ORG_ID,
    breezeSessionId: SESSION_ID,
    inputController: { pushMessage: vi.fn() },
    eventBus: { publish: vi.fn() },
    toolUseIdQueue: [],
  } as Record<string, unknown>;
}

function postMessage(body: Record<string, unknown>) {
  return buildApp().request(`/client-ai/sessions/${SESSION_ID}/messages`, {
    method: 'POST',
    headers: AUTHED,
    body: JSON.stringify(body),
  });
}

describe('POST /client-ai/sessions/:id/messages', () => {
  let activeSession: ReturnType<typeof makeActiveSession>;

  beforeEach(() => {
    passthroughDlp();
    activeSession = makeActiveSession();
    managerMock.getOrCreate.mockResolvedValue(activeSession);
    managerMock.get.mockReturnValue(undefined);
  });

  it('404s for an inaccessible session', async () => {
    dbSelectMock.mockImplementation(() => selectChain([]));
    expect((await postMessage({ content: 'hi' })).status).toBe(404);
  });

  it('410s when the session is closed', async () => {
    dbSelectMock.mockImplementation(() => selectChain([{ ...SESSION_ROW, status: 'closed' }]));
    expect((await postMessage({ content: 'hi' })).status).toBe(410);
  });

  it('402s on budget exhaustion, 429s on rate limit (preflight per message)', async () => {
    checkClientBudgetMock.mockResolvedValueOnce('Daily AI budget for your organization has been reached ($5.00).');
    expect((await postMessage({ content: 'hi' })).status).toBe(402);

    rateLimiterMock.mockResolvedValueOnce({ allowed: false, remaining: 0, resetAt: new Date() });
    expect((await postMessage({ content: 'hi' })).status).toBe(429);
  });

  it('accepts a message: persists the user row, pushes to the SDK, starts the turn timeout, audits, 202', async () => {
    const valuesSpy = vi.fn(() => Promise.resolve());
    dbInsertMock.mockImplementation(() => ({ values: valuesSpy }));

    const res = await postMessage({ content: 'sum column B please' });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: true });

    expect(valuesSpy).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: SESSION_ID, role: 'user', content: 'sum column B please',
    }));
    expect(activeSession.inputController).toMatchObject({});
    expect((activeSession.inputController as { pushMessage: ReturnType<typeof vi.fn> }).pushMessage)
      .toHaveBeenCalledWith('sum column B please');
    expect(managerMock.startTurnTimeout).toHaveBeenCalledWith(activeSession);
    expect(writeAuditEventMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'ai.client_session.message',
        actorId: CLIENT_USER_ID,
        details: expect.objectContaining({ principalType: 'portal_user', workbookContextKind: 'none' }),
      }),
    );
  });

  it('REDACT-BEFORE-LOG CONTRACT (Plan 3 Task 6): persists applyDlp().text + redactions, never the raw input', async () => {
    const RAW = 'card 4111111111111111 please check';
    applyDlpMock.mockResolvedValueOnce({
      action: 'allow',
      text: 'card [REDACTED:creditCard] please check',
      redactions: [{ rule: 'creditCard', count: 1, location: 'text' }],
    });
    const valuesSpy = vi.fn(() => Promise.resolve());
    dbInsertMock.mockImplementation(() => ({ values: valuesSpy }));

    const res = await postMessage({ content: RAW });
    expect(res.status).toBe(202);

    // applyDlp received the raw text with the policy's dlpConfig + orgId
    expect(applyDlpMock).toHaveBeenCalledWith({ text: RAW, dlpConfig: policyState.policy.dlpConfig, orgId: ORG_ID });

    // Persisted form: result.text + result.redactions (in content_blocks), never the raw value
    expect(valuesSpy).toHaveBeenCalledWith(expect.objectContaining({
      content: 'card [REDACTED:creditCard] please check',
      contentBlocks: expect.arrayContaining([
        { type: 'dlp_redactions', redactions: [{ rule: 'creditCard', count: 1, location: 'text' }] },
      ]),
    }));
    expect(JSON.stringify(valuesSpy.mock.calls)).not.toContain('4111111111111111');

    // The model sees the redacted form too
    const pushed = (activeSession.inputController as { pushMessage: ReturnType<typeof vi.fn> }).pushMessage.mock.calls[0]![0] as string;
    expect(pushed).toContain('[REDACTED:creditCard]');
    expect(pushed).not.toContain('4111111111111111');
  });

  it('DLP block → 400 with the reason, session_error published, audit denied, nothing persisted or pushed', async () => {
    applyDlpMock.mockResolvedValueOnce({
      action: 'block',
      blockReason: 'dlp_blocked:iban',
      redactions: [{ rule: 'iban', count: 1, location: 'text' }],
    });
    managerMock.get.mockReturnValue(activeSession);

    const res = await postMessage({ content: 'acct DE89370400440532013000' });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('dlp_blocked');
    expect(body.reason).toBe('dlp_blocked:iban');

    expect((activeSession.eventBus as { publish: ReturnType<typeof vi.fn> }).publish).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', message: expect.stringContaining('dlp_blocked:iban') }),
    );
    expect(dbInsertMock).not.toHaveBeenCalled();
    expect(writeAuditEventMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'ai.client_session.message', result: 'denied' }),
    );
  });

  it('workbookContext cells go through applyDlp and the redacted matrix is persisted + sent', async () => {
    const cells = [['Card'], ['4111111111111111']];
    applyDlpMock
      .mockResolvedValueOnce({ action: 'allow', text: 'summarize this', redactions: [] }) // text pass
      .mockResolvedValueOnce({
        action: 'allow',
        cells: [['Card'], ['[REDACTED:creditCard]']],
        redactions: [{ rule: 'creditCard', count: 1, location: 'cell[1][0]' }],
      }); // cells pass
    const valuesSpy = vi.fn(() => Promise.resolve());
    dbInsertMock.mockImplementation(() => ({ values: valuesSpy }));

    const res = await postMessage({
      content: 'summarize this',
      workbookContext: { kind: 'selection', address: 'A1:A2', cells },
    });
    expect(res.status).toBe(202);

    expect(applyDlpMock).toHaveBeenNthCalledWith(2, { cells, dlpConfig: policyState.policy.dlpConfig, orgId: ORG_ID });

    expect(valuesSpy).toHaveBeenCalledWith(expect.objectContaining({
      contentBlocks: expect.arrayContaining([
        expect.objectContaining({ type: 'workbook_context', kind: 'selection', address: 'A1:A2', cells: [['Card'], ['[REDACTED:creditCard]']] }),
        expect.objectContaining({ type: 'dlp_redactions' }),
      ]),
    }));

    const pushed = (activeSession.inputController as { pushMessage: ReturnType<typeof vi.fn> }).pushMessage.mock.calls[0]![0] as string;
    expect(pushed).toContain('[Workbook context — Current selection (A1:A2)]');
    expect(pushed).toContain('[REDACTED:creditCard]');
    expect(pushed).not.toContain('4111111111111111');
  });

  it('workbookContext.text (Word/PPT grid-less host) is interpolated into the model prompt — not the literal placeholder', async () => {
    const res = await postMessage({
      content: 'summarize the deck',
      workbookContext: { kind: 'sheet', text: 'Slide 1: Q3 roadmap\nSlide 2: budget' },
    });
    expect(res.status).toBe(202);

    const pushed = (activeSession.inputController as { pushMessage: ReturnType<typeof vi.fn> }).pushMessage.mock.calls[0]![0] as string;
    expect(pushed).toContain('[Workbook context');
    expect(pushed).toContain('Slide 1: Q3 roadmap');
    expect(pushed).not.toContain('(no cell data provided)');
  });

  it('workbookContext.text goes through applyDlp and the redacted text is interpolated + persisted', async () => {
    applyDlpMock
      .mockResolvedValueOnce({ action: 'allow', text: 'review this', redactions: [] }) // prompt pass
      .mockResolvedValueOnce({
        action: 'allow',
        text: 'card [REDACTED:creditCard] in slide notes',
        redactions: [{ rule: 'creditCard', count: 1, location: 'text' }],
      }); // wb.text pass
    const valuesSpy = vi.fn(() => Promise.resolve());
    dbInsertMock.mockImplementation(() => ({ values: valuesSpy }));

    const res = await postMessage({
      content: 'review this',
      workbookContext: { kind: 'sheet', text: 'card 4111111111111111 in slide notes' },
    });
    expect(res.status).toBe(202);

    // wb.text leaves Breeze too — scanned at the same chokepoint as cells
    expect(applyDlpMock).toHaveBeenNthCalledWith(2, {
      text: 'card 4111111111111111 in slide notes',
      dlpConfig: policyState.policy.dlpConfig,
      orgId: ORG_ID,
    });

    // The model sees the redacted text, never the raw card number
    const pushed = (activeSession.inputController as { pushMessage: ReturnType<typeof vi.fn> }).pushMessage.mock.calls[0]![0] as string;
    expect(pushed).toContain('[REDACTED:creditCard]');
    expect(pushed).not.toContain('4111111111111111');
    expect(JSON.stringify(valuesSpy.mock.calls)).not.toContain('4111111111111111');
  });

  it('wb.text DLP block → 400, nothing pushed (governance gap for mail closed)', async () => {
    applyDlpMock
      .mockResolvedValueOnce({ action: 'allow', text: 'review this', redactions: [] }) // prompt pass
      .mockResolvedValueOnce({
        action: 'block',
        blockReason: 'dlp_blocked:iban',
        redactions: [{ rule: 'iban', count: 1, location: 'text' }],
      }); // wb.text blocked

    const res = await postMessage({
      content: 'review this',
      workbookContext: { kind: 'sheet', text: 'acct DE89370400440532013000' },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).reason).toBe('dlp_blocked:iban');
    expect(dbInsertMock).not.toHaveBeenCalled();
  });

  it('409s when a message is already processing', async () => {
    managerMock.tryTransitionToProcessing.mockReturnValue(false);
    expect((await postMessage({ content: 'hi' })).status).toBe(409);
  });

  it('auto-titles the session from the first (redacted) message', async () => {
    dbSelectMock.mockImplementation(() => selectChain([{ ...SESSION_ROW, title: null }]));
    const setSpy = vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) }));
    dbUpdateMock.mockImplementation(() => ({ set: setSpy }));

    await postMessage({ content: 'sum column B please' });
    expect(setSpy).toHaveBeenCalledWith(expect.objectContaining({ title: 'sum column B please' }));
  });
});
