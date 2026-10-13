import { and, inArray } from 'drizzle-orm';
import type { EdrEndpointActionAvailability, EdrIsolationState, EdrOsPlatform } from '@breeze/shared';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { edrConnections, edrTenants } from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import type { UserPermissions } from '../permissions';
import { describeEndpointActions } from './actions';
import { resolveEdrReadScope } from './read';

/**
 * W03 (#8167): `actions` availability for `GET /edr/endpoints` rows — no
 * vendor call. The rows were read under the caller's RLS context; the facts
 * they need live on the partner-axis tables an org token cannot read, so the
 * connection + tenant facts are loaded under a short SYSTEM context keyed only
 * by ids taken from those authorized rows, and only non-secret columns.
 */
export interface EdrEndpointRowForActions {
  id: string;
  orgId: string;
  connectionId: string;
  tenantId: string;
  vendorEndpointId: string;
  osPlatform: EdrOsPlatform;
  isolationState: EdrIsolationState;
  online: boolean | null;
  breezeDeviceId: string | null;
}

export async function describeEndpointActionsForRows(
  auth: AuthContext,
  perms: UserPermissions | undefined,
  rows: readonly EdrEndpointRowForActions[],
): Promise<Map<string, EdrEndpointActionAvailability[]>> {
  const out = new Map<string, EdrEndpointActionAvailability[]>();
  if (rows.length === 0) return out;
  const restriction = await resolveEdrReadScope(auth, perms);
  const connectionIds = [...new Set(rows.map((r) => r.connectionId))];
  const tenantIds = [...new Set(rows.map((r) => r.tenantId))];
  const orgIds = [...new Set(rows.map((r) => r.orgId))];

  // A second short pooled connection, outside the request transaction (#1105 shape).
  const facts = await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const [connections, tenants] = await Promise.all([
      db.select({
        id: edrConnections.id,
        provider: edrConnections.provider,
        isActive: edrConnections.isActive,
        status: edrConnections.status,
        actionsEnabled: edrConnections.actionsEnabled,
        capabilitiesSnapshot: edrConnections.capabilitiesSnapshot,
      }).from(edrConnections).where(inArray(edrConnections.id, connectionIds)),
      db.select({
        id: edrTenants.id,
        orgId: edrTenants.orgId,
        unsupportedActions: edrTenants.unsupportedActions,
        unsupportedActionsAt: edrTenants.unsupportedActionsAt,
      }).from(edrTenants).where(and(inArray(edrTenants.id, tenantIds), inArray(edrTenants.orgId, orgIds))),
    ]);
    return { connections: new Map(connections.map((c) => [c.id, c])), tenants: new Map(tenants.map((t) => [t.id, t])) };
  }, 'edrActions.availability'));

  const now = new Date();
  for (const row of rows) {
    const connection = facts.connections.get(row.connectionId);
    const tenant = facts.tenants.get(row.tenantId);
    if (!connection || !tenant || tenant.orgId !== row.orgId) {
      out.set(row.id, []);
      continue;
    }
    out.set(row.id, describeEndpointActions(row, tenant, connection, {
      restriction: { allowedDeviceIds: restriction.allowedDeviceIds, allowedSiteIds: restriction.allowedSiteIds },
      now,
    }));
  }
  return out;
}
