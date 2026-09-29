/**
 * Multi-org report series — target set (spec §3.3 "Target set").
 * 'all'      = every ELIGIBLE org of the series partner minus the target rows;
 * 'selected' = exactly the target rows that are eligible.
 * Eligible = status IN SERIES_ELIGIBLE_ORG_STATUSES AND deleted_at IS NULL.
 *
 * Either way, an org that holds a live DETACHED standalone of the series
 * (reports.detached_from_series_id = the series, series_id NULL, not
 * archived) is NOT targeted: detach is remembered on that row, so no later
 * targets change (mode flip, a replace that drops an exclusion) can mint a
 * second child next to it. Deleting or archiving the standalone re-enables
 * targeting. findSeriesNeedingReconcile (reconcile.ts) mirrors this rule.
 */
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { organizations, reports, reportSeriesOrgTargets } from '../../db/schema';
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

/** Orgs holding a live detached standalone of this series (never targeted). */
export async function listDetachedOrgIds(seriesId: string, tx: SeriesTx): Promise<Set<string>> {
  const rows = await tx
    .select({ orgId: reports.orgId })
    .from(reports)
    .where(and(
      eq(reports.detachedFromSeriesId, seriesId),
      isNull(reports.seriesId),
      isNull(reports.archivedAt),
    ));
  return new Set(rows.flatMap((row) => (row.orgId === null ? [] : [row.orgId])));
}

/** applyTargetMode, minus orgs that hold a live detached standalone of the series. */
export async function resolveTargetsForSeries(
  seriesId: string | null,
  eligibleOrgIds: readonly string[],
  targetMode: SeriesTargetMode,
  listedOrgIds: ReadonlySet<string>,
  tx: SeriesTx,
): Promise<string[]> {
  const targeted = applyTargetMode(eligibleOrgIds, targetMode, listedOrgIds);
  if (seriesId === null) return targeted;
  const detached = await listDetachedOrgIds(seriesId, tx);
  return targeted.filter((orgId) => !detached.has(orgId));
}

export async function resolveSeriesTargetOrgIds(
  series: ReportSeriesRow,
  tx: SeriesTx,
): Promise<string[]> {
  // Sequential on purpose: `tx` may be a single transaction connection.
  const eligible = await eligiblePartnerOrgs(series.partnerId, tx);
  const listed = new Set(await listSeriesTargetRows(series.id, tx));
  return (await resolveTargetsForSeries(series.id, eligible.map((org) => org.id), series.targetMode, listed, tx)).sort();
}
