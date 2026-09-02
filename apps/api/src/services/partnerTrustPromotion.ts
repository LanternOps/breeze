import { and, eq, isNull, sql } from 'drizzle-orm';

import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { devices, organizations, partnerAbuseSignals, partners } from '../db/schema';
import type { IpClass } from '../db/schema/orgs';
import { getBreezeBillingClient } from './breezeBillingClient';
import { readTrust } from './partnerTrust.repo';
import { setTrustState } from './partnerTrust';

const DAY_MS = 24 * 60 * 60 * 1_000;

export interface PromotionFacts {
  createdAt: Date;
  emailVerified: boolean;
  settledCard: { chargeId: string; settledAt: Date } | null;
  signupIpClass: IpClass;
  deviceIpClasses: IpClass[];
  unresolvedAlerts: number;
  billingHold: boolean;
  /**
   * True when the billing service could not tell us the risk-hold status
   * (breeze-billing 404s or the request fails) rather than affirmatively
   * reporting the partner clear. `billingHold` is forced true in this case
   * (fail closed — see gatherPromotionFacts) and this flag is what lets
   * promotionDecision report the distinct 'billing_hold_unknown' blocker.
   */
  billingHoldUnknown: boolean;
}

export type PromotionBlocker =
  | 'card_not_settled'
  | 'settled_too_recent'
  | 'signup_ip_hosting'
  | 'signup_ip_unclassified'
  | 'device_on_tor'
  | 'unresolved_alert'
  | 'billing_hold'
  | 'billing_hold_unknown'
  | 'email_unverified'
  | 'too_young';

export function promotionDecision(
  facts: PromotionFacts,
  now: Date,
): { promote: true; reason: 'auto:settled_card_24h' } | { promote: false; blockers: PromotionBlocker[] } {
  const blockers: PromotionBlocker[] = [];
  if (!facts.settledCard) blockers.push('card_not_settled');
  else if (now.getTime() - facts.settledCard.settledAt.getTime() < DAY_MS) blockers.push('settled_too_recent');
  if (facts.signupIpClass === 'unknown') blockers.push('signup_ip_unclassified');
  else if (['hosting', 'vpn', 'tor'].includes(facts.signupIpClass)) blockers.push('signup_ip_hosting');
  if (facts.deviceIpClasses.includes('tor')) blockers.push('device_on_tor');
  if (facts.unresolvedAlerts > 0) blockers.push('unresolved_alert');
  if (facts.billingHold) blockers.push(facts.billingHoldUnknown ? 'billing_hold_unknown' : 'billing_hold');
  if (!facts.emailVerified) blockers.push('email_unverified');
  if (now.getTime() - facts.createdAt.getTime() < DAY_MS) blockers.push('too_young');
  return blockers.length === 0
    ? { promote: true, reason: 'auto:settled_card_24h' }
    : { promote: false, blockers };
}

export async function gatherPromotionFacts(partnerId: string): Promise<PromotionFacts> {
  const localFacts = await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const [[partner], deviceRows, [alertRow]] = await Promise.all([
      db.select({
        createdAt: partners.createdAt,
        emailVerifiedAt: partners.emailVerifiedAt,
        signupIpClass: partners.signupIpClass,
      }).from(partners).where(eq(partners.id, partnerId)).limit(1),
      db.select({ ipClass: devices.enrollmentIpClass }).from(devices)
        .innerJoin(organizations, eq(devices.orgId, organizations.id))
        .where(eq(organizations.partnerId, partnerId)),
      db.select({ count: sql<number>`count(*)::int` }).from(partnerAbuseSignals).where(and(
        eq(partnerAbuseSignals.partnerId, partnerId),
        eq(partnerAbuseSignals.severity, 'alert'),
        isNull(partnerAbuseSignals.resolvedAt),
      )),
    ]);
    if (!partner) throw new Error(`Partner ${partnerId} not found`);
    return {
      createdAt: partner.createdAt,
      emailVerified: partner.emailVerifiedAt !== null,
      signupIpClass: partner.signupIpClass,
      deviceIpClasses: deviceRows.map((row) => row.ipClass),
      unresolvedAlerts: alertRow?.count ?? 0,
    };
  }, 'partnerTrustPromotion.gather'));

  const billing = getBreezeBillingClient();
  const [settledCard, hold] = await Promise.all([
    billing.getSettledCardCharge(partnerId),
    billing.getSignupRiskHold(partnerId),
  ]);
  // getSignupRiskHold returning null means we couldn't determine the
  // risk-hold status (404 from breeze-billing, or the request itself
  // failed) — NOT that the partner is clear. Fail closed: treat an unknown
  // status as a hold so an outage in breeze-billing can never silently
  // unblock an auto-promotion.
  const billingHoldUnknown = hold === null;
  const billingHold = billingHoldUnknown
    ? true
    : hold.status === 'hold' || hold.status === 'review_pending';
  return {
    ...localFacts,
    settledCard: settledCard && !settledCard.disputed && !settledCard.refunded
      && settledCard.paymentMethodType === 'card' && settledCard.threeDsAuthenticated
      && (settledCard.cardholderName ?? '').trim() !== ''
      ? { chargeId: settledCard.chargeId, settledAt: settledCard.settledAt }
      : null,
    billingHold,
    billingHoldUnknown,
  };
}

export async function tryAutoPromote(partnerId: string): Promise<boolean> {
  const current = await readTrust(partnerId);
  if (current?.trustState !== 'probation') return false;
  const facts = await gatherPromotionFacts(partnerId);
  const decision = promotionDecision(facts, new Date());
  if (!decision.promote) return false;
  // setTrustState's writeTrust performs the actual UPDATE under
  // `AND trust_state = 'probation'` (expectedFrom), so this is an atomic
  // compare-and-swap: an admin restriction (or a second, concurrent
  // auto-promote) that lands between the reads above and this write causes
  // the CAS to affect zero rows. setTrustState returns false in that case
  // with no audit row and no Redis publish, which we surface as "not
  // promoted" rather than treating it as success.
  return setTrustState(partnerId, 'trusted', decision.reason, null, { ...facts }, { expectedFrom: 'probation' });
}
