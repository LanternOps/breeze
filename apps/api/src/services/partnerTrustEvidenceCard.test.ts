import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  queryResults: [] as unknown[][],
  selectCalls: 0,
  resolveMx: vi.fn(),
  redisStore: new Map<string, string>(),
}));

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

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => queryChain(mocks.queryResults[mocks.selectCalls++] ?? [])),
  },
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withSystemDbAccessContext: vi.fn((fn: () => unknown) => fn()),
}));

vi.mock('node:dns', () => ({ promises: { resolveMx: mocks.resolveMx } }));

const redis = {
  set: vi.fn(async (key: string, value: string) => { mocks.redisStore.set(key, value); return 'OK'; }),
  get: vi.fn(async (key: string) => mocks.redisStore.get(key) ?? null),
  eval: vi.fn(async (_script: string, _keys: number, key: string) => {
    if (mocks.redisStore.get(key) !== 'active') return 0;
    mocks.redisStore.set(key, 'used');
    return 1;
  }),
};

vi.mock('./redis', () => ({ getRedis: vi.fn(() => redis) }));
vi.mock('./opsAlerts', () => ({ sendOpsAlert: vi.fn(async () => true) }));

import {
  buildEvidenceCard,
  consumeTrustActionToken,
  mintTrustActionToken,
  verifyTrustActionToken,
} from './partnerTrustEvidenceCard';

const PARTNER_ID = '22222222-2222-4222-8222-222222222222';
const OPERATOR_ID = '11111111-1111-4111-8111-111111111111';

describe('partner trust action tokens', () => {
  beforeEach(() => {
    vi.useRealTimers();
    mocks.redisStore.clear();
    process.env.JWT_SECRET = 'test-trust-action-secret-at-least-32-characters';
  });

  it('round-trips a signed token and enforces operator binding and single use', async () => {
    const token = mintTrustActionToken(PARTNER_ID, 'approve', OPERATOR_ID);
    await vi.waitFor(() => expect(mocks.redisStore.size).toBe(1));
    const payload = await verifyTrustActionToken(token, OPERATOR_ID);
    expect(payload).toMatchObject({ partnerId: PARTNER_ID, action: 'approve', operatorUserId: OPERATOR_ID });
    expect(await verifyTrustActionToken(token, '33333333-3333-4333-8333-333333333333')).toBeNull();
    expect(await consumeTrustActionToken(payload!.jti)).toBe(true);
    expect(await verifyTrustActionToken(token, OPERATOR_ID)).toBeNull();
  });

  it('rejects an expired token', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-02T12:00:00Z'));
    const token = mintTrustActionToken(PARTNER_ID, 'suspend', OPERATOR_ID);
    await Promise.resolve();
    vi.setSystemTime(new Date('2026-09-03T12:00:01Z'));
    expect(await verifyTrustActionToken(token, OPERATOR_ID)).toBeNull();
  });
});

describe('buildEvidenceCard', () => {
  beforeEach(() => {
    mocks.selectCalls = 0;
    mocks.resolveMx.mockResolvedValue([{ exchange: 'mx.example.test', priority: 10 }]);
    mocks.queryResults = [
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
        billingCardFingerprint: 'fp_same',
        billingDistinctPaymentMethods: 4,
        billingFailedAttempts: 7,
        billingAddressRegion: 'CO',
      }],
      [{ name: 'Alice Operator', email: 'alice@example.test' }],
      [{ hostname: 'server-1', enrollmentIpClass: 'business', isVirtual: true, enrollmentIp: '203.0.113.5' }],
      [{ count: 6 }],
      [{ id: '33333333-3333-4333-8333-333333333333', billingCardFingerprint: 'fp_same' }],
      [{ partnerId: '33333333-3333-4333-8333-333333333333', email: 'other@example.test' }],
    ];
  });

  it('builds all evidence fields in a system DB context and resolves MX', async () => {
    const card = await buildEvidenceCard(PARTNER_ID);
    expect(card).toMatchObject({
      partner: { id: PARTNER_ID, name: 'Fixture MSP', slug: 'fixture-msp', plan: 'pro', status: 'active', trustState: 'probation' },
      signup: { ip: '198.51.100.10', ipClass: 'hosting', asn: 64500 },
      emailDomain: { domain: 'example.test', ageDays: null, hasMx: true },
      identity: { userName: 'Alice Operator', cardholderName: 'Alice Operator', namesMatch: true },
      billing: { distinctPaymentMethods: 4, failedAttempts: 7, region: 'CO' },
      devices: [{ hostname: 'server-1', enrollmentIpClass: 'business', isVirtual: true, enrollmentIp: '203.0.113.5' }],
      denials24h: 6,
      matchedSuspendedAxes: ['billing_card_fingerprint', 'email_domain'],
    });
    expect(mocks.resolveMx).toHaveBeenCalledWith('example.test');
  });

  it('reports hasMx: null on a DNS error or timeout — distinct from a confirmed absence', async () => {
    mocks.resolveMx.mockRejectedValue(new Error('DNS lookup timed out'));
    const card = await buildEvidenceCard(PARTNER_ID);
    expect(card.emailDomain.hasMx).toBeNull();
  });

  it('reports hasMx: false only for a confirmed empty MX result', async () => {
    mocks.resolveMx.mockResolvedValue([]);
    const card = await buildEvidenceCard(PARTNER_ID);
    expect(card.emailDomain.hasMx).toBe(false);
  });
});
