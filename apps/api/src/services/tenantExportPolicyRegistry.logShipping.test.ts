import { describe, expect, it } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { devices } from '../db/schema';
import { getTenantExportPolicyRegistry } from './tenantExportPolicyRegistry';

/**
 * Log-shipping health W01 (#8608). `devices` is an org-cascade table, so every
 * new column needs an export classification. The live-DB suite
 * (`tenant-export-policy.integration.test.ts`) only runs under Integration
 * Tests; asserting here moves the failure into Test API.
 *
 * All three are scalars (a closed-vocabulary varchar state, a timestamp and a
 * closed-vocabulary varchar error) — none is jsonb/bytea, so none is
 * `excludedOpen`.
 */
describe('devices log-shipping health columns', () => {
  const COLUMNS = {
    logShippingState: 'log_shipping_state',
    logShippingFailureStartedAt: 'log_shipping_failure_started_at',
    logShippingLastError: 'log_shipping_last_error',
  } as const;

  for (const [property, column] of Object.entries(COLUMNS)) {
    it(`devices.${column} is mapped to Drizzle and included`, () => {
      expect((getTableColumns(devices) as Record<string, { name: string }>)[property]?.name).toBe(column);
      expect(getTenantExportPolicyRegistry()['devices']?.columns[column]?.decision).toBe('include');
    });
  }
});
