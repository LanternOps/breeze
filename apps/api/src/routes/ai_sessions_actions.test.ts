import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

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
  isIntentBackedExecution: vi.fn(),
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
  isIntentBackedExecution,
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
      expect(handleApproval).toHaveBeenCalledWith(EXEC_ID, true, expect.any(Object), SESSION_ID);
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
      expect(handleApproval).toHaveBeenCalledWith(EXEC_ID, false, expect.any(Object), SESSION_ID);
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
      vi.mocked(isIntentBackedExecution).mockResolvedValueOnce(false);

      const res = await app.request(`/ai/sessions/${SESSION_ID}/approve/${EXEC_ID}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ approved: true }),
      });

      expect(res.status).toBe(404);
    });

    // CRITICAL-3 (whole-branch review): the web chat "Approve" button must
    // never report success for a Tier-3 intent-backed execution — handleApproval
    // refuses to flip it (four-eyes model), and the route must turn that
    // refusal into an honest "pending" response, not silently claim success
    // nor collapse it into the generic "not found" 404.
    it('never reports success for an intent-backed execution — returns an honest pending response', async () => {
      vi.mocked(getSession).mockResolvedValueOnce({ id: SESSION_ID, orgId: ORG_ID } as any);
      vi.mocked(handleApproval).mockResolvedValueOnce(false);
      vi.mocked(isIntentBackedExecution).mockResolvedValueOnce(true);

      const res = await app.request(`/ai/sessions/${SESSION_ID}/approve/${EXEC_ID}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ approved: true }),
      });

      const body = await res.json();
      expect(body.success).toBe(false);
      expect(body.pending).toBe(true);
      expect(body.via).toBe('intent');
      // Never the plain "success: true" shape the non-intent branch returns.
      expect(body.approved).toBeUndefined();
    });
  });

});
