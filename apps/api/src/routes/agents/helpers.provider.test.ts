import { describe, expect, it, vi } from 'vitest';

// helpers.ts (and its transitive imports) load the db module at import; stub it
// so this pure-function test doesn't spin up a real pool (green-local/red-CI trap).
vi.mock('../../db', () => ({
  db: {},
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn())
}));

import { normalizeProvider } from './helpers';
import { securityProviderValues } from './schemas';
import { providerCatalog } from '../security/schemas';

describe('normalizeProvider — Elastic Defend (#2018)', () => {
  it('maps Elastic Defend variants to elastic_defend', () => {
    expect(normalizeProvider('elastic_defend')).toBe('elastic_defend');
    expect(normalizeProvider('elastic_endpoint')).toBe('elastic_defend');
    expect(normalizeProvider('elastic_agent')).toBe('elastic_defend');
    expect(normalizeProvider('elastic')).toBe('elastic_defend');
    // Case-insensitive, matching the existing provider handling.
    expect(normalizeProvider('Elastic_Defend')).toBe('elastic_defend');
  });

  it('still normalizes known providers and unknowns', () => {
    expect(normalizeProvider('crowdstrike')).toBe('crowdstrike');
    expect(normalizeProvider('acme-shield')).toBe('other');
    expect(normalizeProvider(null)).toBe('other');
  });

  it('keeps the provider sources in sync (dashboard indexes providerCatalog[normalizeProvider(x)])', () => {
    // elastic_defend must be an accepted ingest value...
    expect(securityProviderValues).toContain('elastic_defend');
    // ...and resolvable in the catalog, or dashboard provider labeling throws.
    expect(providerCatalog.elastic_defend).toEqual({
      id: 'elastic_defend',
      name: 'Elastic Defend',
      vendor: 'Elastic'
    });
  });
});
