/**
 * GET /api/v1/admin/system/health — shared background-work observations for
 * /admin/system Health (spec 2026-10-30-system-health-admin-design §6, §9). Auth mocking mirrors
 * systemConnections.test.ts: the real adminRoutes + platformAdminMiddleware.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { redisState, queueCounts, fakeQueue } = vi.hoisted(() => {
  const counts = { value: { waiting: 1, prioritized: 0, delayed: 0, active: 0 } as Record<string, number> };
  return {
    redisState: { values: {} as Record<string, string>, mode: 'ok' as 'ok' | 'null' | 'throws' },
    queueCounts: counts,
    fakeQueue: () => ({ getJobCounts: async () => counts.value }),
  };
});
vi.mock('../../jobs/connectionHealthReconcile', () => ({ getConnectionHealthQueue: fakeQueue }));
vi.mock('../../jobs/connectionHealthDigest', () => ({ getConnectionHealthDigestQueue: fakeQueue }));
vi.mock('../../jobs/alertWorker', () => ({ getAlertQueue: fakeQueue }));
vi.mock('../../services/eventDispatchQueue', () => ({ getEventDispatchQueue: fakeQueue }));

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

const PATH = '/admin/system/health';

beforeEach(() => {
  redisState.values = {};
  redisState.mode = 'ok';
  queueCounts.value = { waiting: 1, prioritized: 0, delayed: 0, active: 0 };
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('GET /admin/system/health', () => {
  it('401 unauthenticated, 403 for a non-platform admin', async () => {
    expect((await buildApp(null).request(PATH)).status).toBe(401);
    expect((await buildApp(partnerAdmin).request(PATH)).status).toBe(403);
  });

  it('returns queues and jobs, uncached, with no tenant or queue payload', async () => {
    const res = await buildApp(platformAdmin).request(PATH);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const { data } = await res.json();
    expect(data.queues.map((q: { id: string }) => q.id)).toEqual([
      'connection-health-reconcile',
      'connection-health-digest',
      'alerts',
      'event-dispatch',
    ]);
    expect(data.queues[0].counts).toEqual({ waiting: 1, prioritized: 0, delayed: 0, active: 0 });
    expect(data.jobs.some((j: { id: string }) => j.id === 'reconcile')).toBe(true);
    expect(JSON.stringify(data)).not.toMatch(/redis:\/\/|password|secret|tenant|orgId/i);
  });

  it('a Redis outage is a 200 with unknown observations, never a 500', async () => {
    redisState.mode = 'throws';
    const res = await buildApp(platformAdmin).request(PATH);
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.queues.every((q: { status: string }) => q.status === 'unknown')).toBe(true);
    expect(data.jobs.every((j: { status: string }) => j.status === 'unknown')).toBe(true);
  });

  it('exposes GET only', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect((await buildApp(platformAdmin).request(PATH, { method })).status, method).toBe(404);
    }
  });
});
