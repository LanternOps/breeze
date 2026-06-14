import { describe, it, expect } from 'vitest';
import {
  deriveUnitPrice,
  resolvePriceFrom,
  detectBundleProblems,
  computeBundleEconomicsFrom
} from './catalogPricing';

describe('deriveUnitPrice', () => {
  it('derives from cost + markup when no explicit price given', () => {
    expect(deriveUnitPrice({ explicitPrice: undefined, costBasis: '100.00', markupPercent: '25.00' })).toBe('125.00');
  });
  it('prefers explicit price over markup derivation', () => {
    expect(deriveUnitPrice({ explicitPrice: 199, costBasis: '100.00', markupPercent: '25.00' })).toBe('199.00');
  });
  it('returns explicit price when no markup/cost', () => {
    expect(deriveUnitPrice({ explicitPrice: 50, costBasis: null, markupPercent: null })).toBe('50.00');
  });
  it('returns 0.00 when cost is given but markup is null (no derivation possible)', () => {
    expect(deriveUnitPrice({ explicitPrice: undefined, costBasis: '100.00', markupPercent: null })).toBe('0.00');
  });
  it('returns 0.00 when everything is null/undefined', () => {
    expect(deriveUnitPrice({ explicitPrice: undefined, costBasis: null, markupPercent: null })).toBe('0.00');
  });
  it('rounds the marked-up price to the nearest cent', () => {
    // 33.33 * 1.10 = 36.663 -> rounds to 36.66
    expect(deriveUnitPrice({ explicitPrice: undefined, costBasis: '33.33', markupPercent: '10' })).toBe('36.66');
  });
});

describe('resolvePriceFrom', () => {
  const item = { unitPrice: '100.00', costBasis: '60.00', taxable: true, taxCategory: 'GST' };
  it('uses the org override when present', () => {
    const r = resolvePriceFrom(item, { unitPrice: '80.00' });
    expect(r).toEqual({ unitPrice: '80.00', costBasis: '60.00', taxable: true, taxCategory: 'GST', source: 'org_override' });
  });
  it('falls back to the item price when no override', () => {
    const r = resolvePriceFrom(item, null);
    expect(r.unitPrice).toBe('100.00');
    expect(r.source).toBe('item');
  });
});

describe('detectBundleProblems', () => {
  const A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  it('rejects a bundle containing itself', () => {
    const problems = detectBundleProblems({
      bundleId: A,
      components: [{ componentItemId: A, quantity: 1 }],
      componentMeta: new Map([[A, { isBundle: false, partnerId: 'p1' }]]),
      bundlePartnerId: 'p1'
    });
    expect(problems).toContain('SELF_REFERENCE');
  });
  it('rejects a component that is itself a bundle', () => {
    const problems = detectBundleProblems({
      bundleId: A,
      components: [{ componentItemId: B, quantity: 1 }],
      componentMeta: new Map([[B, { isBundle: true, partnerId: 'p1' }]]),
      bundlePartnerId: 'p1'
    });
    expect(problems).toContain('NESTED_BUNDLE');
  });
  it('rejects a component from a different partner', () => {
    const problems = detectBundleProblems({
      bundleId: A,
      components: [{ componentItemId: B, quantity: 1 }],
      componentMeta: new Map([[B, { isBundle: false, partnerId: 'p2' }]]),
      bundlePartnerId: 'p1'
    });
    expect(problems).toContain('CROSS_PARTNER');
  });
  it('rejects a missing component', () => {
    const problems = detectBundleProblems({
      bundleId: A,
      components: [{ componentItemId: B, quantity: 1 }],
      componentMeta: new Map(),
      bundlePartnerId: 'p1'
    });
    expect(problems).toContain('COMPONENT_NOT_FOUND');
  });
  it('returns no problems for a valid set', () => {
    const problems = detectBundleProblems({
      bundleId: A,
      components: [{ componentItemId: B, quantity: 2 }],
      componentMeta: new Map([[B, { isBundle: false, partnerId: 'p1' }]]),
      bundlePartnerId: 'p1'
    });
    expect(problems).toEqual([]);
  });
});

describe('computeBundleEconomicsFrom', () => {
  it('sums component costs and computes margin against the headline price', () => {
    const r = computeBundleEconomicsFrom({
      headlinePrice: '100.00',
      components: [
        { quantity: '2', costBasis: '10.00', revenueAllocation: '40.00' },
        { quantity: '1', costBasis: '30.00', revenueAllocation: '60.00' }
      ]
    });
    expect(r.totalCost).toBe('50.00');     // 2*10 + 1*30
    expect(r.margin).toBe('50.00');        // 100 - 50
    expect(r.allocationTotal).toBe('100.00');
    expect(r.allocationMatchesHeadline).toBe(true);
  });
  it('flags allocation mismatch', () => {
    const r = computeBundleEconomicsFrom({
      headlinePrice: '100.00',
      components: [{ quantity: '1', costBasis: '10.00', revenueAllocation: '40.00' }]
    });
    expect(r.allocationMatchesHeadline).toBe(false);
  });
  it('returns marginPct 0 (not NaN/Infinity) when the headline price is zero', () => {
    const r = computeBundleEconomicsFrom({
      headlinePrice: '0.00',
      components: [
        { quantity: '2', costBasis: '10.00', revenueAllocation: null },
        { quantity: '1', costBasis: '30.00', revenueAllocation: null }
      ]
    });
    expect(r.marginPct).toBe(0);
    expect(Number.isFinite(r.marginPct)).toBe(true);
    expect(r.totalCost).toBe('50.00');
    expect(r.margin).toBe('-50.00');
  });
  it('treats an all-null allocation set as matching the headline with a zero total', () => {
    const r = computeBundleEconomicsFrom({
      headlinePrice: '100.00',
      components: [
        { quantity: '2', costBasis: '10.00', revenueAllocation: null },
        { quantity: '1', costBasis: '30.00', revenueAllocation: null }
      ]
    });
    expect(r.allocationMatchesHeadline).toBe(true);
    expect(r.allocationTotal).toBe('0.00');
  });
});
