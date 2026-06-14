import { describe, it, expect } from 'vitest';
import {
  createCatalogItemSchema,
  updateCatalogItemSchema,
  orgPriceOverrideSchema,
  setBundleComponentsSchema,
  listCatalogQuerySchema
} from './catalog';

describe('createCatalogItemSchema', () => {
  it('accepts a minimal valid hardware item', () => {
    const r = createCatalogItemSchema.safeParse({
      itemType: 'hardware',
      name: 'Dell Latitude 5440',
      unitPrice: 1299.0
    });
    expect(r.success).toBe(true);
  });

  it('rejects an empty name', () => {
    const r = createCatalogItemSchema.safeParse({ itemType: 'service', name: '', unitPrice: 10 });
    expect(r.success).toBe(false);
  });

  it('rejects a negative price', () => {
    const r = createCatalogItemSchema.safeParse({ itemType: 'service', name: 'X', unitPrice: -1 });
    expect(r.success).toBe(false);
  });

  it('rejects an unknown item type', () => {
    const r = createCatalogItemSchema.safeParse({ itemType: 'widget', name: 'X', unitPrice: 1 });
    expect(r.success).toBe(false);
  });

  it('defaults billingType to one_time and taxable to true', () => {
    const r = createCatalogItemSchema.parse({ itemType: 'service', name: 'Onsite hour', unitPrice: 150 });
    expect(r.billingType).toBe('one_time');
    expect(r.taxable).toBe(true);
  });

  it('accepts a markupPercent at the numeric(6,2) ceiling', () => {
    const r = createCatalogItemSchema.safeParse({
      itemType: 'service', name: 'X', unitPrice: 1, costBasis: 1, markupPercent: 9999.99
    });
    expect(r.success).toBe(true);
  });

  it('rejects a markupPercent above the numeric(6,2) ceiling (would overflow on insert)', () => {
    for (const markupPercent of [10000, 50000, 100000]) {
      const r = createCatalogItemSchema.safeParse({
        itemType: 'service', name: 'X', unitPrice: 1, costBasis: 1, markupPercent
      });
      expect(r.success).toBe(false);
    }
  });

  it('rejects a unitPrice above the numeric(12,2) ceiling (would overflow on insert)', () => {
    const r = createCatalogItemSchema.safeParse({
      itemType: 'service', name: 'X', unitPrice: 10_000_000_000
    });
    expect(r.success).toBe(false);
  });
});

describe('updateCatalogItemSchema', () => {
  it('requires at least one field', () => {
    expect(updateCatalogItemSchema.safeParse({}).success).toBe(false);
  });
});

describe('orgPriceOverrideSchema', () => {
  it('accepts a valid override', () => {
    expect(orgPriceOverrideSchema.safeParse({ unitPrice: 99.5 }).success).toBe(true);
  });
  it('rejects negative price', () => {
    expect(orgPriceOverrideSchema.safeParse({ unitPrice: -5 }).success).toBe(false);
  });
});

describe('setBundleComponentsSchema', () => {
  it('accepts a list of components', () => {
    const r = setBundleComponentsSchema.safeParse({
      components: [
        { componentItemId: '11111111-1111-1111-1111-111111111111', quantity: 2, showOnInvoice: true, revenueAllocation: 10 }
      ]
    });
    expect(r.success).toBe(true);
  });
  it('rejects zero/negative quantity', () => {
    const r = setBundleComponentsSchema.safeParse({
      components: [{ componentItemId: '11111111-1111-1111-1111-111111111111', quantity: 0 }]
    });
    expect(r.success).toBe(false);
  });
  it('accepts a quantity at the numeric(12,2) ceiling', () => {
    const r = setBundleComponentsSchema.safeParse({
      components: [{ componentItemId: '11111111-1111-1111-1111-111111111111', quantity: 9_999_999_999.99 }]
    });
    expect(r.success).toBe(true);
  });
  it('rejects a quantity above the numeric(12,2) ceiling (would overflow on insert)', () => {
    const r = setBundleComponentsSchema.safeParse({
      components: [{ componentItemId: '11111111-1111-1111-1111-111111111111', quantity: 1e13 }]
    });
    expect(r.success).toBe(false);
  });
});

describe('listCatalogQuerySchema boolean params', () => {
  it('parses isActive=false to false (not truthy-coerced to true)', () => {
    const r = listCatalogQuerySchema.parse({ isActive: 'false' });
    expect(r.isActive).toBe(false);
  });
  it('parses isActive=true to true', () => {
    const r = listCatalogQuerySchema.parse({ isActive: 'true' });
    expect(r.isActive).toBe(true);
  });
  it('parses isBundle=false to false', () => {
    const r = listCatalogQuerySchema.parse({ isBundle: 'false' });
    expect(r.isBundle).toBe(false);
  });
  it('rejects non-boolean strings like "0"', () => {
    expect(listCatalogQuerySchema.safeParse({ isActive: '0' }).success).toBe(false);
  });
  it('leaves boolean params undefined when omitted', () => {
    const r = listCatalogQuerySchema.parse({});
    expect(r.isActive).toBeUndefined();
    expect(r.isBundle).toBeUndefined();
  });
});
