/**
 * GET /api/v1/admin/system/connection-health — reconciler and digest liveness
 * for /admin/system (connection health W4, spec §8). Auth mocking mirrors
 * systemConnections.test.ts: the real adminRoutes + platformAdminMiddleware.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { redisState } = vi.hoisted(() => ({
  redisState: { values: {} as Record<string, string>, mode: 'ok' as 'ok' | 'null' | 'throws' },
}));

vi.mock('../../services/auditService', () => ({
  createAuditLog: vi.fn(async () => undefined),
  createAuditLogAsync: vi.fn(async () => undefined),
}));
vi.mock('../../services/clientIp', () => ({ getTrustedClientIpOrUndefined: vi.fn(() => '127.0.0.1') }));
vi.mock('../../middleware/auth', async () => {
  const actual = await vi.importActual<typeof import('../../middleware/auth')>('../../middleware/auth');
  const { HTTPException } = await import('hono/http-exception');
  return {
    ...actual,
    authMiddleware: vi.fn(async (c: any, next: () => Promise<void>) => {
      if (!c.get('auth')) throw new HTTPException(401, { message: 'Not authenticated' });
      await next();
    }),
  };
});
vi.mock('../../services/redis', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/redis')>()),
  getRedis: vi.fn(() => {
    if (redisState.mode === 'null') return null;
    return {
      mget: vi.fn(async (...keys: string[]) => {
        if (redisState.mode === 'throws') throw new Error('ECONNRESET');
        return keys.map((k) => redisState.values[k] ?? null);
      }),
    };
  }),
}));

import { Hono } from 'hono';
import { adminRoutes } from './index';
import { HEALTH_SOURCES } from '../../services/connectionHealth/sources';

const platformAdmin = {
  scope: 'partner',
  user: { id: 'admin-1', email: 'admin@breeze.test', name: 'PA', isPlatformAdmin: true },
  token: { mfa: true },
};
const partnerAdmin = { ...platformAdmin, user: { ...platformAdmin.user, id: 'pa-1', isPlatformAdmin: false } };

function buildApp(auth: unknown) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (auth) c.set('auth', auth as never);
    await next();
  });
  app.route('/admin', adminRoutes);
  return app;
}

const PATH = '/admin/system/connection-health';

beforeEach(() => {
  redisState.values = {};
  redisState.mode = 'ok';
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('GET /admin/system/connection-health', () => {
  it('401 unauthenticated, 403 for a non-platform admin', async () => {
    expect((await buildApp(null).request(PATH)).status).toBe(401);
    expect((await buildApp(partnerAdmin).request(PATH)).status).toBe(403);
  });

  it('reports the reconciler, the digest and every registered kind, uncached', async () => {
    redisState.values['connection-health:reconcile:heartbeat'] = new Date().toISOString();
    const res = await buildApp(platformAdmin).request(PATH);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const { data } = await res.json();
    expect(data.redis).toBe('ok');
    expect(data.reconcile.state).toBe('ok');
    expect(data.digest.state).toBe('missing');
    expect(data.kinds.map((k: { kind: string }) => k.kind)).toEqual(HEALTH_SOURCES.map((s) => s.kind));
  });

  it('a Redis outage is a 200 with redis: unavailable, never a 500', async () => {
    redisState.mode = 'throws';
    const res = await buildApp(platformAdmin).request(PATH);
    expect(res.status).toBe(200);
    expect((await res.json()).data.redis).toBe('unavailable');
    redisState.mode = 'null';
    expect((await (await buildApp(platformAdmin).request(PATH)).json()).data.redis).toBe('unavailable');
  });

  it('exposes GET only', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect((await buildApp(platformAdmin).request(PATH, { method })).status, method).toBe(404);
    }
  });
});
