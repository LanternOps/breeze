import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const mocks = vi.hoisted(() => ({
  enriched: vi.fn(),
  csv: vi.fn(),
  where: null as unknown,
  selfServiceEnabled: false,
}));

vi.mock('../../services/portal/deviceReadModel', () => ({
  enrichedDevicesForOrg: mocks.enriched,
  devicesCsvForOrg: mocks.csv,
}));

vi.mock('../../db', () => ({
  db: {
    select: vi.fn((selection: Record<string, unknown>) => ({
      from: vi.fn(() => ({
        where: vi.fn((condition: unknown) => {
          if ('slug' in selection) {
            mocks.where = condition;
            return { limit: vi.fn(() => Promise.resolve([{ slug: 'acme' }])) };
          }
          if ('enableSelfService' in selection) {
            return {
              limit: vi.fn(() =>
                Promise.resolve([{ enableSelfService: mocks.selfServiceEnabled }]),
              ),
            };
          }
          return Promise.resolve([]);
        }),
      })),
    })),
  },
  runOutsideDbContext: <T,>(fn: () => T): T => fn(),
  withSystemDbAccessContext: <T,>(fn: () => Promise<T>): Promise<T> => fn(),
  withDbAccessContext: <T,>(
    _context: unknown,
    fn: () => Promise<T>,
  ): Promise<T> => fn(),
}));

vi.mock('./auth', async () => {
  const { Hono } = await import('hono');
  return {
    authRoutes: new Hono(),
    portalAuthMiddleware: async (c: {
      req: { header(name: string): string | undefined };
      json(body: unknown, status: 401): Response;
      set(key: string, value: unknown): void;
    }, next: () => Promise<void>) => {
      if (!c.req.header('Authorization')) {
        return c.json({ error: 'Authentication required' }, 401);
      }
      c.set('portalAuth', {
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
      await next();
    },
  };
});

import { deviceRoutes } from './devices';
import { portalRoutes } from './index';

function isolatedApp() {
  const hono = new Hono();
  hono.use('*', async (c, next) => {
    c.set('portalAuth', {
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
    await next();
  });
  hono.route('/', deviceRoutes);
  return hono;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.where = null;
  mocks.selfServiceEnabled = false;
});

it('delegates the JSON list with the session org', async () => {
  mocks.enriched.mockResolvedValue({
    data: [],
    pagination: { page: 1, limit: 50, total: 0 },
  });
  const response = await isolatedApp().request('/devices?page=1&limit=50');
  expect(response.status).toBe(200);
  expect(mocks.enriched).toHaveBeenCalledWith(
    '11111111-1111-4111-8111-111111111111',
    expect.objectContaining({
      page: 1,
      limit: 50,
      timezone: 'America/Denver',
      now: expect.any(Date),
    }),
  );
});

it('streams CSV with an org/date filename and scoped slug query', async () => {
  mocks.csv.mockImplementation(async function* () {
    yield 'Device,Status\n';
    yield 'Laptop,online\n';
  });

  const response = await isolatedApp().request('/devices/export.csv');
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/csv');
  expect(response.headers.get('content-disposition')).toMatch(
    /acme-devices-\d{4}-\d{2}-\d{2}\.csv/,
  );
  expect(await response.text()).toBe('Device,Status\nLaptop,online\n');
  expect(mocks.csv).toHaveBeenCalledWith(
    '11111111-1111-4111-8111-111111111111',
    expect.objectContaining({ timezone: 'America/Denver', now: expect.any(Date) }),
  );

  const query = new PgDialect().sqlToQuery(mocks.where as SQL);
  expect(query.sql).toContain('"organizations"."id" =');
  expect(query.params).toContain('11111111-1111-4111-8111-111111111111');
});

describe('real portal router auth and enableSelfService gate', () => {
  it.each(['/devices', '/devices/export.csv'])(
    'returns 401 for unauthenticated GET %s',
    async (path) => {
      const response = await portalRoutes.request(path);
      expect(response.status).toBe(401);
      expect(mocks.enriched).not.toHaveBeenCalled();
      expect(mocks.csv).not.toHaveBeenCalled();
    },
  );

  it.each(['/devices', '/devices/export.csv'])(
    'returns 403 when enableSelfService is false for GET %s',
    async (path) => {
      const response = await portalRoutes.request(path, {
        headers: { Authorization: 'Bearer portal-token' },
      });
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        code: 'PORTAL_SELF_SERVICE_DISABLED',
      });
      expect(mocks.enriched).not.toHaveBeenCalled();
      expect(mocks.csv).not.toHaveBeenCalled();
    },
  );
});
