import { describe, expect, it } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { portalUserIdentities } from '../db/schema/portal';
import { portalScimTokens } from '../db/schema/portalScim';
import { getTenantExportPolicyRegistry } from './tenantExportPolicyRegistry';

/**
 * Portal registration W9 (#11386, plan D1, D3): Entra SCIM provisioning. One new
 * org-cascade table (portal_scim_tokens) and six new portal_user_identities
 * columns. tenant-export-policy.integration.test.ts classifies every column but
 * needs a live database (Integration Tests only); pinning it here moves the
 * failure into Test API.
 *
 * The token's secret hash and hint are verifier material → excludedSensitive.
 * Everything else is a plain value (text, timestamptz, uuid) → include.
 */
const columnNames = (schema: Parameters<typeof getTableColumns>[0]) =>
  Object.values(getTableColumns(schema) as Record<string, { name: string }>).map((c) => c.name);

const SENSITIVE_TOKEN_COLUMNS = ['secret_hash', 'secret_hint'];

const NEW_IDENTITY_COLUMNS = [
  'scim_user_name',
  'scim_display_name',
  'scim_given_name',
  'scim_family_name',
  'scim_provisioned_at',
  'scim_deleted_at',
] as const;

describe('portal SCIM export policy (W9)', () => {
  const registry = getTenantExportPolicyRegistry();

  it('classifies every portal_scim_tokens column; the secret material is excluded', () => {
    const policy = registry['portal_scim_tokens'];
    expect(policy, 'portal_scim_tokens must be registered').toBeDefined();
    expect(policy!.organizationKey).toBe('org_id');
    const dbColumns = columnNames(portalScimTokens);
    expect(Object.keys(policy!.columns).sort()).toEqual([...dbColumns].sort());
    for (const col of dbColumns) {
      const expected = SENSITIVE_TOKEN_COLUMNS.includes(col) ? 'exclude' : 'include';
      expect(policy!.columns[col]?.decision, `portal_scim_tokens.${col}`).toBe(expected);
    }
  });

  it('scim_provisioned_at matches the "provision" suspicious name part and is a REVIEWED include (else the live export plan throws)', () => {
    const decision = registry['portal_user_identities']?.columns['scim_provisioned_at'];
    expect(decision?.decision).toBe('include');
    expect(decision?.reviewedSensitiveName).toBe(true);
  });

  it('classifies every new portal_user_identities column as include', () => {
    const policy = registry['portal_user_identities'];
    const dbColumns = columnNames(portalUserIdentities);
    for (const col of NEW_IDENTITY_COLUMNS) {
      expect(dbColumns, `Drizzle portal_user_identities.${col}`).toContain(col);
      expect(policy?.columns[col]?.decision, `portal_user_identities.${col}`).toBe('include');
    }
  });
});
