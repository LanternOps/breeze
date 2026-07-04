import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const { authRef, dbSelectResult, dbUpsertReturning, auditSpy } = vi.hoisted(() => ({
  authRef: {
    current: {
      scope: 'partner' as string,
      user: { id: 'u-1', name: 'Tess Tech', email: 'tess@msp.example', isPlatformAdmin: false },
      partnerId: 'p-1' as string | null,
      partnerOrgAccess: 'all' as 'all' | 'selected' | 'none' | null | undefined,
      orgId: null as string | null,
      accessibleOrgIds: null as string[] | null
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
  }
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
  partnerLoginBranding: {
    partnerId: 'partnerId',
    logoUrl: 'logoUrl',
    accentColor: 'accentColor',
    headline: 'headline'
  }
}));

vi.mock('../services/auditEvents', () => ({
  writeRouteAudit: (...args: unknown[]) => auditSpy(...args)
}));

import { authMiddleware } from '../middleware/auth';
import { partnerLoginBrandingRoutes } from './partnerLoginBranding';

const DEFAULT_AUTH = {
  scope: 'partner' as string,
  user: { id: 'u-1', name: 'Tess Tech', email: 'tess@msp.example', isPlatformAdmin: false },
  partnerId: 'p-1' as string | null,
  partnerOrgAccess: 'all' as 'all' | 'selected' | 'none' | null | undefined,
  orgId: null as string | null,
  accessibleOrgIds: null as string[] | null
};

function resetAuth(overrides: Partial<typeof DEFAULT_AUTH> = {}) {
  authRef.current = { ...DEFAULT_AUTH, ...overrides } as typeof authRef.current;
}

function makeApp() {
  const app = new Hono();
  app.route('/partners', partnerLoginBrandingRoutes);
  return app;
}

describe('partner login branding routes (#2183)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authMiddleware);
    resetAuth();
  });

  it('GET returns null data when unset', async () => {
    dbSelectResult.mockResolvedValueOnce([]);
    const res = await makeApp().request('/partners/me/login-branding');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toBeNull();
  });

  it('PUT upserts for a partner admin with orgAccess=all', async () => {
    resetAuth({ partnerOrgAccess: 'all' });
    const returned = { logoUrl: 'https://cdn.example.com/logo.png', accentColor: '#336699', headline: 'Welcome' };
    dbUpsertReturning.mockResolvedValueOnce([returned]);

    const res = await makeApp().request('/partners/me/login-branding', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(returned)
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual(returned);
    expect(auditSpy).toHaveBeenCalledTimes(1);
    const event = auditSpy.mock.calls[0]?.[1];
    expect(event.orgId).toBeNull();
    expect(event.action).toBe('partner.login_branding.update');
    expect(event.resourceId).toBe('p-1');
    expect(event.details.partnerId).toBe('p-1');
    // Audit must reflect the effective applied row, not the raw request body —
    // full-replace semantics mean omitted fields were coalesced to null.
    expect(event.details.applied).toEqual(returned);
  });

  it('PUT audits the effective applied row (full-replace nulls omitted fields), not a changed-fields list', async () => {
    resetAuth({ partnerOrgAccess: 'all' });
    // Only accentColor is sent; logoUrl/headline are coalesced to null by the
    // route and that's what actually lands in the DB row returned here.
    const returned = { logoUrl: null, accentColor: '#abcdef', headline: null };
    dbUpsertReturning.mockResolvedValueOnce([returned]);

    const res = await makeApp().request('/partners/me/login-branding', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accentColor: '#abcdef' })
    });

    expect(res.status).toBe(200);
    const event = auditSpy.mock.calls[0]?.[1];
    expect(event.details).not.toHaveProperty('changedFields');
    expect(event.details.applied).toEqual(returned);
  });

  it('PUT populated then GET returns the populated row (round-trip)', async () => {
    resetAuth({ partnerOrgAccess: 'all' });
    const applied = { logoUrl: 'https://cdn.example.com/logo.png', accentColor: '#336699', headline: 'Welcome' };
    dbUpsertReturning.mockResolvedValueOnce([applied]);

    const putRes = await makeApp().request('/partners/me/login-branding', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(applied)
    });
    expect(putRes.status).toBe(200);
    expect((await putRes.json()).data).toEqual(applied);

    dbSelectResult.mockResolvedValueOnce([applied]);
    const getRes = await makeApp().request('/partners/me/login-branding');
    expect(getRes.status).toBe(200);
    expect((await getRes.json()).data).toEqual(applied);
  });

  it('PUT 403s without canManagePartnerWidePolicies', async () => {
    resetAuth({ partnerOrgAccess: 'selected' });

    const res = await makeApp().request('/partners/me/login-branding', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accentColor: '#336699' })
    });

    expect(res.status).toBe(403);
    expect(auditSpy).not.toHaveBeenCalled();
  });

  it('PUT 400s a non-hex accentColor', async () => {
    const res = await makeApp().request('/partners/me/login-branding', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accentColor: 'blue' })
    });
    expect(res.status).toBe(400);
  });

  it('PUT 400s a logoUrl that is neither https:// nor data:image/', async () => {
    const res = await makeApp().request('/partners/me/login-branding', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ logoUrl: 'http://insecure.example.com/logo.png' })
    });
    expect(res.status).toBe(400);
  });

  it('PUT 400s a data:image subtype the login page will not render (svg) (#2195)', async () => {
    // sanitizeImageSrc renders only png/jpeg/webp — accepting other subtypes
    // here let a partner save a logo that silently never displayed.
    const res = await makeApp().request('/partners/me/login-branding', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ logoUrl: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' })
    });
    expect(res.status).toBe(400);
  });

  it('PUT accepts a base64 data:image/png logoUrl', async () => {
    resetAuth({ partnerOrgAccess: 'all' });
    const applied = { logoUrl: 'data:image/png;base64,iVBORw0KGgo=', accentColor: null, headline: null };
    dbUpsertReturning.mockResolvedValueOnce([applied]);

    const res = await makeApp().request('/partners/me/login-branding', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ logoUrl: applied.logoUrl })
    });
    expect(res.status).toBe(200);
  });

  it('PUT 400s a headline over 120 chars', async () => {
    const res = await makeApp().request('/partners/me/login-branding', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ headline: 'x'.repeat(121) })
    });
    expect(res.status).toBe(400);
  });
});
