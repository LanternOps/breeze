import { describe, expect, it, vi } from 'vitest';

// Provider availability is env-driven (vendor API keys); pin it so the refusal
// tests do not depend on the runner's environment. Only Dell is "configured".
vi.mock('./warrantyProviders', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./warrantyProviders')>();
  return {
    ...actual,
    getProviderForManufacturer: (manufacturer: string) =>
      actual.normalizeManufacturer(manufacturer) === 'dell' ? ({ name: 'dell' } as never) : null,
  };
});

import {
  AGENT_CMSL_WARRANTY_SOURCE,
  AGENT_OWNED_WARRANTY_SOURCE_LIST,
  AGENT_OWNED_WARRANTY_SOURCES,
  AGENT_PLIST_WARRANTY_SOURCE,
  IMPORT_WARRANTY_SOURCE,
  MAX_AGENT_WARRANTY_ENTITLEMENTS,
  PROVIDER_WARRANTY_SOURCE,
  isAgentCollectedWarrantyDevice,
  isAgentOwnedWarrantySource,
  isNonVendorWarrantySource,
  vendorHitShortensCoverage,
  warrantyEntitlementProviderForSource,
  warrantyRefreshRefusal,
} from './warrantyDataSources';

describe('isAgentOwnedWarrantySource', () => {
  it('recognises both agent collectors', () => {
    expect(isAgentOwnedWarrantySource(AGENT_PLIST_WARRANTY_SOURCE)).toBe(true);
    expect(isAgentOwnedWarrantySource(AGENT_CMSL_WARRANTY_SOURCE)).toBe(true);
  });

  it('does not claim server-written or imported rows', () => {
    expect(isAgentOwnedWarrantySource('provider')).toBe(false);
    expect(isAgentOwnedWarrantySource('import')).toBe(false);
  });

  it('is null-safe — data_source is a nullable varchar with no CHECK', () => {
    expect(isAgentOwnedWarrantySource(null)).toBe(false);
    expect(isAgentOwnedWarrantySource(undefined)).toBe(false);
    expect(isAgentOwnedWarrantySource('')).toBe(false);
  });

  it('keeps the set and the list in agreement', () => {
    expect([...AGENT_OWNED_WARRANTY_SOURCES].sort()).toEqual([...AGENT_OWNED_WARRANTY_SOURCE_LIST].sort());
  });
});

describe('warrantyEntitlementProviderForSource', () => {
  it('derives hp from the CMSL collector — the defect this replaces hardcoded apple', () => {
    expect(warrantyEntitlementProviderForSource(AGENT_CMSL_WARRANTY_SOURCE, 'HP')).toBe('hp');
    expect(warrantyEntitlementProviderForSource(AGENT_CMSL_WARRANTY_SOURCE, 'Hewlett-Packard')).toBe('hp');
  });

  it('keeps apple for the macOS plist collector', () => {
    expect(warrantyEntitlementProviderForSource(AGENT_PLIST_WARRANTY_SOURCE, 'Apple Inc.')).toBe('apple');
  });

  it('falls back to the normalized manufacturer for an unknown source', () => {
    expect(warrantyEntitlementProviderForSource('agent_future', 'Dell Inc.')).toBe('dell');
    expect(warrantyEntitlementProviderForSource('agent_future', 'LENOVO')).toBe('lenovo');
  });

  it('returns null rather than mislabelling coverage it cannot attribute', () => {
    expect(warrantyEntitlementProviderForSource('agent_future', 'Acme Whitebox')).toBeNull();
    expect(warrantyEntitlementProviderForSource('agent_future', '')).toBeNull();
  });

  it('trusts the source over a contradictory manufacturer string', () => {
    // A CMSL report is produced by HP's own tooling on an HP device; a garbled
    // SMBIOS manufacturer must not turn its entitlements into Apple ones.
    expect(warrantyEntitlementProviderForSource(AGENT_CMSL_WARRANTY_SOURCE, 'Apple Inc.')).toBe('hp');
  });
});

describe('isAgentCollectedWarrantyDevice', () => {
  it('is true for any HP device, with or without a stored row', () => {
    expect(isAgentCollectedWarrantyDevice({ manufacturer: 'HP', dataSource: null })).toBe(true);
    expect(isAgentCollectedWarrantyDevice({ manufacturer: 'Hewlett-Packard', dataSource: 'provider' })).toBe(true);
  });

  it('is true for a device whose row an agent already owns', () => {
    expect(isAgentCollectedWarrantyDevice({ manufacturer: 'Apple Inc.', dataSource: AGENT_PLIST_WARRANTY_SOURCE })).toBe(true);
  });

  it('is false for a device a registered vendor provider can answer for', () => {
    expect(isAgentCollectedWarrantyDevice({ manufacturer: 'Dell Inc.', dataSource: 'provider' })).toBe(false);
    expect(isAgentCollectedWarrantyDevice({ manufacturer: 'Lenovo', dataSource: null })).toBe(false);
  });

  it('is false when the manufacturer is unknown and no agent row exists', () => {
    expect(isAgentCollectedWarrantyDevice({ manufacturer: null, dataSource: null })).toBe(false);
    expect(isAgentCollectedWarrantyDevice({ manufacturer: '', dataSource: undefined })).toBe(false);
  });
});

describe('MAX_AGENT_WARRANTY_ENTITLEMENTS', () => {
  it('is the contract bound of 25', () => {
    expect(MAX_AGENT_WARRANTY_ENTITLEMENTS).toBe(25);
  });
});

describe('isNonVendorWarrantySource (#9862)', () => {
  it('counts imported and agent rows, and any future non-vendor writer', () => {
    expect(isNonVendorWarrantySource(IMPORT_WARRANTY_SOURCE)).toBe(true);
    expect(isNonVendorWarrantySource(AGENT_PLIST_WARRANTY_SOURCE)).toBe(true);
    expect(isNonVendorWarrantySource(AGENT_CMSL_WARRANTY_SOURCE)).toBe(true);
    expect(isNonVendorWarrantySource('some_future_collector')).toBe(true);
  });

  it('treats a vendor row and a legacy NULL as vendor-shaped', () => {
    expect(isNonVendorWarrantySource(PROVIDER_WARRANTY_SOURCE)).toBe(false);
    expect(isNonVendorWarrantySource(null)).toBe(false);
    expect(isNonVendorWarrantySource(undefined)).toBe(false);
  });
});

describe('warrantyRefreshRefusal (#9862)', () => {
  it('keeps the agent refusal first', () => {
    expect(warrantyRefreshRefusal({ manufacturer: 'HP', dataSource: IMPORT_WARRANTY_SOURCE })).toBe('agent_collected');
    expect(warrantyRefreshRefusal({ manufacturer: 'Apple Inc.', dataSource: AGENT_PLIST_WARRANTY_SOURCE })).toBe('agent_collected');
  });

  it('refuses an imported row when no provider answers for the manufacturer', () => {
    expect(warrantyRefreshRefusal({ manufacturer: 'Acme Whitebox', dataSource: IMPORT_WARRANTY_SOURCE })).toBe('no_vendor_lookup');
    expect(warrantyRefreshRefusal({ manufacturer: null, dataSource: IMPORT_WARRANTY_SOURCE })).toBe('no_vendor_lookup');
  });

  it('lets an imported row refresh when a provider is configured (a vendor hit may replace it)', () => {
    expect(warrantyRefreshRefusal({ manufacturer: 'Dell Inc.', dataSource: IMPORT_WARRANTY_SOURCE })).toBeNull();
  });

  it('still queues a device with no row or a vendor row, even with no provider', () => {
    expect(warrantyRefreshRefusal({ manufacturer: 'Acme Whitebox', dataSource: null })).toBeNull();
    expect(warrantyRefreshRefusal({ manufacturer: 'Acme Whitebox', dataSource: PROVIDER_WARRANTY_SOURCE })).toBeNull();
  });
});

describe('vendorHitShortensCoverage (#9862 amendment)', () => {
  it('a vendor end date earlier than the stored one would shorten coverage', () => {
    expect(vendorHitShortensCoverage({ storedEndDate: '2028-06-30', vendorEndDate: '2026-03-31' })).toBe(true);
  });

  it('a vendor end date that is the same or later loses nothing', () => {
    expect(vendorHitShortensCoverage({ storedEndDate: '2028-06-30', vendorEndDate: '2028-06-30' })).toBe(false);
    expect(vendorHitShortensCoverage({ storedEndDate: '2028-06-30', vendorEndDate: '2030-01-01' })).toBe(false);
  });

  it('a vendor hit with no end date would erase a stored one', () => {
    expect(vendorHitShortensCoverage({ storedEndDate: '2028-06-30', vendorEndDate: null })).toBe(true);
  });

  it('nothing stored means nothing to lose', () => {
    expect(vendorHitShortensCoverage({ storedEndDate: null, vendorEndDate: '2026-03-31' })).toBe(false);
    expect(vendorHitShortensCoverage({ storedEndDate: null, vendorEndDate: null })).toBe(false);
  });
});
