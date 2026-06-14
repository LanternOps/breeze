import { describe, it, expect } from 'vitest';
import {
  createCatalogItemSchema,
  updateCatalogItemSchema,
  orgPriceOverrideSchema,
  setBundleComponentsSchema
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
});
