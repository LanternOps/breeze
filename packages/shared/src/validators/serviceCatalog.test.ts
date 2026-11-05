import { describe, it, expect } from 'vitest';
import {
  createServiceCatalogItemSchema,
  updateServiceCatalogItemSchema,
  updateServiceCatalogSchema,
  listServiceCatalogItemsQuerySchema,
  serviceLineRequiresPillar,
} from './serviceCatalog';

describe('createServiceCatalogItemSchema', () => {
  it('applies defaults and trims labels', () => {
    const r = createServiceCatalogItemSchema.parse({ name: '  Patching ', pillar: ' Infra ' });
    expect(r).toMatchObject({ name: 'Patching', pillar: 'Infra', isActive: true, showInPortal: false, sortOrder: 0 });
  });
  it('rejects blank labels', () => {
    expect(createServiceCatalogItemSchema.safeParse({ name: '   ' }).success).toBe(false);
    expect(createServiceCatalogItemSchema.safeParse({ name: 'x', pillar: ' ' }).success).toBe(false);
    expect(createServiceCatalogItemSchema.safeParse({ name: 'x', pillar: 'p', serviceLine: '' }).success).toBe(false);
  });
  it('requires a pillar for a service line', () => {
    expect(createServiceCatalogItemSchema.safeParse({ name: 'x', serviceLine: 'L' }).success).toBe(false);
    expect(createServiceCatalogItemSchema.safeParse({ name: 'x', pillar: null, serviceLine: 'L' }).success).toBe(false);
    expect(createServiceCatalogItemSchema.safeParse({ name: 'x', pillar: 'P', serviceLine: 'L' }).success).toBe(true);
  });
  it('rejects ownership and unknown keys', () => {
    for (const key of ['partnerId', 'orgId', 'catalogId', 'ownerScope', 'itilClass']) {
      expect(createServiceCatalogItemSchema.safeParse({ name: 'x', [key]: 'v' }).success).toBe(false);
    }
  });
  it('bounds description and sortOrder', () => {
    expect(createServiceCatalogItemSchema.safeParse({ name: 'x', description: 'a'.repeat(2001) }).success).toBe(false);
    expect(createServiceCatalogItemSchema.safeParse({ name: 'x', sortOrder: 100_001 }).success).toBe(false);
    expect(createServiceCatalogItemSchema.safeParse({ name: 'x', sortOrder: 1.5 }).success).toBe(false);
  });
});

describe('updateServiceCatalogItemSchema', () => {
  it('is truly partial (no defaults materialised)', () => {
    expect(updateServiceCatalogItemSchema.parse({ name: 'n' })).toEqual({ name: 'n' });
    expect(updateServiceCatalogItemSchema.parse({})).toEqual({});
  });
  it('accepts null to clear and rejects pillar:null with serviceLine in same payload', () => {
    expect(updateServiceCatalogItemSchema.safeParse({ pillar: null }).success).toBe(true);
    expect(updateServiceCatalogItemSchema.safeParse({ pillar: null, serviceLine: 'L' }).success).toBe(false);
  });
  it('rejects ownership keys', () => {
    expect(updateServiceCatalogItemSchema.safeParse({ partnerId: 'x' }).success).toBe(false);
    expect(updateServiceCatalogItemSchema.safeParse({ catalogId: 'x' }).success).toBe(false);
  });
});

describe('updateServiceCatalogSchema', () => {
  it('accepts name/isActive only', () => {
    expect(updateServiceCatalogSchema.safeParse({ name: 'N', isActive: false }).success).toBe(true);
    expect(updateServiceCatalogSchema.safeParse({ name: ' ' }).success).toBe(false);
    expect(updateServiceCatalogSchema.safeParse({ partnerId: 'x' }).success).toBe(false);
  });
});

describe('listServiceCatalogItemsQuerySchema', () => {
  it('parses includeArchived', () => {
    expect(listServiceCatalogItemsQuerySchema.parse({}).includeArchived).toBe(false);
    expect(listServiceCatalogItemsQuerySchema.parse({ includeArchived: 'true' }).includeArchived).toBe(true);
  });
});

describe('serviceLineRequiresPillar', () => {
  it('mirrors the DB check', () => {
    expect(serviceLineRequiresPillar({ pillar: null, serviceLine: null })).toBe(true);
    expect(serviceLineRequiresPillar({ pillar: null, serviceLine: 'L' })).toBe(false);
  });
});
