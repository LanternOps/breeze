import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const mocks = vi.hoisted(() => ({
  serviceOverview: vi.fn(),
  deliverableOccurrences: vi.fn(),
}));

const routerState = vi.hoisted(() => ({
  authenticated: true,
  brandingRows: [] as unknown[],
}));

vi.mock('../../services/portal/serviceReadModel', () => ({
  serviceOverview: mocks.serviceOverview,
  deliverableOccurrences: mocks.deliverableOccurrences,
}));
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
      c.set('portalAuth', AUTH);
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

import { portalServiceRoutes } from './service';
import { portalRoutes } from './index';

const ORG_ID = '11111111-1111-4111-8111-111111111111';

const AUTH = {
  user: {
    id: 'portal-user-1',
    orgId: ORG_ID,
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
  hono.route('/', portalServiceRoutes);
  return hono;
}

beforeEach(() => {
  vi.clearAllMocks();
  routerState.authenticated = true;
  routerState.brandingRows = [];
});

describe('GET /service', () => {
  it('uses the session org and hydrated timezone and sends private cache headers', async () => {
    mocks.serviceOverview.mockResolvedValue({ asOf: '2026-10-15T12:00:00.000Z', timezone: 'America/Denver', groups: [], keyDates: [] });
    const response = await isolatedApp().request('/service');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('private');
    expect(response.headers.get('cache-control')).toContain('max-age=30');
    expect(response.headers.get('etag')).toMatch(/^W\/"[A-Za-z0-9_-]+"$/);
    expect(mocks.serviceOverview).toHaveBeenCalledWith(
      ORG_ID,
      expect.objectContaining({ timezone: 'America/Denver' }),
    );
  });

  it('returns 304 when the private ETag is fresh', async () => {
    mocks.serviceOverview.mockResolvedValue({ asOf: '2026-10-15T12:00:00.000Z', timezone: 'America/Denver', groups: [], keyDates: [] });
    const first = await isolatedApp().request('/service');
    const etag = first.headers.get('etag')!;
    const second = await isolatedApp().request('/service', { headers: { 'If-None-Match': etag } });
    expect(second.status).toBe(304);
    expect(second.headers.get('etag')).toBe(etag);
  });
});

describe('GET /service/:deliverableId/occurrences', () => {
  it('404s a deliverable the read model refuses, with no body detail', async () => {
    mocks.deliverableOccurrences.mockResolvedValue(null);
    const response = await isolatedApp().request(`/service/${ORG_ID}/occurrences`);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Not found' });
  });

  it('rejects a non-uuid deliverable id before touching the read model', async () => {
    const response = await isolatedApp().request('/service/not-a-uuid/occurrences');
    expect(response.status).toBe(400);
    expect(mocks.deliverableOccurrences).not.toHaveBeenCalled();
  });

  it('rejects a limit above the published window', async () => {
    const response = await isolatedApp().request(`/service/${ORG_ID}/occurrences?limit=500`);
    expect(response.status).toBe(400);
    expect(mocks.deliverableOccurrences).not.toHaveBeenCalled();
  });

  it('accepts exactly the published window and refuses one more', async () => {
    // Pins the boundary itself: max(24) is the published window (spec §8), so
    // a silent widening to 25 would otherwise go unnoticed.
    mocks.deliverableOccurrences.mockResolvedValue({ asOf: '', timezone: 'UTC', deliverable: { id: 'd1', name: 'x', cadence: 'monthly' }, occurrences: [] });
    expect((await isolatedApp().request(`/service/${ORG_ID}/occurrences?limit=24`)).status).toBe(200);
    expect((await isolatedApp().request(`/service/${ORG_ID}/occurrences?limit=25`)).status).toBe(400);
  });

  it('defaults to the full window when no limit is given', async () => {
    mocks.deliverableOccurrences.mockResolvedValue({ asOf: '', timezone: 'UTC', deliverable: { id: 'd1', name: 'x', cadence: 'monthly' }, occurrences: [] });
    await isolatedApp().request(`/service/${ORG_ID}/occurrences`);
    expect(mocks.deliverableOccurrences).toHaveBeenCalledWith(
      ORG_ID, ORG_ID, expect.objectContaining({ limit: 24 }));
  });

  it('passes the validated limit through', async () => {
    mocks.deliverableOccurrences.mockResolvedValue({ asOf: '', timezone: 'America/Denver', deliverable: { id: 'd1', name: 'x', cadence: 'monthly' }, occurrences: [] });
    await isolatedApp().request(`/service/${ORG_ID}/occurrences?limit=5`);
    expect(mocks.deliverableOccurrences).toHaveBeenCalledWith(
      ORG_ID,
      ORG_ID,
      expect.objectContaining({ limit: 5 }),
    );
  });
});

describe('GET /service through the real portal router', () => {
  it('returns 401 without an authenticated portal session', async () => {
    routerState.authenticated = false;
    const response = await portalRoutes.request('/service');
    expect(response.status).toBe(401);
    expect(mocks.serviceOverview).not.toHaveBeenCalled();
  });

  it('returns 403 when service visibility is disabled', async () => {
    routerState.brandingRows = [{ enableService: false }];
    const response = await portalRoutes.request('/service', { headers: { Authorization: 'Bearer token' } });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'PORTAL_SERVICE_DISABLED' });
    expect(mocks.serviceOverview).not.toHaveBeenCalled();
  });

  it('gates the occurrences path on the same flag', async () => {
    routerState.brandingRows = [{ enableService: false }];
    const response = await portalRoutes.request(
      `/service/${ORG_ID}/occurrences`,
      { headers: { Authorization: 'Bearer token' } },
    );
    expect(response.status).toBe(403);
  });

  it('serves the overview when the flag is on', async () => {
    routerState.brandingRows = [{ enableService: true }];
    mocks.serviceOverview.mockResolvedValue({ asOf: '2026-10-15T12:00:00.000Z', timezone: 'America/Denver', groups: [], keyDates: [] });
    const response = await portalRoutes.request('/service', { headers: { Authorization: 'Bearer token' } });
    expect(response.status).toBe(200);
  });
});
