import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

// #6396: own-session chat routes are gated on the dedicated ai_sessions:use
// capability — NOT organizations:write, which no seeded org-scope role holds
// (so org users could never open chat). This suite uses an ENFORCING
// requirePermission mock so the gate is actually exercised end-to-end.

type Perm = { resource: string; action: string };
let currentAuth: any;

vi.mock('../db', () => ({
  getCurrentDbAccessContext: vi.fn(() => undefined),
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn() },
}));

vi.mock('../db/schema', () => ({
  aiSessions: {},
  aiMessages: {},
  aiToolExecutions: {},
  auditLogs: {},
  aiActionPlans: {},
  organizations: {},
  devices: {},
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', currentAuth);
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn((resource: string, action: string) => async (c: any, next: any) => {
    const perms: Perm[] = c.get('auth')?.permissions ?? [];
    const ok = perms.some(
      (p) => (p.resource === resource || p.resource === '*') && (p.action === action || p.action === '*'),
    );
    if (!ok) return c.json({ error: 'Forbidden' }, 403);
    return next();
  }),
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
  resolveDefaultModel: vi.fn(() => 'model'),
}));

vi.mock('../services/aiCostTracker', () => ({
  getSessionHistory: vi.fn().mockResolvedValue([]),
  getUsageSummary: vi.fn(),
  updateBudget: vi.fn(),
  recordUsage: vi.fn(),
}));

vi.mock('../services/streamingSessionManager', () => ({
  streamingSessionManager: { get: vi.fn(), remove: vi.fn(), interrupt: vi.fn() },
}));

vi.mock('../services/aiAgentSdk', () => ({
  runPreFlightChecks: vi.fn(),
  settleBlockedTurnForNewMessage: vi.fn(() => Promise.resolve('not_blocked_on_approvals')),
  abortActivePlan: vi.fn(),
}));

vi.mock('../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));
// PUT /budget fire-and-forgets evaluateAiBudgetThresholds after the gate; an
// unmocked call rejects against the partial db mock and fails the run as an
// unhandled error even though every assertion passes.
vi.mock('../services/aiBudgetAlerts', () => ({ evaluateAiBudgetThresholds: vi.fn(async () => undefined) }));
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../services/effectiveSettings', () => ({ assertNotLocked: vi.fn() }));

import { aiRoutes } from './ai';
import { createSession, listSessions, getSession } from '../services/aiAgent';
import { updateBudget } from '../services/aiCostTracker';

const ORG_ID = 'org-111';

function authWith(permissions: Perm[]) {
  return {
    user: { id: 'user-1', email: 'test@example.com', name: 'Test User' },
    scope: 'organization',
    partnerId: null,
    orgId: ORG_ID,
    accessibleOrgIds: [ORG_ID],
    permissions,
    orgCondition: () => undefined,
    canAccessOrg: (id: string) => id === ORG_ID,
  };
}

const ORGS_WRITE: Perm = { resource: 'organizations', action: 'write' };
const AI_SESSIONS_USE: Perm = { resource: 'ai_sessions', action: 'use' };

describe('own-session chat routes are gated on ai_sessions:use (#6396)', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(createSession).mockResolvedValue({ id: 'sess-1', orgId: ORG_ID } as never);
    vi.mocked(updateBudget).mockResolvedValue(undefined as never);
    vi.mocked(listSessions).mockResolvedValue({ data: [], total: 0 } as never);
    vi.mocked(getSession).mockResolvedValue({ id: 'sess-1', orgId: ORG_ID, userId: 'user-1' } as never);
    app = new Hono();
    app.route('/ai', aiRoutes);
  });

  const post = (path: string, body: unknown) =>
    app.request(`/ai${path}`, {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('POST /sessions denies a caller holding only organizations:write (the old gate)', async () => {
    currentAuth = authWith([ORGS_WRITE]);
    const res = await post('/sessions', {});
    expect(res.status).toBe(403);
    expect(createSession).not.toHaveBeenCalled();
  });

  it('POST /sessions allows a caller holding ai_sessions:use', async () => {
    currentAuth = authWith([AI_SESSIONS_USE]);
    const res = await post('/sessions', {});
    expect(res.status).toBe(201);
    expect(createSession).toHaveBeenCalled();
  });

  it('POST /sessions allows a wildcard (*:*) admin such as Partner Admin', async () => {
    currentAuth = authWith([{ resource: '*', action: '*' }]);
    const res = await post('/sessions', {});
    expect(res.status).toBe(201);
  });

  it('POST /sessions/:id/messages denies organizations:write alone', async () => {
    currentAuth = authWith([ORGS_WRITE]);
    const res = await post('/sessions/sess-1/messages', { content: 'hi' });
    expect(res.status).toBe(403);
  });

  it('PUT /budget stays an org-config action: ai_sessions:use alone is denied, organizations:write passes the gate', async () => {
    const put = (auth: ReturnType<typeof authWith>) => {
      currentAuth = auth;
      return app.request('/ai/budget', {
        method: 'PUT',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true }),
      });
    };
    expect((await put(authWith([AI_SESSIONS_USE]))).status).toBe(403);
    expect((await put(authWith([ORGS_WRITE]))).status).not.toBe(403);
  });

  it('GET /sessions (own list) denies organizations:read alone — seeded org roles hold neither organizations:read nor :write', async () => {
    currentAuth = authWith([{ resource: 'organizations', action: 'read' }]);
    const res = await app.request(`/ai/sessions?orgId=${ORG_ID}`, { headers: { Authorization: 'Bearer t' } });
    expect(res.status).toBe(403);
    expect(listSessions).not.toHaveBeenCalled();
  });

  it('GET /sessions (own list) allows ai_sessions:use', async () => {
    currentAuth = authWith([AI_SESSIONS_USE]);
    const res = await app.request(`/ai/sessions?orgId=${ORG_ID}`, { headers: { Authorization: 'Bearer t' } });
    expect(res.status).toBe(200);
    expect(listSessions).toHaveBeenCalled();
  });

  it('POST /sessions/:id/flag is cross-owner moderation and stays on organizations:write', async () => {
    currentAuth = authWith([AI_SESSIONS_USE]);
    expect((await post('/sessions/sess-1/flag', {})).status).toBe(403);
    currentAuth = authWith([ORGS_WRITE]);
    expect((await post('/sessions/sess-1/flag', {})).status).not.toBe(403);
  });

  // Every route that moved onto the alias, so a future edit that re-types
  // requireAiWrite on one of them is caught individually.
  const REGATED: Array<[string, string, unknown]> = [
    ['GET', '/sessions', undefined],
    ['GET', '/sessions/search?q=x', undefined],
    ['GET', '/sessions/sess-1', undefined],
    ['GET', '/m365-connections', undefined],
    ['GET', '/usage', undefined],
    ['POST', '/sessions', {}],
    ['PATCH', '/sessions/sess-1', { title: 't' }],
    ['DELETE', '/sessions/sess-1', undefined],
    ['POST', '/sessions/sess-1/messages', { content: 'hi' }],
    ['POST', '/sessions/sess-1/interrupt', {}],
    ['POST', '/sessions/sess-1/approve/exec-1', { approved: true }],
    ['POST', '/sessions/sess-1/pause', {}],
    ['POST', '/sessions/sess-1/approve-plan', {}],
    ['POST', '/sessions/sess-1/abort-plan', {}],
  ];
  const call = (method: string, path: string, body: unknown) =>
    app.request(`/ai${path}${path.includes('?') ? '&' : '?'}orgId=${ORG_ID}`, {
      method,
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  it.each(REGATED)('%s %s denies organizations:read+write alone and lets ai_sessions:use past the gate', async (method, path, body) => {
    currentAuth = authWith([ORGS_WRITE, { resource: 'organizations', action: 'read' }]);
    expect((await call(method, path, body)).status).toBe(403);
    currentAuth = authWith([AI_SESSIONS_USE]);
    // Past the permission gate the handler may still 400/404/500 on the
    // minimal mocks; the gate itself is what this asserts.
    expect((await call(method, path, body)).status).not.toBe(403);
  });
});
