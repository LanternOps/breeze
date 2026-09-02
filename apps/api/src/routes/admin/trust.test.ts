import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  trust: null as null | {
    trustState: 'probation' | 'trusted' | 'restricted';
    probationEnrollments: number;
    trustReviewRequestedAt: Date | null;
  },
  queueRows: [] as Array<Record<string, unknown>>,
}));

const writeTrust = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock('../../services/partnerTrust.repo', () => ({
  readTrust: vi.fn(async () => state.trust),
  writeTrust,
  partnerForDevice: vi.fn(),
}));

vi.mock('../../services/redis', () => ({ getRedis: vi.fn(() => null) }));

vi.mock('../../services/auditService', () => ({
  createAuditLog: vi.fn(async () => undefined),
}));

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: () => Promise.resolve(state.queueRows),
          }),
        }),
      }),
    })),
  },
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../../middleware/auth', () => ({
  requireMfa: vi.fn(() => async (c: any, next: () => Promise<void>) => {
    const auth = c.get('auth');
    if (!auth) return c.json({ error: 'Not authenticated' }, 401);
    if (auth.token?.mfa === false) return c.json({ error: 'MFA required' }, 403);
    await next();
  }),
}));

import { Hono } from 'hono';
import { trustAdminRoutes } from './trust';
import { createAuditLog } from '../../services/auditService';

const auth = {
  user: {
    id: '11111111-1111-4111-8111-111111111111',
    email: 'admin@breeze.test',
    isPlatformAdmin: true,
  },
  token: { mfa: true },
};

function buildApp() {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth', auth as never);
    await next();
  });
  app.route('/admin', trustAdminRoutes);
  return app;
}

describe('admin partner trust routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.trust = {
      trustState: 'probation',
      probationEnrollments: 0,
      trustReviewRequestedAt: null,
    };
    state.queueRows = [];
  });

  it('returns 404 for an unknown partner', async () => {
    state.trust = null;
    const response = await buildApp().request('/admin/partners/missing/trust/promote', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'review completed' }),
    });

    expect(response.status).toBe(404);
    expect(writeTrust).not.toHaveBeenCalled();
  });

  it('returns 409 when promoting a restricted partner without override', async () => {
    state.trust = { trustState: 'restricted', probationEnrollments: 0, trustReviewRequestedAt: null };
    const response = await buildApp().request('/admin/partners/p-1/trust/promote', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'manual approval' }),
    });

    expect(response.status).toBe(409);
    expect(writeTrust).not.toHaveBeenCalled();
  });

  it('promotes with override and records the trust-service audit evidence', async () => {
    state.trust = { trustState: 'restricted', probationEnrollments: 0, trustReviewRequestedAt: null };
    const response = await buildApp().request('/admin/partners/p-1/trust/promote', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'manual approval', override: true }),
    });

    expect(response.status).toBe(200);
    expect(writeTrust).toHaveBeenCalledWith(
      'p-1',
      'trusted',
      'admin:promote',
      auth.user.id,
    );
    expect(createAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      actorId: auth.user.id,
      action: 'partner.trust.promoted',
      resourceId: 'p-1',
      details: expect.objectContaining({
        from: 'restricted',
        to: 'trusted',
        reason: 'manual approval',
      }),
    }));
  });

  it('restricts a partner with the admin reason code', async () => {
    const response = await buildApp().request('/admin/partners/p-1/trust/restrict', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'confirmed abuse' }),
    });

    expect(response.status).toBe(200);
    expect(writeTrust).toHaveBeenCalledWith(
      'p-1',
      'restricted',
      'admin:restrict',
      auth.user.id,
    );
  });

  it('returns the non-trusted queue and a cursor based on the last visible row', async () => {
    const changedAt = new Date('2026-09-01T12:00:00.000Z');
    state.queueRows = [
      {
        id: '22222222-2222-4222-8222-222222222222',
        name: 'Probation MSP',
        slug: 'probation-msp',
        plan: 'pro',
        status: 'active',
        trustState: 'probation',
        trustReason: 'signup',
        trustChangedAt: changedAt,
        trustReviewRequestedAt: null,
        createdAt: new Date('2026-08-30T12:00:00.000Z'),
        signupIp: '192.0.2.1',
        signupIpClass: 'business',
        signupIpAsn: 64500,
        deviceCount: 3,
      },
      {
        id: '33333333-3333-4333-8333-333333333333',
        name: 'Next MSP',
        slug: 'next-msp',
        plan: 'free',
        status: 'active',
        trustState: 'restricted',
        trustReason: 'abuse',
        trustChangedAt: null,
        trustReviewRequestedAt: null,
        createdAt: new Date('2026-08-29T12:00:00.000Z'),
        signupIp: null,
        signupIpClass: 'unknown',
        signupIpAsn: null,
        deviceCount: 0,
      },
    ];

    const response = await buildApp().request('/admin/trust/queue?limit=1');
    const body = await response.json() as { partners: Array<Record<string, unknown>>; nextCursor: string };

    expect(response.status).toBe(200);
    expect(body.partners).toHaveLength(1);
    expect(body.partners[0]).toMatchObject({ name: 'Probation MSP', deviceCount: 3 });
    expect(JSON.parse(Buffer.from(body.nextCursor, 'base64url').toString('utf8'))).toEqual({
      trustChangedAt: changedAt.toISOString(),
      id: '22222222-2222-4222-8222-222222222222',
    });
  });
});
