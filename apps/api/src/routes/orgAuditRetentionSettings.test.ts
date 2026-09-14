import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const { authRef, dbSelectResult, serviceMocks, auditSpy } = vi.hoisted(() => ({
  authRef: {
    current: {
      scope: 'partner' as string,
      user: { id: 'u-1', name: 'Tess Tech', email: 'tess@msp.example', isPlatformAdmin: false },
      partnerId: 'p-1' as string | null,
      orgId: null as string | null,
      accessibleOrgIds: null as string[] | null,
      orgCondition: () => undefined,
      canAccessOrg: (_id: string) => true as boolean,
    },
  },
  dbSelectResult: vi.fn(),
  serviceMocks: {
    getOrgAuditRetentionPolicy: vi.fn(),
    upsertOrgAuditRetentionPolicy: vi.fn(),
  },
  auditSpy: vi.fn(),
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn(async (c: any, next: any) => {
    if (!authRef.current) {
      return c.json({ error: 'Not authenticated' }, 401);
    }
    c.set('auth', authRef.current);
    await next();
  }),
  // Mirrors the real requireScope (middleware/auth.ts): 401 unauthenticated,
  // 403 for an ai_agent principal, else 403 unless the caller's scope is in
  // the route's declared list. Keeping the scope check real is what lets
  // these tests prove which scopes the route admits.
  requireScope: (...scopes: string[]) => async (c: any, next: any) => {
    const auth = c.get('auth');
    if (!auth) {
      return c.json({ error: 'Not authenticated' }, 401);
    }
    if (auth.principal?.kind === 'ai_agent') {
      return c.json({ error: 'AI agents cannot call HTTP routes' }, 403);
    }
    if (!scopes.includes(auth.scope)) {
      return c.json({ error: 'Insufficient permissions' }, 403);
    }
    await next();
  },
  requirePermission: () => async (_c: any, next: any) => next(),
  requireMfa: () => async (_c: any, next: any) => next(),
}));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => dbSelectResult()),
        })),
      })),
    })),
  },
}));

vi.mock('../db/schema', () => ({
  organizations: { id: 'id', deletedAt: 'deletedAt' },
}));

vi.mock('../services/auditRetentionPolicyService', () => ({
  getOrgAuditRetentionPolicy: (...args: unknown[]) => serviceMocks.getOrgAuditRetentionPolicy(...args),
  upsertOrgAuditRetentionPolicy: (...args: unknown[]) => serviceMocks.upsertOrgAuditRetentionPolicy(...args),
}));

vi.mock('../services/auditEvents', () => ({
  writeRouteAudit: (...args: unknown[]) => auditSpy(...args),
}));

import { authMiddleware } from '../middleware/auth';
import { registerOrgAuditRetentionSettingsRoutes } from './orgAuditRetentionSettings';

const ORG_ID = '7c0a1f7e-1111-4222-8333-444455556666';
const OTHER_ORG_ID = '9d1b2e8f-5555-4666-8777-888899990000';

/** An organization-scope Org Admin whose token is bound to `orgId`. */
const orgScopedAuth = (orgId: string) => ({
  scope: 'organization' as string,
  orgId,
  partnerId: 'p-1' as string | null,
  accessibleOrgIds: [orgId] as string[] | null,
  canAccessOrg: (id: string) => id === orgId,
});

const DEFAULT_AUTH = {
  scope: 'partner' as string,
  user: { id: 'u-1', name: 'Tess Tech', email: 'tess@msp.example', isPlatformAdmin: false },
  partnerId: 'p-1' as string | null,
  orgId: null as string | null,
  accessibleOrgIds: null as string[] | null,
  orgCondition: () => undefined,
  canAccessOrg: (_id: string) => true as boolean,
};

function makeApp() {
  const app = new Hono();
  app.use('*', authMiddleware as any);
  registerOrgAuditRetentionSettingsRoutes(app);
  return app;
}

function resetAuth(overrides: Partial<typeof DEFAULT_AUTH> = {}) {
  authRef.current = { ...DEFAULT_AUTH, ...overrides } as typeof authRef.current;
}

describe('GET /organizations/:id/audit-retention', () => {
  beforeEach(() => { vi.clearAllMocks(); dbSelectResult.mockReset(); resetAuth(); });

  it('returns configured: false when no policy row exists yet', async () => {
    dbSelectResult.mockResolvedValueOnce([{ id: ORG_ID }]);
    serviceMocks.getOrgAuditRetentionPolicy.mockResolvedValue({
      orgId: ORG_ID, configured: false, retentionDays: 365, lastCleanupAt: null,
    });
    const res = await makeApp().request(`/organizations/${ORG_ID}/audit-retention`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({ orgId: ORG_ID, configured: false, retentionDays: 365, lastCleanupAt: null });
    expect(serviceMocks.getOrgAuditRetentionPolicy).toHaveBeenCalledWith(ORG_ID);
  });

  it('returns the saved policy when one exists', async () => {
    dbSelectResult.mockResolvedValueOnce([{ id: ORG_ID }]);
    serviceMocks.getOrgAuditRetentionPolicy.mockResolvedValue({
      orgId: ORG_ID, configured: true, retentionDays: 90, lastCleanupAt: '2026-09-01T03:30:00.000Z',
    });
    const res = await makeApp().request(`/organizations/${ORG_ID}/audit-retention`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toMatchObject({ orgId: ORG_ID, configured: true, retentionDays: 90 });
  });

  it('404 when the org does not exist (or is soft-deleted)', async () => {
    dbSelectResult.mockResolvedValueOnce([]);
    const res = await makeApp().request(`/organizations/${ORG_ID}/audit-retention`);
    expect(res.status).toBe(404);
  });

  it('404 when partner scope cannot access the org', async () => {
    resetAuth({ canAccessOrg: () => false });
    const res = await makeApp().request(`/organizations/${ORG_ID}/audit-retention`);
    expect(res.status).toBe(404);
    expect(await res.json()).toHaveProperty('error', 'Organization not found');
  });

  it('allows an organization-scoped caller to read their OWN org policy (#5423)', async () => {
    resetAuth(orgScopedAuth(ORG_ID));
    dbSelectResult.mockResolvedValueOnce([{ id: ORG_ID }]);
    serviceMocks.getOrgAuditRetentionPolicy.mockResolvedValue({
      orgId: ORG_ID, configured: true, retentionDays: 90, lastCleanupAt: null,
    });
    const res = await makeApp().request(`/organizations/${ORG_ID}/audit-retention`);
    expect(res.status).toBe(200);
    expect(serviceMocks.getOrgAuditRetentionPolicy).toHaveBeenCalledWith(ORG_ID);
  });

  it('404 when an organization-scoped caller targets a DIFFERENT org (#5423)', async () => {
    resetAuth(orgScopedAuth(OTHER_ORG_ID));
    const res = await makeApp().request(`/organizations/${ORG_ID}/audit-retention`);
    expect(res.status).toBe(404);
    expect(await res.json()).toHaveProperty('error', 'Organization not found');
    // Refused before the org lookup, so no cross-tenant read happens at all.
    expect(dbSelectResult).not.toHaveBeenCalled();
    expect(serviceMocks.getOrgAuditRetentionPolicy).not.toHaveBeenCalled();
  });

  it('404 for an org-scoped caller whose allowlist wrongly admits a foreign org (#5423)', async () => {
    // Isolates the token-identity check from the accessible-org allowlist:
    // production derives one from the other, so only a deliberately
    // disagreeing allowlist can prove the `auth.orgId !== :id` guard is what
    // refuses the request. Without that guard this returns 200.
    resetAuth({ ...orgScopedAuth(OTHER_ORG_ID), canAccessOrg: () => true });
    const res = await makeApp().request(`/organizations/${ORG_ID}/audit-retention`);
    expect(res.status).toBe(404);
    expect(dbSelectResult).not.toHaveBeenCalled();
    expect(serviceMocks.getOrgAuditRetentionPolicy).not.toHaveBeenCalled();
  });

  it('404 for an org-scoped caller with no bound orgId (#5423)', async () => {
    resetAuth({ ...orgScopedAuth(ORG_ID), orgId: null, accessibleOrgIds: [] });
    const res = await makeApp().request(`/organizations/${ORG_ID}/audit-retention`);
    expect(res.status).toBe(404);
    expect(dbSelectResult).not.toHaveBeenCalled();
  });

  it('403 for an ai_agent principal even at organization scope', async () => {
    resetAuth({ ...orgScopedAuth(ORG_ID), principal: { kind: 'ai_agent' } } as never);
    const res = await makeApp().request(`/organizations/${ORG_ID}/audit-retention`);
    expect(res.status).toBe(403);
  });

  it('401 when unauthenticated', async () => {
    authRef.current = null as unknown as typeof authRef.current;
    const res = await makeApp().request(`/organizations/${ORG_ID}/audit-retention`);
    expect(res.status).toBe(401);
  });
});

describe('PUT /organizations/:id/audit-retention', () => {
  beforeEach(() => { vi.clearAllMocks(); dbSelectResult.mockReset(); resetAuth(); });

  const put = (body: unknown) =>
    makeApp().request(`/organizations/${ORG_ID}/audit-retention`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('upserts and fires an audit event', async () => {
    dbSelectResult.mockResolvedValueOnce([{ id: ORG_ID }]);
    serviceMocks.upsertOrgAuditRetentionPolicy.mockResolvedValue({
      orgId: ORG_ID, configured: true, retentionDays: 180, lastCleanupAt: null,
    });
    const res = await put({ retentionDays: 180 });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toMatchObject({ orgId: ORG_ID, configured: true, retentionDays: 180 });
    expect(serviceMocks.upsertOrgAuditRetentionPolicy).toHaveBeenCalledWith(ORG_ID, 180);
    expect(auditSpy).toHaveBeenCalledTimes(1);
    const event = auditSpy.mock.calls[0]?.[1];
    expect(event.action).toBe('organization.audit_retention.update');
    expect(event.orgId).toBe(ORG_ID);
    expect(event.details).toEqual({ retentionDays: 180 });
  });

  it('400 when retentionDays is missing', async () => {
    const res = await put({});
    expect(res.status).toBe(400);
  });

  it('400 when retentionDays is out of bounds', async () => {
    const res = await put({ retentionDays: 0 });
    expect(res.status).toBe(400);
  });

  it('400 when retentionDays exceeds the 10-year cap', async () => {
    const res = await put({ retentionDays: 3651 });
    expect(res.status).toBe(400);
  });

  it('404 when the org does not exist', async () => {
    dbSelectResult.mockResolvedValueOnce([]);
    const res = await put({ retentionDays: 90 });
    expect(res.status).toBe(404);
  });

  it('404 when partner scope cannot access the org', async () => {
    resetAuth({ canAccessOrg: () => false });
    const res = await put({ retentionDays: 90 });
    expect(res.status).toBe(404);
  });

  it('allows an organization-scoped caller to update their OWN org policy (#5423)', async () => {
    resetAuth(orgScopedAuth(ORG_ID));
    dbSelectResult.mockResolvedValueOnce([{ id: ORG_ID }]);
    serviceMocks.upsertOrgAuditRetentionPolicy.mockResolvedValue({
      orgId: ORG_ID, configured: true, retentionDays: 120, lastCleanupAt: null,
    });
    const res = await put({ retentionDays: 120 });
    expect(res.status).toBe(200);
    expect(serviceMocks.upsertOrgAuditRetentionPolicy).toHaveBeenCalledWith(ORG_ID, 120);
    expect(auditSpy).toHaveBeenCalledTimes(1);
  });

  it('404 when an organization-scoped caller targets a DIFFERENT org (#5423)', async () => {
    resetAuth(orgScopedAuth(OTHER_ORG_ID));
    const res = await put({ retentionDays: 120 });
    expect(res.status).toBe(404);
    expect(await res.json()).toHaveProperty('error', 'Organization not found');
    expect(dbSelectResult).not.toHaveBeenCalled();
    expect(serviceMocks.upsertOrgAuditRetentionPolicy).not.toHaveBeenCalled();
    expect(auditSpy).not.toHaveBeenCalled();
  });

  it('404 for an org-scoped caller whose allowlist wrongly admits a foreign org (#5423)', async () => {
    resetAuth({ ...orgScopedAuth(OTHER_ORG_ID), canAccessOrg: () => true });
    const res = await put({ retentionDays: 120 });
    expect(res.status).toBe(404);
    expect(dbSelectResult).not.toHaveBeenCalled();
    expect(serviceMocks.upsertOrgAuditRetentionPolicy).not.toHaveBeenCalled();
    expect(auditSpy).not.toHaveBeenCalled();
  });

  it('401 when unauthenticated', async () => {
    authRef.current = null as unknown as typeof authRef.current;
    const res = await put({ retentionDays: 90 });
    expect(res.status).toBe(401);
  });
});
