import { describe, it, expect } from 'vitest';
import {
  createCatalogItemSchema,
  updateCatalogItemSchema,
  orgPriceOverrideSchema,
  setBundleComponentsSchema,
  listCatalogQuerySchema,
  enrichRequestSchema,
  enrichDraftSchema,
  enrichResponseSchema,
  enrichmentProvenanceSchema
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

describe('catalog subscription fields', () => {
  it('accepts billingFrequency + commitmentTermMonths', () => {
    const parsed = createCatalogItemSchema.parse({
      itemType: 'software', name: 'Microsoft 365 Business Premium',
      billingType: 'recurring', unitPrice: 22, unitOfMeasure: 'seat',
      taxable: true, isBundle: false,
      billingFrequency: 'monthly', commitmentTermMonths: 12,
    });
    expect(parsed.billingFrequency).toBe('monthly');
    expect(parsed.commitmentTermMonths).toBe(12);
  });

  it('rejects an unknown billingFrequency', () => {
    expect(() => createCatalogItemSchema.parse({
      itemType: 'software', name: 'x', billingType: 'recurring',
      unitPrice: 1, unitOfMeasure: 'seat', taxable: true, isBundle: false,
      billingFrequency: 'weekly',
    })).toThrow();
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

describe('enrich validators', () => {
  it('accepts a valid enrich request with optional hint', () => {
    expect(enrichRequestSchema.parse({ query: 'APC Back-UPS 600VA' })).toEqual({
      query: 'APC Back-UPS 600VA',
    });
    expect(enrichRequestSchema.parse({ query: 'x', hint: 'hardware' }).hint).toBe('hardware');
  });

  it('rejects an empty or oversized query', () => {
    expect(enrichRequestSchema.safeParse({ query: '' }).success).toBe(false);
    expect(enrichRequestSchema.safeParse({ query: 'a'.repeat(201) }).success).toBe(false);
  });

  it('validates a draft and a full response', () => {
    const draft = {
      name: 'APC Back-UPS 600VA',
      description: 'Battery backup',
      itemType: 'hardware' as const,
      unitOfMeasure: 'each',
      taxable: true,
      taxCategory: null,
    };
    expect(enrichDraftSchema.parse(draft)).toEqual(draft);
    const resp = {
      draft,
      priceGuidance: 'typically $80–120',
      provenance: {
        source: 'ai_enrich' as const,
        model: 'claude-sonnet-4-6',
        query: 'APC Back-UPS 600VA',
        suggestion: { priceLow: 80, priceHigh: 120 },
        enrichedAt: '2026-06-25T00:00:00.000Z',
        enrichedBy: '00000000-0000-0000-0000-000000000001',
      },
    };
    expect(enrichResponseSchema.parse(resp)).toBeTruthy();
    expect(enrichmentProvenanceSchema.parse(resp.provenance).source).toBe('ai_enrich');
  });

  it('rejects create attributes larger than 60k chars', () => {
    const big = { blob: 'x'.repeat(60_001) };
    const res = createCatalogItemSchema.safeParse({
      itemType: 'service', name: 'svc', unitPrice: 10, attributes: big,
    });
    expect(res.success).toBe(false);
  });

  it('rejects an enrichment suggestion larger than 20k chars', () => {
    const res = enrichmentProvenanceSchema.safeParse({
      source: 'ai_enrich', model: 'm', query: 'q',
      suggestion: { blob: 'x'.repeat(20_001) },
      enrichedAt: '2026-06-26T00:00:00.000Z', enrichedBy: 'u1',
    });
    expect(res.success).toBe(false);
  });
});

describe('createCatalogItemSchema attributes.enrichment shape', () => {
  const validProvenance = {
    source: 'ai_enrich' as const,
    model: 'claude-sonnet-4-6',
    query: 'APC Back-UPS 600VA',
    suggestion: { priceLow: 80, priceHigh: 120 },
    enrichedAt: '2026-06-25T00:00:00.000Z',
    enrichedBy: '00000000-0000-0000-0000-000000000001',
  };

  it('accepts a well-formed attributes.enrichment provenance object', () => {
    const r = createCatalogItemSchema.safeParse({
      itemType: 'hardware', name: 'APC Back-UPS', unitPrice: 99,
      attributes: { enrichment: validProvenance },
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.attributes.enrichment?.source).toBe('ai_enrich');
    }
  });

  it('rejects a malformed attributes.enrichment (missing source)', () => {
    const { source: _omit, ...noSource } = validProvenance;
    const r = createCatalogItemSchema.safeParse({
      itemType: 'hardware', name: 'X', unitPrice: 1,
      attributes: { enrichment: noSource },
    });
    expect(r.success).toBe(false);
  });

  it('rejects a malformed attributes.enrichment (wrong source literal)', () => {
    const r = createCatalogItemSchema.safeParse({
      itemType: 'hardware', name: 'X', unitPrice: 1,
      attributes: { enrichment: { ...validProvenance, source: 'manual' } },
    });
    expect(r.success).toBe(false);
  });

  it('rejects a malformed attributes.enrichment (wrong field type)', () => {
    const r = createCatalogItemSchema.safeParse({
      itemType: 'hardware', name: 'X', unitPrice: 1,
      attributes: { enrichment: { ...validProvenance, model: 123 } },
    });
    expect(r.success).toBe(false);
  });

  it('enforces the 20k suggestion cap at the create boundary', () => {
    const r = createCatalogItemSchema.safeParse({
      itemType: 'hardware', name: 'X', unitPrice: 1,
      attributes: {
        enrichment: { ...validProvenance, suggestion: { blob: 'x'.repeat(20_001) } },
      },
    });
    expect(r.success).toBe(false);
  });

  it('allows forward-compatible extra attribute keys via catchall', () => {
    const r = createCatalogItemSchema.safeParse({
      itemType: 'hardware', name: 'X', unitPrice: 1,
      attributes: { enrichment: validProvenance, futureKey: { nested: true }, tag: 'abc' },
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect((r.data.attributes as Record<string, unknown>).futureKey).toEqual({ nested: true });
      expect((r.data.attributes as Record<string, unknown>).tag).toBe('abc');
    }
  });

  it('accepts attributes without an enrichment key (enrichment is optional)', () => {
    const r = createCatalogItemSchema.safeParse({
      itemType: 'service', name: 'Onsite hour', unitPrice: 150,
      attributes: { customField: 'value' },
    });
    expect(r.success).toBe(true);
  });

  it('defaults attributes to an empty object when omitted', () => {
    const r = createCatalogItemSchema.parse({
      itemType: 'service', name: 'Onsite hour', unitPrice: 150,
    });
    expect(r.attributes).toEqual({});
  });
});
