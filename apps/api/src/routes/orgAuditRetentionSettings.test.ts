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
  requireScope: () => async (c: any, next: any) => {
    if (!c.get('auth')) {
      return c.json({ error: 'Not authenticated' }, 401);
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
  beforeEach(() => { vi.clearAllMocks(); resetAuth(); });

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

  it('401 when unauthenticated', async () => {
    authRef.current = null as unknown as typeof authRef.current;
    const res = await makeApp().request(`/organizations/${ORG_ID}/audit-retention`);
    expect(res.status).toBe(401);
  });
});

describe('PUT /organizations/:id/audit-retention', () => {
  beforeEach(() => { vi.clearAllMocks(); resetAuth(); });

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

  it('401 when unauthenticated', async () => {
    authRef.current = null as unknown as typeof authRef.current;
    const res = await put({ retentionDays: 90 });
    expect(res.status).toBe(401);
  });
});
