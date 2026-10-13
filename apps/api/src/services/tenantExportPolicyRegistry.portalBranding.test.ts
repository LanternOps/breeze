import { describe, expect, it } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { portalBranding } from '../db/schema/portal';
import { getTenantExportPolicyRegistry } from './tenantExportPolicyRegistry';

/**
 * chrome_accent (packages/shared/src/types/portalChromeAccent.ts) added
 * alongside the migration in this same PR. portal_branding is an org-cascade
 * table, so `tenant-export-policy.integration.test.ts` classifies every
 * column of it — but that suite needs a live database, so a missed
 * classification only reds in Integration Tests. Pinning it here moves the
 * failure into Test API, same reasoning as the network_monitors TLS-column
 * test (tenantExportPolicyRegistry.tls.test.ts).
 */
describe('portal_branding.chrome_accent export policy', () => {
  it('is mapped and included (plain enum-shaped varchar, not jsonb/bytea, no SUSPICIOUS_NAME_PARTS hit)', () => {
    expect(
      getTenantExportPolicyRegistry()['portal_branding']?.columns['chrome_accent']?.decision,
    ).toBe('include');
    expect(
      (getTableColumns(portalBranding) as Record<string, { name: string }>)['chromeAccent']?.name,
    ).toBe('chrome_accent');
  });
});

describe('portal_branding.enable_patch_detail export policy (portal visibility W05)', () => {
  it('is mapped and included (plain boolean, not jsonb/bytea)', () => {
    expect(
      getTenantExportPolicyRegistry()['portal_branding']?.columns['enable_patch_detail']?.decision,
    ).toBe('include');
    expect(
      (getTableColumns(portalBranding) as Record<string, { name: string }>)['enablePatchDetail']?.name,
    ).toBe('enable_patch_detail');
  });
});

describe('portal_branding.enable_vulnerability_detail export policy (portal visibility W06)', () => {
  it('is mapped and included (plain boolean, not jsonb/bytea)', () => {
    expect(
      getTenantExportPolicyRegistry()['portal_branding']?.columns['enable_vulnerability_detail']?.decision,
    ).toBe('include');
    expect(
      (getTableColumns(portalBranding) as Record<string, { name: string }>)['enableVulnerabilityDetail']?.name,
    ).toBe('enable_vulnerability_detail');
  });
});

describe('portal_branding.enable_edr_visibility export policy (EDR provider framework W02)', () => {
  it('is mapped and included (plain boolean, not jsonb/bytea)', () => {
    expect(
      getTenantExportPolicyRegistry()['portal_branding']?.columns['enable_edr_visibility']?.decision,
    ).toBe('include');
    expect(
      (getTableColumns(portalBranding) as Record<string, { name: string }>)['enableEdrVisibility']?.name,
    ).toBe('enable_edr_visibility');
  });
});

describe('portal_branding.enable_hour_block export policy (block hours W04)', () => {
  it('is mapped and included (plain boolean, not jsonb/bytea, no SUSPICIOUS_NAME_PARTS hit)', () => {
    expect(
      getTenantExportPolicyRegistry()['portal_branding']?.columns['enable_hour_block']?.decision,
    ).toBe('include');
    expect(
      (getTableColumns(portalBranding) as Record<string, { name: string }>)['enableHourBlock']?.name,
    ).toBe('enable_hour_block');
  });
});
