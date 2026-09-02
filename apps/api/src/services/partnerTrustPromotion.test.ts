import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpClass } from '../db/schema/orgs';

const { readTrust, setTrustState, getSettledCardCharge, getSignupRiskHold, select, runOutside, withSystem } = vi.hoisted(() => ({
  readTrust: vi.fn(),
  setTrustState: vi.fn(),
  getSettledCardCharge: vi.fn(),
  getSignupRiskHold: vi.fn(),
  select: vi.fn(),
  runOutside: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withSystem: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../db', () => ({
  db: { select },
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
  getBreezeBillingClient: () => ({ getSettledCardCharge, getSignupRiskHold }),
}));

import { promotionDecision, tryAutoPromote, type PromotionFacts } from './partnerTrustPromotion';

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
    ['billing hold', { billingHold: true }, ['billing_hold']],
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
});

describe('tryAutoPromote', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readTrust.mockResolvedValue({ trustState: 'probation', probationEnrollments: 0 });
    getSettledCardCharge.mockResolvedValue({
      chargeId: 'ch_1', settledAt: hoursAgo(24), paymentMethodType: 'card',
      threeDsAuthenticated: true, cardholderName: 'Ada', disputed: false, refunded: false,
    });
    getSignupRiskHold.mockResolvedValue(null);

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
    );
    expect(runOutside).toHaveBeenCalledTimes(1);
    expect(withSystem).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['link', { paymentMethodType: 'link' }],
    ['refunded', { refunded: true }],
    ['disputed', { disputed: true }],
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

  it('does not overwrite a restriction applied while facts were gathered', async () => {
    readTrust
      .mockResolvedValueOnce({ trustState: 'probation', probationEnrollments: 0 })
      .mockResolvedValueOnce({ trustState: 'restricted', probationEnrollments: 0 });

    await expect(tryAutoPromote('p1')).resolves.toBe(false);
    expect(setTrustState).not.toHaveBeenCalled();
  });
});
