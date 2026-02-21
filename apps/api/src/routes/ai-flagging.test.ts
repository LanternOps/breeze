import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../db', () => ({
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
      orgId: '11111111-1111-1111-1111-111111111111',
      accessibleOrgIds: ['11111111-1111-1111-1111-111111111111'],
      orgCondition: () => undefined,
      canAccessOrg: () => true,
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

import { aiRoutes } from './ai';
import { db } from '../db';
import { getSession } from '../services/aiAgent';

const SESSION_ID = '11111111-1111-1111-1111-111111111111';

describe('AI flagging routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/ai', aiRoutes);
  });

  // ============================================
  // POST /sessions/:id/flag
  // ============================================

  it('POST /flag — flags a session with a reason', async () => {
    vi.mocked(getSession).mockResolvedValueOnce({
      id: SESSION_ID,
      orgId: '11111111-1111-1111-1111-111111111111',
    } as any);

    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    } as any);

    const res = await app.request(`/ai/sessions/${SESSION_ID}/flag`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({ reason: 'Inappropriate response' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);

    expect(getSession).toHaveBeenCalledWith(SESSION_ID, expect.any(Object));
    expect(db.update).toHaveBeenCalled();
  });

  it('POST /flag — flags a session without a reason', async () => {
    vi.mocked(getSession).mockResolvedValueOnce({
      id: SESSION_ID,
      orgId: '11111111-1111-1111-1111-111111111111',
    } as any);

    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    } as any);

    const res = await app.request(`/ai/sessions/${SESSION_ID}/flag`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  it('POST /flag — returns 404 for nonexistent session', async () => {
    vi.mocked(getSession).mockResolvedValueOnce(null);

    const res = await app.request(`/ai/sessions/${SESSION_ID}/flag`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({ reason: 'test' }),
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('Session not found');
  });

  // ============================================
  // DELETE /sessions/:id/flag
  // ============================================

  it('DELETE /flag — clears the flag', async () => {
    vi.mocked(getSession).mockResolvedValueOnce({
      id: SESSION_ID,
      orgId: '11111111-1111-1111-1111-111111111111',
    } as any);

    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    } as any);

    const res = await app.request(`/ai/sessions/${SESSION_ID}/flag`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);

    expect(getSession).toHaveBeenCalledWith(SESSION_ID, expect.any(Object));
    expect(db.update).toHaveBeenCalled();
  });

  it('DELETE /flag — returns 404 for nonexistent session', async () => {
    vi.mocked(getSession).mockResolvedValueOnce(null);

    const res = await app.request(`/ai/sessions/${SESSION_ID}/flag`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('Session not found');
  });
});
