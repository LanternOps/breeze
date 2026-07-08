import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

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
  recordUsage: vi.fn(),
}));

vi.mock('../services/aiTicketDraft', () => ({
  draftTicketFromTranscript: vi.fn(),
  ThinTranscriptError: class ThinTranscriptError extends Error {
    constructor() {
      super('Not enough conversation to draft a ticket');
      this.name = 'ThinTranscriptError';
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

vi.mock('../services/timeEntryService', () => ({
  createTimeEntry: routeMocks.createTimeEntryMock,
}));

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

import { aiRoutes } from './ai';
import { db } from '../db';
import { getSessionMessages } from '../services/aiAgent';
import { recordUsage } from '../services/aiCostTracker';
import { draftTicketFromTranscript, ThinTranscriptError } from '../services/aiTicketDraft';

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

describe('POST /ai/sessions/:id/ticket-draft', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    authHarness.currentAuth.value = partnerAuth;
    app = new Hono();
    app.route('/ai', aiRoutes);

    vi.mocked(db.select).mockReturnValue(selectRows([{ name: 'Acme Co' }]) as any);
  });

  function postDraft(sessionId: string, auth = partnerAuth) {
    authHarness.currentAuth.value = auth;
    return app.request(`/ai/sessions/${sessionId}/ticket-draft`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token' },
    });
  }

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
      inputTokens: 10,
      outputTokens: 5,
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
        model: 'claude-test',
      })
    );
    expect(recordUsage).toHaveBeenCalledWith('s1', 'org1', 'claude-test', 10, 5, false);
  });

  it('404 when the session is not reachable', async () => {
    vi.mocked(getSessionMessages).mockResolvedValueOnce(null);

    const res = await postDraft('sX', partnerAuth);

    expect(res.status).toBe(404);
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

  function postTicket(sessionId: string, auth: typeof partnerAuth | typeof orgAuth = partnerAuth, payload: unknown = body) {
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

  it('resolves the ticket and sets the resolution note', async () => {
    const res = await postTicket('s1', partnerAuth, { ...body, status: 'resolved', resolutionNote: 'Fixed it.' });
    expect(res.status).toBe(201);
    expect(changeStatusMock).toHaveBeenCalledWith('t1', { status: 'resolved' }, { resolutionNote: 'Fixed it.' }, expect.any(Object));
    expect((await res.json()).resolved).toBe(true);
  });

  it('does not log time for an org-scope caller', async () => {
    const res = await postTicket('s1', orgAuth, body);
    expect(res.status).toBe(201);
    expect(createTimeEntryMock).not.toHaveBeenCalled();
    expect((await res.json()).timeLogged).toBe(false);
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
});
