import { describe, expect, it } from 'vitest';
import {
  LAUNCH_CATALOG_VERSION, LEGACY_LAUNCH_CAPACITIES, launchPurchaseSelectionSchema,
} from './launchPurchaseSelection';

const selection = { catalogVersion: LAUNCH_CATALOG_VERSION, capacity: 250, billingPeriod: 'annual' as const };

describe('legacy launch purchase selection', () => {
  it('has the approved capacity allowlists', () => {
    expect(LEGACY_LAUNCH_CAPACITIES).toEqual({
      monthly: [100, 150, 200, 250, 300, 350, 400, 450, 500, 750, 1000],
      annual: [100, 250, 500, 1000],
    });
  });
  it.each(LEGACY_LAUNCH_CAPACITIES.monthly)('accepts monthly capacity %i', (capacity) => {
    expect(launchPurchaseSelectionSchema.safeParse({ ...selection, capacity, billingPeriod: 'monthly' }).success).toBe(true);
  });
  it.each(LEGACY_LAUNCH_CAPACITIES.annual)('accepts annual capacity %i', (capacity) => {
    expect(launchPurchaseSelectionSchema.safeParse({ ...selection, capacity }).success).toBe(true);
  });
  it.each([
    { ...selection, capacity: 150 }, { ...selection, capacity: '250' },
    { ...selection, capacity: 251 }, { ...selection, capacity: 0 },
    { ...selection, catalogVersion: 'legacy' }, { ...selection, billingPeriod: 'year' },
    { ...selection, priceId: 'price_untrusted' }, undefined, {}, null,
  ])('rejects unavailable or malformed input %j', (input) => {
    expect(launchPurchaseSelectionSchema.safeParse(input).success).toBe(false);
  });
});
