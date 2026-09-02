import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  redisStore: new Map<string, string>(),
  mfaValid: true,
  setTrustState: vi.fn(),
  suspendPartnerForAbuse: vi.fn(),
  dbQueryResults: [] as unknown[][],
  dbSelectCalls: 0,
}));

const redis = {
  set: vi.fn(async (key: string, value: string) => { mocks.redisStore.set(key, value); return 'OK'; }),
  get: vi.fn(async (key: string) => mocks.redisStore.get(key) ?? null),
  eval: vi.fn(async (_script: string, _keys: number, key: string) => {
    if (mocks.redisStore.get(key) !== 'active') return 0;
    mocks.redisStore.set(key, 'used');
    return 1;
  }),
};

vi.mock('../../services/redis', () => ({ getRedis: vi.fn(() => redis) }));
vi.mock('../auth/helpers', () => ({
  requireFreshMfaStepUp: vi.fn(async (c: any) =>
    mocks.mfaValid ? null : c.json({ error: 'Invalid credentials' }, 401)),
}));
vi.mock('../../services/partnerTrust', () => ({ setTrustState: mocks.setTrustState }));
// Partial mock: this test file also mounts the REAL `adminRoutes` (see the
// "real auth boundary" describe block below), which imports the REAL
// `abuseRoutes` sub-router from this same module — importOriginal keeps that
// intact while still letting every test override `suspendPartnerForAbuse`,
// the one export the trust-action route itself calls.
vi.mock('./abuse', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./abuse')>();
  return { ...actual, suspendPartnerForAbuse: mocks.suspendPartnerForAbuse };
});

// Chainable `db.select(...).from(...).where(...).limit(...)` stand-in, queued
// by call order. Used both by authMiddleware's user lookup (real-auth test
// below) and by buildEvidenceCard's multi-query chain (preview tests).
function queryChain(rows: unknown[]) {
  const promise = Promise.resolve(rows);
  const chain: Record<string, unknown> = {};
  for (const method of ['from', 'where', 'limit', 'orderBy', 'innerJoin']) {
    chain[method] = vi.fn(() => chain);
  }
  chain.then = promise.then.bind(promise);
  chain.catch = promise.catch.bind(promise);
  chain.finally = promise.finally.bind(promise);
  return chain;
}

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(() => queryChain(mocks.dbQueryResults[mocks.dbSelectCalls++] ?? [])),
    insert: vi.fn(() => ({ values: vi.fn(() => Promise.resolve()) })),
  },
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withSystemDbAccessContext: vi.fn((fn: () => unknown) => fn()),
  withDbAccessContext: vi.fn((_ctx: unknown, fn: () => unknown) => fn()),
}));

import { Hono } from 'hono';
import { trustActionAdminRoutes } from './trustAct';
import {
  consumeTrustActionToken,
  mintTrustActionToken,
  verifyTrustActionToken,
} from '../../services/partnerTrustEvidenceCard';
import { createAccessToken } from '../../services/jwt';

const PARTNER_ID = '22222222-2222-4222-8222-222222222222';
const OPERATOR_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_OPERATOR_ID = '33333333-3333-4333-8333-333333333333';

function buildApp(userId = OPERATOR_ID) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth', {
      user: { id: userId, email: 'admin@breeze.test', name: 'Admin', isPlatformAdmin: true },
      principal: { kind: 'user_session' },
    } as never);
    await next();
  });
  app.route('/admin', trustActionAdminRoutes);
  return app;
}

async function post(token: string, userId = OPERATOR_ID) {
  return buildApp(userId).request('/admin/trust/act', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, totp: '123456' }),
  });
}

async function preview(token: string | null, userId = OPERATOR_ID) {
  const qs = token !== null ? `?token=${encodeURIComponent(token)}` : '';
  return buildApp(userId).request(`/admin/trust/act/preview${qs}`);
}

/** Fixture row for buildEvidenceCard's partner select — no suspended-axis
 * lookups (billingAddressRegion null) so the preview happy-path needs only
 * the 4 selects: partner, primary user, devices, denials. */
function seedEvidenceCardQueries() {
  mocks.dbSelectCalls = 0;
  mocks.dbQueryResults = [
    [{
      id: PARTNER_ID,
      name: 'Fixture MSP',
      slug: 'fixture-msp',
      plan: 'pro',
      status: 'active',
      trustState: 'probation',
      signupIp: '198.51.100.10',
      signupIpClass: 'hosting',
      signupIpAsn: 64500,
      billingCardholderName: 'Alice Operator',
      billingCardFingerprint: 'fp_1',
      billingDistinctPaymentMethods: 1,
      billingFailedAttempts: 0,
      billingAddressRegion: null,
    }],
    [{ name: 'Alice Operator', email: 'alice@example.test' }],
    [],
    [{ count: 0 }],
  ];
}

describe('admin trust action route', () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    mocks.redisStore.clear();
    mocks.mfaValid = true;
    mocks.dbQueryResults = [];
    mocks.dbSelectCalls = 0;
    mocks.setTrustState.mockResolvedValue(undefined);
    mocks.suspendPartnerForAbuse.mockImplementation((c: any) => c.json({ status: 'suspended' }));
    process.env.JWT_SECRET = 'test-trust-action-secret-at-least-32-characters';
  });

  describe('POST /admin/trust/act', () => {
    it('returns 403 for expired, used, and operator-mismatched tokens', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-09-02T12:00:00Z'));
      const expired = mintTrustActionToken(PARTNER_ID, 'approve', OPERATOR_ID);
      await Promise.resolve();
      vi.setSystemTime(new Date('2026-09-03T12:00:01Z'));
      expect((await post(expired)).status).toBe(403);
      vi.useRealTimers();

      const used = mintTrustActionToken(PARTNER_ID, 'approve', OPERATOR_ID);
      const usedPayload = await verifyTrustActionToken(used, OPERATOR_ID);
      expect(await consumeTrustActionToken(usedPayload!.jti)).toBe(true);
      expect((await post(used)).status).toBe(403);

      const mismatched = mintTrustActionToken(PARTNER_ID, 'approve', OPERATOR_ID);
      expect((await post(mismatched, OTHER_OPERATOR_ID)).status).toBe(403);
      expect(mocks.setTrustState).not.toHaveBeenCalled();
    });

    it('returns 403 for a wrong TOTP without consuming the action token', async () => {
      mocks.mfaValid = false;
      const token = mintTrustActionToken(PARTNER_ID, 'approve', OPERATOR_ID);
      expect((await post(token)).status).toBe(403);
      expect(await verifyTrustActionToken(token, OPERATOR_ID)).not.toBeNull();
      expect(mocks.setTrustState).not.toHaveBeenCalled();
    });

    it('changes trust state and consumes the jti after a correct TOTP', async () => {
      const token = mintTrustActionToken(PARTNER_ID, 'approve', OPERATOR_ID);
      const response = await post(token);
      expect(response.status).toBe(200);
      expect(mocks.setTrustState).toHaveBeenCalledWith(
        PARTNER_ID,
        'trusted',
        'admin:approve_link',
        OPERATOR_ID,
        { via: 'email_card' },
      );
      expect(await verifyTrustActionToken(token, OPERATOR_ID)).toBeNull();
    });

    it('uses the existing abuse suspension flow for suspend actions', async () => {
      const token = mintTrustActionToken(PARTNER_ID, 'suspend', OPERATOR_ID);
      const response = await post(token);
      expect(response.status).toBe(200);
      expect(mocks.suspendPartnerForAbuse).toHaveBeenCalledWith(expect.anything(), PARTNER_ID, 'trust_card_link');
    });
  });

  describe('GET /admin/trust/act/preview', () => {
    it('returns the evidence card without consuming or acting on a valid token', async () => {
      seedEvidenceCardQueries();
      const token = mintTrustActionToken(PARTNER_ID, 'approve', OPERATOR_ID);
      const response = await preview(token);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({
        valid: true,
        action: 'approve',
        partner: {
          id: PARTNER_ID,
          name: 'Fixture MSP',
          slug: 'fixture-msp',
          plan: 'pro',
          trustState: 'probation',
        },
        card: { partner: { id: PARTNER_ID } },
      });
      expect(body.reason).toBeUndefined();

      // Not consumed: the token is still usable by the real POST route, and
      // no action was taken as a side effect of previewing it.
      expect(await verifyTrustActionToken(token, OPERATOR_ID)).not.toBeNull();
      expect(mocks.setTrustState).not.toHaveBeenCalled();
      expect(mocks.suspendPartnerForAbuse).not.toHaveBeenCalled();
    });

    it('reports bad_signature for a missing or tampered token', async () => {
      const missing = await preview(null);
      expect(missing.status).toBe(200);
      expect(await missing.json()).toEqual({ valid: false, reason: 'bad_signature' });

      const token = mintTrustActionToken(PARTNER_ID, 'approve', OPERATOR_ID);
      const tampered = `${token.slice(0, -4)}XXXX`;
      const response = await preview(tampered);
      expect(await response.json()).toEqual({ valid: false, reason: 'bad_signature' });
    });

    it('reports expired for a token past its exp claim', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-09-02T12:00:00Z'));
      const token = mintTrustActionToken(PARTNER_ID, 'approve', OPERATOR_ID);
      await Promise.resolve();
      vi.setSystemTime(new Date('2026-09-03T12:00:01Z'));
      const response = await preview(token);
      vi.useRealTimers();
      expect(await response.json()).toEqual({ valid: false, reason: 'expired' });
    });

    it('reports used for an already-consumed token', async () => {
      const token = mintTrustActionToken(PARTNER_ID, 'approve', OPERATOR_ID);
      const payload = await verifyTrustActionToken(token, OPERATOR_ID);
      expect(await consumeTrustActionToken(payload!.jti)).toBe(true);
      const response = await preview(token);
      expect(await response.json()).toEqual({ valid: false, reason: 'used' });
    });

    it('reports operator_mismatch for a token minted for a different operator', async () => {
      const token = mintTrustActionToken(PARTNER_ID, 'approve', OPERATOR_ID);
      const response = await preview(token, OTHER_OPERATOR_ID);
      expect(await response.json()).toEqual({ valid: false, reason: 'operator_mismatch' });
      expect(mocks.setTrustState).not.toHaveBeenCalled();
      expect(mocks.suspendPartnerForAbuse).not.toHaveBeenCalled();
    });
  });
});

// Wave 5.5 fix round 1: the tests above build their own tiny Hono app and
// inject `auth` directly, which never exercises the real platform-admin gate
// (platformAdminMiddleware -> authMiddleware). This block mounts the REAL
// `adminRoutes` aggregator (routes/admin/index.ts, same as production) so the
// actual bearer-auth boundary in front of POST /admin/trust/act is what gets
// asserted on, not a stand-in.
describe('POST /admin/trust/act — real auth boundary (routes/admin/index.ts)', () => {
  const ADMIN_EMAIL = 'admin@breeze.test';
  const AUTH_EPOCH = 5;
  const MFA_EPOCH = 3;

  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    mocks.redisStore.clear();
    mocks.mfaValid = true;
    mocks.dbQueryResults = [];
    mocks.dbSelectCalls = 0;
    mocks.setTrustState.mockResolvedValue(undefined);
    mocks.suspendPartnerForAbuse.mockImplementation((c: any) => c.json({ status: 'suspended' }));
    process.env.JWT_SECRET = 'test-trust-action-secret-at-least-32-characters';
    // authMiddleware's pre-auth user lookup — the only `db.select` this path
    // hits for a system-scope token (computeAccessibleOrgIds short-circuits
    // for scope='system', and ipAllowlistGuard short-circuits on a null
    // partnerId), so a single queued row is enough.
    mocks.dbQueryResults = [[{
      id: OPERATOR_ID,
      email: ADMIN_EMAIL,
      name: 'Admin',
      status: 'active',
      passwordChangedAt: null,
      mfaEnabled: true,
      isPlatformAdmin: true,
      authEpoch: AUTH_EPOCH,
      mfaEpoch: MFA_EPOCH,
    }]];
  });

  async function realApp() {
    const { adminRoutes } = await import('./index');
    const app = new Hono();
    app.route('/admin', adminRoutes);
    return app;
  }

  async function platformAdminBearer() {
    return createAccessToken({
      sub: OPERATOR_ID,
      email: ADMIN_EMAIL,
      roleId: null,
      orgId: null,
      partnerId: null,
      scope: 'system',
      mfa: true,
      aep: AUTH_EPOCH,
      mep: MFA_EPOCH,
      sid: 'test-session',
    });
  }

  it('returns 401 with no bearer at all', async () => {
    const token = mintTrustActionToken(PARTNER_ID, 'approve', OPERATOR_ID);
    const app = await realApp();
    const response = await app.request('/admin/trust/act', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, totp: '123456' }),
    });
    expect(response.status).toBe(401);
    expect(mocks.setTrustState).not.toHaveBeenCalled();
  });

  it('proceeds through the real platform-admin gate with a valid bearer + fresh TOTP', async () => {
    const token = mintTrustActionToken(PARTNER_ID, 'approve', OPERATOR_ID);
    const bearer = await platformAdminBearer();
    const app = await realApp();
    const response = await app.request('/admin/trust/act', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${bearer}`,
      },
      body: JSON.stringify({ token, totp: '123456' }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, partnerId: PARTNER_ID, trustState: 'trusted' });
    expect(mocks.setTrustState).toHaveBeenCalledWith(
      PARTNER_ID,
      'trusted',
      'admin:approve_link',
      OPERATOR_ID,
      { via: 'email_card' },
    );
  });
});
