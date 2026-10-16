import { and, eq, isNull, sql } from 'drizzle-orm';
import { edrActions, edrDetections, edrEndpoints, edrTenants, organizations } from '../../db/schema';
import {
  resolveAutoMapNameSuggestions,
  resolveAutoMappings,
  type AutoMapNameSuggestion,
} from '../externalTenantMapping';
import { isUnassignedPoolOrgType } from '../unassignedPool/orgType';
import { notHiddenOrgType } from '../unassignedPool/visibility';
import type { EdrSyncTx, PersistConnection } from './persist';

export type { AutoMapNameSuggestion };

/*
 * Vendor tenant -> Breeze org mapping for the EDR framework. Mirrors
 * backupProviders/mapping.ts, except that history is TOMBSTONED, not deleted,
 * on a remap (spec D13 option C, plan index correction 1): detections and
 * actions keep their rows under the OLD org with `detached_at` set and
 * `tenant_id` NULL; the partial live-identity index then lets the next sync
 * create a fresh row under the NEW org. Endpoints are inventory, not history,
 * so they are deleted and re-created by the next inventory pass.
 *
 * Callers: `remapEdrTenant` is reached only from PUT /edr/tenants/:id/mapping
 * (behind requireEdrPartnerAdmin); `autoMapEdrTenants` only from the sync worker.
 */

/** Orgs a tenant may be mapped onto: the partner's live, visible, non-holding orgs. */
async function loadMappableOrgs(tx: EdrSyncTx, partnerId: string) {
  return tx
    .select({ id: organizations.id, name: organizations.name })
    .from(organizations)
    .where(and(
      eq(organizations.partnerId, partnerId),
      isNull(organizations.deletedAt),
      isNull(organizations.archivedAt),
      sql`${organizations.status} NOT IN ('archived','purging','merging')`,
      // Quick Support and the holding org are never a customer to map onto.
      notHiddenOrgType(),
      sql`${organizations.type} <> 'unassigned_pool'`,
    ));
}

async function loadUnmappedTenants(tx: EdrSyncTx, connectionId: string) {
  return tx
    .select({
      id: edrTenants.id,
      vendorName: edrTenants.vendorTenantName,
      vendorExternalCode: edrTenants.vendorExternalCode,
    })
    .from(edrTenants)
    .where(and(eq(edrTenants.connectionId, connectionId), isNull(edrTenants.mappingSource)));
}

/**
 * Map every still-unmapped tenant (`mapping_source IS NULL`) whose external code
 * is the id of one of the partner's orgs. `manual` / `manual_unmapped` are a
 * technician's decision and are never touched. Name matches are RETURNED as
 * suggestions, never written.
 */
export async function autoMapEdrTenants(
  tx: EdrSyncTx,
  conn: PersistConnection,
): Promise<{ mapped: number; suggestions: AutoMapNameSuggestion[] }> {
  const tenants = await loadUnmappedTenants(tx, conn.id);
  if (tenants.length === 0) return { mapped: 0, suggestions: [] };

  const orgs = await loadMappableOrgs(tx, conn.partnerId);
  const decisions = resolveAutoMappings(tenants, orgs);
  const suggestions = resolveAutoMapNameSuggestions(
    tenants,
    orgs,
    new Set(decisions.map((d) => d.orgId)),
  );

  let mapped = 0;
  if (decisions.length > 0) {
    // `mapping_source IS NULL` is repeated here on purpose: it is the concurrency
    // control, so a manual remap that landed after the SELECT wins.
    const values = sql.join(
      decisions.map((d) => sql`(${d.tenantId}::uuid, ${d.orgId}::uuid, ${d.mappingSource})`),
      sql`, `,
    );
    const updated = await tx.execute(sql`
      UPDATE edr_tenants AS t
      SET org_id = v.org_id, mapping_source = v.mapping_source, updated_at = now()
      FROM (VALUES ${values}) AS v(tenant_id, org_id, mapping_source)
      WHERE t.id = v.tenant_id
        AND t.connection_id = ${conn.id}::uuid
        AND t.mapping_source IS NULL
      RETURNING t.id
    `);
    mapped = (updated as unknown as unknown[]).length;
  }
  return { mapped, suggestions };
}

/** Name-based suggestions for the operator UI (never persisted). */
export async function listNameSuggestions(
  tx: EdrSyncTx,
  connectionId: string,
): Promise<AutoMapNameSuggestion[]> {
  const [partnerRow] = await tx
    .select({ partnerId: edrTenants.partnerId })
    .from(edrTenants)
    .where(eq(edrTenants.connectionId, connectionId))
    .limit(1);
  if (!partnerRow) return [];

  const tenants = await loadUnmappedTenants(tx, connectionId);
  if (tenants.length === 0) return [];
  const orgs = await loadMappableOrgs(tx, partnerRow.partnerId);
  const claimed = new Set(resolveAutoMappings(tenants, orgs).map((d) => d.orgId));
  return resolveAutoMapNameSuggestions(tenants, orgs, claimed);
}

export type RemapEdrTenantErrorCode = 'NOT_FOUND' | 'ORG_NOT_IN_PARTNER' | 'HOLDING_ORG';

export class RemapEdrTenantError extends Error {
  readonly code: RemapEdrTenantErrorCode;
  constructor(code: RemapEdrTenantErrorCode, message: string) {
    super(message);
    this.name = 'RemapEdrTenantError';
    this.code = code;
  }
}

export interface RemapEdrTenantResult {
  tenantId: string;
  previousOrgId: string | null;
  orgId: string | null;
  endpointsDeleted: number;
  detectionsDetached: number;
  actionsDetached: number;
}

/**
 * Map, re-map or un-map one vendor tenant inside the caller's transaction. The
 * caller holds `pg_advisory_xact_lock(hashtext('edr-provider-sync'),
 * hashtext(connectionId))` so this serializes with sync Phase 3.
 *
 * ORDER MATTERS: children are detached BEFORE the tenant's `org_id` changes.
 * `edr_detections` / `edr_actions` carry a composite `(tenant_id, org_id) ->
 * edr_tenants(id, org_id)` FK; Postgres has no column-list form for ON UPDATE,
 * so a live child still pointing at `(tenant, old_org)` makes the tenant UPDATE
 * fail with 23503.
 */
export async function remapEdrTenant(
  tx: EdrSyncTx,
  actor: { partnerId: string; userId: string | null },
  tenantId: string,
  orgId: string | null,
): Promise<RemapEdrTenantResult> {
  const [tenant] = await tx
    .select({ id: edrTenants.id, partnerId: edrTenants.partnerId, orgId: edrTenants.orgId })
    .from(edrTenants)
    .where(eq(edrTenants.id, tenantId))
    .for('update')
    .limit(1);

  // RLS already hides another partner's row; this stays as belt-and-braces for a
  // system-context caller.
  if (!tenant || tenant.partnerId !== actor.partnerId) {
    throw new RemapEdrTenantError('NOT_FOUND', 'EDR tenant not found');
  }

  if (orgId !== null) {
    // Validated before anything is written: the composite (org_id, partner_id)
    // FK would also refuse a foreign org, but as a 23503 that poisons the
    // request transaction.
    const [org] = await tx
      .select({ id: organizations.id, partnerId: organizations.partnerId, type: organizations.type })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);
    if (!org || org.partnerId !== actor.partnerId) {
      throw new RemapEdrTenantError('ORG_NOT_IN_PARTNER', 'The target organization does not belong to this partner');
    }
    if (isUnassignedPoolOrgType(org.type)) {
      throw new RemapEdrTenantError('HOLDING_ORG', 'The unassigned-device holding area cannot be a mapping target');
    }
  }

  const previousOrgId = tenant.orgId;
  const mappingSource = orgId === null ? 'manual_unmapped' : 'manual';
  const now = new Date();

  if (previousOrgId === orgId) {
    // Same org: only confirm the decision (a suggestion becomes `manual`).
    await tx
      .update(edrTenants)
      .set({ mappingSource, updatedAt: now })
      .where(eq(edrTenants.id, tenantId));
    return { tenantId, previousOrgId, orgId, endpointsDeleted: 0, detectionsDetached: 0, actionsDetached: 0 };
  }

  // D13 option C: tombstone history under the OLD org (never moved, never deleted).
  const detached = await tx
    .update(edrDetections)
    .set({ detachedAt: now, tenantId: null, endpointId: null, updatedAt: now })
    .where(and(eq(edrDetections.tenantId, tenantId), isNull(edrDetections.detachedAt)))
    .returning({ id: edrDetections.id });

  const detachedActions = await tx
    .update(edrActions)
    .set({ detachedAt: now, tenantId: null, endpointId: null, updatedAt: now })
    .where(and(eq(edrActions.tenantId, tenantId), isNull(edrActions.detachedAt)))
    .returning({ id: edrActions.id });

  // Inventory is not history: the next inventory pass re-creates it under the new org.
  const deletedEndpoints = await tx
    .delete(edrEndpoints)
    .where(eq(edrEndpoints.tenantId, tenantId))
    .returning({ id: edrEndpoints.id });

  await tx
    .update(edrTenants)
    .set({
      orgId,
      mappingSource,
      detectionCursor: null,
      openDetectionCount: 0,
      endpointCount: 0,
      updatedAt: now,
    })
    .where(eq(edrTenants.id, tenantId));

  return {
    tenantId,
    previousOrgId,
    orgId,
    endpointsDeleted: deletedEndpoints.length,
    detectionsDetached: detached.length,
    actionsDetached: detachedActions.length,
  };
}
