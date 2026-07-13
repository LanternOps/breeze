import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

// SR5-09(b): GET /admin/sessions enumerates OTHER users' AI sessions and must be
// gated on the dedicated ai_sessions:read_all capability — NOT organizations:read
// (which every technician/viewer holds). This suite uses an ENFORCING
// requirePermission mock so the gate is actually exercised end-to-end.

type Perm = { resource: string; action: string };
let currentAuth: any;

vi.mock('../db', () => ({
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
  abortActivePlan: vi.fn(),
}));

vi.mock('../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../services/effectiveSettings', () => ({ assertNotLocked: vi.fn() }));

import { aiRoutes } from './ai';
import { getSessionHistory } from '../services/aiCostTracker';

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

describe('GET /ai/admin/sessions permission gate (SR5-09)', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getSessionHistory).mockResolvedValue([]);
    app = new Hono();
    app.route('/ai', aiRoutes);
  });

  it('denies a caller holding only organizations:read (the old, too-broad gate)', async () => {
    currentAuth = authWith([{ resource: 'organizations', action: 'read' }]);

    const res = await app.request(`/ai/admin/sessions?orgId=${ORG_ID}`, {
      headers: { Authorization: 'Bearer t' },
    });

    expect(res.status).toBe(403);
    expect(getSessionHistory).not.toHaveBeenCalled();
  });

  it('allows a caller holding ai_sessions:read_all', async () => {
    currentAuth = authWith([{ resource: 'ai_sessions', action: 'read_all' }]);

    const res = await app.request(`/ai/admin/sessions?orgId=${ORG_ID}`, {
      headers: { Authorization: 'Bearer t' },
    });

    expect(res.status).toBe(200);
    expect(getSessionHistory).toHaveBeenCalled();
  });

  it('allows a wildcard (*:*) admin such as Partner Admin', async () => {
    currentAuth = authWith([{ resource: '*', action: '*' }]);

    const res = await app.request(`/ai/admin/sessions?orgId=${ORG_ID}`, {
      headers: { Authorization: 'Bearer t' },
    });

    expect(res.status).toBe(200);
  });
});
