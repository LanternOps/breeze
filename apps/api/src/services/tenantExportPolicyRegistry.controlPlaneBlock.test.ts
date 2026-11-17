import { describe, expect, it } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { devices } from '../db/schema';
import { getTenantExportPolicyRegistry } from './tenantExportPolicyRegistry';

/**
 * Control-plane block episodes (#8868). `devices` is an org-cascade table, so
 * every new column needs an export classification. The live-DB suite
 * (`tenant-export-policy.integration.test.ts`) only runs under Integration
 * Tests; asserting here moves the failure into Test API.
 *
 * The kind is a closed-enum varchar (`included`). The episode is jsonb holding
 * network-supplied host and issuer text, so it is an open container
 * (`excludedOpen`), never `included`.
 */
describe('devices control-plane block columns', () => {
  const columns = getTableColumns(devices) as Record<string, { name: string }>;
  const policy = () => getTenantExportPolicyRegistry()['devices']?.columns;

  it('devices.control_plane_block_kind is mapped to Drizzle and included', () => {
    expect(columns.controlPlaneBlockKind?.name).toBe('control_plane_block_kind');
    expect(policy()?.['control_plane_block_kind']?.decision).toBe('include');
  });

  it('devices.control_plane_block (jsonb) is mapped to Drizzle and excluded as an open container', () => {
    expect(columns.controlPlaneBlock?.name).toBe('control_plane_block');
    expect(policy()?.['control_plane_block']).toMatchObject({
      decision: 'exclude',
      openContainerReviewed: true,
      rationale: expect.stringMatching(/^Open-ended container/),
    });
  });
});
