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

  it('PUT 400s a headline over 120 chars', async () => {
    const res = await makeApp().request('/partners/me/login-branding', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ headline: 'x'.repeat(121) })
    });
    expect(res.status).toBe(400);
  });
});
