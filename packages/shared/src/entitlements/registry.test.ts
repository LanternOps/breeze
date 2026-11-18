import { describe, expect, it } from 'vitest';
import { PARTNER_PLANS } from '../constants';
import {
  ENTITLEMENTS,
  ENTITLEMENT_KEYS,
  ENTITLEMENT_GRACE_DAYS,
  ENTITLEMENT_ROW_SOURCES,
  ENTITLEMENT_SOURCE_RANK,
  isEntitlementKey,
  wispLimitsSchema
} from './registry';

describe('entitlement registry', () => {
  it('has exactly the W00 key set', () => {
    expect([...ENTITLEMENT_KEYS]).toEqual(['onboarding_supervisor', 'verified_library', 'wisp']);
    expect(Object.keys(ENTITLEMENTS).sort()).toEqual([...ENTITLEMENT_KEYS].sort());
  });

  it.each(ENTITLEMENT_KEYS)('%s declares a default for every plan_type value', (key) => {
    expect(Object.keys(ENTITLEMENTS[key].defaults).sort()).toEqual([...PARTNER_PLANS].sort());
    expect(ENTITLEMENTS[key].key).toBe(key);
  });

  it.each(ENTITLEMENT_KEYS)('%s: free/starter/community disabled, pro/enterprise/unlimited enabled', (key) => {
    expect(ENTITLEMENTS[key].defaults).toEqual({
      free: 'disabled',
      starter: 'disabled',
      community: 'disabled',
      pro: 'enabled',
      enterprise: 'enabled',
      unlimited: 'enabled'
    });
  });

  it('wisp label and why line', () => {
    expect(ENTITLEMENTS.wisp.label).toBe('Wisp');
    expect(ENTITLEMENTS.wisp.why).toBe(
      'Wisp triages your fleet continuously and nudges the right person; available on Pro and above.'
    );
  });

  it('wisp per-plan limits match the W00 contract', () => {
    expect(ENTITLEMENTS.wisp.defaultLimits).toEqual({
      pro: { maxGrants: 25, budgetCentsPerDayCeiling: 1000, minFloorTickMinutes: 15 },
      enterprise: { maxGrants: 100, budgetCentsPerDayCeiling: 2500, minFloorTickMinutes: 15 },
      unlimited: { maxGrants: 500, budgetCentsPerDayCeiling: 5000, minFloorTickMinutes: 15 }
    });
  });

  it.each(ENTITLEMENT_KEYS)('%s defaultLimits (when present) validate against its own limits schema', (key) => {
    const def = ENTITLEMENTS[key];
    const values = Object.values(def.defaultLimits ?? {});
    if (values.length > 0) expect(def.limits).toBeDefined();
    for (const v of values) expect(def.limits!.safeParse(v).success).toBe(true);
  });

  it('wisp limits schema rejects unknown fields and negative numbers', () => {
    expect(
      wispLimitsSchema.safeParse({ maxGrants: 1, budgetCentsPerDayCeiling: 1, minFloorTickMinutes: 15, extra: 1 }).success
    ).toBe(false);
    expect(wispLimitsSchema.safeParse({ maxGrants: -1, budgetCentsPerDayCeiling: 1, minFloorTickMinutes: 15 }).success).toBe(
      false
    );
    expect(wispLimitsSchema.safeParse({ maxGrants: 1, budgetCentsPerDayCeiling: 1, minFloorTickMinutes: 0 }).success).toBe(false);
  });

  it('isEntitlementKey', () => {
    expect(isEntitlementKey('wisp')).toBe(true);
    expect(isEntitlementKey('ai_for_office')).toBe(false);
    expect(isEntitlementKey('toString')).toBe(false);
  });

  it('row sources rank manual > license > billing', () => {
    expect([...ENTITLEMENT_ROW_SOURCES]).toEqual(['billing', 'license', 'manual']);
    expect(ENTITLEMENT_SOURCE_RANK.manual).toBeGreaterThan(ENTITLEMENT_SOURCE_RANK.license);
    expect(ENTITLEMENT_SOURCE_RANK.license).toBeGreaterThan(ENTITLEMENT_SOURCE_RANK.billing);
  });

  it('grace is 14 days', () => {
    expect(ENTITLEMENT_GRACE_DAYS).toBe(14);
  });
});
