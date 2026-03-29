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

vi.mock('../services/effectiveSettings', () => ({
  assertNotLocked: vi.fn(),
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
