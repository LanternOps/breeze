// Fixtures for the count-parity (arrival) harness. A tiny fake of the three
// server behaviours the parity argument rests on, all narrowed by the SAME
// session inputs the real routes share:
//
//   GET  /devices/stats        - the tile's source (statsFor)
//   GET  /orgs/sites/:id       - the site-detail count (siteCountFor)
//   POST /filters/preview      - the destination's predicate resolution
//   GET  /devices (list)       - the destination's population (listFor)
//
// Narrowing inputs: the ambient org (injected by fetchWithAuth as ?orgId=) and
// the session's site allowlist (`allowedSiteIds`, enforced server-side on every
// one of those routes). Counts are never compared live (RF3): the harness
// compares the predicate and scope each side sends, then checks the rows the
// destination would show against the tile's number computed from the same
// fixture.
import type { FilterCondition, FilterConditionGroup } from '@breeze/shared';

export const ORG_A = '0f8fad5b-d9cb-469f-a165-70867728950e';
export const ORG_B = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
export const SITE_A = '3c9d6f1e-1b2a-4c3d-8e4f-5a6b7c8d9e0f';
export const SITE_B = '9b2e4a7d-5c61-4f08-a3d2-1e7f6b5c4d3a';
export const SITE_C = 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f';
/** Parked in a holding org: the preview over-reports it, the list never contains it. */
export const PARKED_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

export interface FixtureDevice {
  id: string;
  hostname: string;
  status: string;
  orgId: string;
  siteId: string;
}

export const FIXTURE_DEVICES: FixtureDevice[] = [
  { id: 'd01', hostname: 'host-01', status: 'online', orgId: ORG_A, siteId: SITE_A },
  { id: 'd02', hostname: 'host-02', status: 'online', orgId: ORG_A, siteId: SITE_B },
  { id: 'd03', hostname: 'host-03', status: 'online', orgId: ORG_A, siteId: SITE_A },
  { id: 'd04', hostname: 'host-04', status: 'offline', orgId: ORG_A, siteId: SITE_A },
  { id: 'd05', hostname: 'host-05', status: 'offline', orgId: ORG_A, siteId: SITE_B },
  { id: 'd06', hostname: 'host-06', status: 'maintenance', orgId: ORG_A, siteId: SITE_A },
  { id: 'd07', hostname: 'host-07', status: 'quarantined', orgId: ORG_A, siteId: SITE_B },
  // Removed: the list endpoint returns it (the page asks includeDecommissioned),
  // the page hides it by default; the tile counts exclude it.
  { id: 'd08', hostname: 'host-08', status: 'decommissioned', orgId: ORG_A, siteId: SITE_A },
  // Another org: only visible in fleet view.
  { id: 'd09', hostname: 'host-09', status: 'online', orgId: ORG_B, siteId: SITE_C },
  { id: 'd10', hostname: 'host-10', status: 'offline', orgId: ORG_B, siteId: SITE_C },
];

export interface Session {
  /** Ambient org the fetch layer injects (null = fleet view). */
  orgId: string | null;
  /** Server-side site allowlist; null = unconfined. */
  allowedSiteIds: string[] | null;
}

function inScope(d: FixtureDevice, s: Session): boolean {
  if (s.orgId && d.orgId !== s.orgId) return false;
  if (s.allowedSiteIds && !s.allowedSiteIds.includes(d.siteId)) return false;
  return true;
}

/** What GET /devices returns: scoped, parked absent, decommissioned included. */
export function listFor(s: Session): FixtureDevice[] {
  return FIXTURE_DEVICES.filter((d) => inScope(d, s));
}

/** What /devices/stats counts: scoped, decommissioned (and parked) excluded. */
export function statsFor(s: Session) {
  const rows = FIXTURE_DEVICES.filter((d) => inScope(d, s) && d.status !== 'decommissioned');
  const byStatus: Record<string, number> = {};
  for (const d of rows) byStatus[d.status] = (byStatus[d.status] ?? 0) + 1;
  return {
    total: rows.length,
    online: byStatus.online ?? 0,
    offline: byStatus.offline ?? 0,
    byStatus,
    migrationRequiredCount: 0,
    logShippingFailingCount: 0,
  };
}

/** `deviceCount` on GET /orgs/sites/:id: same exclusions as the stats. */
export function siteCountFor(siteId: string, s: Session): number {
  return FIXTURE_DEVICES.filter(
    (d) => d.siteId === siteId && inScope(d, s) && d.status !== 'decommissioned',
  ).length;
}

function matchesCondition(d: FixtureDevice, c: FilterCondition): boolean {
  const actual = (d as unknown as Record<string, unknown>)[c.field];
  if (c.operator === 'equals') return actual === c.value;
  if (c.operator === 'in') return Array.isArray(c.value) && (c.value as unknown[]).includes(actual);
  throw new Error(`parity fixture: unsupported operator ${c.operator}`);
}

/** Ids POST /filters/preview resolves, plus the parked device it over-reports. */
export function previewIds(group: FilterConditionGroup, s: Session): string[] {
  const hits = FIXTURE_DEVICES.filter(
    (d) =>
      inScope(d, s) &&
      group.conditions.every((c) => matchesCondition(d, c as FilterCondition)),
  ).map((d) => d.id);
  return [...hits, PARKED_ID];
}

export function rawDevice(d: FixtureDevice) {
  return {
    id: d.id,
    hostname: d.hostname,
    osType: 'windows',
    osVersion: '11',
    status: d.status,
    lastSeenAt: '2026-10-01T00:00:00.000Z',
    orgId: d.orgId,
    siteId: d.siteId,
    agentVersion: '1.0.0',
    tags: [],
  };
}

export const hashOf = (href: string): string => href.slice(href.indexOf('#'));

/** What a count link must make the destination's population request say. */
export interface ParityExpectation {
  /** Conditions the preview body must carry; null = the link claims no status filter. */
  conditions: FilterCondition[] | null | ((stats: ReturnType<typeof statsFor>) => FilterCondition[]);
  /** The tile's number, from the fixture, as the card computes it. */
  tileCount: (stats: ReturnType<typeof statsFor>) => number;
}

const statusEq = (value: string): FilterCondition => ({ field: 'status', operator: 'equals', value });

/** One entry per devices-destination `count` metric in DASHBOARD_METRICS. */
export const DEVICES_PARITY: Record<string, ParityExpectation> = {
  'kpi.totalDevices': { conditions: null, tileCount: (s) => s.total },
  'kpi.online': { conditions: [statusEq('online')], tileCount: (s) => s.online },
  'fleet.legend.online': { conditions: [statusEq('online')], tileCount: (s) => s.online },
  'fleet.legend.offline': { conditions: [statusEq('offline')], tileCount: (s) => s.byStatus.offline ?? 0 },
  'fleet.viewOffline': { conditions: [statusEq('offline')], tileCount: (s) => s.byStatus.offline ?? 0 },
  'fleet.legend.other': {
    // Remaining byStatus keys, sorted: the card builds the link from the stats
    // it shows, so the expectation is derived from the same scope's stats.
    conditions: (s) => [
      {
        field: 'status',
        operator: 'in',
        value: Object.keys(s.byStatus)
          .filter((k) => k !== 'online' && k !== 'offline')
          .sort(),
      },
    ],
    tileCount: (s) => Math.max(s.total - s.online - (s.byStatus.offline ?? 0), 0),
  },
};

/** Count metrics whose destination is not a devices list, with the reason the
 *  devices harness does not cover them. Later waves add their own families. */
export const OTHER_FAMILIES: Record<string, string> = {
  'kpi.tickets': 'tickets queue opens on its default (open) tab; the link claims no filter (spec §3.2)',
};
