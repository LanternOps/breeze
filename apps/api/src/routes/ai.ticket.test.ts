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
  return { currentAuth: { value: partnerAuth }, partnerAuth };
});

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
}));

vi.mock('../services/aiAgent', () => ({
  createSession: vi.fn(),
  getSession: vi.fn(),
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
  writeRouteAudit: vi.fn(),
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
