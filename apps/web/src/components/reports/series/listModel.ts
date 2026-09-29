import type { Report } from '../ReportsList';
import type { SeriesDetail, SeriesOrgStatus, SeriesTargets } from './types';

/** Name | Covers | Type | Schedule | Format | Last generated | Actions (W01's table). */
export const SAVED_REPORTS_COLUMN_COUNT = 7;

export type ReportsListFilter = 'all' | 'multi' | 'single' | 'combined';
export const REPORTS_LIST_FILTERS: readonly ReportsListFilter[] = ['all', 'multi', 'single', 'combined'];

export type ReportsListEntry =
  | { kind: 'report'; report: Report }
  | { kind: 'series'; detail: SeriesDetail };

export interface ReportsListView { filter: ReportsListFilter; seriesId: string | null }
export const DEFAULT_REPORTS_LIST_VIEW: ReportsListView = { filter: 'all', seriesId: null };

/** What an entry covers, for the filter chips. A child row is "multi". */
export function entryCoverKind(entry: ReportsListEntry): Exclude<ReportsListFilter, 'all'> {
  if (entry.kind === 'series') return 'multi';
  const { report } = entry;
  if (report.seriesId) return 'multi';
  if (!report.orgId && report.partnerId) return 'combined';
  return 'single';
}

/**
 * Grouped (All organizations, partner-wide user): one entry per series, then
 * the standalone rows (children never appear twice). Org view: the list API's
 * rows as-is — children are ordinary rows with a Multi-org badge (spec §3.7).
 */
export function buildListEntries(reports: Report[], series: SeriesDetail[], grouped: boolean): ReportsListEntry[] {
  const reportEntries: ReportsListEntry[] = reports
    .filter((report) => !(grouped && report.seriesId))
    .map((report) => ({ kind: 'report', report }));
  if (!grouped) return reportEntries;
  return [...series.map((detail): ReportsListEntry => ({ kind: 'series', detail })), ...reportEntries];
}

export function filterListEntries(entries: ReportsListEntry[], filter: ReportsListFilter): ReportsListEntry[] {
  return filter === 'all' ? entries : entries.filter((entry) => entryCoverKind(entry) === filter);
}

// ---- hash: '' | <filter> | series/<uuid> | <filter>/series/<uuid> ----
const FILTER_TO_HASH: Record<ReportsListFilter, string> = { all: '', multi: 'multi-org', single: 'single-org', combined: 'combined' };
const HASH_TO_FILTER: Record<string, ReportsListFilter> = { 'multi-org': 'multi', 'single-org': 'single', combined: 'combined' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function formatReportsListHash(view: ReportsListView): string {
  const parts = [FILTER_TO_HASH[view.filter], view.seriesId ? `series/${view.seriesId}` : ''].filter(Boolean);
  return parts.join('/');
}

export function parseReportsListHash(hash: string): ReportsListView | undefined {
  if (!hash) return undefined;
  const segments = hash.split('/');
  let filter: ReportsListFilter = 'all';
  if (HASH_TO_FILTER[segments[0]!]) filter = HASH_TO_FILTER[segments.shift()!]!;
  if (segments.length === 0) return { filter, seriesId: null };
  if (segments.length === 2 && segments[0] === 'series' && UUID.test(segments[1]!)) {
    return { filter, seriesId: segments[1]! };
  }
  return undefined;
}

// ---- delivery summary (spec §3.7 "Oct 1 · 17/18 delivered · 1 no recipient ⚠") ----
const COVERED_STATES = new Set<SeriesOrgStatus['state']>(['active', 'blocked_no_authority', 'blocked_no_recipients']);

export interface SeriesDeliverySummary {
  lastRunAt: string | null;
  delivered: number;
  total: number;
  noRecipient: number;
  blocked: number;
}

/** "Delivered" counts `sent` only — a partial send is not reported as delivered. */
export function summarizeSeriesDelivery(orgs: SeriesOrgStatus[]): SeriesDeliverySummary {
  const covered = orgs.filter((o) => COVERED_STATES.has(o.state));
  let lastRunAt: string | null = null;
  for (const o of covered) {
    const at = o.lastRun?.completedAt ?? null;
    if (at && (!lastRunAt || at > lastRunAt)) lastRunAt = at;
  }
  return {
    lastRunAt,
    delivered: covered.filter((o) => o.lastRun?.deliveryStatus === 'sent').length,
    total: covered.length,
    noRecipient: covered.filter((o) => o.state === 'blocked_no_recipients' || o.lastRun?.deliveryStatus === 'no_recipients').length,
    blocked: covered.filter((o) => o.state === 'blocked_no_authority').length,
  };
}

export function seriesCoveredOrgCount(detail: SeriesDetail): number {
  return detail.orgs.filter((o) => COVERED_STATES.has(o.state)).length;
}

// ---- per-org target edits (drill-down Exclude / Include) ----
export function targetsAfterExclude(detail: SeriesDetail, orgId: string): SeriesTargets {
  const { targetMode } = detail.series;
  return targetMode === 'all'
    ? { targetMode, orgIds: detail.targets.includes(orgId) ? detail.targets : [...detail.targets, orgId] }
    : { targetMode, orgIds: detail.targets.filter((id) => id !== orgId) };
}

export function targetsAfterInclude(detail: SeriesDetail, orgId: string): SeriesTargets {
  const { targetMode } = detail.series;
  return targetMode === 'all'
    ? { targetMode, orgIds: detail.targets.filter((id) => id !== orgId) }
    : { targetMode, orgIds: detail.targets.includes(orgId) ? detail.targets : [...detail.targets, orgId] };
}

/** A Chosen-organizations series keeps at least one org (Review Focus 1). */
export function canExcludeOrg(detail: SeriesDetail, orgId: string): boolean {
  return detail.series.targetMode === 'all' || detail.targets.some((id) => id !== orgId);
}
