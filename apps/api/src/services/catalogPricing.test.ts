import { describe, it, expect } from 'vitest';
import { importedCost } from './catalogPricing';
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
  const item = { costBasis: '60.00', costCurrency: 'EUR', taxable: true, taxCategory: 'GST' };

  it('uses an org override in the target currency', () => {
    const r = resolvePriceFrom(
      item,
      { unitPrice: '80.00', currencyCode: 'EUR' },
      { unitPrice: '100.00' },
      'EUR'
    );

    expect(r).toEqual({
      unitPrice: '80.00',
      currencyCode: 'EUR',
      costBasis: '60.00',
      costCurrency: 'EUR',
      marginAvailable: true,
      taxable: true,
      taxCategory: 'GST',
      source: 'org_override'
    });
  });

  it('skips an override in another currency and uses the target-currency price-book row', () => {
    const r = resolvePriceFrom(
      item,
      { unitPrice: '90.00', currencyCode: 'USD' },
      { unitPrice: '85.00' },
      'EUR'
    );

    expect(r).toMatchObject({ unitPrice: '85.00', currencyCode: 'EUR', source: 'price_book' });
  });

  it('returns the NO_PRICE_FOR_CURRENCY gap when neither a matching override nor a price-book row exists', () => {
    expect(resolvePriceFrom(item, null, null, 'EUR')).toEqual({ gap: 'NO_PRICE_FOR_CURRENCY' });
  });

  it('marks margin unavailable when cost and target currencies differ', () => {
    const r = resolvePriceFrom(
      { ...item, costCurrency: 'CAD' },
      null,
      { unitPrice: '100.00' },
      'USD'
    );

    expect(r).toMatchObject({ marginAvailable: false });
  });

  it('marks margin available when cost and target currencies match', () => {
    const r = resolvePriceFrom(
      { ...item, costCurrency: 'USD' },
      null,
      { unitPrice: '100.00' },
      'USD'
    );

    expect(r).toMatchObject({ marginAvailable: true });
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
  const componentA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const componentB = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

  it('computes totals when pricing is complete and costs use the target currency', () => {
    const r = computeBundleEconomicsFrom({
      currencyCode: 'USD',
      headlinePrice: '100.00',
      components: [
        {
          componentItemId: componentA,
          quantity: '2',
          costBasis: '10.00',
          costCurrency: 'USD',
          revenueAllocation: '40.00',
          hasPriceInCurrency: true
        },
        {
          componentItemId: componentB,
          quantity: '1',
          costBasis: '30.00',
          costCurrency: 'USD',
          revenueAllocation: '60.00',
          hasPriceInCurrency: true
        }
      ]
    });

    expect(r.headlinePrice).toBe('100.00');
    expect(r.priceBookComplete).toBe(true);
    expect(r.marginAvailable).toBe(true);
    expect(r.totalCost).toBe('50.00');
    expect(r.margin).toBe('50.00');
    expect(r.marginPct).toBe(50);
    expect(r.allocationTotal).toBe('100.00');
    expect(r.allocationMatchesHeadline).toBe(true);
    expect(r.missingPriceComponentIds).toEqual([]);
  });

  it('withholds all cost economics when a component lacks target-currency pricing', () => {
    const r = computeBundleEconomicsFrom({
      currencyCode: 'USD',
      headlinePrice: '100.00',
      components: [
        {
          componentItemId: componentA,
          quantity: '2',
          costBasis: '10.00',
          costCurrency: 'USD',
          revenueAllocation: '40.00',
          hasPriceInCurrency: true
        },
        {
          componentItemId: componentB,
          quantity: '1',
          costBasis: '30.00',
          costCurrency: 'USD',
          revenueAllocation: '60.00',
          hasPriceInCurrency: false
        }
      ]
    });

    expect(r.priceBookComplete).toBe(false);
    expect(r.missingPriceComponentIds).toEqual([componentB]);
    expect(r.totalCost).toBeNull();
    expect(r.margin).toBeNull();
    expect(r.marginPct).toBeNull();
  });

  it('withholds cost economics when a component cost uses another currency', () => {
    const r = computeBundleEconomicsFrom({
      currencyCode: 'USD',
      headlinePrice: '100.00',
      components: [
        {
          componentItemId: componentA,
          quantity: '2',
          costBasis: '10.00',
          costCurrency: 'USD',
          revenueAllocation: '40.00',
          hasPriceInCurrency: true
        },
        {
          componentItemId: componentB,
          quantity: '1',
          costBasis: '30.00',
          costCurrency: 'CAD',
          revenueAllocation: '60.00',
          hasPriceInCurrency: true
        }
      ]
    });

    expect(r.priceBookComplete).toBe(true);
    expect(r.marginAvailable).toBe(false);
    expect(r.totalCost).toBeNull();
    expect(r.margin).toBeNull();
    expect(r.marginPct).toBeNull();
    expect(r.allocationTotal).toBe('100.00');
  });

  it('marks price-book pricing incomplete when the bundle lacks a headline price', () => {
    const r = computeBundleEconomicsFrom({
      currencyCode: 'USD',
      headlinePrice: null,
      components: [
        {
          componentItemId: componentA,
          quantity: '2',
          costBasis: '10.00',
          costCurrency: 'USD',
          revenueAllocation: null,
          hasPriceInCurrency: true
        }
      ]
    });

    expect(r.headlinePrice).toBeNull();
    expect(r.priceBookComplete).toBe(false);
    expect(r.totalCost).toBeNull();
    expect(r.margin).toBeNull();
    expect(r.marginPct).toBeNull();
    expect(r.allocationMatchesHeadline).toBe(true);
    expect(r.allocationTotal).toBe('0.00');
  });

  it('returns marginPct 0 (not NaN/Infinity) when the headline price is zero', () => {
    const r = computeBundleEconomicsFrom({
      currencyCode: 'USD',
      headlinePrice: '0.00',
      components: [
        { componentItemId: componentA, quantity: '2', costBasis: '10.00', costCurrency: 'USD', revenueAllocation: null, hasPriceInCurrency: true },
        { componentItemId: componentB, quantity: '1', costBasis: '30.00', costCurrency: 'USD', revenueAllocation: null, hasPriceInCurrency: true }
      ]
    });

    expect(r.priceBookComplete).toBe(true);
    expect(r.marginPct).toBe(0);
    expect(Number.isFinite(r.marginPct)).toBe(true);
    expect(r.totalCost).toBe('50.00');
    expect(r.margin).toBe('-50.00');
  });

  it('treats an all-null allocation set as matching a non-null headline with a zero total', () => {
    const r = computeBundleEconomicsFrom({
      currencyCode: 'USD',
      headlinePrice: '100.00',
      components: [
        { componentItemId: componentA, quantity: '2', costBasis: '10.00', costCurrency: 'USD', revenueAllocation: null, hasPriceInCurrency: true },
        { componentItemId: componentB, quantity: '1', costBasis: '30.00', costCurrency: 'USD', revenueAllocation: null, hasPriceInCurrency: true }
      ]
    });

    expect(r.allocationMatchesHeadline).toBe(true);
    expect(r.allocationTotal).toBe('0.00');
    expect(r.totalCost).toBe('50.00');
  });

  it('reports a null headline with a partial allocation as NOT matching', () => {
    const r = computeBundleEconomicsFrom({
      currencyCode: 'USD',
      headlinePrice: null,
      components: [
        { componentItemId: componentA, quantity: '1', costBasis: '10.00', costCurrency: 'USD', revenueAllocation: '40.00', hasPriceInCurrency: true }
      ]
    });

    expect(r.allocationMatchesHeadline).toBe(false);
    expect(r.allocationTotal).toBe('40.00');
  });

  it('reports an allocation mismatch when pricing is complete', () => {
    const r = computeBundleEconomicsFrom({
      currencyCode: 'USD',
      headlinePrice: '100.00',
      components: [
        {
          componentItemId: componentA,
          quantity: '1',
          costBasis: '10.00',
          costCurrency: 'USD',
          revenueAllocation: '40.00',
          hasPriceInCurrency: true
        }
      ]
    });

    expect(r.priceBookComplete).toBe(true);
    expect(r.allocationTotal).toBe('40.00');
    expect(r.allocationMatchesHeadline).toBe(false);
  });
});

describe('importedCost (#3775 review #2)', () => {
  it('feed cost + feed currency → stored as that currency pair', () => {
    expect(importedCost(381.35, ' cad ')).toEqual({ costBasis: 381.35, costCurrency: 'CAD' });
  });
  it('feed cost without a feed currency → a gap (null cost, no currency), never the partner currency', () => {
    expect(importedCost(381.35, null)).toEqual({ costBasis: null, costCurrency: undefined });
    expect(importedCost(381.35, '')).toEqual({ costBasis: null, costCurrency: undefined });
  });
  it('no cost → null cost; currency still recorded when the feed names one', () => {
    expect(importedCost(null, 'USD')).toEqual({ costBasis: null, costCurrency: 'USD' });
    expect(importedCost(undefined, null)).toEqual({ costBasis: null, costCurrency: undefined });
    expect(importedCost(Number.NaN, 'USD')).toEqual({ costBasis: null, costCurrency: 'USD' });
  });
});

describe('resolvePriceFrom — non-representable legacy amounts (#3775 review #4)', () => {
  const jpyItem = { costBasis: '100.00', costCurrency: 'JPY', taxable: true, taxCategory: null };

  it('a fractional-yen price-book row is a PRICE_NOT_REPRESENTABLE gap, not a price', () => {
    expect(resolvePriceFrom(jpyItem, null, { unitPrice: '100.50' }, 'JPY')).toEqual({
      gap: 'PRICE_NOT_REPRESENTABLE', source: 'price_book', unitPrice: '100.50'
    });
  });

  it('a fractional-yen org override is a PRICE_NOT_REPRESENTABLE gap and does NOT fall through to the book row', () => {
    expect(resolvePriceFrom(jpyItem, { unitPrice: '10.50', currencyCode: 'JPY' }, { unitPrice: '100.00' }, 'JPY')).toEqual({
      gap: 'PRICE_NOT_REPRESENTABLE', source: 'org_override', unitPrice: '10.50'
    });
  });

  it('a missing price is still the NO_PRICE_FOR_CURRENCY gap', () => {
    expect(resolvePriceFrom(jpyItem, null, null, 'JPY')).toEqual({ gap: 'NO_PRICE_FOR_CURRENCY' });
  });

  it('a fractional-yen legacy cost makes margin unavailable (cost null) instead of being snapshotted', () => {
    const r = resolvePriceFrom({ ...jpyItem, costBasis: '100.50' }, null, { unitPrice: '200.00' }, 'JPY');
    expect(r).toMatchObject({ unitPrice: '200.00', costBasis: null, marginAvailable: false, source: 'price_book' });
  });

  it('a representable yen price and cost resolve normally', () => {
    const r = resolvePriceFrom(jpyItem, null, { unitPrice: '200.00' }, 'JPY');
    expect(r).toMatchObject({ unitPrice: '200.00', costBasis: '100.00', marginAvailable: true });
  });
});
