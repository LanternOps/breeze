import { describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({ db: {} }));

import { catalogSeveritySource } from './patchSeveritySource';

// loadCatalogReportedSeverities' SQL is covered against real Postgres in
// __tests__/integration/patchSeveritySource.integration.test.ts.
describe('catalogSeveritySource (#9387 gap 2)', () => {
  it('returns the device provenance when the row displays the device-reported severity', () => {
    expect(catalogSeveritySource('important', { severity: 'important', source: 'derived' })).toBe('derived');
    expect(catalogSeveritySource('critical', { severity: 'critical', source: 'vendor' })).toBe('vendor');
  });

  it('returns null when the displayed severity is not the device report', () => {
    // e.g. the catalog shows the trusted shared value, or (before the catalog
    // resolves device reports) still shows unknown.
    expect(catalogSeveritySource('critical', { severity: 'important', source: 'derived' })).toBeNull();
    expect(catalogSeveritySource('unknown', { severity: 'important', source: 'derived' })).toBeNull();
  });

  it('returns null with no device report or no displayed severity', () => {
    expect(catalogSeveritySource('important', undefined)).toBeNull();
    expect(catalogSeveritySource(null, { severity: 'important', source: 'derived' })).toBeNull();
  });
});
