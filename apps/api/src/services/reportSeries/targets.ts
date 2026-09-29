/**
 * Multi-org report series — target set (spec §3.3 "Target set").
 * 'all'      = every ELIGIBLE org of the series partner minus the target rows;
 * 'selected' = exactly the target rows that are eligible.
 * Eligible = status IN SERIES_ELIGIBLE_ORG_STATUSES AND deleted_at IS NULL.
 */
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { organizations, reportSeriesOrgTargets } from '../../db/schema';
import {
  SERIES_ELIGIBLE_ORG_STATUSES,
  type ReportSeriesRow,
  type SeriesTargetMode,
  type SeriesTx,
} from './types';

export async function eligiblePartnerOrgs(
  partnerId: string,
  tx: SeriesTx,
): Promise<Array<{ id: string; name: string }>> {
  return tx
    .select({ id: organizations.id, name: organizations.name })
    .from(organizations)
    .where(and(
      eq(organizations.partnerId, partnerId),
      inArray(organizations.status, [...SERIES_ELIGIBLE_ORG_STATUSES]),
      isNull(organizations.deletedAt),
    ))
    .orderBy(asc(organizations.name), asc(organizations.id));
}

export function applyTargetMode(
  eligibleOrgIds: readonly string[],
  targetMode: SeriesTargetMode,
  listedOrgIds: ReadonlySet<string>,
): string[] {
  return eligibleOrgIds.filter((orgId) =>
    targetMode === 'all' ? !listedOrgIds.has(orgId) : listedOrgIds.has(orgId),
  );
}

export async function listSeriesTargetRows(seriesId: string, tx: SeriesTx): Promise<string[]> {
  const rows = await tx
    .select({ orgId: reportSeriesOrgTargets.orgId })
    .from(reportSeriesOrgTargets)
    .where(eq(reportSeriesOrgTargets.seriesId, seriesId));
  return rows.map((row) => row.orgId).sort();
}

export async function resolveSeriesTargetOrgIds(
  series: ReportSeriesRow,
  tx: SeriesTx,
): Promise<string[]> {
  // Sequential on purpose: `tx` may be a single transaction connection.
  const eligible = await eligiblePartnerOrgs(series.partnerId, tx);
  const listed = new Set(await listSeriesTargetRows(series.id, tx));
  return applyTargetMode(eligible.map((org) => org.id), series.targetMode, listed).sort();
}
