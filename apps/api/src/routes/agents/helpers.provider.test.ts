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
import { securityProviderEnum } from '../../db/schema/security';
import { prettySecurityProvider } from '../../services/securityComplianceReportProducts';

describe('normalizeProvider — provider mapping (#2018, #7551)', () => {
  it('maps Elastic Defend variants to elastic_defend', () => {
    expect(normalizeProvider('elastic_defend')).toBe('elastic_defend');
    expect(normalizeProvider('elastic_endpoint')).toBe('elastic_defend');
    expect(normalizeProvider('elastic_agent')).toBe('elastic_defend');
    expect(normalizeProvider('elastic')).toBe('elastic_defend');
    // Case-insensitive, matching the existing provider handling.
    expect(normalizeProvider('Elastic_Defend')).toBe('elastic_defend');
  });

  it.each([
    ['emsisoft', 'emsisoft'],
    ['Emsisoft', 'emsisoft'],
    ['webroot', 'webroot'],
    ['withsecure', 'withsecure'],
    ['f-secure', 'withsecure'],
    ['f_secure', 'withsecure'],
    ['fsecure', 'withsecure'],
    ['threatdown', 'malwarebytes'],
    ['malwarebytes', 'malwarebytes'],
    ['eset', 'eset']
  ])('maps %s to %s (#7551)', (raw, expected) => {
    expect(normalizeProvider(raw)).toBe(expected);
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

  it('every ingest provider value is in the catalog, the DB enum and the report labels (#7551)', () => {
    const dbEnum = securityProviderEnum.enumValues as readonly string[];
    expect([...securityProviderValues]).toEqual([...dbEnum]);
    for (const value of securityProviderValues) {
      // Every value the agent ingest can store must render in the dashboard...
      expect(providerCatalog[value as keyof typeof providerCatalog]?.id).toBe(value);
      // ...and normalize to itself, or the agent's report is relabelled 'other'.
      expect(normalizeProvider(value)).toBe(value);
      // ...and carry a friendly label in the compliance/posture reports.
      if (value !== 'other') {
        expect(prettySecurityProvider(value)).not.toBe(value);
      }
    }
    expect(securityProviderValues).toEqual(expect.arrayContaining(['emsisoft', 'webroot', 'withsecure']));
  });
});
