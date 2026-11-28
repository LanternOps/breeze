import { afterEach, describe, expect, it } from 'vitest';
import {
  deployKeyBillingConfigured,
  evaluateDeployKeyEligibility,
  type DeployKeyEligibilityFacts,
} from './eligibility';

const eligible: DeployKeyEligibilityFacts = {
  trustState: 'trusted',
  deployKeyEnrollmentEnabled: true,
  paymentMethodAttachedAt: new Date('2026-11-01T00:00:00Z'),
  billingSubscriptionStatus: 'active',
};

const billed = { billingConfigured: true };
const selfHosted = { billingConfigured: false };

describe('evaluateDeployKeyEligibility (spec §10.3, §13 decision 10)', () => {
  it('passes a trusted partner with the switch on and, under billing, a payment method and no veto', () => {
    expect(evaluateDeployKeyEligibility(eligible, billed)).toEqual({ eligible: true });
    expect(evaluateDeployKeyEligibility(eligible, selfHosted)).toEqual({ eligible: true });
  });

  it('refuses a missing partner', () => {
    expect(evaluateDeployKeyEligibility(null, billed)).toEqual({ eligible: false, reason: 'partner_not_found' });
    expect(evaluateDeployKeyEligibility(undefined, selfHosted)).toEqual({ eligible: false, reason: 'partner_not_found' });
  });

  it.each(['probation', 'restricted'])('refuses trust_state %s, with or without billing', (trustState) => {
    for (const options of [billed, selfHosted]) {
      expect(evaluateDeployKeyEligibility({ ...eligible, trustState }, options))
        .toEqual({ eligible: false, reason: 'partner_not_trusted' });
    }
  });

  it('refuses with the partner switch off, with or without billing', () => {
    for (const options of [billed, selfHosted]) {
      expect(evaluateDeployKeyEligibility({ ...eligible, deployKeyEnrollmentEnabled: false }, options))
        .toEqual({ eligible: false, reason: 'enrollment_switch_off' });
    }
  });

  it('under billing, requires the payment stamp', () => {
    expect(evaluateDeployKeyEligibility({ ...eligible, paymentMethodAttachedAt: null }, billed))
      .toEqual({ eligible: false, reason: 'payment_method_missing' });
  });

  it.each(['incomplete', 'incomplete_expired', 'canceled', 'unpaid', 'paused'])(
    'under billing, the non-entitled status %s vetoes the stamp',
    (billingSubscriptionStatus) => {
      expect(evaluateDeployKeyEligibility({ ...eligible, billingSubscriptionStatus }, billed))
        .toEqual({ eligible: false, reason: 'billing_status_contradicts_payment' });
    },
  );

  it.each([null, 'active', 'trialing', 'past_due', 'something_new'])(
    'under billing, the status %s is not a veto (a veto, not a requirement)',
    (billingSubscriptionStatus) => {
      expect(evaluateDeployKeyEligibility({ ...eligible, billingSubscriptionStatus }, billed)).toEqual({ eligible: true });
    },
  );

  it('self-hosted (no billing) skips both payment clauses', () => {
    expect(evaluateDeployKeyEligibility({ ...eligible, paymentMethodAttachedAt: null, billingSubscriptionStatus: 'canceled' }, selfHosted))
      .toEqual({ eligible: true });
  });

  it('checks trust before the switch, and both before payment', () => {
    expect(evaluateDeployKeyEligibility({ trustState: 'restricted', deployKeyEnrollmentEnabled: false, paymentMethodAttachedAt: null, billingSubscriptionStatus: 'canceled' }, billed))
      .toEqual({ eligible: false, reason: 'partner_not_trusted' });
    expect(evaluateDeployKeyEligibility({ ...eligible, deployKeyEnrollmentEnabled: false, paymentMethodAttachedAt: null }, billed))
      .toEqual({ eligible: false, reason: 'enrollment_switch_off' });
  });
});

describe('deployKeyBillingConfigured', () => {
  const original = process.env.BREEZE_BILLING_URL;
  afterEach(() => {
    if (original === undefined) delete process.env.BREEZE_BILLING_URL;
    else process.env.BREEZE_BILLING_URL = original;
  });

  it('follows BREEZE_BILLING_URL per call, blank meaning unset', () => {
    delete process.env.BREEZE_BILLING_URL;
    expect(deployKeyBillingConfigured()).toBe(false);
    process.env.BREEZE_BILLING_URL = '   ';
    expect(deployKeyBillingConfigured()).toBe(false);
    process.env.BREEZE_BILLING_URL = 'https://billing.example.test';
    expect(deployKeyBillingConfigured()).toBe(true);
  });

  it('is the default when no option is passed', () => {
    const noStamp = { ...eligible, paymentMethodAttachedAt: null };
    delete process.env.BREEZE_BILLING_URL;
    expect(evaluateDeployKeyEligibility(noStamp)).toEqual({ eligible: true });
    process.env.BREEZE_BILLING_URL = 'https://billing.example.test';
    expect(evaluateDeployKeyEligibility(noStamp)).toEqual({ eligible: false, reason: 'payment_method_missing' });
  });
});
