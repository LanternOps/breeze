import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { TimeEntryServiceError } from '../services/timeEntryService';

const authHarness = vi.hoisted(() => {
  const partnerAuth = {
    user: { id: 'user-1', email: 'test@example.com', name: 'Test User' },
    scope: 'partner' as const,
    partnerId: 'partner-111',
    orgId: null,
    accessibleOrgIds: ['org1'],
    orgCondition: () => undefined,
    canAccessOrg: (id: string) => id === 'org1',
  };
  const orgAuth = {
    ...partnerAuth,
    scope: 'organization' as const,
    partnerId: null,
    orgId: 'org1',
  };
  return { currentAuth: { value: partnerAuth as typeof partnerAuth | typeof orgAuth }, partnerAuth, orgAuth };
});

const routeMocks = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  createTicketMock: vi.fn(),
  changeStatusMock: vi.fn(),
  createTimeEntryMock: vi.fn(),
  deviceInSiteScopeMock: vi.fn(),
  writeRouteAuditMock: vi.fn(),
  resolveSessionTurnMock: vi.fn(),
  anthropicClientForMock: vi.fn(),
  settleInvocationMock: vi.fn(),
  checkBudgetDetailedMock: vi.fn(),
  anthropicClient: { messages: { create: vi.fn() } },
  reserveAiBudget: vi.fn(),
  markAiBudgetReservationIndeterminate: vi.fn(),
  releaseUnusedAiBudgetReservation: vi.fn(),
}));

const configRef = vi.hoisted(() => ({
  provider: 'anthropic' as 'anthropic' | 'openai-compatible',
}));

vi.mock('../config/validate', () => ({
  getConfig: vi.fn(() => ({ MCP_LLM_PROVIDER: configRef.provider })),
}));

vi.mock('../services/llm/llmConfigResolver', () => ({
  LlmUnavailableError: class LlmUnavailableError extends Error {
    constructor() {
      super('AI is unavailable for this partner.');
      this.name = 'LlmUnavailableError';
    }
  },
}));

vi.mock('../services/aiModels/sessionModel', () => ({
  resolveSessionTurn: routeMocks.resolveSessionTurnMock,
  InvalidSessionModelError: class InvalidSessionModelError extends Error {},
}));

vi.mock('../services/aiModels/connectionFactory', async (importOriginal) => ({
  // Real MessageDispatchError: failoverDispatch's pre-output check reads it.
  MessageDispatchError: (await importOriginal<typeof import('../services/aiModels/connectionFactory')>()).MessageDispatchError,
  anthropicClientFor: routeMocks.anthropicClientForMock,
}));

// W09 failover cools a failed offering down in Redis: never touched here.
vi.mock('../services/aiModels/offeringHealth', () => ({
  noteProviderFailure: vi.fn(async () => undefined),
}));

vi.mock('../services/aiModels/settleInvocation', () => ({
  settleInvocation: routeMocks.settleInvocationMock,
}));

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock('../db/schema', () => ({
  aiSessions: {
    id: 'aiSessions.id',
    orgId: 'aiSessions.orgId',
    flaggedAt: 'aiSessions.flaggedAt',
    flaggedBy: 'aiSessions.flaggedBy',
    flagReason: 'aiSessions.flagReason',
  },
  aiMessages: {
    id: 'aiMessages.id',
    sessionId: 'aiMessages.sessionId',
  },
  aiToolExecutions: {
    id: 'aiToolExecutions.id',
    sessionId: 'aiToolExecutions.sessionId',
    status: 'aiToolExecutions.status',
    toolName: 'aiToolExecutions.toolName',
    createdAt: 'aiToolExecutions.createdAt',
    durationMs: 'aiToolExecutions.durationMs',
    toolInput: 'aiToolExecutions.toolInput',
    approvedBy: 'aiToolExecutions.approvedBy',
    approvedAt: 'aiToolExecutions.approvedAt',
    errorMessage: 'aiToolExecutions.errorMessage',
    completedAt: 'aiToolExecutions.completedAt',
  },
  auditLogs: {
    id: 'auditLogs.id',
    orgId: 'auditLogs.orgId',
    action: 'auditLogs.action',
    timestamp: 'auditLogs.timestamp',
    actorType: 'auditLogs.actorType',
    actorEmail: 'auditLogs.actorEmail',
    resourceType: 'auditLogs.resourceType',
    resourceId: 'auditLogs.resourceId',
    result: 'auditLogs.result',
    errorMessage: 'auditLogs.errorMessage',
    details: 'auditLogs.details',
  },
  aiActionPlans: {
    id: 'aiActionPlans.id',
    status: 'aiActionPlans.status',
    approvedBy: 'aiActionPlans.approvedBy',
    approvedAt: 'aiActionPlans.approvedAt',
  },
  organizations: {
    id: 'organizations.id',
    name: 'organizations.name',
    partnerId: 'organizations.partnerId',
  },
  devices: {
    id: 'devices.id',
    hostname: 'devices.hostname',
  },
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', authHarness.currentAuth.value);
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
  hasPermission: vi.fn(() => false),
}));

vi.mock('../services/aiAgent', () => ({
  createSession: vi.fn(),
  getSession: routeMocks.getSessionMock,
  listSessions: vi.fn(),
  closeSession: vi.fn(),
  getSessionMessages: vi.fn(),
  handleApproval: vi.fn(),
  searchSessions: vi.fn(),
  listM365Connections: vi.fn(),
  resolveDefaultModel: vi.fn(() => 'claude-test'),
}));

vi.mock('../services/aiCostTracker', () => ({
  getSessionHistory: vi.fn(),
  getUsageSummary: vi.fn(),
  updateBudget: vi.fn(),
  checkBudgetDetailed: routeMocks.checkBudgetDetailedMock,
}));

vi.mock('../services/aiBudgetReservations', () => ({
  reserveAiBudget: routeMocks.reserveAiBudget,
  markAiBudgetReservationIndeterminate: routeMocks.markAiBudgetReservationIndeterminate,
  releaseUnusedAiBudgetReservation: routeMocks.releaseUnusedAiBudgetReservation,
}));

vi.mock('../services/aiTicketDraft', () => ({
  draftTicketFromTranscript: vi.fn(),
  ThinTranscriptError: class ThinTranscriptError extends Error {
    constructor() {
      super('Not enough conversation to draft a ticket');
      this.name = 'ThinTranscriptError';
    }
  },
  TicketDraftFailedError: class TicketDraftFailedError extends Error {
    constructor(message: string, public attempts: unknown[] = [], public providerOutcomeUnknown = false) {
      super(message);
    }
  },
}));

vi.mock('../services/ticketService', () => ({
  createTicket: routeMocks.createTicketMock,
  changeTicketStatus: routeMocks.changeStatusMock,
  TicketServiceError: class TicketServiceError extends Error {
    status: number;

    constructor(message: string, status = 400) {
      super(message);
      this.name = 'TicketServiceError';
      this.status = status;
    }
  },
}));

vi.mock('../services/timeEntryService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/timeEntryService')>();
  return { createTimeEntry: routeMocks.createTimeEntryMock, TimeEntryServiceError: actual.TimeEntryServiceError };
});

vi.mock('./tickets/siteScope', () => ({
  deviceInSiteScope: routeMocks.deviceInSiteScopeMock,
}));

vi.mock('../services/streamingSessionManager', () => ({
  streamingSessionManager: {
    getOrCreate: vi.fn(),
    get: vi.fn(),
    remove: vi.fn(),
    tryTransitionToProcessing: vi.fn(),
    interrupt: vi.fn(),
    startTurnTimeout: vi.fn(),
  },
}));

vi.mock('../services/aiAgentSdk', () => ({
  runPreFlightChecks: vi.fn(),
  settleBlockedTurnForNewMessage: vi.fn(() => Promise.resolve('not_blocked_on_approvals')),
  abortActivePlan: vi.fn(),
}));

vi.mock('../services/auditEvents', () => ({
  writeRouteAudit: routeMocks.writeRouteAuditMock,
}));

vi.mock('../services/sentry', () => ({
  captureException: vi.fn(),
}));

vi.mock('../services/effectiveSettings', () => ({
  assertNotLocked: vi.fn(),
}));

import { aiRoutes, isOpenAICompatibleProvider } from './ai';
import { db } from '../db';
import { getSessionMessages } from '../services/aiAgent';
import { draftTicketFromTranscript, ThinTranscriptError } from '../services/aiTicketDraft';
import { LlmUnavailableError } from '../services/llm/llmConfigResolver';
import { TicketDraftFailedError } from '../services/aiTicketDraft';
import { turnBindingFrom } from '../services/aiModels/turnBinding';
import { makeResolvedModel } from '../services/aiModels/__fixtures__/resolvedModel';
import { TicketServiceError } from '../services/ticketService';
import { captureException } from '../services/sentry';

const partnerAuth = authHarness.partnerAuth;
const orgAuth = authHarness.orgAuth;
const {
  getSessionMock,
  createTicketMock,
  changeStatusMock,
  createTimeEntryMock,
  deviceInSiteScopeMock,
} = routeMocks;

function selectRows(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(rows),
      }),
    }),
  };
}

const msgFixture = {
  id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', stop_reason: 'end_turn', stop_sequence: null,
  content: [{ type: 'text', text: '{}' }],
  usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
} as never;
const attemptsFixture = [{ wireModel: 'claude-sonnet-5-5', message: msgFixture }];

describe('POST /ai/sessions/:id/ticket-draft', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    configRef.provider = 'anthropic';
    authHarness.currentAuth.value = partnerAuth;
    app = new Hono();
    app.route('/ai', aiRoutes);
    routeMocks.reserveAiBudget.mockResolvedValue({
      kind: 'unlimited',
      reservationId: '66666666-6666-4666-8666-666666666666',
      dailyPeriodKey: '2026-09-06',
      monthlyPeriodKey: '2026-09-01',
      status: 'active',
    });
    routeMocks.markAiBudgetReservationIndeterminate.mockResolvedValue({
      kind: 'indeterminate', reservationId: '66666666-6666-4666-8666-666666666666',
    });
    routeMocks.releaseUnusedAiBudgetReservation.mockResolvedValue({
      kind: 'released', reservationId: '66666666-6666-4666-8666-666666666666',
    });

    routeMocks.resolveSessionTurnMock.mockResolvedValue(makeResolvedModel('anthropic_byok'));
    routeMocks.anthropicClientForMock.mockReturnValue(routeMocks.anthropicClient);
    routeMocks.checkBudgetDetailedMock.mockResolvedValue(null);
    routeMocks.settleInvocationMock.mockResolvedValue({ costCents: 1, invocationIds: ['inv-1'], deferred: false });

    vi.mocked(db.select).mockReturnValue(selectRows([{
      name: 'Acme Co',
      partnerId: 'partner-from-session-org',
    }]) as any);
  });

  function postDraft(sessionId: string, auth: any = partnerAuth) {
    authHarness.currentAuth.value = auth;
    return app.request(`/ai/sessions/${sessionId}/ticket-draft`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token' },
    });
  }

  it('does not call the ticket drafter when durable budget admission denies', async () => {
    vi.mocked(getSessionMessages).mockResolvedValueOnce({
      session: {
        id: 's1', orgId: 'org1', deviceId: null, model: null,
        createdAt: new Date(), contextSnapshot: null,
      },
      messages: [{ role: 'assistant', content: 'fixed' }],
    } as any);
    routeMocks.reserveAiBudget.mockResolvedValueOnce({
      kind: 'denied', reason: 'daily_budget', message: 'Daily AI budget exhausted ($1.00)',
    });

    const res = await postDraft('s1', partnerAuth);

    expect(res.status).toBe(429);
    expect(draftTicketFromTranscript).not.toHaveBeenCalled();
  });

  it('returns a draft assembled from the session + summarizer', async () => {
    const createdAt = new Date(Date.now() - 25 * 60000);
    vi.mocked(getSessionMessages).mockResolvedValueOnce({
      session: { id: 's1', orgId: 'org1', deviceId: null, model: null, createdAt, contextSnapshot: null },
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'fixed' },
      ],
    } as any);
    vi.mocked(draftTicketFromTranscript).mockResolvedValueOnce({
      subject: 'S',
      problemSummary: 'P',
      resolutionSummary: 'R',
      wasFixed: true,
      suggestedTimeMinutes: 15,
      attempts: attemptsFixture,
    });

    const res = await postDraft('s1', partnerAuth);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toMatchObject({
      subject: 'S',
      problemSummary: 'P',
      resolutionSummary: 'R',
      suggestedStatus: 'resolved',
      suggestedTimeMinutes: 15,
      orgId: 'org1',
      orgName: 'Acme Co',
      deviceId: null,
      deviceHostname: null,
    });
    expect(body.data).not.toHaveProperty('wasFixed');
    expect(getSessionMessages).toHaveBeenCalledWith('s1', partnerAuth);
    expect(draftTicketFromTranscript).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: 'fixed' },
        ],
        contextSnapshot: null,
        elapsedMinutes: expect.any(Number),
        resolved: expect.objectContaining({ wireModel: 'claude-sonnet-5-5' }),
        client: routeMocks.anthropicClient,
      })
    );
    expect(routeMocks.anthropicClientForMock).toHaveBeenCalledWith(
      expect.anything(), { surface: 'one_shot_ticket_draft', orgId: 'org1' },
    );
  });

  it('ticket draft inherits the chat session offering, reserves with its funding + binding, and settles every attempt', async () => {
    const model = makeResolvedModel('anthropic_byok');
    routeMocks.resolveSessionTurnMock.mockResolvedValue(model);
    vi.mocked(getSessionMessages).mockResolvedValueOnce({
      session: { id: 's1', orgId: 'org1', deviceId: null, model: null, createdAt: new Date(), contextSnapshot: null },
      messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'fixed' }],
    } as any);
    vi.mocked(draftTicketFromTranscript).mockResolvedValueOnce({
      subject: 's', problemSummary: 'p', resolutionSummary: '', wasFixed: false, suggestedTimeMinutes: 3,
      attempts: attemptsFixture,
    });

    const res = await postDraft('s1', partnerAuth);

    expect(res.status).toBe(200);
    expect(routeMocks.resolveSessionTurnMock).toHaveBeenCalledWith({
      sessionId: 's1', surface: 'chat', userId: 'user-1', maxTokens: 1024, transport: 'messages_api',
    });
    expect(routeMocks.checkBudgetDetailedMock).toHaveBeenCalledWith('org1', 'partner_key');
    expect(routeMocks.reserveAiBudget).toHaveBeenCalledWith(expect.objectContaining({
      billingSource: 'partner_key', binding: turnBindingFrom(model),
    }));
    expect(routeMocks.settleInvocationMock).toHaveBeenCalledTimes(1);
    expect(routeMocks.settleInvocationMock).toHaveBeenCalledWith(expect.objectContaining({
      binding: turnBindingFrom(model), sourceRef: 'ticket_draft', userId: 'user-1', sessionId: null,
      orgId: 'org1', reservationId: '66666666-6666-4666-8666-666666666666',
      usage: [expect.objectContaining({ model: 'claude-sonnet-5-5', tokens: expect.objectContaining({ input: 10, output: 5 }) })],
    }));
  });

  it('a ticket draft is NOT a session turn: the reservation is sessionless, so it never stamps or claims the chat session', async () => {
    vi.mocked(getSessionMessages).mockResolvedValueOnce({
      session: { id: '11111111-1111-4111-8111-111111111111', orgId: 'org1', deviceId: null, model: null, createdAt: new Date(), contextSnapshot: null },
      messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'fixed' }],
    } as any);
    vi.mocked(draftTicketFromTranscript).mockResolvedValueOnce({
      subject: 's', problemSummary: 'p', resolutionSummary: '', wasFixed: false, suggestedTimeMinutes: 3,
      attempts: attemptsFixture,
    });

    const res = await postDraft('11111111-1111-4111-8111-111111111111', partnerAuth);

    expect(res.status).toBe(200);
    // Session authorization still happened first (org + owner via getSessionMessages).
    expect(getSessionMessages).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111', partnerAuth);
    const reserveInput = routeMocks.reserveAiBudget.mock.calls[0]![0] as Record<string, unknown>;
    // reserveAiBudget stamps the session binding whenever a sessionId is passed.
    expect(reserveInput.sessionId ?? null).toBeNull();
    // Reservation and settlement agree: both sessionless.
    expect(routeMocks.settleInvocationMock).toHaveBeenCalledWith(expect.objectContaining({ sessionId: null }));
  });

  it('a refused attempt whose fallback then threw is settled (billed) with an error outcome, not left indeterminate', async () => {
    vi.mocked(getSessionMessages).mockResolvedValueOnce({
      session: { id: 's1', orgId: 'org1', deviceId: null, model: null, createdAt: new Date(), contextSnapshot: null },
      messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'fixed' }],
    } as any);
    const refused = { ...(msgFixture as object), stop_reason: 'refusal', stop_details: { category: 'cyber' } };
    vi.mocked(draftTicketFromTranscript).mockRejectedValueOnce(
      new TicketDraftFailedError('fallback socket', [{ wireModel: 'claude-sonnet-5-5', message: refused as never }], true),
    );

    const res = await postDraft('s1', partnerAuth);

    expect(res.status).toBe(502);
    expect(routeMocks.markAiBudgetReservationIndeterminate).not.toHaveBeenCalled();
    expect(routeMocks.settleInvocationMock).toHaveBeenCalledWith(expect.objectContaining({
      sourceRef: 'ticket_draft', sessionId: null,
      usage: [expect.objectContaining({ model: 'claude-sonnet-5-5', tokens: expect.objectContaining({ input: 10, output: 5 }) })],
      outcome: expect.objectContaining({ stopReason: 'error' }),
    }));
  });

  it('exhausted platform credits refuse the ticket draft before any reservation or provider call', async () => {
    routeMocks.resolveSessionTurnMock.mockResolvedValue(makeResolvedModel('platform'));
    routeMocks.checkBudgetDetailedMock.mockResolvedValue({ message: 'You are out of AI credits.', reason: 'credits_exhausted', permanent: false });
    vi.mocked(getSessionMessages).mockResolvedValueOnce({
      session: { id: 's1', orgId: 'org1', deviceId: null, model: null, createdAt: new Date(), contextSnapshot: null },
      messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'fixed' }],
    } as any);

    const res = await postDraft('s1', partnerAuth);

    expect(res.status).toBe(402);
    expect(routeMocks.checkBudgetDetailedMock).toHaveBeenCalledWith('org1', 'platform');
    expect(routeMocks.reserveAiBudget).not.toHaveBeenCalled();
    expect(draftTicketFromTranscript).not.toHaveBeenCalled();
  });

  it('a failed draft that burned tokens still settles its attempts', async () => {
    vi.mocked(getSessionMessages).mockResolvedValueOnce({
      session: { id: 's1', orgId: 'org1', deviceId: null, model: null, createdAt: new Date(), contextSnapshot: null },
      messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'fixed' }],
    } as any);
    const failure = new TicketDraftFailedError('bad json', attemptsFixture, false);
    vi.mocked(draftTicketFromTranscript).mockRejectedValueOnce(failure);

    const res = await postDraft('s1', partnerAuth);

    expect(res.status).toBe(502);
    expect(routeMocks.settleInvocationMock).toHaveBeenCalledTimes(1);
    expect(routeMocks.releaseUnusedAiBudgetReservation).not.toHaveBeenCalled();
  });

  it('a failure-path settlement that THROWS holds the reservation indeterminate and is reported scrubbed (review S7)', async () => {
    vi.mocked(getSessionMessages).mockResolvedValueOnce({
      session: { id: 's1', orgId: 'org1', deviceId: null, model: null, createdAt: new Date(), contextSnapshot: null },
      messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'fixed' }],
    } as any);
    vi.mocked(draftTicketFromTranscript).mockRejectedValueOnce(new TicketDraftFailedError('bad json', attemptsFixture, false));
    routeMocks.settleInvocationMock.mockRejectedValueOnce(Object.assign(new Error('Failed query: insert … params: sk-ant-secret'), { params: ['sk-ant-secret'] }));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await postDraft('s1', partnerAuth);
    const logged = JSON.stringify(errSpy.mock.calls);
    errSpy.mockRestore();

    expect(res.status).toBe(502);
    expect(routeMocks.markAiBudgetReservationIndeterminate).toHaveBeenCalledWith({
      orgId: 'org1', reservationId: '66666666-6666-4666-8666-666666666666',
    });
    expect(logged).not.toContain('sk-ant-secret');
    const messages = vi.mocked(captureException).mock.calls.map(([e]) => String((e as Error).message));
    expect(messages.some((msg) => /ticket draft settlement failed/.test(msg))).toBe(true);
    expect(messages.join(' ')).not.toContain('sk-ant-secret');
  });

  it('an UNRECORDED success-path settlement keeps the reservation indeterminate (review S1)', async () => {
    vi.mocked(getSessionMessages).mockResolvedValueOnce({
      session: { id: 's1', orgId: 'org1', deviceId: null, model: null, createdAt: new Date(), contextSnapshot: null },
      messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'fixed' }],
    } as any);
    vi.mocked(draftTicketFromTranscript).mockResolvedValueOnce({
      subject: 'S', problemSummary: 'P', resolutionSummary: 'R', wasFixed: true, suggestedTimeMinutes: 15, attempts: attemptsFixture,
    });
    routeMocks.settleInvocationMock.mockResolvedValueOnce({ costCents: 1, invocationIds: [], deferred: true, unrecorded: true });

    const res = await postDraft('s1', partnerAuth);

    expect(res.status).toBe(200);
    expect(routeMocks.markAiBudgetReservationIndeterminate).toHaveBeenCalledWith({
      orgId: 'org1', reservationId: '66666666-6666-4666-8666-666666666666',
    });
  });

  it('a provider throw with nothing billed leaves the reservation indeterminate and never settles', async () => {
    vi.mocked(getSessionMessages).mockResolvedValueOnce({
      session: { id: 's1', orgId: 'org1', deviceId: null, model: null, createdAt: new Date(), contextSnapshot: null },
      messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'fixed' }],
    } as any);
    const failure = new TicketDraftFailedError('socket', [], true);
    vi.mocked(draftTicketFromTranscript).mockRejectedValueOnce(failure);

    const res = await postDraft('s1', partnerAuth);

    expect(res.status).toBe(502);
    expect(routeMocks.markAiBudgetReservationIndeterminate).toHaveBeenCalledTimes(1);
    expect(routeMocks.settleInvocationMock).not.toHaveBeenCalled();
  });

  it('a thin transcript releases the reservation without settling', async () => {
    vi.mocked(getSessionMessages).mockResolvedValueOnce({
      session: { id: 's1', orgId: 'org1', deviceId: null, model: null, createdAt: new Date(), contextSnapshot: null },
      messages: [{ role: 'user', content: 'hi' }],
    } as any);
    vi.mocked(draftTicketFromTranscript).mockRejectedValueOnce(new ThinTranscriptError());

    const res = await postDraft('s1', partnerAuth);

    expect(res.status).toBe(422);
    expect(routeMocks.releaseUnusedAiBudgetReservation).toHaveBeenCalledTimes(1);
    expect(routeMocks.settleInvocationMock).not.toHaveBeenCalled();
  });

  it('answers a recoverable resolver failure as 409 with the code, before any client or reservation', async () => {
    routeMocks.resolveSessionTurnMock.mockResolvedValue({
      ok: false, reason: 'model_unavailable', recoverable: true, offeringId: 'off-1', message: 'Model gone.',
    });
    vi.mocked(getSessionMessages).mockResolvedValueOnce({
      session: { id: 's1', orgId: 'org1', deviceId: null, model: null, createdAt: new Date(), contextSnapshot: null },
      messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'fixed' }],
    } as any);

    const res = await postDraft('s1', partnerAuth);

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Model gone.', code: 'model_unavailable', recoverable: true });
    expect(routeMocks.anthropicClientForMock).not.toHaveBeenCalled();
    expect(routeMocks.reserveAiBudget).not.toHaveBeenCalled();
  });

  it('registry_unavailable answers 503', async () => {
    routeMocks.resolveSessionTurnMock.mockResolvedValue({
      ok: false, reason: 'registry_unavailable', recoverable: true, offeringId: null, message: 'Upgrading.',
    });
    vi.mocked(getSessionMessages).mockResolvedValueOnce({
      session: { id: 's1', orgId: 'org1', deviceId: null, model: null, createdAt: new Date(), contextSnapshot: null },
      messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'fixed' }],
    } as any);
    const res = await postDraft('s1', partnerAuth);
    expect(res.status).toBe(503);
  });

  it('enriches a draft with the session device hostname', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(selectRows([{
        name: 'Acme Co',
        partnerId: 'partner-from-session-org',
      }]) as any)
      .mockReturnValueOnce(selectRows([{ hostname: 'WKS-04' }]) as any);
    vi.mocked(getSessionMessages).mockResolvedValueOnce({
      session: { id: 's1', orgId: 'org1', deviceId: 'dev1', model: null, createdAt: new Date(), contextSnapshot: null },
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'fixed' },
      ],
    } as any);
    vi.mocked(draftTicketFromTranscript).mockResolvedValueOnce({
      subject: 'S',
      problemSummary: 'P',
      resolutionSummary: 'R',
      wasFixed: true,
      suggestedTimeMinutes: 15,
      attempts: attemptsFixture,
    });

    const res = await postDraft('s1', partnerAuth);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      data: {
        deviceId: 'dev1',
        deviceHostname: 'WKS-04',
      },
    });
  });

  it('404 when the session is not reachable', async () => {
    vi.mocked(getSessionMessages).mockResolvedValueOnce(null);

    const res = await postDraft('sX', partnerAuth);

    expect(res.status).toBe(404);
  });

  it('503s when the session organization is missing without constructing a client or recording usage', async () => {
    vi.mocked(db.select).mockReturnValueOnce(selectRows([]) as any);
    vi.mocked(getSessionMessages).mockResolvedValueOnce({
      session: { id: 's1', orgId: 'org1', deviceId: null, model: null, createdAt: new Date(), contextSnapshot: null },
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'working' },
      ],
    } as any);

    const res = await postDraft('s1', partnerAuth);

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'ai_unavailable' });
    expect(routeMocks.resolveSessionTurnMock).not.toHaveBeenCalled();
    expect(draftTicketFromTranscript).not.toHaveBeenCalled();
    expect(routeMocks.settleInvocationMock).not.toHaveBeenCalled();
  });

  it('422 on a thin transcript', async () => {
    vi.mocked(getSessionMessages).mockResolvedValueOnce({
      session: { id: 's1', orgId: 'org1', deviceId: null, model: null, createdAt: new Date(), contextSnapshot: null },
      messages: [{ role: 'user', content: 'hi' }],
    } as any);
    vi.mocked(draftTicketFromTranscript).mockRejectedValueOnce(new ThinTranscriptError());

    const res = await postDraft('s1', partnerAuth);

    expect(res.status).toBe(422);
  });

  it('502 on a generic summarizer failure', async () => {
    vi.mocked(getSessionMessages).mockResolvedValueOnce({
      session: { id: 's1', orgId: 'org1', deviceId: null, model: null, createdAt: new Date(), contextSnapshot: null },
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'working' },
      ],
    } as any);
    vi.mocked(draftTicketFromTranscript).mockRejectedValueOnce(new Error('anthropic down'));

    const res = await postDraft('s1', partnerAuth);

    expect(res.status).toBe(502);
  });

  it('503s with ai_unavailable when the connection has no usable key', async () => {
    vi.mocked(getSessionMessages).mockResolvedValueOnce({
      session: { id: 's1', orgId: 'org1', deviceId: null, model: null, createdAt: new Date(), contextSnapshot: null },
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'working' },
      ],
    } as any);
    routeMocks.anthropicClientForMock.mockImplementationOnce(() => { throw new LlmUnavailableError('no key'); });

    const res = await postDraft('s1', partnerAuth);

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'ai_unavailable' });
    expect(draftTicketFromTranscript).not.toHaveBeenCalled();
  });

  describe('W09 failover (#7607)', () => {
    const SESSION_ID = '11111111-1111-4111-8111-111111111111';
    const HOP0_RESERVATION = '77777777-7777-4777-8777-777777777777';
    const HOP1_RESERVATION = '88888888-8888-4888-8888-888888888888';
    const reserved = (reservationId: string, reservedCostCents: number) => ({
      kind: 'reserved', reservationId, reservedCostCents,
      dailyPeriodKey: '2026-09-06', monthlyPeriodKey: '2026-09-01', status: 'active',
    });
    const overloaded = () => Object.assign(new Error('Overloaded'), {
      status: 529, error: { type: 'error', error: { type: 'overloaded_error' } },
    });
    // What draftTicketFromTranscript throws when createMessage rejects.
    const providerFailure = (attempts: unknown[]) => Object.assign(
      new TicketDraftFailedError('Ticket draft provider outcome is unknown', attempts as never, true), { cause: overloaded() },
    );
    const primary = () => makeResolvedModel('platform', {
      surface: 'chat', transport: 'messages_api', offering: { id: 'p', displayName: 'P' }, failoverRemaining: ['k'],
    });
    const backup = () => makeResolvedModel('anthropic_byok', {
      surface: 'chat', transport: 'messages_api', offering: { id: 'k', displayName: 'K' }, wireModel: 'claude-haiku-4-5',
      failover: { fromOfferingId: 'p', hop: 1, cause: 'overloaded' }, failoverRemaining: [],
    });
    const draftOutcome = (wireModel: string) => ({
      subject: 's', problemSummary: 'p', resolutionSummary: '', wasFixed: false, suggestedTimeMinutes: 3,
      attempts: [{ wireModel, message: msgFixture }],
    });
    const settledRows = () => routeMocks.settleInvocationMock.mock.calls.map((c) => {
      const arg = c[0] as { binding: { offeringId: string }; usage: unknown[]; reservationId: string };
      return [arg.binding.offeringId, arg.reservationId, arg.usage.length];
    });
    let warnSpy: { mockRestore: () => void };

    beforeEach(() => {
      // clearAllMocks keeps queued *Once values: reset what these cases script.
      routeMocks.resolveSessionTurnMock.mockReset();
      routeMocks.reserveAiBudget.mockReset();
      vi.mocked(draftTicketFromTranscript).mockReset();
      routeMocks.resolveSessionTurnMock.mockResolvedValueOnce(primary()).mockResolvedValueOnce(backup());
      routeMocks.reserveAiBudget
        .mockResolvedValueOnce(reserved(HOP0_RESERVATION, 80))
        .mockResolvedValueOnce(reserved(HOP1_RESERVATION, 20));
      vi.mocked(getSessionMessages).mockResolvedValueOnce({
        session: { id: SESSION_ID, orgId: 'org1', deviceId: null, model: null, createdAt: new Date(), contextSnapshot: null },
        messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'fixed' }],
      } as any);
      warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => warnSpy.mockRestore());

    it('a 529 before any attempt fails over within the session; each sessionless hop is reserved and settled on its own', async () => {
      vi.mocked(draftTicketFromTranscript)
        .mockRejectedValueOnce(providerFailure([]))
        .mockResolvedValueOnce(draftOutcome('claude-haiku-4-5'));

      const res = await postDraft(SESSION_ID, partnerAuth);

      expect(res.status).toBe(200);
      expect(routeMocks.resolveSessionTurnMock).toHaveBeenLastCalledWith(expect.objectContaining({
        sessionId: SESSION_ID, surface: 'chat', userId: 'user-1', maxTokens: 1024, transport: 'messages_api',
        excludeOfferingIds: ['p'], failoverCause: 'overloaded',
        failoverOrigin: expect.objectContaining({ offeringId: 'p' }),
      }));
      expect(routeMocks.checkBudgetDetailedMock).toHaveBeenLastCalledWith('org1', 'partner_key');
      const keys = routeMocks.reserveAiBudget.mock.calls.map((c) => (c[0] as { idempotencyKey: string }).idempotencyKey);
      expect(keys).toHaveLength(2);
      expect(keys[0]).toMatch(new RegExp(`^ticket-draft:${SESSION_ID}:`));
      expect(keys[1]).toBe(`${keys[0]}:hop:1`);
      // Codex review 2: every ticket-draft reservation is sessionless, so its sessionless settlement succeeds.
      expect(routeMocks.reserveAiBudget.mock.calls.every((c) => (c[0] as { sessionId?: string }).sessionId === undefined)).toBe(true);
      expect(settledRows()).toEqual([['p', HOP0_RESERVATION, 0], ['k', HOP1_RESERVATION, 1]]);
      expect(routeMocks.settleInvocationMock.mock.calls.every(([arg]) =>
        (arg as { sourceRef: string }).sourceRef === 'ticket_draft' && (arg as { sessionId: unknown }).sessionId === null,
      )).toBe(true);
      // The backup drafts within ITS OWN reservation, on its own client.
      const calls = vi.mocked(draftTicketFromTranscript).mock.calls.map((c) => c[0] as { budgetCents?: number; resolved: { offering: { id: string | null } } });
      expect(calls.map((c) => [c.resolved.offering.id, c.budgetCents])).toEqual([['p', 80], ['k', 20]]);
      expect(routeMocks.anthropicClientForMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ offering: { id: 'k', displayName: 'K' } }), { surface: 'one_shot_ticket_draft', orgId: 'org1' },
      );
      expect(routeMocks.markAiBudgetReservationIndeterminate).not.toHaveBeenCalled();
      expect(routeMocks.releaseUnusedAiBudgetReservation).not.toHaveBeenCalled();
    });

    it('attempt 2 failing after attempt 1 returned a message never fails over (burned tokens bill on hop 0)', async () => {
      vi.mocked(draftTicketFromTranscript).mockRejectedValueOnce(providerFailure([{ wireModel: 'claude-sonnet-5-5', message: msgFixture }]));

      const res = await postDraft(SESSION_ID, partnerAuth);

      expect(res.status).toBe(502);
      expect(routeMocks.resolveSessionTurnMock).toHaveBeenCalledTimes(1);
      expect(routeMocks.reserveAiBudget).toHaveBeenCalledTimes(1);
      expect(settledRows()).toEqual([['p', HOP0_RESERVATION, 1]]);
    });

    it('with no fallback list configured, a 529 keeps the W03 single-reservation behaviour', async () => {
      routeMocks.resolveSessionTurnMock.mockReset();
      routeMocks.resolveSessionTurnMock.mockResolvedValue(makeResolvedModel('platform', { offering: { id: 'p', displayName: 'P' } }));
      vi.mocked(draftTicketFromTranscript).mockRejectedValueOnce(providerFailure([]));

      const res = await postDraft(SESSION_ID, partnerAuth);

      expect(res.status).toBe(502);
      expect(routeMocks.resolveSessionTurnMock).toHaveBeenCalledTimes(1);
      expect(routeMocks.reserveAiBudget).toHaveBeenCalledTimes(1);
      expect(routeMocks.settleInvocationMock).not.toHaveBeenCalled();
      expect(routeMocks.markAiBudgetReservationIndeterminate).toHaveBeenCalledWith({ orgId: 'org1', reservationId: HOP0_RESERVATION });
    });

    it('the backup is refused by its own credits check: 402 with that message, hop 0 settled, nothing reserved for the backup', async () => {
      routeMocks.checkBudgetDetailedMock
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ message: 'You are out of AI credits.', reason: 'credits_exhausted', permanent: false });
      vi.mocked(draftTicketFromTranscript).mockRejectedValueOnce(providerFailure([]));

      const res = await postDraft(SESSION_ID, partnerAuth);

      expect(res.status).toBe(402);
      expect(await res.json()).toEqual({ error: 'You are out of AI credits.' });
      expect(routeMocks.reserveAiBudget).toHaveBeenCalledTimes(1);
      expect(settledRows()).toEqual([['p', HOP0_RESERVATION, 0]]);
    });

    it('no usable backup answers 503 ai_unavailable with hop 0 already settled and nothing held', async () => {
      routeMocks.resolveSessionTurnMock.mockReset();
      routeMocks.resolveSessionTurnMock
        .mockResolvedValueOnce(primary())
        .mockResolvedValueOnce({ ok: false, reason: 'model_unavailable', recoverable: true, offeringId: null, message: 'none' });
      vi.mocked(draftTicketFromTranscript).mockRejectedValueOnce(providerFailure([]));
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const res = await postDraft(SESSION_ID, partnerAuth);
      errSpy.mockRestore();

      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'ai_unavailable' });
      expect(routeMocks.reserveAiBudget).toHaveBeenCalledTimes(1);
      expect(settledRows()).toEqual([['p', HOP0_RESERVATION, 0]]);
      expect(routeMocks.markAiBudgetReservationIndeterminate).not.toHaveBeenCalled();
      expect(routeMocks.releaseUnusedAiBudgetReservation).not.toHaveBeenCalled();
    });
  });
});

describe('isOpenAICompatibleProvider', () => {
  it.each([
    ['openai-compatible', true],
    ['anthropic', false],
  ] as const)('returns %s only for the openai-compatible config', (provider, expected) => {
    configRef.provider = provider;
    expect(isOpenAICompatibleProvider()).toBe(expected);
  });
});

describe('POST /ai/sessions/:id/ticket', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    authHarness.currentAuth.value = partnerAuth;
    app = new Hono();
    app.route('/ai', aiRoutes);

    getSessionMock.mockResolvedValue({ id: 's1', orgId: 'org1', deviceId: 'dev1', model: null });
    createTicketMock.mockResolvedValue({ id: 't1', ticketNumber: 'ORG-1', orgId: 'org1', status: 'new' });
    deviceInSiteScopeMock.mockResolvedValue(true);
    changeStatusMock.mockResolvedValue({ id: 't1', status: 'resolved' });
    createTimeEntryMock.mockResolvedValue({ id: 'te1' });
  });

  const body = { subject: 'S', description: 'P', status: 'open' as const, timeMinutes: 15, billable: true };

  function postTicket(sessionId: string, auth: any = partnerAuth, payload: unknown = body) {
    authHarness.currentAuth.value = auth;
    return app.request(`/ai/sessions/${sessionId}/ticket`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }

  it('creates a ticket with source ai and logs time for a partner-scope caller', async () => {
    const res = await postTicket('s1', partnerAuth, body);
    expect(res.status).toBe(201);
    expect(createTicketMock).toHaveBeenCalledWith(expect.objectContaining({ source: 'ai', orgId: 'org1', deviceId: 'dev1' }), expect.any(Object));
    expect(createTimeEntryMock).toHaveBeenCalledTimes(1);
    const json = await res.json();
    expect(json).toMatchObject({ resolved: false, timeLogged: true });
  });

  it('omits the billing override when the client leaves it to the card', async () => {
    const { billable: _billable, ...payload } = body;
    const res = await postTicket('s1', partnerAuth, payload);
    expect(res.status).toBe(201);
    expect(createTimeEntryMock).toHaveBeenCalledTimes(1);
    expect(createTimeEntryMock.mock.calls[0]![0]).not.toHaveProperty('isBillable');
  });

  it('returns a billing-gate timeLogError while retaining the created ticket', async () => {
    createTimeEntryMock.mockRejectedValueOnce(new TimeEntryServiceError(
      'Changing billing terms requires manage billing permission', 403, 'MANAGE_BILLING_REQUIRED',
    ));
    const res = await postTicket('s1');
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      data: { id: 't1' }, timeLogged: false,
      timeLogError: 'Changing billing terms requires manage billing permission',
    });
  });

  it('does not log a time entry when timeMinutes is zero', async () => {
    const res = await postTicket('s1', partnerAuth, { ...body, timeMinutes: 0 });

    expect(res.status).toBe(201);
    expect(createTimeEntryMock).not.toHaveBeenCalled();
    expect(await res.json()).toMatchObject({ timeLogged: false });
  });

  it('resolves the ticket and sets the resolution note', async () => {
    const res = await postTicket('s1', partnerAuth, { ...body, status: 'resolved', resolutionNote: 'Fixed it.' });
    expect(res.status).toBe(201);
    expect(changeStatusMock).toHaveBeenCalledWith('t1', { status: 'resolved' }, { resolutionNote: 'Fixed it.' }, expect.any(Object));
    expect((await res.json()).resolved).toBe(true);
  });

  it('keeps the ticket when resolving fails', async () => {
    changeStatusMock.mockRejectedValueOnce(new Error('transition failed'));

    const res = await postTicket('s1', partnerAuth, { ...body, status: 'resolved', resolutionNote: 'Fixed it.' });

    expect(res.status).toBe(201);
    expect(changeStatusMock).toHaveBeenCalledWith('t1', { status: 'resolved' }, { resolutionNote: 'Fixed it.' }, expect.any(Object));
    expect(await res.json()).toMatchObject({
      data: { id: 't1', ticketNumber: 'ORG-1' },
      resolved: false,
    });
  });

  it('keeps the ticket when time entry logging fails', async () => {
    createTimeEntryMock.mockRejectedValueOnce(new Error('rls'));

    const res = await postTicket('s1', partnerAuth, body);

    expect(res.status).toBe(201);
    expect(createTimeEntryMock).toHaveBeenCalledTimes(1);
    expect(await res.json()).toMatchObject({
      data: { id: 't1', ticketNumber: 'ORG-1' },
      timeLogged: false,
      timeLogError: 'The time entry could not be logged. Please log it on the ticket.',
    });
  });

  it('does not log time for an org-scope caller', async () => {
    const res = await postTicket('s1', orgAuth, body);
    expect(res.status).toBe(201);
    expect(createTimeEntryMock).not.toHaveBeenCalled();
    expect((await res.json()).timeLogged).toBe(false);
  });

  it('logs time for a system-scope caller', async () => {
    const systemAuth = {
      ...partnerAuth,
      scope: 'system' as const,
      partnerId: null,
      orgId: null,
    };

    const res = await postTicket('s1', systemAuth, body);

    expect(res.status).toBe(201);
    expect(createTimeEntryMock).toHaveBeenCalledTimes(1);
    expect(await res.json()).toMatchObject({ timeLogged: true });
  });

  it('drops deviceId when the caller fails site scope', async () => {
    deviceInSiteScopeMock.mockResolvedValue(false);
    await postTicket('s1', partnerAuth, body);
    expect(createTicketMock).toHaveBeenCalledWith(expect.objectContaining({ deviceId: undefined }), expect.any(Object));
  });

  it('404 when the session is unreachable', async () => {
    getSessionMock.mockResolvedValue(null);
    expect((await postTicket('sX', partnerAuth, body)).status).toBe(404);
  });

  it('400 when resolving without a note (schema)', async () => {
    expect((await postTicket('s1', partnerAuth, { ...body, status: 'resolved' })).status).toBe(400);
  });

  it('maps TicketServiceError status codes', async () => {
    createTicketMock.mockRejectedValueOnce(new TicketServiceError('nope', 409));

    const res = await postTicket('s1', partnerAuth, body);

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'nope' });
  });
});
