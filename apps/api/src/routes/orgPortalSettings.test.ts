import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const { authRef, dbSelectResult, dbUpsertReturning, auditSpy } = vi.hoisted(() => ({
  authRef: {
    current: {
      scope: 'partner' as string,
      user: { id: 'u-1', name: 'Tess Tech', email: 'tess@msp.example', isPlatformAdmin: false },
      partnerId: 'p-1' as string | null,
      orgId: null as string | null,
      accessibleOrgIds: null as string[] | null,
      orgCondition: () => undefined,
      canAccessOrg: (_id: string) => true as boolean
    }
  },
  dbSelectResult: vi.fn(),
  dbUpsertReturning: vi.fn(),
  auditSpy: vi.fn()
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
  requireMfa: () => async (_c: any, next: any) => next()
}));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => dbSelectResult())
        }))
      }))
    })),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        onConflictDoUpdate: vi.fn(() => ({
          returning: vi.fn(() => dbUpsertReturning())
        }))
      }))
    }))
  }
}));

vi.mock('../db/schema', () => ({
  portalBranding: {
    orgId: 'orgId',
    enableTickets: 'enableTickets',
    enableAssetCheckout: 'enableAssetCheckout',
    enableSelfService: 'enableSelfService',
    enablePasswordReset: 'enablePasswordReset',
    supportEmail: 'supportEmail',
    supportPhone: 'supportPhone',
    welcomeMessage: 'welcomeMessage',
    footerText: 'footerText',
    updatedAt: 'updatedAt'
  },
  organizations: { id: 'id', deletedAt: 'deletedAt' }
}));

vi.mock('../services/auditEvents', () => ({
  writeRouteAudit: (...args: unknown[]) => auditSpy(...args)
}));

import { authMiddleware } from '../middleware/auth';
import { registerOrgPortalSettingsRoutes } from './orgPortalSettings';

const ORG_ID = '7c0a1f7e-1111-4222-8333-444455556666';

const FULL_ROW = {
  id: 'row-1',
  orgId: ORG_ID,
  enableTickets: false,
  enableAssetCheckout: true,
  enableSelfService: true,
  enablePasswordReset: true,
  supportEmail: 'help@msp.example',
  supportPhone: null,
  welcomeMessage: 'Welcome',
  footerText: null,
  // Read-only columns that must never leak into the response payload:
  customDomain: 'portal.customer.example',
  customCss: 'body{}',
  logoUrl: 'https://x/logo.png'
};

const DEFAULT_AUTH = {
  scope: 'partner' as string,
  user: { id: 'u-1', name: 'Tess Tech', email: 'tess@msp.example', isPlatformAdmin: false },
  partnerId: 'p-1' as string | null,
  orgId: null as string | null,
  accessibleOrgIds: null as string[] | null,
  orgCondition: () => undefined,
  canAccessOrg: (_id: string) => true as boolean
};

function makeApp() {
  const app = new Hono();
  app.use('*', authMiddleware as any);
  registerOrgPortalSettingsRoutes(app);
  return app;
}

function resetAuth(overrides: Partial<typeof DEFAULT_AUTH> = {}) {
  authRef.current = { ...DEFAULT_AUTH, ...overrides } as typeof authRef.current;
}

describe('GET /organizations/:id/portal-settings', () => {
  beforeEach(() => { vi.clearAllMocks(); resetAuth(); });

  it('returns the managed subset when a row exists (never visual branding columns)', async () => {
    dbSelectResult
      .mockResolvedValueOnce([{ id: ORG_ID }]) // org existence check
      .mockResolvedValueOnce([FULL_ROW]);      // portal_branding row
    const res = await makeApp().request(`/organizations/${ORG_ID}/portal-settings`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({
      orgId: ORG_ID,
      enableTickets: false,
      enableAssetCheckout: true,
      enableSelfService: true,
      enablePasswordReset: true,
      supportEmail: 'help@msp.example',
      supportPhone: null,
      welcomeMessage: 'Welcome',
      footerText: null
    });
    expect(JSON.stringify(body)).not.toContain('customDomain');
    expect(JSON.stringify(body)).not.toContain('customCss');
  });

  it('returns schema defaults when no row exists', async () => {
    dbSelectResult
      .mockResolvedValueOnce([{ id: ORG_ID }])
      .mockResolvedValueOnce([]);
    const res = await makeApp().request(`/organizations/${ORG_ID}/portal-settings`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({
      orgId: ORG_ID,
      enableTickets: true,
      enableAssetCheckout: true,
      enableSelfService: true,
      enablePasswordReset: true,
      supportEmail: null,
      supportPhone: null,
      welcomeMessage: null,
      footerText: null
    });
  });

  it('404 when the org does not exist (or is soft-deleted)', async () => {
    dbSelectResult.mockResolvedValueOnce([]);
    const res = await makeApp().request(`/organizations/${ORG_ID}/portal-settings`);
    expect(res.status).toBe(404);
  });

  it('404 when partner scope cannot access the org', async () => {
    resetAuth({ canAccessOrg: () => false });
    const res = await makeApp().request(`/organizations/${ORG_ID}/portal-settings`);
    expect(res.status).toBe(404);
    expect(await res.json()).toHaveProperty('error', 'Organization not found');
  });

  it('401 when unauthenticated', async () => {
    authRef.current = null as unknown as typeof authRef.current;
    const res = await makeApp().request(`/organizations/${ORG_ID}/portal-settings`);
    expect(res.status).toBe(401);
  });
});

describe('PATCH /organizations/:id/portal-settings', () => {
  beforeEach(() => { vi.clearAllMocks(); resetAuth(); });

  const patch = (body: unknown) =>
    makeApp().request(`/organizations/${ORG_ID}/portal-settings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

  it('upserts and returns the managed subset', async () => {
    dbSelectResult.mockResolvedValueOnce([{ id: ORG_ID }]);
    dbUpsertReturning.mockResolvedValue([{ ...FULL_ROW, enableTickets: true }]);
    const res = await patch({ enableTickets: true, supportEmail: 'help@msp.example' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.enableTickets).toBe(true);
    expect(body.data.orgId).toBe(ORG_ID);

    const { db } = await import('../db');
    const valuesArg = vi.mocked(db.insert).mock.results[0]?.value.values.mock.calls[0]?.[0];
    expect(valuesArg.orgId).toBe(ORG_ID);
    expect(valuesArg.enableTickets).toBe(true);
    const conflictArg = vi.mocked(db.insert).mock.results[0]?.value.values.mock.results[0]?.value
      .onConflictDoUpdate.mock.calls[0]?.[0];
    expect(conflictArg.set.enableTickets).toBe(true);
    expect(conflictArg.set.updatedAt).toBeInstanceOf(Date);
  });

  it('writes an audit event', async () => {
    dbSelectResult.mockResolvedValueOnce([{ id: ORG_ID }]);
    dbUpsertReturning.mockResolvedValue([FULL_ROW]);
    const res = await patch({ enableTickets: false });
    expect(res.status).toBe(200);
    expect(auditSpy).toHaveBeenCalledTimes(1);
    const event = auditSpy.mock.calls[0]?.[1];
    expect(event.action).toBe('organization.portal_settings.update');
    expect(event.orgId).toBe(ORG_ID);
    expect(event.details.changedFields).toEqual(['enableTickets']);
  });

  it('400 on an empty body (no-op)', async () => {
    const res = await patch({});
    expect(res.status).toBe(400);
    expect(await res.json()).toHaveProperty('error', 'No updates provided');
  });

  it('400 on unknown keys (visual branding not writable)', async () => {
    expect((await patch({ customDomain: 'evil.example' })).status).toBe(400);
  });

  it('400 on invalid email', async () => {
    expect((await patch({ supportEmail: 'nope' })).status).toBe(400);
  });

  it('404 when partner scope cannot access the org', async () => {
    resetAuth({ canAccessOrg: () => false });
    const res = await patch({ enableTickets: false });
    expect(res.status).toBe(404);
  });

  it('404 when the org does not exist', async () => {
    dbSelectResult.mockResolvedValueOnce([]);
    const res = await patch({ enableTickets: false });
    expect(res.status).toBe(404);
  });
});
