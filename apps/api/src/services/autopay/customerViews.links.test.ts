import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ rows: new Map<unknown, any[]>(), inspect: vi.fn(), method: vi.fn() }));
vi.mock('../../db', () => {
  const query = () => {
    let table: unknown;
    const c: any = {};
    c.from = (t: unknown) => { table = t; return c; };
    for (const op of ['where', 'limit', 'innerJoin', 'orderBy']) c[op] = () => c;
    c.then = (resolve: any, reject: any) => Promise.resolve(h.rows.get(table) ?? []).then(resolve, reject);
    return c;
  };
  return { db: { select: () => query() }, runOutsideDbContext: (fn: () => unknown) => fn(),
    withSystemDbAccessContext: (fn: () => unknown) => fn() };
});
vi.mock('./linkTokens', () => ({ inspectBillingLinkToken: h.inspect, resolveBillingLinkToken: vi.fn() }));
vi.mock('./paymentMethods', () => ({ getAutopayMethod: h.method }));
vi.mock('./consentText', () => ({ buildAutopayDisclosure: vi.fn() }));
vi.mock('./stripeCapabilities', () => ({ getAutopayStripeReadiness: vi.fn() }));
vi.mock('./billingPaymentSettings', () => ({ resolveBillingPaymentSettings: vi.fn() }));
vi.mock('./enrollmentService', () => ({ completeAutopaySetup: vi.fn() }));
import { describeAutopayLinkFailure, getAutopayStopView } from './customerViews';
import { invoices, organizations, orgAutopayEnrollments, partners, portalBranding } from '../../db/schema';

const orgId = '11111111-1111-4111-8111-111111111111';
const partnerId = '22222222-2222-4222-8222-222222222222';
const link = { id: 'link', orgId, enrollmentId: 'enrollment', generation: 2, purpose: 'enroll' };
const branding = { partnerName: 'Example MSP', logoUrl: 'https://cdn.example/logo.png', supportEmail: 'billing@msp.example' };
beforeEach(() => {
  vi.clearAllMocks(); h.rows.clear();
  h.rows.set(organizations, [{ id: orgId, partnerId, name: 'Client', status: 'active', deletedAt: null }]);
  h.rows.set(partners, [{ name: 'Example MSP', billingEmail: 'billing@msp.example' }]);
  h.rows.set(portalBranding, [{ logoUrl: 'https://cdn.example/logo.png' }]);
  h.rows.set(orgAutopayEnrollments, [{ id: 'enrollment', orgId, status: 'active', generation: 2 }]);
});

describe('describeAutopayLinkFailure', () => {
  it('an unknown token reveals no partner, org or enrollment', async () => {
    h.inspect.mockResolvedValue({ row: null, failure: 'invalid' });
    const failure = await describeAutopayLinkFailure('token', 'enroll');
    expect(failure).toEqual({ error: expect.any(String), code: 'link_invalid' });
  });
  it.each([
    ['an expired link', { failure: 'expired' }, { code: 'link_expired' }],
    ['a used setup link after enrolling', { failure: 'consumed' }, { code: 'link_used', enrollmentStatus: 'active' }],
    ['an old link after a resend', { failure: 'revoked', row: { ...link, generation: 1 } }, { code: 'link_replaced' }],
    ['a matched link whose generation moved on', { failure: null, row: { ...link, generation: 1 } }, { code: 'link_replaced' }],
  ] as const)('%s', async (_label, inspected, expected) => {
    h.inspect.mockResolvedValue({ row: link, ...inspected });
    const { enrollmentStatus, ...code } = expected as { code: string; enrollmentStatus?: string };
    expect(await describeAutopayLinkFailure('token', 'enroll')).toMatchObject({ ...code, data: { ...branding, ...(enrollmentStatus ? { enrollmentStatus } : {}) } });
  });
  it('a stop link revoked by the stop itself says automatic payments are off', async () => {
    h.rows.set(orgAutopayEnrollments, [{ id: 'enrollment', orgId, status: 'cancelled', generation: 2 }]);
    h.inspect.mockResolvedValue({ row: { ...link, purpose: 'stop_autopay' }, failure: 'revoked' });
    expect(await describeAutopayLinkFailure('token', 'stop_autopay'))
      .toMatchObject({ code: 'link_used', data: { enrollmentStatus: 'cancelled', ...branding } });
  });
  it('a link for a deleted or suspended org is invalid and reveals nothing', async () => {
    h.rows.set(organizations, [{ id: orgId, partnerId, status: 'suspended', deletedAt: null }]);
    h.inspect.mockResolvedValue({ row: link, failure: 'expired' });
    expect(await describeAutopayLinkFailure('token', 'enroll')).toEqual({ error: expect.any(String), code: 'link_invalid' });
  });
});

describe('getAutopayStopView', () => {
  it('names the MSP, the method being removed and how many invoices stay open', async () => {
    h.rows.set(orgAutopayEnrollments, [{ id: 'enrollment', orgId, status: 'active', generation: 2, effectiveFrom: new Date('2026-10-05T04:05:08Z'),
      needsAttentionReason: null, cancelSource: null, cancelledAt: null, pausedAt: null }]);
    h.rows.set(invoices, [{ count: 2 }]);
    h.method.mockResolvedValue({ type: 'card', cardBrand: 'visa', cardFunding: 'credit', cardLast4: '4242', cardExpMonth: 12, cardExpYear: 2031,
      bankName: null, bankLast4: null, status: 'active' });
    expect(await getAutopayStopView(orgId)).toMatchObject({ ...branding, orgName: 'Client', openInvoiceCount: 2,
      enrollment: { status: 'active', effectiveFrom: '2026-10-05T04:05:08.000Z' }, method: { type: 'card', cardLast4: '4242' } });
  });
  it('reports who stopped automatic payments and when', async () => {
    h.rows.set(orgAutopayEnrollments, [{ id: 'enrollment', orgId, status: 'cancelled', generation: 2, effectiveFrom: null, needsAttentionReason: null,
      cancelSource: 'msp', cancelledAt: new Date('2026-10-06T10:00:00Z'), pausedAt: null }]);
    h.method.mockResolvedValue(null);
    expect(await getAutopayStopView(orgId)).toMatchObject({ enrollment: { status: 'cancelled', cancelSource: 'msp',
      cancelledAt: '2026-10-06T10:00:00.000Z' }, method: null, openInvoiceCount: 0 });
  });
});
