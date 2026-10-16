import { describe, expect, it } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { devices } from '../db/schema';
import { getTenantExportPolicyRegistry } from './tenantExportPolicyRegistry';

/**
 * Watchdog install health W02 (#8620). `devices` is an org-cascade table, so
 * every new column needs an export classification. The live-DB suite
 * (`tenant-export-policy.integration.test.ts`) only runs under Integration
 * Tests; asserting here moves the failure into Test API.
 *
 * All three are scalars (two closed-vocabulary varchars and a timestamp) —
 * none is jsonb/bytea, so none is `excludedOpen`, and none carries raw agent
 * error text.
 */
describe('devices watchdog install health columns', () => {
  const COLUMNS = {
    watchdogInstallState: 'watchdog_install_state',
    watchdogInstallErrorClass: 'watchdog_install_error_class',
    watchdogInstallSince: 'watchdog_install_since',
  } as const;

  for (const [property, column] of Object.entries(COLUMNS)) {
    it(`devices.${column} is mapped to Drizzle and included`, () => {
      expect((getTableColumns(devices) as Record<string, { name: string }>)[property]?.name).toBe(column);
      expect(getTenantExportPolicyRegistry()['devices']?.columns[column]?.decision).toBe('include');
    });
  }
});
