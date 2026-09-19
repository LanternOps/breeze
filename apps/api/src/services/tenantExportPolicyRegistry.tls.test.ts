import { describe, expect, it } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { networkMonitors } from '../db/schema/monitors';
import { getTenantExportPolicyRegistry } from './tenantExportPolicyRegistry';

/**
 * Registration shipped with the DDL in #5751 W03 (#5754); this also pins
 * Drizzle parity.
 *
 * `tenant-export-policy.integration.test.ts` classifies every column of every
 * org-cascade table, but it needs a live database, so a missed classification
 * only reds in Integration Tests. Asserting it here moves the failure into
 * **Test API** where the PR that adds the columns actually sees it.
 *
 * All five are scalars (timestamps and varchars), so `included` — the
 * open-container rule that pushes `config` to `excludedOpen` does not reach
 * them.
 */
describe('network_monitors TLS observation columns', () => {
  const TLS_COLUMNS = {
    tlsNotAfter: 'tls_not_after',
    tlsObservedHost: 'tls_observed_host',
    tlsIssuer: 'tls_issuer',
    tlsObservedAt: 'tls_observed_at',
    tlsState: 'tls_state',
  } as const;

  for (const [property, column] of Object.entries(TLS_COLUMNS)) {
    it(`network_monitors.${column} is mapped and included`, () => {
      expect(getTenantExportPolicyRegistry()['network_monitors']?.columns[column]?.decision).toBe(
        'include',
      );
      expect(
        (getTableColumns(networkMonitors) as Record<string, { name: string }>)[property]?.name,
      ).toBe(column);
    });
  }

  it('leaves config excludedOpen — a jsonb column is never included', () => {
    expect(getTenantExportPolicyRegistry()['network_monitors']?.columns['config']?.decision).toBe(
      'exclude',
    );
  });
});
