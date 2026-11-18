import { describe, expect, it } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { devices } from '../db/schema';
import { getTenantExportPolicyRegistry } from './tenantExportPolicyRegistry';

/**
 * #4297 — `devices.watchdog_edition`. `devices` is an org-cascade table, so
 * the new column needs an export classification. The live-DB suite
 * (`tenant-export-policy.integration.test.ts`) only runs under Integration
 * Tests; asserting here moves the failure into Test API.
 *
 * A closed-vocabulary varchar ('hosted' | 'self-host') of build telemetry,
 * the twin of `agent_edition`: not jsonb/bytea, not credential material, so
 * it is `included`.
 */
describe('devices.watchdog_edition export classification', () => {
  it('is mapped to Drizzle and included, like agent_edition', () => {
    const columns = getTableColumns(devices) as Record<string, { name: string }>;
    expect(columns.watchdogEdition?.name).toBe('watchdog_edition');
    const policy = getTenantExportPolicyRegistry()['devices']?.columns;
    expect(policy?.['watchdog_edition']?.decision).toBe('include');
    expect(policy?.['agent_edition']?.decision).toBe('include');
  });
});
