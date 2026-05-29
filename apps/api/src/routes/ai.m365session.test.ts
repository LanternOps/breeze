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
    userId: 'aiSessions.userId',
    delegantM365ConnectionId: 'aiSessions.delegantM365ConnectionId',
  },
  aiMessages: {
    id: 'aiMessages.id',
    sessionId: 'aiMessages.sessionId',
  },
  aiToolExecutions: {
    id: 'aiToolExecutions.id',
    sessionId: 'aiToolExecutions.sessionId',
  },
  auditLogs: {
    id: 'auditLogs.id',
    orgId: 'auditLogs.orgId',
  },
  aiActionPlans: {
    id: 'aiActionPlans.id',
  },
  delegantM365Connections: {
    id: 'delegantM365Connections.id',
    orgId: 'delegantM365Connections.orgId',
    customerLabel: 'delegantM365Connections.customerLabel',
    customerDisplayName: 'delegantM365Connections.customerDisplayName',
    status: 'delegantM365Connections.status',
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
  searchSessions: vi.fn(),
  listM365Connections: vi.fn(),
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
import { createSession, listM365Connections } from '../services/aiAgent';

const SESSION_ID = '11111111-1111-1111-1111-111111111111';
const CONNECTION_ID = '33333333-3333-3333-3333-333333333333';

describe('AI M365 session binding', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/ai', aiRoutes);
  });

  // ============================================
  // POST /sessions with delegantM365ConnectionId
  // ============================================
  describe('POST /ai/sessions with M365 connection', () => {
    it('creates a session bound to a same-org connection', async () => {
      vi.mocked(createSession).mockResolvedValueOnce({
        id: SESSION_ID,
        orgId: 'org-111',
        delegantM365ConnectionId: CONNECTION_ID,
      } as any);

      const res = await app.request('/ai/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ delegantM365ConnectionId: CONNECTION_ID }),
      });

      expect(res.status).toBe(201);
      // service was called with the connection id in the body
      expect(vi.mocked(createSession)).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ delegantM365ConnectionId: CONNECTION_ID })
      );
    });

    it('rejects a session bound to a cross-org / unknown connection with 400', async () => {
      vi.mocked(createSession).mockRejectedValueOnce(new Error('Invalid M365 connection'));

      const res = await app.request('/ai/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ delegantM365ConnectionId: CONNECTION_ID }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('Invalid M365 connection');
    });

    it('creates a session with NO connection (back-compat)', async () => {
      vi.mocked(createSession).mockResolvedValueOnce({
        id: SESSION_ID,
        orgId: 'org-111',
      } as any);

      const res = await app.request('/ai/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(201);
      const callArg = vi.mocked(createSession).mock.calls[0]![1] as any;
      expect(callArg.delegantM365ConnectionId).toBeUndefined();
    });

    it('rejects a non-uuid connection id at the schema boundary with 400', async () => {
      const res = await app.request('/ai/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ delegantM365ConnectionId: 'not-a-uuid' }),
      });

      expect(res.status).toBe(400);
      expect(vi.mocked(createSession)).not.toHaveBeenCalled();
    });
  });

  // ============================================
  // GET /m365-connections
  // ============================================
  describe('GET /ai/m365-connections', () => {
    it('returns only the three safe fields for active connections', async () => {
      vi.mocked(listM365Connections).mockResolvedValueOnce([
        { id: CONNECTION_ID, customerLabel: 'acme', customerDisplayName: 'Acme Corp' },
      ]);

      const res = await app.request('/ai/m365-connections', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toEqual([
        { id: CONNECTION_ID, customerLabel: 'acme', customerDisplayName: 'Acme Corp' },
      ]);
      // never leak the delegant pointer fields
      const json = JSON.stringify(body);
      expect(json).not.toContain('delegantOrgId');
      expect(json).not.toContain('delegantConnectionId');
      expect(json).not.toContain('m365TenantId');
    });
  });
});
