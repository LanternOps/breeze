import { describe, expect, it } from 'vitest';
import {
  LAUNCH_CATALOG_VERSION, LAUNCH_MONTHLY_PRICES_USD, LAUNCH_ANNUAL_TOTALS_USD,
  DEFAULT_LAUNCH_PURCHASE_SELECTION, newPartnerPurchaseSelectionSchema,
  launchPurchaseSelectionSchema, parseLaunchPurchaseHandoff,
  launchPurchaseHandoffQuery, registrationAliasTarget,
} from './launchPurchaseSelection';

const selection = { catalogVersion: LAUNCH_CATALOG_VERSION, capacity: 250, billingPeriod: 'annual' as const };

describe('launch purchase selection', () => {
  it('defaults only fresh partner creation to 250 devices billed monthly', () => {
    expect(DEFAULT_LAUNCH_PURCHASE_SELECTION).toEqual({
      catalogVersion: 'launch-2026-10', capacity: 250, billingPeriod: 'monthly',
    });
    expect(newPartnerPurchaseSelectionSchema.parse(undefined)).toEqual(DEFAULT_LAUNCH_PURCHASE_SELECTION);
    expect(launchPurchaseSelectionSchema.safeParse(undefined).success).toBe(false);
    expect(newPartnerPurchaseSelectionSchema.parse(selection)).toEqual(selection);
  });
  it.each(Object.keys(LAUNCH_MONTHLY_PRICES_USD).map(Number))('accepts monthly capacity %i', (capacity) => {
    expect(launchPurchaseSelectionSchema.safeParse({ ...selection, capacity, billingPeriod: 'monthly' }).success).toBe(true);
  });
  it.each(Object.keys(LAUNCH_ANNUAL_TOTALS_USD).map(Number))('accepts annual capacity %i', (capacity) => {
    expect(launchPurchaseSelectionSchema.safeParse({ ...selection, capacity }).success).toBe(true);
  });
  it.each([
    { ...selection, capacity: 150 }, { ...selection, capacity: '250' },
    { ...selection, capacity: 251 }, { ...selection, capacity: 0 },
    { ...selection, catalogVersion: 'legacy' }, { ...selection, billingPeriod: 'year' },
    { ...selection, priceId: 'price_untrusted' }, {}, null,
  ])('rejects unavailable or malformed input %j', (input) => {
    expect(launchPurchaseSelectionSchema.safeParse(input).success).toBe(false);
    expect(newPartnerPurchaseSelectionSchema.safeParse(input).success).toBe(false);
  });
  it('has the approved totals with no annual option synthesized for monthly-only capacities', () => {
    expect(LAUNCH_MONTHLY_PRICES_USD).toEqual({ 100:499,150:699,200:849,250:999,300:1199,350:1349,400:1499,450:1649,500:1799,750:2399,1000:2999 });
    expect(LAUNCH_ANNUAL_TOTALS_USD).toEqual({ 100:5388,250:10788,500:19188,1000:32388 });
  });
  it('round trips the allowlisted durable URL handoff', () => {
    const query = launchPurchaseHandoffQuery(selection);
    expect(query).toBe('catalog=launch-2026-10&capacity=250&billing=annual');
    expect(parseLaunchPurchaseHandoff(new URLSearchParams(query))).toEqual({ kind: 'selected', selection });
  });
  it('leaves no-selection and unrelated query parameters alone', () => {
    expect(parseLaunchPurchaseHandoff(new URLSearchParams('utm_source=test'))).toEqual({ kind: 'none' });
  });
  it.each([
    'capacity=250', 'catalog=launch-2026-10&capacity=250',
    'catalog=launch-2026-10&capacity=150&billing=annual',
    'catalog=launch-2026-10&capacity=250&capacity=500&billing=annual',
    'catalog=launch-2026-10&capacity=0250&billing=annual',
    'catalog=launch-2026-10&capacity=2.5e2&billing=annual',
    'catalog=launch-2026-10&capacity=250&billing=',
  ])('reports invalid selection instead of silently dropping it: %s', (query) => {
    expect(parseLaunchPurchaseHandoff(new URLSearchParams(query))).toEqual({ kind: 'invalid' });
  });
  it('preserves only handoff keys in the /register alias, including invalid duplicates for recovery', () => {
    expect(registrationAliasTarget(new URLSearchParams('capacity=250&capacity=500&next=//evil.test&billing=annual')))
      .toBe('/register-partner?capacity=250&capacity=500&billing=annual');
    expect(registrationAliasTarget(new URLSearchParams())).toBe('/register-partner');
  });
});
