import { and, eq, gt, inArray, or } from 'drizzle-orm';
import type { EdrEndpointActionAvailability, EdrIsolationState, EdrOsPlatform } from '@breeze/shared';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { edrActions, edrConnections, edrTenants } from '../../db/schema';
import { hasSatisfiedMfa, type AuthContext } from '../../middleware/auth';
import { hasPermission, PERMISSIONS, type UserPermissions } from '../permissions';
import { describeEndpointActions, type EdrActionLedgerFact } from './actions';
import { EDR_ACTION_COOLDOWN_MS } from './actionTargets';
import { resolveEdrReadScope } from './read';

/**
 * W03 (#8167): `actions` availability for `GET /edr/endpoints` rows — no
 * vendor call. The rows were read under the caller's RLS context; the facts
 * they need live on the partner-axis tables an org token cannot read, so the
 * connection + tenant facts are loaded under a short SYSTEM context keyed only
 * by ids taken from those authorized rows, and only non-secret columns.
 * The endpoints' open and just-settled `edr_actions` rows are read in the
 * CALLER's own context (shape-1 RLS), so the list reflects in-flight and
 * outcome-unknown requests exactly as dispatch would (#12789).
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
        vendorMissingSince: edrTenants.vendorMissingSince,
      }).from(edrTenants).where(and(inArray(edrTenants.id, tenantIds), inArray(edrTenants.orgId, orgIds))),
    ]);
    return { connections: new Map(connections.map((c) => [c.id, c])), tenants: new Map(tenants.map((t) => [t.id, t])) };
  }, 'edrActions.availability'));

  const now = new Date();
  const ledger = await loadLedger(rows.map((r) => r.id), now);
  // Unresolved permissions fail closed.
  const caller = {
    canExecute: !!perms && hasPermission(perms, PERMISSIONS.DEVICES_EXECUTE.resource, PERMISSIONS.DEVICES_EXECUTE.action),
    mfaSatisfied: hasSatisfiedMfa(auth),
  };
  for (const row of rows) {
    const connection = facts.connections.get(row.connectionId);
    const tenant = facts.tenants.get(row.tenantId);
    if (!connection || !tenant || tenant.orgId !== row.orgId) {
      out.set(row.id, []);
      continue;
    }
    out.set(row.id, describeEndpointActions(row, tenant, connection, {
      caller,
      restriction: { allowedDeviceIds: restriction.allowedDeviceIds, allowedSiteIds: restriction.allowedSiteIds },
      now,
      ledger: ledger.get(row.id) ?? [],
    }));
  }
  return out;
}

/**
 * The rows `lockAndRecheckEdrActionTarget` would count: open (queued /
 * submitted) per (endpoint, action), and successes inside the cooldown.
 * Endpoint ids come from rows the caller already read; RLS fences this read.
 */
async function loadLedger(endpointIds: string[], now: Date): Promise<Map<string, EdrActionLedgerFact[]>> {
  const out = new Map<string, EdrActionLedgerFact[]>();
  const rows = await db.select({
    endpointId: edrActions.endpointId,
    action: edrActions.action,
    status: edrActions.status,
    error: edrActions.error,
    requestedAt: edrActions.requestedAt,
  }).from(edrActions).where(and(
    inArray(edrActions.endpointId, endpointIds),
    or(
      inArray(edrActions.status, ['queued', 'submitted']),
      and(eq(edrActions.status, 'succeeded'), gt(edrActions.requestedAt, new Date(now.getTime() - EDR_ACTION_COOLDOWN_MS))),
    ),
  ));
  for (const r of rows) {
    if (!r.endpointId) continue;
    const list = out.get(r.endpointId) ?? [];
    list.push({ action: r.action, status: r.status, error: r.error ?? null, requestedAt: r.requestedAt });
    out.set(r.endpointId, list);
  }
  return out;
}
