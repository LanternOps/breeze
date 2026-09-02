import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpClass } from '../db/schema/orgs';

const {
  readTrust, setTrustState, getSettledCardCharge, getSignupRiskHold,
  hasFraudulentRefundMatch, select, execute, runOutside, withSystem,
} = vi.hoisted(() => ({
  readTrust: vi.fn(),
  setTrustState: vi.fn(),
  getSettledCardCharge: vi.fn(),
  getSignupRiskHold: vi.fn(),
  hasFraudulentRefundMatch: vi.fn(),
  select: vi.fn(),
  execute: vi.fn(),
  runOutside: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withSystem: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../db', () => ({
  db: { select, execute },
  runOutsideDbContext: runOutside,
  withSystemDbAccessContext: withSystem,
}));
vi.mock('../db/schema', () => ({
  partners: { id: 'partners.id', createdAt: 'partners.createdAt', emailVerifiedAt: 'partners.emailVerifiedAt', signupIpClass: 'partners.signupIpClass' },
  devices: { orgId: 'devices.orgId', enrollmentIpClass: 'devices.enrollmentIpClass' },
  organizations: { id: 'organizations.id', partnerId: 'organizations.partnerId' },
  partnerAbuseSignals: { partnerId: 'signals.partnerId', severity: 'signals.severity', resolvedAt: 'signals.resolvedAt' },
}));
vi.mock('./partnerTrust.repo', () => ({ readTrust }));
vi.mock('./partnerTrust', () => ({ setTrustState }));
vi.mock('./breezeBillingClient', () => ({
  getBreezeBillingClient: () => ({
    getSettledCardCharge, getSignupRiskHold, hasFraudulentRefundMatch,
  }),
}));

import {
  evaluateHardDenies, promotionDecision, tryAutoPromote, type PromotionFacts,
} from './partnerTrustPromotion';

const now = new Date('2026-09-02T12:00:00.000Z');
const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 60 * 60 * 1_000);
const baseFacts = (): PromotionFacts => ({
  createdAt: hoursAgo(48),
  emailVerified: true,
  settledCard: { chargeId: 'ch_1', settledAt: hoursAgo(24) },
  signupIpClass: 'residential',
  deviceIpClasses: ['business'],
  unresolvedAlerts: 0,
  billingHold: false,
  billingHoldUnknown: false,
});

const hardDenyRow = (overrides: Record<string, unknown> = {}) => ({
  trust_state: 'probation',
  signup_ip_class: 'residential',
  card_partner_id: null,
  network_partner_id: null,
  candidate_ip: null,
  suspended_ip: null,
  prefix_length: null,
  corroboration_type: null,
  corroboration_value: null,
  ...overrides,
});

describe('evaluateHardDenies', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    execute.mockResolvedValue([hardDenyRow()]);
    hasFraudulentRefundMatch.mockResolvedValue(false);
  });

  it('restricts a probation partner that signed up over Tor', async () => {
    execute.mockResolvedValue([hardDenyRow({ signup_ip_class: 'tor' })]);

    await expect(evaluateHardDenies('p1')).resolves.toEqual({
      restrict: true,
      reason: 'auto:tor_signup',
      evidence: { matchedAxes: ['signup_ip_class'], signupIpClass: 'tor' },
    });
    expect(hasFraudulentRefundMatch).not.toHaveBeenCalled();
  });

  it('does not restrict on a suspended-partner network match alone', async () => {
    // No network result is returned unless SQL found a second, corroborating
    // axis; sharing an IP prefix by itself remains deliberately insufficient.
    execute.mockResolvedValue([hardDenyRow()]);

    await expect(evaluateHardDenies('p1')).resolves.toEqual({ restrict: false });
  });

  it('restricts on an IP prefix plus the same email domain and names both axes', async () => {
    execute.mockResolvedValue([hardDenyRow({
      network_partner_id: 'suspended-1',
      candidate_ip: '198.51.100.9',
      suspended_ip: '198.51.100.25',
      prefix_length: 24,
      corroboration_type: 'email_domain',
      corroboration_value: 'example.com',
    })]);

    const decision = await evaluateHardDenies('p1');

    expect(decision).toEqual(expect.objectContaining({
      restrict: true,
      reason: 'auto:corroborated_suspended_network',
      evidence: expect.objectContaining({
        matchedAxes: ['network_prefix', 'email_domain'],
        network: expect.objectContaining({ prefixLength: 24 }),
        corroboration: { type: 'email_domain', value: 'example.com' },
      }),
    }));
  });

  it('restricts on a card fingerprint belonging to a suspended-for-abuse partner', async () => {
    execute.mockResolvedValue([hardDenyRow({ card_partner_id: 'suspended-1' })]);

    await expect(evaluateHardDenies('p1')).resolves.toEqual(expect.objectContaining({
      restrict: true,
      reason: 'auto:fraud_identity_match',
      evidence: expect.objectContaining({ matchedSuspendedPartnerId: 'suspended-1' }),
    }));
  });

  it('uses the billing fraudulent-refund match as an independent fraud identity rule', async () => {
    hasFraudulentRefundMatch.mockResolvedValue(true);

    await expect(evaluateHardDenies('p1')).resolves.toEqual({
      restrict: true,
      reason: 'auto:fraud_identity_match',
      evidence: { matchedAxes: ['fraudulent_refund_customer'] },
    });
  });

  it.each(['trusted', 'restricted'] as const)('never restricts an already-%s partner', async (trustState) => {
    // In production the SQL target CTE's WHERE clause already excludes
    // non-probation partners, so this row would never come back at all. Set
    // it on the mocked row anyway (rather than an unconditional empty array
    // for both cases) to exercise evaluateHardDenies' own belt-and-suspenders
    // trust_state check independently of the SQL filter.
    execute.mockResolvedValue([hardDenyRow({ trust_state: trustState })]);

    await expect(evaluateHardDenies('p1')).resolves.toEqual({ restrict: false });
    expect(hasFraudulentRefundMatch).not.toHaveBeenCalled();
  });
});

describe('promotionDecision', () => {
  it.each([
    ['link charge', { settledCard: null }, ['card_not_settled']],
    ['23 hour card', { settledCard: { chargeId: 'ch_1', settledAt: hoursAgo(23) } }, ['settled_too_recent']],
    ['refunded card', { settledCard: null }, ['card_not_settled']],
    ['disputed card', { settledCard: null }, ['card_not_settled']],
    ['hosting signup', { signupIpClass: 'hosting' as IpClass }, ['signup_ip_hosting']],
    ['unknown signup', { signupIpClass: 'unknown' as IpClass }, ['signup_ip_unclassified']],
    ['device on hosting', { deviceIpClasses: ['hosting'] as IpClass[] }, []],
    ['device on tor', { deviceIpClasses: ['tor'] as IpClass[] }, ['device_on_tor']],
    ['unresolved alert', { unresolvedAlerts: 1 }, ['unresolved_alert']],
    ['billing hold', { billingHold: true, billingHoldUnknown: false }, ['billing_hold']],
    ['billing hold unknown (billing service unreachable)', { billingHold: true, billingHoldUnknown: true }, ['billing_hold_unknown']],
    ['email unverified', { emailVerified: false }, ['email_unverified']],
    ['partner too young', { createdAt: hoursAgo(23) }, ['too_young']],
  ] as const)('%s', (_name, overrides, blockers) => {
    const decision = promotionDecision({ ...baseFacts(), ...overrides }, now);
    if (blockers.length === 0) expect(decision).toEqual({ promote: true, reason: 'auto:settled_card_24h' });
    else expect(decision).toEqual({ promote: false, blockers });
  });

  it('promotes at the exact 24-hour boundary when all facts are clear', () => {
    expect(promotionDecision(baseFacts(), now)).toEqual({
      promote: true, reason: 'auto:settled_card_24h',
    });
  });

  it('promotes when the partner is exactly 24 hours old', () => {
    const facts = { ...baseFacts(), createdAt: hoursAgo(24) };
    expect(promotionDecision(facts, now)).toEqual({ promote: true, reason: 'auto:settled_card_24h' });
  });

  it('blocks as too_young at 23 hours 59 minutes old', () => {
    const createdAt = new Date(now.getTime() - (23 * 60 + 59) * 60 * 1_000);
    const facts = { ...baseFacts(), createdAt };
    expect(promotionDecision(facts, now)).toEqual({ promote: false, blockers: ['too_young'] });
  });
});

describe('tryAutoPromote', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readTrust.mockResolvedValue({ trustState: 'probation', probationEnrollments: 0 });
    getSettledCardCharge.mockResolvedValue({
      chargeId: 'ch_1', settledAt: hoursAgo(24), paymentMethodType: 'card',
      threeDsAuthenticated: true, cardholderName: 'Ada', disputed: false, refunded: false,
    });
    // A resolved "clear" status, not null — null now means "unknown" and
    // fails closed (see the billing-hold-unknown tests below).
    getSignupRiskHold.mockResolvedValue({ status: 'clear' });
    setTrustState.mockResolvedValue(true);

    select.mockImplementation((fields: Record<string, unknown>) => {
      if ('createdAt' in fields) {
        return { from: () => ({ where: () => ({ limit: async () => [{ createdAt: hoursAgo(48), emailVerifiedAt: hoursAgo(47), signupIpClass: 'residential' }] }) }) };
      }
      if ('ipClass' in fields) {
        return { from: () => ({ innerJoin: () => ({ where: async () => [{ ipClass: 'business' }] }) }) };
      }
      return { from: () => ({ where: async () => [{ count: 0 }] }) };
    });
  });

  it('promotes an eligible probation partner with its facts as evidence', async () => {
    await expect(tryAutoPromote('p1')).resolves.toBe(true);

    expect(setTrustState).toHaveBeenCalledWith(
      'p1', 'trusted', 'auto:settled_card_24h', null,
      expect.objectContaining({ settledCard: { chargeId: 'ch_1', settledAt: hoursAgo(24) } }),
      { expectedFrom: 'probation' },
    );
    expect(runOutside).toHaveBeenCalledTimes(1);
    expect(withSystem).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['link', { paymentMethodType: 'link' }],
    ['refunded', { refunded: true }],
    ['disputed', { disputed: true }],
    ['missing cardholder name', { cardholderName: '' }],
    ['null cardholder name', { cardholderName: null }],
    ['threeDsAuthenticated false', { threeDsAuthenticated: false }],
    ['threeDsAuthenticated null', { threeDsAuthenticated: null }],
  ])('does not promote a %s charge returned by billing', async (_name, overrides) => {
    getSettledCardCharge.mockResolvedValue({
      chargeId: 'ch_1', settledAt: hoursAgo(48), paymentMethodType: 'card',
      threeDsAuthenticated: true, cardholderName: 'Ada', disputed: false, refunded: false,
      ...overrides,
    });

    await expect(tryAutoPromote('p1')).resolves.toBe(false);
    expect(setTrustState).not.toHaveBeenCalled();
  });

  it.each(['trusted', 'restricted'] as const)('never promotes from %s', async (trustState) => {
    readTrust.mockResolvedValue({ trustState, probationEnrollments: 0 });

    await expect(tryAutoPromote('p1')).resolves.toBe(false);
    expect(setTrustState).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
  });

  it('does not promote when getSignupRiskHold returns null (unknown, fails closed)', async () => {
    getSignupRiskHold.mockResolvedValue(null);

    await expect(tryAutoPromote('p1')).resolves.toBe(false);
    expect(setTrustState).not.toHaveBeenCalled();
  });

  it('treats a CAS miss on the underlying write as "not promoted" with no audit/event', async () => {
    // setTrustState itself performs the atomic compare-and-swap (writeTrust
    // with expectedFrom); when it reports the row already moved out of
    // 'probation' (e.g. an admin restriction landed concurrently), tryAutoPromote
    // must surface that as false rather than assuming success.
    setTrustState.mockResolvedValue(false);

    await expect(tryAutoPromote('p1')).resolves.toBe(false);
    expect(setTrustState).toHaveBeenCalledWith(
      'p1', 'trusted', 'auto:settled_card_24h', null,
      expect.anything(),
      { expectedFrom: 'probation' },
    );
  });
});
