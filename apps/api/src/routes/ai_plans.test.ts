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

});
