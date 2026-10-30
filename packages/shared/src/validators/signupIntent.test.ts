import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import * as shared from './index';
import {
  signupIntentSchema, DEFAULT_SIGNUP_INTENT, parseSignupIntentParams, normalizeSignupIntent,
  signupIntentHandoffQuery, registrationAliasTarget, partnerPurchaseSelectionSchema,
} from './signupIntent';

describe('signupIntentSchema', () => {
  it.each([
    { intent: 'cloud' }, { intent: 'cloud', offer: 'founding' },
    { intent: 'wisp' }, { intent: 'wisp', offer: 'founding' },
  ])('accepts %j', (input) => {
    expect(signupIntentSchema.parse(input)).toEqual(input);
  });
  it.each([
    { intent: 'hosting' }, { intent: 'cloud', offer: 'Founding' },
    { intent: 'cloud', offer: 'a'.repeat(33) }, { intent: 'cloud', offer: 7 },
    { intent: 'cloud', capacity: 250 }, {}, null, [],
  ])('rejects %j', (input) => {
    expect(signupIntentSchema.safeParse(input).success).toBe(false);
  });
});

describe('DEFAULT_SIGNUP_INTENT', () => {
  it('is cloud and frozen', () => {
    expect(DEFAULT_SIGNUP_INTENT).toEqual({ intent: 'cloud' });
    expect(Object.isFrozen(DEFAULT_SIGNUP_INTENT)).toBe(true);
  });
});

describe('parseSignupIntentParams', () => {
  it.each([
    ['', { intent: 'cloud' }],
    ['intent=cloud&offer=founding', { intent: 'cloud', offer: 'founding' }],
    ['intent=wisp&offer=founding', { intent: 'wisp', offer: 'founding' }],
    ['intent=wisp', { intent: 'wisp' }],
    ['intent=hosting', { intent: 'cloud' }],
    ['intent=cloud&offer=%3Cx%3E', { intent: 'cloud' }],
    ['intent=cloud&intent=wisp', { intent: 'cloud' }],
    ['catalog=launch-2026-10&capacity=250&billing=monthly', { intent: 'cloud' }],
    ['utm_source=x', { intent: 'cloud' }],
  ])('%s', (q, expected) => {
    expect(parseSignupIntentParams(new URLSearchParams(q))).toEqual(expected);
  });
});

describe('normalizeSignupIntent', () => {
  it('defaults, collapses the launch tuple, passes valid, throws on invalid', () => {
    expect(normalizeSignupIntent(undefined)).toEqual(DEFAULT_SIGNUP_INTENT);
    expect(normalizeSignupIntent({ catalogVersion: 'launch-2026-10', capacity: 250, billingPeriod: 'monthly' }))
      .toEqual({ intent: 'cloud' });
    expect(normalizeSignupIntent({ intent: 'wisp', offer: 'founding' })).toEqual({ intent: 'wisp', offer: 'founding' });
    expect(() => normalizeSignupIntent({ intent: 'hosting' })).toThrow(ZodError);
  });
});

describe('handoff helpers', () => {
  it('builds the handoff query', () => {
    expect(signupIntentHandoffQuery({ intent: 'cloud', offer: 'founding' })).toBe('intent=cloud&offer=founding');
    expect(signupIntentHandoffQuery({ intent: 'cloud' })).toBe('intent=cloud');
  });
  it('alias keeps only intent and offer', () => {
    expect(registrationAliasTarget(new URLSearchParams('intent=wisp&offer=founding&next=//evil.test')))
      .toBe('/register-partner?intent=wisp&offer=founding');
    expect(registrationAliasTarget(new URLSearchParams())).toBe('/register-partner');
  });
});

describe('partnerPurchaseSelectionSchema', () => {
  it('accepts an intent or an allowlisted launch tuple, rejects capacity 150 annual', () => {
    expect(partnerPurchaseSelectionSchema.safeParse({ intent: 'cloud' }).success).toBe(true);
    const tuple = { catalogVersion: 'launch-2026-10', capacity: 250, billingPeriod: 'annual' };
    expect(partnerPurchaseSelectionSchema.safeParse(tuple).success).toBe(true);
    expect(partnerPurchaseSelectionSchema.safeParse({ ...tuple, capacity: 150 }).success).toBe(false);
  });
});

describe('core holds no prices', () => {
  it('exports none of the retired launch symbols', () => {
    for (const name of ['LAUNCH_MONTHLY_PRICES_USD', 'LAUNCH_ANNUAL_TOTALS_USD',
      'DEFAULT_LAUNCH_PURCHASE_SELECTION', 'newPartnerPurchaseSelectionSchema']) {
      expect(shared).not.toHaveProperty(name);
    }
  });
});
