/**
 * Organizations account board — W03 "No active contract" and backup inputs
 * (spec: cut lists under "Setup cell" and "Account data cell", resolved in
 * the W03 plan's "Spec ambiguities resolved" §1 and §8).
 */
import { and, eq, gte, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { db } from '../db';
import { backupConfigs, contracts, organizations } from '../db/schema';

function toCount(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Active contracts per org: `status = 'active' AND (end_date IS NULL OR
 * end_date >= CURRENT_DATE)`. Evergreen terms (NULL end_date) count — the
 * `contracts` table is the source of truth, not organizations.contract_*.
 * Only orgs with at least one such contract are keys.
 */
export async function loadActiveContractCounts(orgIds: readonly string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (orgIds.length === 0) return out;
  const rows = await db
    .select({ orgId: contracts.orgId, active: sql<string>`count(*)` })
    .from(contracts)
    .where(
      and(
        inArray(contracts.orgId, [...orgIds]),
        eq(contracts.status, 'active'),
        or(isNull(contracts.endDate), gte(contracts.endDate, sql`CURRENT_DATE`)) as SQL,
      ),
    )
    .groupBy(contracts.orgId);
  for (const row of rows) out.set(row.orgId, toCount(row.active));
  return out;
}

export interface BackupReadiness {
  /** The partner has at least one active backup_configs row under any non-deleted org. */
  applicable: boolean;
  /** Accepted org ids that have at least one active backup_configs row. */
  configuredOrgIds: Set<string>;
}

/**
 * Applicability = the partner uses backup at all. There is no entitlement
 * signal to read (no plan/edition/feature flag ties to backup; `backup:read`
 * is the only gate), so a partner that never configured a destination gets no
 * backup chips — "backup is an entitlement, not a requirement" (spec). Under a
 * partner-scope RLS context the EXISTS only sees the caller's accessible orgs,
 * which is the intended visibility.
 */
export async function loadBackupReadiness(partnerId: string, orgIds: readonly string[]): Promise<BackupReadiness> {
  const [anyActive] = await db
    .select({ id: backupConfigs.id })
    .from(backupConfigs)
    .innerJoin(organizations, eq(organizations.id, backupConfigs.orgId))
    .where(
      and(
        eq(organizations.partnerId, partnerId),
        isNull(organizations.deletedAt),
        eq(backupConfigs.isActive, true),
      ),
    )
    .limit(1);
  if (!anyActive) return { applicable: false, configuredOrgIds: new Set() };
  if (orgIds.length === 0) return { applicable: true, configuredOrgIds: new Set() };

  const configured = await db
    .selectDistinct({ orgId: backupConfigs.orgId })
    .from(backupConfigs)
    .where(and(inArray(backupConfigs.orgId, [...orgIds]), eq(backupConfigs.isActive, true)));
  return { applicable: true, configuredOrgIds: new Set(configured.map((row) => row.orgId)) };
}
