/**
 * Managed evidence definitions (#5784 W01, spec §5.1, OD-4 = A).
 *
 * "The managed definition for org O and type T" is the single
 * `portal_self_service = true` row of type T in org O — the persisted registry
 * is the existing partial unique index
 * `reports_portal_self_service_org_type_uniq (org_id, type) WHERE portal_self_service`.
 * No column is added to `reports`.
 */
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db';
import { reports } from '../db/schema/reports';
import type { DbExecutor } from './serviceDeliverableService';
import {
  isManagedEvidenceType,
  managedEvidenceEntry,
  type ManagedEvidenceType,
} from './managedEvidenceRegistry';
import { portalReportDefinitionRow } from './portal/reportsSelfService';

export type ManagedDefinition = {
  id: string;
  type: ManagedEvidenceType;
  config: Record<string, unknown>;
  /** True when an already-present definition of this type was taken over rather
   *  than created. Its config is left exactly as the partner tuned it. */
  adopted: boolean;
};

/** Read the org's managed definition for a type, or null. */
export async function loadManagedEvidenceDefinition(
  orgId: string,
  type: ManagedEvidenceType,
  executor: DbExecutor = db,
): Promise<ManagedDefinition | null> {
  const [row] = await executor
    .select({ id: reports.id, type: reports.type, config: reports.config })
    .from(reports)
    .where(and(
      eq(reports.orgId, orgId),
      eq(reports.type, type),
      eq(reports.portalSelfService, true),
    ))
    .limit(1);
  if (!row) return null;
  return {
    id: row.id,
    type: row.type as ManagedEvidenceType,
    config: (row.config ?? {}) as Record<string, unknown>,
    adopted: true,
  };
}

/**
 * Find-or-create the org's managed evidence definition for a type (#5784 §5.1).
 *
 * INSERT-IF-ABSENT, never an updating upsert: an already-present
 * portal_self_service definition of this type is ADOPTED with its config and
 * owner untouched. The partial unique index forbids a second row, so adoption is
 * the only possible behaviour — this makes it deliberate. Repair of a stale
 * config is an explicit `--repair` run of `reports:reprovision-portal-definitions`,
 * never a side effect of this call.
 *
 * Provenance: minted with a USER principal (`createdBy`) exactly as
 * `portalReportDefinitionsInsertQuery` does, so the ordinary edit/reauthorize
 * surface keeps working. The EXECUTION path no longer depends on that user
 * (`generateManagedEvidenceReport` runs under system authority), so a departed
 * owner no longer stops evidence.
 *
 * `executor` MUST be the caller's real transaction handle when called from
 * inside one: the ambient `db` proxy resolves to the AMBIENT request
 * transaction, not the nested one (`serviceDeliverableService.ts:52`).
 */
export async function resolveManagedEvidenceDefinition(
  orgId: string,
  type: ManagedEvidenceType,
  createdBy: string,
  executor: DbExecutor = db,
): Promise<ManagedDefinition> {
  if (!isManagedEvidenceType(type)) {
    throw new Error(`${type} is not a managed evidence type`);
  }
  const existing = await loadManagedEvidenceDefinition(orgId, type, executor);
  if (existing) return existing;

  const entry = managedEvidenceEntry(type);
  await executor
    .insert(reports)
    .values(portalReportDefinitionRow({
      orgId,
      createdBy,
      type,
      name: entry.definitionName,
      config: { ...entry.defaultConfig },
    }))
    .onConflictDoNothing({
      target: [reports.orgId, reports.type],
      where: sql`portal_self_service = true`,
    });

  // Re-read rather than trusting `.returning()`: onConflictDoNothing returns no
  // row when a concurrent apply won the race, and that race is real — two
  // template applies for the same org can run at once.
  const settled = await loadManagedEvidenceDefinition(orgId, type, executor);
  if (!settled) {
    throw new Error(`Failed to provision managed evidence definition ${type} for org ${orgId}`);
  }
  return { ...settled, adopted: false };
}
