import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const onPortalFlagsChanged = vi.hoisted(() => vi.fn());

vi.mock('../services/portal/portalFlags', async () => {
  const actual = await vi.importActual<
    typeof import('../services/portal/portalFlags')
  >('../services/portal/portalFlags');

  return {
    ...actual,
    onPortalFlagsChanged
  };
});

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
    enableDevices: 'enableDevices',
    enableSelfService: 'enableSelfService',
    enablePasswordReset: 'enablePasswordReset',
    enableDashboard: 'enableDashboard',
    enableSecurity: 'enableSecurity',
    enableBackups: 'enableBackups',
    enableReports: 'enableReports',
    enableSupportUsage: 'enableSupportUsage',
    enableService: 'enableService',
    enableDocuments: 'enableDocuments',
    enableLifecycle: 'enableLifecycle',
    enableNetworkVisibility: 'enableNetworkVisibility',
    supportEmail: 'supportEmail',
    supportPhone: 'supportPhone',
    welcomeMessage: 'welcomeMessage',
    footerText: 'footerText',
    customCss: 'customCss',
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
  enableDevices: false,
  enableSelfService: true,
  enablePasswordReset: true,
  enableDashboard: false,
  enableSecurity: false,
  enableBackups: false,
  enableReports: false,
  enableSupportUsage: false,
  enableService: false,
  enableDocuments: false,
  enableLifecycle: false,
  enableNetworkVisibility: false,
  supportEmail: 'help@msp.example',
  supportPhone: null,
  welcomeMessage: 'Welcome',
  footerText: null,
  customCss: 'body{}',
  // Read-only columns that must never leak into the response payload:
  customDomain: 'portal.customer.example',
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

  it('returns the managed subset when a row exists (including customCss, never visual branding columns)', async () => {
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
      enableDevices: false,
      enableSelfService: true,
      enablePasswordReset: true,
      enableDashboard: false,
      enableSecurity: false,
      enableBackups: false,
      enableReports: false,
      enableSupportUsage: false,
      enableService: false,
      enableDocuments: false,
      enableLifecycle: false,
      enableNetworkVisibility: false,
      supportEmail: 'help@msp.example',
      supportPhone: null,
      welcomeMessage: 'Welcome',
      footerText: null,
      customCss: 'body{}'
    });
    expect(JSON.stringify(body)).not.toContain('customDomain');
    expect(JSON.stringify(body)).not.toContain('logo.png');
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
      enableAssetCheckout: false, // parked — the portal has no checkout UI yet
      enableDevices: false,
      enableSelfService: true,
      enablePasswordReset: true,
      enableDashboard: false,
      enableSecurity: false,
      enableBackups: false,
      enableReports: false,
      enableSupportUsage: false,
      enableService: false,
      enableDocuments: false,
      enableLifecycle: false,
      enableNetworkVisibility: false,
      supportEmail: null,
      supportPhone: null,
      welcomeMessage: null,
      footerText: null,
      customCss: null
    });
  });

  it('returns false defaults for every visibility flag', async () => {
    dbSelectResult
      .mockResolvedValueOnce([{ id: ORG_ID }])
      .mockResolvedValueOnce([]);

    const response = await makeApp().request(
      `/organizations/${ORG_ID}/portal-settings`
    );

    expect(response.status).toBe(200);
    expect((await response.json()).data).toMatchObject({
      enableDashboard: false,
      enableSecurity: false,
      enableBackups: false,
      enableReports: false,
      enableSupportUsage: false,
      enableNetworkVisibility: false
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

  it('persists the independent Devices visibility flag', async () => {
    dbSelectResult.mockResolvedValueOnce([{ id: ORG_ID }]);
    dbUpsertReturning.mockResolvedValue([{ ...FULL_ROW, enableDevices: true, enableSelfService: false }]);
    const res = await patch({ enableDevices: true, enableSelfService: false });
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ enableDevices: true, enableSelfService: false });
    const { db } = await import('../db');
    const values = vi.mocked(db.insert).mock.results[0]?.value.values.mock.calls[0]?.[0];
    expect(values).toMatchObject({ orgId: ORG_ID, enableDevices: true, enableSelfService: false });
    const returning = vi.mocked(db.insert).mock.results[0]?.value.values.mock.results[0]?.value
      .onConflictDoUpdate.mock.results[0]?.value.returning;
    expect(returning.mock.calls[0]?.[0]).toHaveProperty('enableDevices', 'enableDevices');
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

  it('persists visibility flags and invokes the W09 seam', async () => {
    dbSelectResult.mockResolvedValueOnce([{ id: ORG_ID }]);
    dbUpsertReturning.mockResolvedValue([{
      ...FULL_ROW,
      enableDashboard: true,
      enableReports: true,
      enableService: true,
      enableDocuments: false,
      enableLifecycle: true,
      enableNetworkVisibility: true
    }]);

    const res = await patch({
      enableDashboard: true,
      enableReports: true,
      enableService: true,
      enableLifecycle: true,
      enableNetworkVisibility: true
    });

    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({
      enableDashboard: true,
      enableSecurity: false,
      enableBackups: false,
      enableReports: true,
      enableSupportUsage: false,
      enableService: true,
      enableDocuments: false,
      enableLifecycle: true,
      enableNetworkVisibility: true
    });
    expect(onPortalFlagsChanged).toHaveBeenCalledWith({
      orgId: ORG_ID,
      createdBy: 'u-1',
      requested: {
        enableDashboard: true,
        enableReports: true,
        enableService: true,
        enableLifecycle: true,
        enableNetworkVisibility: true
      },
      current: {
        enableDashboard: true,
        enableSecurity: false,
        enableBackups: false,
        enableReports: true,
        enableSupportUsage: false,
        enableService: true,
        enableDocuments: false,
        enableLifecycle: true,
        enableNetworkVisibility: true
      }
    });
  });

  it('does not invoke the visibility seam for unrelated settings', async () => {
    dbSelectResult.mockResolvedValueOnce([{ id: ORG_ID }]);
    dbUpsertReturning.mockResolvedValue([FULL_ROW]);

    await patch({ supportEmail: 'support@example.test' });

    expect(onPortalFlagsChanged).not.toHaveBeenCalled();
  });

  describe('customCss (#5952)', () => {
    it('accepts and persists safe custom CSS', async () => {
      dbSelectResult.mockResolvedValueOnce([{ id: ORG_ID }]);
      dbUpsertReturning.mockResolvedValue([{ ...FULL_ROW, customCss: '.portal-header { color: red; }' }]);

      const res = await patch({ customCss: '.portal-header { color: red; }' });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.customCss).toBe('.portal-header { color: red; }');

      const { db } = await import('../db');
      const valuesArg = vi.mocked(db.insert).mock.results[0]?.value.values.mock.calls[0]?.[0];
      expect(valuesArg.customCss).toBe('.portal-header { color: red; }');
    });

    it('accepts null to clear custom CSS', async () => {
      dbSelectResult.mockResolvedValueOnce([{ id: ORG_ID }]);
      dbUpsertReturning.mockResolvedValue([{ ...FULL_ROW, customCss: null }]);

      const res = await patch({ customCss: null });
      expect(res.status).toBe(200);
    });

    it('rejects @import', async () => {
      const res = await patch({ customCss: '@import url("evil.css");' });
      expect(res.status).toBe(400);
    });

    it('rejects expression()', async () => {
      const res = await patch({ customCss: 'body { width: expression(alert(1)); }' });
      expect(res.status).toBe(400);
    });

    it('rejects behavior:', async () => {
      const res = await patch({ customCss: 'body { behavior: url(evil.htc); }' });
      expect(res.status).toBe(400);
    });

    it('rejects -moz-binding', async () => {
      const res = await patch({ customCss: 'body { -moz-binding: url("evil.xml#x"); }' });
      expect(res.status).toBe(400);
    });

    it('rejects url() with a non-https/data scheme', async () => {
      expect((await patch({ customCss: 'body { background: url(http://evil.example/x.png); }' })).status).toBe(400);
      expect((await patch({ customCss: 'body { background: url(javascript:alert(1)); }' })).status).toBe(400);
      expect((await patch({ customCss: 'body { background: url(//evil.example/x.png); }' })).status).toBe(400);
      expect((await patch({ customCss: 'body { background: url(/local/x.png); }' })).status).toBe(400);
    });

    it('accepts url() with https: and data: schemes', async () => {
      dbSelectResult.mockResolvedValue([{ id: ORG_ID }]);
      dbUpsertReturning.mockResolvedValue([FULL_ROW]);

      expect((await patch({ customCss: 'body { background: url(https://cdn.example/x.png); }' })).status).toBe(200);
      expect((await patch({ customCss: "body { background: url(data:image/png;base64,AAAA); }" })).status).toBe(200);
    });

    it('rejects custom CSS over the 65536-char cap', async () => {
      const res = await patch({ customCss: 'a'.repeat(65_537) });
      expect(res.status).toBe(400);
    });

    it('accepts custom CSS at exactly the cap', async () => {
      dbSelectResult.mockResolvedValueOnce([{ id: ORG_ID }]);
      dbUpsertReturning.mockResolvedValue([FULL_ROW]);
      const css = '.a{}'.repeat(16_384); // 65536 chars exactly
      expect(css).toHaveLength(65_536);
      const res = await patch({ customCss: css });
      expect(res.status).toBe(200);
    });
  });
});
