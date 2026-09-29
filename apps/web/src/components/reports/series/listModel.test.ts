import { describe, expect, it } from 'vitest';
import type { Report } from '../ReportsList';
import type { SeriesDetail, SeriesOrgStatus } from './types';
import {
  buildListEntries,
  canExcludeOrg,
  DEFAULT_REPORTS_LIST_VIEW,
  filterListEntries,
  formatReportsListHash,
  parseReportsListHash,
  seriesCoveredOrgCount,
  summarizeSeriesDelivery,
  targetsAfterExclude,
  targetsAfterInclude,
} from './listModel';

const SID = '6f1c1b1e-3b8a-4c52-9a47-0c1d2e3f4a5b';
const rep = (over: Partial<Report>): Report => ({
  id: 'r', name: 'n', type: 'device_inventory', schedule: 'monthly', format: 'pdf', config: {},
  orgId: 'o-1', partnerId: null, portalSelfService: false, lastGeneratedAt: null, createdAt: '', updatedAt: '', ...over,
});
const org = (over: Partial<SeriesOrgStatus>): SeriesOrgStatus => ({
  orgId: 'o', orgName: 'O', state: 'active', childReportId: 'c', lastRun: null, ...over,
});
const detail = (over: Partial<SeriesDetail> = {}): SeriesDetail => ({
  series: { id: SID, targetMode: 'all' } as SeriesDetail['series'], targets: [], orgs: [], ...over,
});

describe('hash grammar', () => {
  it('round-trips every view', () => {
    for (const view of [
      { filter: 'all', seriesId: null },
      { filter: 'multi', seriesId: null },
      { filter: 'combined', seriesId: SID },
      { filter: 'all', seriesId: SID },
    ] as const) {
      // The empty hash is the default view (useHashState falls back to it).
      expect(parseReportsListHash(formatReportsListHash(view)) ?? DEFAULT_REPORTS_LIST_VIEW).toEqual(view);
    }
  });
  it('matches the builder\'s post-save redirect', () => {
    expect(formatReportsListHash({ filter: 'all', seriesId: SID })).toBe(`series/${SID}`);
  });
  it('ignores hashes it does not own', () => {
    expect(parseReportsListHash('')).toBeUndefined();
    expect(parseReportsListHash('runs')).toBeUndefined();
    expect(parseReportsListHash('series/not-a-uuid')).toBeUndefined();
  });
});

describe('entries and filters', () => {
  const partnerOwned = rep({ id: 'p', orgId: null, partnerId: 'p-1' });
  const single = rep({ id: 's' });
  const child = rep({ id: 'c', seriesId: SID, seriesName: 'Monthly' });
  it('grouped: series first, children folded into their series', () => {
    const entries = buildListEntries([single, child, partnerOwned], [detail()], true);
    expect(entries.map((e) => (e.kind === 'series' ? `series:${e.detail.series.id}` : e.report.id))).toEqual([`series:${SID}`, 's', 'p']);
  });
  it('org view: children are ordinary rows', () => {
    expect(buildListEntries([single, child], [], false).map((e) => e.kind)).toEqual(['report', 'report']);
  });
  it('filters by what each entry covers', () => {
    const grouped = buildListEntries([single, partnerOwned], [detail()], true);
    expect(filterListEntries(grouped, 'multi').map((e) => e.kind)).toEqual(['series']);
    expect(filterListEntries(grouped, 'single')).toHaveLength(1);
    expect(filterListEntries(grouped, 'combined')).toHaveLength(1);
    const orgView = buildListEntries([single, child], [], false);
    expect(filterListEntries(orgView, 'multi').map((e) => e.kind === 'report' && e.report.id)).toEqual(['c']);
  });
});

describe('delivery summary', () => {
  it('reads "17/18 delivered · 1 no recipient"', () => {
    const orgs = [
      ...Array.from({ length: 17 }, (_, i) => org({ orgId: `o${i}`, lastRun: { status: 'completed', deliveryStatus: 'sent', recipientCount: 1, completedAt: '2026-10-01T09:00:00Z' } })),
      org({ orgId: 'o17', state: 'blocked_no_recipients', lastRun: { status: 'completed', deliveryStatus: 'no_recipients', recipientCount: 0, completedAt: '2026-10-01T09:05:00Z' } }),
      org({ orgId: 'x', state: 'excluded' }),
    ];
    expect(summarizeSeriesDelivery(orgs)).toEqual({ lastRunAt: '2026-10-01T09:05:00Z', delivered: 17, total: 18, noRecipient: 1, blocked: 0 });
    expect(seriesCoveredOrgCount(detail({ orgs }))).toBe(18);
  });
  it('has no date before any run', () => {
    expect(summarizeSeriesDelivery([org({})]).lastRunAt).toBeNull();
  });
});

describe('target edits', () => {
  it('excludes and includes per mode', () => {
    const all = detail({ targets: ['o-9'] });
    expect(targetsAfterExclude(all, 'o-1')).toEqual({ targetMode: 'all', orgIds: ['o-9', 'o-1'] });
    expect(targetsAfterInclude(all, 'o-9')).toEqual({ targetMode: 'all', orgIds: [] });
    const chosen = detail({ series: { id: SID, targetMode: 'selected' } as SeriesDetail['series'], targets: ['o-1', 'o-2'] });
    expect(targetsAfterExclude(chosen, 'o-1')).toEqual({ targetMode: 'selected', orgIds: ['o-2'] });
    expect(targetsAfterInclude(chosen, 'o-3')).toEqual({ targetMode: 'selected', orgIds: ['o-1', 'o-2', 'o-3'] });
  });
  // Review Focus 1.
  it('never lets a Chosen-organizations series drop its last org', () => {
    const one = detail({ series: { id: SID, targetMode: 'selected' } as SeriesDetail['series'], targets: ['o-1'] });
    expect(canExcludeOrg(one, 'o-1')).toBe(false);
    expect(canExcludeOrg(detail(), 'o-1')).toBe(true);
  });
  it('does not count a suspended or detached chosen org as the one that remains', () => {
    const chosen = detail({
      series: { id: SID, targetMode: 'selected' } as SeriesDetail['series'],
      targets: ['o-1', 'o-s'],
      orgs: [org({ orgId: 'o-1', state: 'active' }), org({ orgId: 'o-s', state: 'ineligible' })],
    });
    expect(canExcludeOrg(chosen, 'o-1')).toBe(false);
  });
});
