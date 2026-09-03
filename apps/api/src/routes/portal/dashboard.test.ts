import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const mocks = vi.hoisted(() => ({
  dashboardForOrg: vi.fn(),
  buildWeakEtag: vi.fn(() => 'W/"dashboard"'),
}));

const routerState = vi.hoisted(() => ({
  authenticated: true,
  brandingRows: [] as unknown[],
}));

vi.mock('../../services/portal/dashboard', () => ({
  dashboardForOrg: mocks.dashboardForOrg,
}));
vi.mock('./helpers', async (importActual) => {
  const actual = await importActual<typeof import('./helpers')>();
  return { ...actual, buildWeakEtag: mocks.buildWeakEtag };
});
vi.mock('./auth', async () => {
  const { Hono: MockHono } = await import('hono');
  return {
    authRoutes: new MockHono(),
    portalAuthMiddleware: async (c: {
      json: (body: unknown, status: 401) => Response;
      set: (key: string, value: unknown) => void;
    }, next: () => Promise<void>) => {
      if (!routerState.authenticated) {
        return c.json({ error: 'Authentication required' }, 401);
      }
      c.set('portalAuth', {
        user: {
          id: 'portal-user-1',
          orgId: '11111111-1111-4111-8111-111111111111',
          email: 'customer@example.com',
          name: 'Customer',
          contactId: null,
          receiveNotifications: true,
          status: 'active',
        },
        token: 'token',
        authMethod: 'bearer',
        timezone: 'America/Denver',
      });
      await next();
    },
  };
});
vi.mock('../../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve(routerState.brandingRows)),
        })),
      })),
    })),
  },
  runOutsideDbContext: <T,>(fn: () => T): T => fn(),
  withDbAccessContext: <T,>(_context: unknown, fn: () => T): T => fn(),
  withSystemDbAccessContext: <T,>(fn: () => T): T => fn(),
}));

import { portalDashboardRoutes } from './dashboard';
import { portalRoutes } from './index';

const AUTH = {
  user: {
    id: 'portal-user-1',
    orgId: '11111111-1111-4111-8111-111111111111',
    email: 'customer@example.com',
    name: 'Customer',
    contactId: null,
    receiveNotifications: true,
    status: 'active',
  },
  token: 'token',
  authMethod: 'bearer' as const,
  timezone: 'America/Denver',
};

function isolatedApp() {
  const hono = new Hono();
  hono.use('*', async (c, next) => {
    c.set('portalAuth', AUTH);
    await next();
  });
  // The production hub is mounted at root and owns the absolute path.
  hono.route('/', portalDashboardRoutes);
  return hono;
}

describe('GET /dashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    routerState.authenticated = true;
    routerState.brandingRows = [];
  });

  it('uses the session org and hydrated timezone and sends private cache headers', async () => {
    mocks.dashboardForOrg.mockResolvedValue({
      asOf: '2026-09-02T12:00:00.000Z',
      timezone: 'America/Denver',
      securityScore: { status: 'no_data' },
    });

    const response = await isolatedApp().request('/dashboard');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('private');
    expect(response.headers.get('cache-control')).toContain('max-age=30');
    expect(response.headers.get('etag')).toBe('W/"dashboard"');
    expect(mocks.dashboardForOrg).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      expect.objectContaining({ timezone: 'America/Denver' }),
    );
  });

  it('returns 304 when the private ETag is fresh', async () => {
    mocks.dashboardForOrg.mockResolvedValue({
      asOf: '2026-09-02T12:00:00.000Z',
      timezone: 'America/Denver',
    });

    const response = await isolatedApp().request('/dashboard', {
      headers: { 'If-None-Match': 'W/"dashboard"' },
    });

    expect(response.status).toBe(304);
    expect(response.headers.get('cache-control')).toContain('private');
    expect(response.headers.get('etag')).toBe('W/"dashboard"');
  });
});

describe('GET /dashboard through the real portal router', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    routerState.authenticated = true;
    routerState.brandingRows = [];
  });

  it('returns 401 without an authenticated portal session', async () => {
    routerState.authenticated = false;

    const response = await portalRoutes.request('/dashboard');

    expect(response.status).toBe(401);
    expect(mocks.dashboardForOrg).not.toHaveBeenCalled();
  });

  it('returns 403 when dashboard visibility is disabled', async () => {
    routerState.brandingRows = [{ enableDashboard: false }];

    const response = await portalRoutes.request('/dashboard', {
      headers: { Authorization: 'Bearer token' },
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      code: 'PORTAL_DASHBOARD_DISABLED',
    });
    expect(mocks.dashboardForOrg).not.toHaveBeenCalled();
  });
});
