import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
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
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-1', email: 'test@example.com', name: 'Test User' },
      scope: 'organization',
      partnerId: null,
      orgId: 'org-111',
      accessibleOrgIds: ['org-111'],
      orgCondition: () => undefined,
      canAccessOrg: (id: string) => id === 'org-111',
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
}));

vi.mock('../services/aiAgent', () => ({
  createSession: vi.fn(),
  getSession: vi.fn(),
  listSessions: vi.fn(),
  closeSession: vi.fn(),
  getSessionMessages: vi.fn(),
  handleApproval: vi.fn(),
  searchSessions: vi.fn(),
}));

vi.mock('../services/aiCostTracker', () => ({
  getSessionHistory: vi.fn(),
  getUsageSummary: vi.fn(),
  updateBudget: vi.fn(),
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

import { aiRoutes } from './ai';
import { db } from '../db';
import {
  createSession,
  getSession,
  listSessions,
  closeSession,
  getSessionMessages,
  handleApproval,
  searchSessions,
} from '../services/aiAgent';
import { getUsageSummary, updateBudget, getSessionHistory } from '../services/aiCostTracker';
import { streamingSessionManager } from '../services/streamingSessionManager';
import { runPreFlightChecks, abortActivePlan } from '../services/aiAgentSdk';

const ORG_ID = 'org-111';
const SESSION_ID = '11111111-1111-1111-1111-111111111111';

describe('AI routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/ai', aiRoutes);
  });

  // ============================================
  // POST /sessions
  // ============================================
  describe('POST /ai/sessions', () => {
    it('creates a new session and returns 201', async () => {
      const session = { id: SESSION_ID, orgId: ORG_ID, title: 'Test Chat' };
      vi.mocked(createSession).mockResolvedValueOnce(session as any);

      const res = await app.request('/ai/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ title: 'Test Chat' }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.id).toBe(SESSION_ID);
      expect(createSession).toHaveBeenCalledTimes(1);
    });

    it('returns 400 when organization context is required', async () => {
      vi.mocked(createSession).mockRejectedValueOnce(new Error('Organization context required'));

      const res = await app.request('/ai/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ title: 'Test' }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('Organization context required');
    });

    it('returns 403 when access denied to org', async () => {
      vi.mocked(createSession).mockRejectedValueOnce(new Error('Access denied to this organization'));

      const res = await app.request('/ai/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ title: 'Test' }),
      });

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toBe('Access denied to this organization');
    });

    it('returns 500 on unexpected creation error', async () => {
      vi.mocked(createSession).mockRejectedValueOnce(new Error('DB connection failed'));

      const res = await app.request('/ai/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ title: 'Test' }),
      });

      expect(res.status).toBe(500);
    });
  });

  // ============================================
  // GET /sessions
  // ============================================
  describe('GET /ai/sessions', () => {
    it('lists sessions with defaults', async () => {
      vi.mocked(listSessions).mockResolvedValueOnce([
        { id: SESSION_ID, title: 'Chat 1' },
      ] as any);

      const res = await app.request('/ai/sessions', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
      expect(listSessions).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({ page: 1, limit: 20 })
      );
    });

    it('passes pagination params', async () => {
      vi.mocked(listSessions).mockResolvedValueOnce([]);

      const res = await app.request('/ai/sessions?page=2&limit=5', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
      expect(listSessions).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({ page: 2, limit: 5 })
      );
    });
  });

  // ============================================
  // GET /sessions/search
  // ============================================
  describe('GET /ai/sessions/search', () => {
    it('searches sessions with valid query', async () => {
      vi.mocked(searchSessions).mockResolvedValueOnce([
        { id: SESSION_ID, title: 'Disk cleanup chat' },
      ] as any);

      const res = await app.request('/ai/sessions/search?q=disk', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
      expect(searchSessions).toHaveBeenCalledWith(
        expect.any(Object),
        'disk',
        expect.objectContaining({ limit: 20 })
      );
    });

    it('returns 400 when query is too short', async () => {
      const res = await app.request('/ai/sessions/search?q=d', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('at least 2 characters');
    });

    it('returns 400 when query is missing', async () => {
      const res = await app.request('/ai/sessions/search', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(400);
    });
  });

  // ============================================
  // GET /sessions/:id
  // ============================================
  describe('GET /ai/sessions/:id', () => {
    it('returns session with messages', async () => {
      vi.mocked(getSessionMessages).mockResolvedValueOnce({
        session: { id: SESSION_ID },
        messages: [{ role: 'user', content: 'hello' }],
      } as any);

      const res = await app.request(`/ai/sessions/${SESSION_ID}`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.session.id).toBe(SESSION_ID);
      expect(body.messages).toHaveLength(1);
    });

    it('returns 404 when session not found', async () => {
      vi.mocked(getSessionMessages).mockResolvedValueOnce(null);

      const res = await app.request(`/ai/sessions/${SESSION_ID}`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe('Session not found');
    });
  });

  // ============================================
  // DELETE /sessions/:id
  // ============================================
  describe('DELETE /ai/sessions/:id', () => {
    it('closes a session successfully', async () => {
      vi.mocked(closeSession).mockResolvedValueOnce({ id: SESSION_ID, orgId: ORG_ID } as any);

      const res = await app.request(`/ai/sessions/${SESSION_ID}`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(streamingSessionManager.remove).toHaveBeenCalledWith(SESSION_ID);
    });

    it('returns 404 when session not found', async () => {
      vi.mocked(closeSession).mockResolvedValueOnce(null as any);

      const res = await app.request(`/ai/sessions/${SESSION_ID}`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(404);
    });
  });

  // ============================================
  // PATCH /sessions/:id
  // ============================================
  describe('PATCH /ai/sessions/:id', () => {
    it('updates session title', async () => {
      vi.mocked(getSession).mockResolvedValueOnce({ id: SESSION_ID, orgId: ORG_ID } as any);
      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      } as any);

      const res = await app.request(`/ai/sessions/${SESSION_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ title: 'Renamed Chat' }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.title).toBe('Renamed Chat');
    });

    it('returns 404 when session not found', async () => {
      vi.mocked(getSession).mockResolvedValueOnce(null);

      const res = await app.request(`/ai/sessions/${SESSION_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ title: 'New Title' }),
      });

      expect(res.status).toBe(404);
    });

    it('rejects empty title', async () => {
      const res = await app.request(`/ai/sessions/${SESSION_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ title: '' }),
      });

      expect(res.status).toBe(400);
    });
  });

  // ============================================
  // POST /sessions/:id/interrupt
  // ============================================
  describe('POST /ai/sessions/:id/interrupt', () => {
    it('interrupts an active session', async () => {
      vi.mocked(getSession).mockResolvedValueOnce({ id: SESSION_ID, orgId: ORG_ID } as any);
      vi.mocked(streamingSessionManager.interrupt).mockResolvedValueOnce({
        interrupted: true,
      });

      const res = await app.request(`/ai/sessions/${SESSION_ID}/interrupt`, {
        method: 'POST',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.interrupted).toBe(true);
    });

    it('returns 409 when session is not processing', async () => {
      vi.mocked(getSession).mockResolvedValueOnce({ id: SESSION_ID, orgId: ORG_ID } as any);
      vi.mocked(streamingSessionManager.interrupt).mockResolvedValueOnce({
        interrupted: false,
        reason: 'Session is not processing',
      });

      const res = await app.request(`/ai/sessions/${SESSION_ID}/interrupt`, {
        method: 'POST',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.interrupted).toBe(false);
    });

    it('returns 404 when session not found', async () => {
      vi.mocked(getSession).mockResolvedValueOnce(null);

      const res = await app.request(`/ai/sessions/${SESSION_ID}/interrupt`, {
        method: 'POST',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(404);
    });
  });

  // ============================================
  // POST /sessions/:id/approve/:executionId
  // ============================================
  describe('POST /ai/sessions/:id/approve/:executionId', () => {
    const EXEC_ID = '22222222-2222-2222-2222-222222222222';

    it('approves a tool execution', async () => {
      vi.mocked(getSession).mockResolvedValueOnce({ id: SESSION_ID, orgId: ORG_ID } as any);
      vi.mocked(handleApproval).mockResolvedValueOnce(true);

      const res = await app.request(`/ai/sessions/${SESSION_ID}/approve/${EXEC_ID}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ approved: true }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.approved).toBe(true);
    });

    it('rejects a tool execution', async () => {
      vi.mocked(getSession).mockResolvedValueOnce({ id: SESSION_ID, orgId: ORG_ID } as any);
      vi.mocked(handleApproval).mockResolvedValueOnce(true);

      const res = await app.request(`/ai/sessions/${SESSION_ID}/approve/${EXEC_ID}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ approved: false }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.approved).toBe(false);
    });

    it('returns 404 when session not found', async () => {
      vi.mocked(getSession).mockResolvedValueOnce(null);

      const res = await app.request(`/ai/sessions/${SESSION_ID}/approve/${EXEC_ID}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ approved: true }),
      });

      expect(res.status).toBe(404);
    });

    it('returns 404 when execution not found', async () => {
      vi.mocked(getSession).mockResolvedValueOnce({ id: SESSION_ID, orgId: ORG_ID } as any);
      vi.mocked(handleApproval).mockResolvedValueOnce(false);

      const res = await app.request(`/ai/sessions/${SESSION_ID}/approve/${EXEC_ID}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ approved: true }),
      });

      expect(res.status).toBe(404);
    });
  });

  // ============================================
  // POST /sessions/:id/pause
  // ============================================
  describe('POST /ai/sessions/:id/pause', () => {
    it('pauses a session', async () => {
      vi.mocked(getSession).mockResolvedValueOnce({ id: SESSION_ID, orgId: ORG_ID } as any);
      const mockSession = {
        isPaused: false,
        activePlanId: null,
        approvalMode: 'auto_approve',
        eventBus: { publish: vi.fn() },
      };
      vi.mocked(streamingSessionManager.get).mockReturnValueOnce(mockSession as any);

      const res = await app.request(`/ai/sessions/${SESSION_ID}/pause`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ paused: true }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.paused).toBe(true);
      expect(body.effectiveMode).toBe('per_step');
    });

    it('unpauses a session', async () => {
      vi.mocked(getSession).mockResolvedValueOnce({ id: SESSION_ID, orgId: ORG_ID } as any);
      const mockSession = {
        isPaused: true,
        activePlanId: null,
        approvalMode: 'auto_approve',
        eventBus: { publish: vi.fn() },
      };
      vi.mocked(streamingSessionManager.get).mockReturnValueOnce(mockSession as any);

      const res = await app.request(`/ai/sessions/${SESSION_ID}/pause`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ paused: false }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.paused).toBe(false);
      expect(body.effectiveMode).toBe('auto_approve');
    });

    it('returns 404 when session not in memory', async () => {
      vi.mocked(getSession).mockResolvedValueOnce({ id: SESSION_ID, orgId: ORG_ID } as any);
      vi.mocked(streamingSessionManager.get).mockReturnValueOnce(undefined as any);

      const res = await app.request(`/ai/sessions/${SESSION_ID}/pause`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ paused: true }),
      });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toContain('not active');
    });
  });

  // ============================================
  // POST /sessions/:id/approve-plan
  // ============================================
  describe('POST /ai/sessions/:id/approve-plan', () => {
    it('approves a plan', async () => {
      vi.mocked(getSession).mockResolvedValueOnce({ id: SESSION_ID, orgId: ORG_ID } as any);
      const resolver = vi.fn();
      const mockSession = {
        activePlanId: 'plan-1',
        planApprovalResolver: resolver,
        eventBus: { publish: vi.fn() },
      };
      vi.mocked(streamingSessionManager.get).mockReturnValueOnce(mockSession as any);
      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      } as any);

      const res = await app.request(`/ai/sessions/${SESSION_ID}/approve-plan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ approved: true }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.approved).toBe(true);
      expect(resolver).toHaveBeenCalledWith(true);
    });

    it('returns 400 when no pending plan approval', async () => {
      vi.mocked(getSession).mockResolvedValueOnce({ id: SESSION_ID, orgId: ORG_ID } as any);
      const mockSession = {
        activePlanId: null,
        planApprovalResolver: null,
      };
      vi.mocked(streamingSessionManager.get).mockReturnValueOnce(mockSession as any);

      const res = await app.request(`/ai/sessions/${SESSION_ID}/approve-plan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ approved: true }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('No pending plan approval');
    });
  });

  // ============================================
  // POST /sessions/:id/abort-plan
  // ============================================
  describe('POST /ai/sessions/:id/abort-plan', () => {
    it('aborts an active plan', async () => {
      vi.mocked(getSession).mockResolvedValueOnce({ id: SESSION_ID, orgId: ORG_ID } as any);
      const mockSession = { activePlanId: 'plan-1' };
      vi.mocked(streamingSessionManager.get).mockReturnValueOnce(mockSession as any);
      vi.mocked(abortActivePlan).mockResolvedValueOnce(true);

      const res = await app.request(`/ai/sessions/${SESSION_ID}/abort-plan`, {
        method: 'POST',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
    });

    it('returns 400 when no active plan', async () => {
      vi.mocked(getSession).mockResolvedValueOnce({ id: SESSION_ID, orgId: ORG_ID } as any);
      const mockSession = { activePlanId: null };
      vi.mocked(streamingSessionManager.get).mockReturnValueOnce(mockSession as any);

      const res = await app.request(`/ai/sessions/${SESSION_ID}/abort-plan`, {
        method: 'POST',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('No active plan');
    });

    it('returns 404 when session not in memory', async () => {
      vi.mocked(getSession).mockResolvedValueOnce({ id: SESSION_ID, orgId: ORG_ID } as any);
      vi.mocked(streamingSessionManager.get).mockReturnValueOnce(undefined as any);

      const res = await app.request(`/ai/sessions/${SESSION_ID}/abort-plan`, {
        method: 'POST',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(404);
    });
  });

  // ============================================
  // GET /usage
  // ============================================
  describe('GET /ai/usage', () => {
    it('returns usage summary for org-scoped user', async () => {
      vi.mocked(getUsageSummary).mockResolvedValueOnce({
        daily: { inputTokens: 100, outputTokens: 200, totalCostCents: 50, messageCount: 5 },
        monthly: { inputTokens: 1000, outputTokens: 2000, totalCostCents: 500, messageCount: 50 },
        budget: null,
      } as any);

      const res = await app.request('/ai/usage', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.daily.inputTokens).toBe(100);
      expect(body.monthly.messageCount).toBe(50);
    });

    it('returns 403 when accessing other org', async () => {
      const res = await app.request('/ai/usage?orgId=other-org', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(403);
    });
  });

  // ============================================
  // PUT /budget
  // ============================================
  describe('PUT /ai/budget', () => {
    it('updates budget settings', async () => {
      vi.mocked(updateBudget).mockResolvedValueOnce(undefined);

      const res = await app.request('/ai/budget', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          enabled: true,
          monthlyBudgetCents: 10000,
          approvalMode: 'per_step',
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(updateBudget).toHaveBeenCalledWith(
        ORG_ID,
        expect.objectContaining({ enabled: true, monthlyBudgetCents: 10000 })
      );
    });

    it('rejects invalid approval mode', async () => {
      const res = await app.request('/ai/budget', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ approvalMode: 'invalid_mode' }),
      });

      expect(res.status).toBe(400);
    });

    it('returns 403 when accessing other org budget', async () => {
      const res = await app.request('/ai/budget?orgId=other-org', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ enabled: true }),
      });

      expect(res.status).toBe(403);
    });
  });

  // ============================================
  // GET /admin/sessions
  // ============================================
  describe('GET /ai/admin/sessions', () => {
    it('returns session history', async () => {
      vi.mocked(getSessionHistory).mockResolvedValueOnce([
        { id: SESSION_ID, title: 'Test Session' },
      ] as any);

      const res = await app.request(`/ai/admin/sessions?orgId=${ORG_ID}`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
    });

    it('returns empty data when no orgId for system user', async () => {
      // Override auth to system scope without orgId
      const { authMiddleware } = await import('../middleware/auth');
      vi.mocked(authMiddleware).mockImplementationOnce((c: any, next: any) => {
        c.set('auth', {
          user: { id: 'admin-1', email: 'admin@example.com' },
          scope: 'system',
          orgId: null,
          accessibleOrgIds: null,
          canAccessOrg: () => true,
        });
        return next();
      });

      const res = await app.request('/ai/admin/sessions', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toEqual([]);
    });

    it('passes flagged filter', async () => {
      vi.mocked(getSessionHistory).mockResolvedValueOnce([]);

      await app.request(`/ai/admin/sessions?orgId=${ORG_ID}&flagged=true`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(getSessionHistory).toHaveBeenCalledWith(
        ORG_ID,
        expect.objectContaining({ flagged: true })
      );
    });
  });

  // ============================================
  // GET /admin/security-events
  // ============================================
  describe('GET /ai/admin/security-events', () => {
    it('returns security events', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([
                {
                  id: 'event-1',
                  timestamp: new Date(),
                  action: 'ai.security.injection_detected',
                  actorType: 'user',
                  actorEmail: 'test@example.com',
                  resourceType: 'ai_session',
                  resourceId: SESSION_ID,
                  result: 'blocked',
                  errorMessage: null,
                  details: {},
                },
              ]),
            }),
          }),
        }),
      } as any);

      const res = await app.request(`/ai/admin/security-events?orgId=${ORG_ID}`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
      expect(body.data[0].action).toContain('ai.security');
    });

    it('returns 403 for unauthorized org access', async () => {
      const res = await app.request('/ai/admin/security-events?orgId=other-org', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(403);
    });
  });

  // ============================================
  // GET /admin/tool-executions
  // ============================================
  describe('GET /ai/admin/tool-executions', () => {
    it('returns empty analytics when no orgId', async () => {
      const { authMiddleware } = await import('../middleware/auth');
      vi.mocked(authMiddleware).mockImplementationOnce((c: any, next: any) => {
        c.set('auth', {
          user: { id: 'admin-1', email: 'admin@example.com' },
          scope: 'system',
          orgId: null,
          accessibleOrgIds: null,
          canAccessOrg: () => true,
        });
        return next();
      });

      const res = await app.request('/ai/admin/tool-executions', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.summary.total).toBe(0);
      expect(body.timeSeries).toEqual([]);
      expect(body.executions).toEqual([]);
    });

    it('returns 400 for invalid since date', async () => {
      const res = await app.request(`/ai/admin/tool-executions?orgId=${ORG_ID}&since=not-a-date`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("Invalid 'since' date");
    });

    it('returns 403 for unauthorized org access', async () => {
      const res = await app.request('/ai/admin/tool-executions?orgId=other-org', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(403);
    });
  });
});
