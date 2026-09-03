import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const mocks = vi.hoisted(() => ({
  overview: vi.fn(),
  devices: vi.fn(),
  dbSelect: vi.fn(),
}));

vi.mock('../../services/portal/backupReadModel', () => ({
  backupOverview: mocks.overview,
  backupDevicesPage: mocks.devices,
}));

vi.mock('../../db', () => ({
  db: { select: mocks.dbSelect },
  runOutsideDbContext: <T,>(fn: () => T): T => fn(),
  withDbAccessContext: <T,>(_context: unknown, fn: () => T): T => fn(),
  withSystemDbAccessContext: <T,>(fn: () => T): T => fn(),
}));

vi.mock('./auth', async () => {
  const { Hono } = await import('hono');
  return {
    authRoutes: new Hono(),
    portalAuthMiddleware: async (c: Parameters<import('hono').MiddlewareHandler>[0], next: Parameters<import('hono').MiddlewareHandler>[1]) => {
      if (!c.req.header('Authorization')) {
        return c.json({ error: 'Missing or invalid authorization header' }, 401);
      }
      c.set('portalAuth' as never, {
        user: {
          id: 'pu-1',
          orgId: '11111111-1111-4111-8111-111111111111',
          email: 'user@example.com',
          name: null,
          contactId: null,
          receiveNotifications: true,
          status: 'active',
        },
        token: 'token',
        authMethod: 'bearer',
        timezone: 'America/Denver',
      });
      return next();
    },
  };
});

import { portalBackupRoutes } from './backups';
import { portalRoutes } from './index';

function app() {
  const hono = new Hono();
  hono.use('*', async (c, next) => {
    c.set('portalAuth', {
      user: {
        id: 'pu-1', orgId: '11111111-1111-4111-8111-111111111111',
        email: 'user@example.com', name: null, contactId: null,
        receiveNotifications: true, status: 'active',
      },
      token: 'token', authMethod: 'bearer', timezone: 'America/Denver',
    });
    await next();
  });
  hono.route('/', portalBackupRoutes);
  return hono;
}

beforeEach(() => vi.clearAllMocks());

it('uses the session org for overview', async () => {
  mocks.overview.mockResolvedValue({
    dataStatus: 'not_configured',
    asOf: '2026-09-02T12:00:00.000Z',
    protected: 0,
    unprotected: 0,
    total: 0,
    lastPassedVerification: null,
    lastTestRestoreAt: null,
    openRpoBreaches: 0,
    openRtoBreaches: 0,
    meanReadinessScore: null,
  });
  const response = await app().request('/backups/overview');
  expect(response.status).toBe(200);
  expect(mocks.overview).toHaveBeenCalledWith(
    '11111111-1111-4111-8111-111111111111',
    expect.objectContaining({
      timezone: 'America/Denver',
      now: expect.any(Date),
    }),
  );
  expect(response.headers.get('cache-control')).toContain('max-age=30');
  expect(response.headers.get('etag')).toBeTruthy();
});

it('validates and forwards pagination', async () => {
  mocks.devices.mockResolvedValue({
    dataStatus: 'no_data',
    asOf: '2026-09-02T12:00:00.000Z',
    data: [],
    pagination: { page: 2, limit: 25, total: 0 },
  });
  const response = await app().request('/backups/devices?page=2&limit=25');
  expect(response.status).toBe(200);
  expect(mocks.devices).toHaveBeenCalledWith(
    '11111111-1111-4111-8111-111111111111',
    expect.objectContaining({
      page: 2, limit: 25,
      timezone: 'America/Denver',
      now: expect.any(Date),
    }),
  );
});

describe('index.ts backup mount wiring and strict gate', () => {
  function mountedApp() {
    const hono = new Hono();
    hono.route('/portal', portalRoutes);
    return hono;
  }

  it('returns 401 when the real mounted route is unauthenticated', async () => {
    const response = await mountedApp().request('/portal/backups/overview');

    expect(response.status).toBe(401);
    expect(mocks.overview).not.toHaveBeenCalled();
  });

  it('returns 403 when backups are disabled for the session org', async () => {
    mocks.dbSelect.mockReturnValue({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve([{ enableBackups: false }])),
        })),
      })),
    });

    const response = await mountedApp().request('/portal/backups/overview', {
      headers: { Authorization: 'Bearer portal-token' },
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: 'Backup visibility is not enabled for this portal',
      code: 'PORTAL_BACKUPS_DISABLED',
    });
    expect(mocks.overview).not.toHaveBeenCalled();
  });
});
