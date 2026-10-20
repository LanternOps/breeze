import { describe, expect, it } from 'vitest';

import {
  AGENT_CMSL_WARRANTY_SOURCE,
  AGENT_OWNED_WARRANTY_SOURCE_LIST,
  AGENT_OWNED_WARRANTY_SOURCES,
  AGENT_PLIST_WARRANTY_SOURCE,
  MAX_AGENT_WARRANTY_ENTITLEMENTS,
  isAgentCollectedWarrantyDevice,
  isAgentOwnedWarrantySource,
  warrantyEntitlementProviderForSource,
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
