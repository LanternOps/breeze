import { withSystemDbAccessContext, db } from '../../../db';
import { m365Connections, type M365ConnectionRow } from '../../../db/schema';

/**
 * Test-only helper: inserts an active (by default) `customer-graph-actions`
 * `m365_connections` row for an org, under a system context (mirrors
 * intentReleaseWorkerGoogleHeadless.integration.test.ts's
 * `seedGoogleConnection`, but for the M365 write-action ladder
 * (executeM365WriteActionByOrg reads exactly this row/profile).
 *
 * Populates every NOT NULL column on `m365_connections` with a minimal valid
 * value; only the columns the write-action ladder actually branches on
 * (`orgId`, `tenantId`, `status`) are caller-controlled.
 */
export async function seedActionsConnection(input: {
  orgId: string;
  tenantId: string;
  status?: M365ConnectionRow['status'];
}): Promise<M365ConnectionRow> {
  return withSystemDbAccessContext(async () => {
    const [row] = await db
      .insert(m365Connections)
      .values({
        orgId: input.orgId,
        tenantId: input.tenantId,
        profile: 'customer-graph-actions',
        authMode: 'application-certificate',
        credentialDomain: 'customer-graph-actions',
        clientId: 'test-customer-graph-actions-client',
        // credential_location_check (2026-07-13-m365-control-plane-foundation.sql):
        // a non-legacy-direct profile requires client_secret NULL AND vault_ref
        // + credential_version NOT NULL. Leave clientSecret unset.
        vaultRef: 'akv://vault.example/m365-customer-graph-actions/0123456789abcdef0123456789abcdef',
        credentialVersion: '0123456789abcdef0123456789abcdef',
        // manifest_version_check: a non-legacy-direct profile requires
        // permission_manifest_version >= 1.
        permissionManifestVersion: 1,
        status: input.status ?? 'active',
      })
      .returning();
    return row!;
  });
}
