import { describe, expect, it } from 'vitest';
import {
  isOrderableQuoteLine,
  isProductLikeQuoteLine,
  isUnorderableProductLine,
  type QuoteOrderabilityLine,
} from './quoteOrderability';

const line = (over: Partial<QuoteOrderabilityLine> = {}): QuoteOrderabilityLine => ({
  sku: null,
  partNumber: null,
  itemType: null,
  unitCost: null,
  ...over,
});

describe('isOrderableQuoteLine', () => {
  it.each([
    ['sku only', line({ sku: 'SKU-1' }), true],
    ['part number only', line({ partNumber: 'MD3Y4LL/A' }), true],
    ['both identifiers', line({ sku: 'S', partNumber: 'P' }), true],
    ['no identifier', line(), false],
    // #8232: hardware without an identifier no longer slips into the order.
    ['hardware without identifier', line({ itemType: 'hardware', unitCost: '400.00' }), false],
    ['whitespace-only identifiers', line({ sku: '   ', partNumber: '\t' }), false],
    ['service with a sku', line({ itemType: 'service', sku: 'LAB-1' }), true],
  ])('%s → %s', (_label, l, expected) => {
    expect(isOrderableQuoteLine(l)).toBe(expected);
  });

  it('accepts lines that omit the optional fields entirely', () => {
    expect(isOrderableQuoteLine({ sku: 'X' })).toBe(true);
    expect(isOrderableQuoteLine({})).toBe(false);
  });
});

describe('isProductLikeQuoteLine', () => {
  it.each([
    ['hardware, no cost', line({ itemType: 'hardware' }), true],
    ['software, no cost', line({ itemType: 'software' }), true],
    ['manual line with a cost', line({ unitCost: '12.50' }), true],
    ['manual line with a numeric cost', line({ unitCost: 12.5 }), true],
    ['manual line with a zero cost', line({ unitCost: '0.00' }), true],
    ['manual line without cost', line(), false],
    ['manual line with a blank cost', line({ unitCost: '  ' }), false],
    ['service with a cost', line({ itemType: 'service', unitCost: '30.00' }), false],
    ['service without cost', line({ itemType: 'service' }), false],
  ])('%s → %s', (_label, l, expected) => {
    expect(isProductLikeQuoteLine(l)).toBe(expected);
  });
});

describe('isUnorderableProductLine', () => {
  it('flags a product-like line with no part number or SKU (the iPad case)', () => {
    expect(isUnorderableProductLine(line({ unitCost: '329.00' }))).toBe(true);
    expect(isUnorderableProductLine(line({ itemType: 'hardware' }))).toBe(true);
  });

  it('does not flag a product-like line that has an identifier', () => {
    expect(isUnorderableProductLine(line({ itemType: 'hardware', partNumber: 'MD3Y4LL/A' }))).toBe(false);
    expect(isUnorderableProductLine(line({ unitCost: '1.00', sku: 'S' }))).toBe(false);
  });

  it('does not flag non-product lines', () => {
    expect(isUnorderableProductLine(line({ itemType: 'service', unitCost: '50.00' }))).toBe(false);
    expect(isUnorderableProductLine(line())).toBe(false);
  });
});
