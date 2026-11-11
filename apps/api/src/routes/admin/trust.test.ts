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
const buildEvidenceCard = vi.hoisted(() => vi.fn(async (partnerId: string) => ({
  partner: { id: partnerId, name: 'Card MSP', plan: 'pro', status: 'active', trustState: 'probation' },
  devices: [],
})));

vi.mock('../../services/partnerTrust.repo', () => ({
  readTrust: vi.fn(async () => state.trust),
  writeTrust,
  partnerForDevice: vi.fn(),
}));

vi.mock('../../services/redis', () => ({ getRedis: vi.fn(() => null) }));

vi.mock('../../services/auditService', () => ({
  createAuditLog: vi.fn(async () => undefined),
}));

vi.mock('../../services/partnerTrustEvidenceCard', () => ({ buildEvidenceCard }));

const readOfflineClassifierStatus = vi.hoisted(() => vi.fn());
const readPromotionBlockers = vi.hoisted(() => vi.fn());
vi.mock('../../services/ipClassifyOffline', () => ({ readOfflineClassifierStatus }));
vi.mock('../../services/partnerTrustBlockers', () => ({ readPromotionBlockers }));

vi.mock('../../services/partnerTrustPartnerMail', () => ({
  sendTrustApprovedEmail: vi.fn(async () => 0),
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
  runAfterDbContextExit: vi.fn((_label: string, work: () => unknown) => { void work(); }),
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

// requireMfa() step-up: the mocked '../../middleware/auth' above rejects with
// 403 when auth.token.mfa is false, mirroring the real middleware's behavior.
// Mirrors the abuse.test.ts "auth gate" harness (see admin/abuse.test.ts
// platformAdminAuthNoMfa) so promote/restrict get the same MFA-not-satisfied
// coverage that suspend/unsuspend already have.
const authNoMfa = {
  ...auth,
  token: { mfa: false },
};

function buildApp(authToInject: typeof auth = auth) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth', authToInject as never);
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
    readOfflineClassifierStatus.mockResolvedValue(null);
    readPromotionBlockers.mockResolvedValue(new Map());
    delete process.env.IP_CLASSIFY_PROVIDER;
    delete process.env.IP_CLASSIFY_API_KEY;
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
      'restricted',
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

  it('promotes a probation partner with a CAS on the loaded state', async () => {
    state.trust = { trustState: 'probation', probationEnrollments: 0, trustReviewRequestedAt: null };
    const response = await buildApp().request('/admin/partners/p-1/trust/promote', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'review completed' }),
    });

    expect(response.status).toBe(200);
    expect(writeTrust).toHaveBeenCalledWith('p-1', 'trusted', 'admin:promote', auth.user.id, 'probation');
  });

  it('returns 409 and writes no audit row when the CAS loses', async () => {
    state.trust = { trustState: 'probation', probationEnrollments: 0, trustReviewRequestedAt: null };
    writeTrust.mockResolvedValueOnce(0 as never);
    const response = await buildApp().request('/admin/partners/p-1/trust/promote', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'review completed' }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'trust state changed since the queue was loaded; refresh and retry' });
    expect(createAuditLog).not.toHaveBeenCalled();
  });

  it('restricts with a CAS on the loaded state', async () => {
    state.trust = { trustState: 'probation', probationEnrollments: 0, trustReviewRequestedAt: null };
    const response = await buildApp().request('/admin/partners/p-1/trust/restrict', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'manual restriction' }),
    });

    expect(response.status).toBe(200);
    expect(writeTrust).toHaveBeenCalledWith('p-1', 'restricted', 'admin:restrict', auth.user.id, 'probation');
  });

  it('rejects promote when the MFA step-up is not satisfied (403)', async () => {
    state.trust = { trustState: 'restricted', probationEnrollments: 0, trustReviewRequestedAt: null };
    const response = await buildApp(authNoMfa).request('/admin/partners/p-1/trust/promote', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'manual approval', override: true }),
    });

    expect(response.status).toBe(403);
    const body = await response.json() as { error: string };
    expect(body.error).toBe('MFA required');
    expect(writeTrust).not.toHaveBeenCalled();
  });

  it('rejects restrict when the MFA step-up is not satisfied (403)', async () => {
    const response = await buildApp(authNoMfa).request('/admin/partners/p-1/trust/restrict', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'confirmed abuse' }),
    });

    expect(response.status).toBe(403);
    const body = await response.json() as { error: string };
    expect(body.error).toBe('MFA required');
    expect(writeTrust).not.toHaveBeenCalled();
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
      'probation',
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

  describe('classifier and blockers (#11698)', () => {
    const probationRow = {
      id: '22222222-2222-4222-8222-222222222222',
      name: 'Probation MSP',
      slug: 'probation-msp',
      plan: 'pro',
      status: 'active',
      trustState: 'probation',
      trustReason: 'signup',
      trustChangedAt: null,
      trustReviewRequestedAt: null,
      createdAt: new Date('2026-08-30T12:00:00.000Z'),
      signupIp: '203.0.113.10',
      signupIpClass: 'unknown',
      signupIpAsn: 64501,
      signupIpClassSource: 'offline',
      deviceCount: 1,
    };
    const restrictedRow = {
      ...probationRow,
      id: '33333333-3333-4333-8333-333333333333',
      trustState: 'restricted',
      signupIpClassSource: null,
    };
    const offlineStatus = {
      tor: { source: 'download', entries: 1200, updatedAt: '2026-11-11T00:00:00.000Z', lastError: null },
      hosting: { source: 'snapshot', entries: 700, updatedAt: '2026-11-11T00:00:00.000Z', lastError: 'HTTP 503' },
      asn: { source: 'unavailable', entries: 0, updatedAt: null, lastError: 'timed out' },
      reportedAt: '2026-11-11T00:05:00.000Z',
    };

    it('reports the offline classifier with its data status when no provider is configured', async () => {
      readOfflineClassifierStatus.mockResolvedValue(offlineStatus);

      const response = await buildApp().request('/admin/trust/queue');
      const body = await response.json() as { classifier: unknown };
      expect(response.status).toBe(200);
      expect(body.classifier).toEqual({ active: 'offline', offline: offlineStatus });
    });

    it('reports a keyed provider without offline status', async () => {
      process.env.IP_CLASSIFY_PROVIDER = 'ipinfo';
      process.env.IP_CLASSIFY_API_KEY = 'k';

      const response = await buildApp().request('/admin/trust/queue');
      const body = await response.json() as { classifier: unknown };
      expect(body.classifier).toEqual({ active: 'ipinfo', offline: null });
      expect(readOfflineClassifierStatus).not.toHaveBeenCalled();
    });

    it('returns each row\'s classification source and, for probation rows, the recorded blockers', async () => {
      state.queueRows = [probationRow, restrictedRow];
      readPromotionBlockers.mockResolvedValue(new Map([
        [probationRow.id, { blockers: ['card_not_settled'], evaluatedAt: '2026-11-11T00:00:00.000Z' }],
        [restrictedRow.id, { blockers: ['too_young'], evaluatedAt: '2026-11-11T00:00:00.000Z' }],
      ]));

      const response = await buildApp().request('/admin/trust/queue');
      const body = await response.json() as { partners: Array<Record<string, unknown>> };
      expect(readPromotionBlockers).toHaveBeenCalledWith([probationRow.id]);
      expect(body.partners[0]).toMatchObject({
        signupIpClassSource: 'offline',
        promotionBlockers: { blockers: ['card_not_settled'], evaluatedAt: '2026-11-11T00:00:00.000Z' },
      });
      // A restricted partner is held by its restriction, not by promotion blockers.
      expect(body.partners[1]).toMatchObject({ signupIpClassSource: null, promotionBlockers: null });
    });
  });

  it('adds evidence cards only when the queue caller opts in with card=1', async () => {
    state.queueRows = [{
      id: '22222222-2222-4222-8222-222222222222',
      name: 'Probation MSP',
      slug: 'probation-msp',
      plan: 'pro',
      status: 'active',
      trustState: 'probation',
      trustReason: 'signup',
      trustChangedAt: null,
      trustReviewRequestedAt: null,
      createdAt: new Date('2026-08-30T12:00:00.000Z'),
      signupIp: '192.0.2.1',
      signupIpClass: 'business',
      signupIpAsn: 64500,
      deviceCount: 1,
    }];

    const response = await buildApp().request('/admin/trust/queue?card=1');
    const body = await response.json() as { partners: Array<{ card: { partner: { id: string } } }> };
    expect(response.status).toBe(200);
    expect(body.partners[0]?.card.partner.id).toBe('22222222-2222-4222-8222-222222222222');
    expect(buildEvidenceCard).toHaveBeenCalledWith('22222222-2222-4222-8222-222222222222');
  });
});
