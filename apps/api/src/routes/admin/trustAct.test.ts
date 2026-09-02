import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  redisStore: new Map<string, string>(),
  mfaValid: true,
  setTrustState: vi.fn(),
  suspendPartnerForAbuse: vi.fn(),
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
vi.mock('./abuse', () => ({ suspendPartnerForAbuse: mocks.suspendPartnerForAbuse }));
vi.mock('../../db', () => ({
  db: { select: vi.fn() },
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withSystemDbAccessContext: vi.fn((fn: () => unknown) => fn()),
}));

import { Hono } from 'hono';
import { trustActionAdminRoutes } from './trustAct';
import {
  consumeTrustActionToken,
  mintTrustActionToken,
  verifyTrustActionToken,
} from '../../services/partnerTrustEvidenceCard';

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

describe('admin trust action route', () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    mocks.redisStore.clear();
    mocks.mfaValid = true;
    mocks.setTrustState.mockResolvedValue(undefined);
    mocks.suspendPartnerForAbuse.mockImplementation((c: any) => c.json({ status: 'suspended' }));
    process.env.JWT_SECRET = 'test-trust-action-secret-at-least-32-characters';
  });

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
