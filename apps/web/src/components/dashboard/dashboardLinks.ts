// The one producer of dashboard click-through links (spec 2026-10-18 §3.6) and
// the registry of every number the dashboard renders (§3.1).
//
// - Every href is built from the destination's OWN encoder
//   (`encodeFilterToHash`, `encodeDeviceClassToHash`), never by concatenating a
//   hash string by hand, so producer and consumer cannot drift.
// - Links never carry an org (R3): the org scope is ambient.
// - Each entry names the nav destination it opens; `visible` is the Sidebar's
//   own gate for that destination (R4), so a viewer who cannot open the page
//   sees plain text.
// - Numbers whose destination does not exist yet are registered `section` or
//   `exempt` with a reason; the alert / vulnerability / security / patch waves
//   flip them.
import type { FilterCondition } from '@breeze/shared';
import { encodeFilterToHash } from '../devices/filterUrl';
import { encodeDeviceClassToHash } from '../devices/deviceClassFilter';
import { canOpenDestination, type NavDestinationGate, type NavViewer } from '../../lib/navVisibility';
import type { DeviceStats } from './types';

export type MetricKind = 'count' | 'affected' | 'section' | 'exempt';

/** What an href builder may read. Only what the registry actually needs. */
export interface DashboardData {
  devices?: DeviceStats | null;
}

export interface MetricDef {
  kind: MetricKind;
  /** null ⇒ no destination for this data (renders as text). */
  href?: (d: DashboardData) => string | null;
  visible?: (v: NavViewer) => boolean;
  reason?: string;
  /** Default `data-testid` for the rendered link (spec §9.3). */
  testId?: string;
}

// ---------------------------------------------------------------------------
// Destination gates: must equal the Sidebar item's gate for the same path
// (asserted in dashboardLinks.test.ts against the real nav arrays).
// ---------------------------------------------------------------------------
export const DESTINATION_GATES = {
  '/devices': { requiredPermission: { resource: 'devices', action: 'read' } },
  '/alerts': { requiredPermission: { resource: 'alerts', action: 'read' } },
  '/patches': { requiredPermission: { resource: 'devices', action: 'read' } },
  '/vulnerabilities': { requiredPermission: { resource: 'devices', action: 'read' } },
  '/security': { requiredPermission: { resource: 'devices', action: 'read' } },
  '/tickets': {
    requiredPermission: { resource: 'tickets', action: 'read' },
    requiresModule: 'service_management',
  },
} as const satisfies Record<string, NavDestinationGate>;

const gatedBy =
  (path: keyof typeof DESTINATION_GATES) =>
  (v: NavViewer): boolean =>
    canOpenDestination(DESTINATION_GATES[path], v);

// ---------------------------------------------------------------------------
// Href builders
// ---------------------------------------------------------------------------

/** `/devices` scoped to agents (what `/devices/stats` counts), optionally
 *  narrowed by one status condition. */
function devicesHref(status?: FilterCondition): string {
  const parts = [encodeDeviceClassToHash('agent')];
  if (status) {
    const encoded = encodeFilterToHash({ operator: 'AND', conditions: [status] });
    if (encoded) parts.push(encoded);
  }
  return `/devices#${parts.join('&')}`;
}

const statusEquals = (value: 'online' | 'offline'): FilterCondition => ({
  field: 'status',
  operator: 'equals',
  value,
});

/** byStatus keys that are neither online nor offline (the legend's "Other"). */
function otherStatuses(d: DashboardData): string[] {
  const byStatus = d.devices?.byStatus ?? {};
  return Object.entries(byStatus)
    .filter(([key, count]) => key !== 'online' && key !== 'offline' && count > 0)
    .map(([key]) => key)
    .sort();
}

const DEVICES_GATE = gatedBy('/devices');

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------
export const DASHBOARD_METRICS = {
  // --- KPI strip -----------------------------------------------------------
  'kpi.totalDevices': {
    kind: 'count',
    href: () => devicesHref(),
    visible: DEVICES_GATE,
  },
  'kpi.online': {
    kind: 'count',
    href: () => devicesHref(statusEquals('online')),
    visible: DEVICES_GATE,
  },
  'kpi.critical': {
    kind: 'section',
    href: () => '/alerts',
    visible: gatedBy('/alerts'),
    reason: 'Opens the alerts page; the severity/status filter destination lands with the alerts wave.',
  },
  'kpi.warnings': {
    kind: 'section',
    href: () => '/alerts',
    visible: gatedBy('/alerts'),
    reason: 'Opens the alerts page; the severity/status filter destination lands with the alerts wave.',
  },
  'kpi.tickets': {
    kind: 'count',
    href: () => '/tickets',
    visible: gatedBy('/tickets'),
  },
  'kpi.ticketsUnassigned': {
    kind: 'exempt',
    reason: 'Sub-line inside a whole-tile link; a tile never contains a second interactive element.',
  },
  'kpi.patchCompliance': {
    kind: 'section',
    href: () => '/patches',
    visible: gatedBy('/patches'),
    reason: 'Percentage has no matching list until the patch-compliance metric is unified.',
  },

  // --- Alerts feed header --------------------------------------------------
  'alerts.criticalCount': {
    kind: 'exempt',
    reason: 'Linked once the alerts page reads a status/severity hash (alerts wave).',
  },
  'alerts.warningCount': {
    kind: 'exempt',
    reason: 'Linked once the alerts page reads a status/severity hash (alerts wave).',
  },

  // --- Fleet card ----------------------------------------------------------
  'fleet.title': {
    kind: 'section',
    href: () => devicesHref(),
    visible: DEVICES_GATE,
    testId: 'dashboard-fleet-title-link',
  },
  'fleet.headerOnline': {
    kind: 'exempt',
    reason: 'The legend below carries the same numbers as links.',
  },
  'fleet.legend.online': {
    kind: 'count',
    href: () => devicesHref(statusEquals('online')),
    visible: DEVICES_GATE,
    testId: 'dashboard-fleet-legend-online-link',
  },
  'fleet.legend.offline': {
    kind: 'count',
    href: () => devicesHref(statusEquals('offline')),
    visible: DEVICES_GATE,
    testId: 'dashboard-fleet-legend-offline-link',
  },
  'fleet.legend.other': {
    kind: 'count',
    href: (d) => {
      const rest = otherStatuses(d);
      return rest.length === 0 ? null : devicesHref({ field: 'status', operator: 'in', value: rest });
    },
    visible: DEVICES_GATE,
    testId: 'dashboard-fleet-legend-other-link',
  },
  'fleet.viewOffline': {
    kind: 'count',
    href: () => devicesHref(statusEquals('offline')),
    visible: DEVICES_GATE,
    testId: 'dashboard-fleet-view-offline-link',
  },

  // --- Security card -------------------------------------------------------
  'security.title': {
    kind: 'section',
    href: () => '/security',
    visible: gatedBy('/security'),
    testId: 'dashboard-security-title-link',
  },
  'security.score': {
    kind: 'exempt',
    reason: 'A score is not an entity count; linked after security scope parity is fixed (security wave).',
  },
  'security.trendCaption': {
    kind: 'exempt',
    reason: 'Sparkline samples are not entities; caption linked after security scope parity is fixed.',
  },
  'security.atRisk': {
    kind: 'exempt',
    reason: 'No list computes at-risk the same way /security/dashboard does (Gate B #6); exempt unless an equality test proves one.',
  },
  'security.threats': {
    kind: 'exempt',
    reason: 'Linked once the threats list reads a #status= hash (security wave).',
  },

  // --- Patch card ----------------------------------------------------------
  'patch.title': {
    kind: 'section',
    href: () => '/patches',
    visible: gatedBy('/patches'),
    testId: 'dashboard-patch-title-link',
  },
  'patch.headline': {
    kind: 'exempt',
    reason: 'Same metric as the KPI tile, which carries the section link.',
  },
  'patch.devicesCompliant': {
    kind: 'exempt',
    reason: 'Needs the compliance list to take its split from the API (patch wave).',
  },
  'patch.installed': {
    kind: 'exempt',
    reason: 'Counts device×patch rows; no list shows that grain.',
  },
  'patch.pending': {
    kind: 'exempt',
    reason: 'Affected link "View devices" lands with the patch wave.',
  },
  'patch.failed': {
    kind: 'exempt',
    reason: 'Affected link "View devices with failed patches" lands with the patch wave.',
  },
  'patch.criticalPending': {
    kind: 'exempt',
    reason: 'Affected link "View devices" lands with the patch wave.',
  },
  'patch.unratedPending': {
    kind: 'exempt',
    reason: 'No list filters on unrated severity.',
  },
  'patch.imagesNotChecked': {
    kind: 'exempt',
    reason: 'Container-image freshness has no list.',
  },

  // --- Vulnerabilities card ------------------------------------------------
  'vuln.title': {
    kind: 'section',
    href: () => '/vulnerabilities',
    visible: gatedBy('/vulnerabilities'),
    testId: 'dashboard-vuln-title-link',
  },
  'vuln.openFindings': {
    kind: 'exempt',
    reason: 'Header counts every status today (bug); linked after it is fixed to open findings (vulnerabilities wave).',
  },
  'vuln.criticalOpen': {
    kind: 'exempt',
    reason: 'Counts findings; affected link "View critical CVEs" lands with the vulnerabilities wave.',
  },
  'vuln.kevCves': {
    kind: 'exempt',
    reason: 'Distinct-CVE count link lands with the vulnerabilities wave.',
  },
  'vuln.kevDevices': {
    kind: 'exempt',
    reason: 'Device count has no matching list.',
  },
  'vuln.patchReady': {
    kind: 'exempt',
    reason: 'Counts findings; affected link lands with the vulnerabilities wave.',
  },
} as const satisfies Record<string, MetricDef>;

export type MetricKey = keyof typeof DASHBOARD_METRICS;

/** The registered href for a key given the data on screen, or null. */
export function metricHref(key: MetricKey, data: DashboardData = {}): string | null {
  const def: MetricDef = DASHBOARD_METRICS[key];
  return def.href ? def.href(data) : null;
}
