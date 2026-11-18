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
import { encodeAlertsHash } from '../alerts/alertsHash';
import { encodeVulnHash, type VulnHashInput } from '../vulnerabilities/vulnHash';
import { encodeThreatsHash } from '../security/threatsHash';
import { encodePatchesHash, type ComplianceStatusFilter } from '../patches/patchesHash';
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

/** Alerts page: the same active critical+high / medium sets the KPI numbers
 *  count (`/alerts/summary` bySeverity counts active alerts only). */
const alertsCriticalHref = (): string =>
  `/alerts${encodeAlertsHash({ status: ['active'], severity: ['critical', 'high'] })}`;
const alertsWarningHref = (): string =>
  `/alerts${encodeAlertsHash({ status: ['active'], severity: ['medium'] })}`;

/** Vulnerabilities page, CVE tab, over open findings. */
const vulnCvesHref = (filters: Omit<VulnHashInput, 'tab' | 'status'>): string =>
  `/vulnerabilities${encodeVulnHash({ tab: 'cves', status: 'open', ...filters })}`;

const alertsGate = gatedBy('/alerts');
const vulnGate = gatedBy('/vulnerabilities');

/** Patches page, compliance tab, optionally filtered to one device status. */
const patchesHref = (status?: ComplianceStatusFilter): string => `/patches${encodePatchesHash({ status })}`;
const patchesGate = gatedBy('/patches');

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
    kind: 'count',
    href: alertsCriticalHref,
    visible: alertsGate,
  },
  'kpi.warnings': {
    kind: 'count',
    href: alertsWarningHref,
    visible: alertsGate,
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
    // The tile and the /patches headline are the same devicePercent from the
    // same GET /patches/compliance (#9791 C, Decision 4).
    kind: 'count',
    href: () => patchesHref(),
    visible: patchesGate,
  },

  // --- Alerts feed header --------------------------------------------------
  'alerts.criticalCount': {
    kind: 'count',
    href: alertsCriticalHref,
    visible: alertsGate,
    testId: 'dashboard-alerts-critical-count-link',
  },
  'alerts.warningCount': {
    kind: 'count',
    href: alertsWarningHref,
    visible: alertsGate,
    testId: 'dashboard-alerts-warning-count-link',
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
    kind: 'section',
    href: () => '/security/score',
    visible: gatedBy('/security'),
    testId: 'dashboard-security-score-link',
    reason: 'A score is not an entity count; opens the score breakdown page.',
  },
  'security.trendCaption': {
    kind: 'section',
    href: () => '/security/trends',
    visible: gatedBy('/security'),
    testId: 'dashboard-security-trend-link',
    reason: 'Sparkline samples are not entities; the caption opens the trends page. The sparkline itself stays plain.',
  },
  'security.atRisk': {
    kind: 'exempt',
    reason:
      'Gate B #6: "at risk" is posture riskLevel medium|high; no web list reproduces it (the /devices/posture report partitions by management-product freshness). Pinned by apps/api security/dashboard.atRisk.test.ts.',
  },
  'security.threats': {
    kind: 'count',
    href: () => `/security/vulnerabilities${encodeThreatsHash({ status: 'active' })}`,
    visible: gatedBy('/security'),
    testId: 'dashboard-security-threats-link',
  },

  // --- Patch card ----------------------------------------------------------
  'patch.title': {
    kind: 'section',
    href: () => '/patches',
    visible: patchesGate,
    testId: 'dashboard-patch-title-link',
  },
  'patch.headline': {
    kind: 'exempt',
    reason: 'Same devicePercent as the KPI tile, which carries the count link to /patches.',
  },
  'patch.devicesCompliant': {
    kind: 'count',
    href: () => patchesHref('compliant'),
    visible: patchesGate,
    testId: 'dashboard-patch-compliant-link',
  },
  'patch.devicesNonCompliant': {
    kind: 'count',
    href: () => patchesHref('needs-patches'),
    visible: patchesGate,
    testId: 'dashboard-patch-noncompliant-link',
  },
  'patch.installed': {
    kind: 'exempt',
    reason: 'Counts device×patch rows; no list shows that grain.',
  },
  'patch.pending': {
    kind: 'exempt',
    reason: 'Counts device×patch rows; the affected link "View devices with pending patches" carries the destination.',
  },
  'patch.viewPendingDevices': {
    kind: 'affected',
    href: () => patchesHref('needs-patches'),
    visible: patchesGate,
    testId: 'dashboard-patch-pending-devices-link',
  },
  'patch.failed': {
    kind: 'exempt',
    reason: 'Counts device×patch rows; the affected link "View devices with failed patches" carries the destination.',
  },
  'patch.viewFailedDevices': {
    kind: 'affected',
    href: () => patchesHref('failed'),
    visible: patchesGate,
    testId: 'dashboard-patch-failed-devices-link',
  },
  'patch.criticalPending': {
    kind: 'exempt',
    reason: 'Counts pending critical patches; the affected link "View devices with critical patches" carries the destination.',
  },
  'patch.viewCriticalDevices': {
    kind: 'affected',
    href: () => patchesHref('critical'),
    visible: patchesGate,
    testId: 'dashboard-patch-critical-devices-link',
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
    reason: 'Counts findings, but the CVE list groups them; the affected link "View open CVEs" carries the destination.',
  },
  'vuln.viewOpen': {
    kind: 'affected',
    href: () => vulnCvesHref({}),
    visible: vulnGate,
    testId: 'dashboard-vuln-open-link',
  },
  'vuln.criticalOpen': {
    kind: 'exempt',
    reason: 'Counts findings, but the CVE list groups them; the affected link "View critical CVEs" carries the destination.',
  },
  'vuln.viewCritical': {
    kind: 'affected',
    href: () => vulnCvesHref({ severity: 'critical' }),
    visible: vulnGate,
    testId: 'dashboard-vuln-critical-link',
  },
  'vuln.kevCves': {
    kind: 'count',
    href: () => vulnCvesHref({ kev: true }),
    visible: vulnGate,
    testId: 'dashboard-vuln-kev-link',
  },
  'vuln.kevDevices': {
    kind: 'exempt',
    reason: 'Device count has no matching list.',
  },
  'vuln.patchReady': {
    kind: 'exempt',
    reason: 'Counts findings, but the CVE list groups them; the affected link "View patch-ready CVEs" carries the destination.',
  },
  // PENDING #9576 (unifies "is there a patch?"): `patchAvailable=1` resolves against today's main
  // definition. Re-run the `vuln.viewPatchReady` parity case in countParity.alertsVulns.test.tsx when it lands.
  'vuln.viewPatchReady': {
    kind: 'affected',
    href: () => vulnCvesHref({ patchAvailable: true }),
    visible: vulnGate,
    testId: 'dashboard-vuln-patch-ready-link',
  },
} as const satisfies Record<string, MetricDef>;

export type MetricKey = keyof typeof DASHBOARD_METRICS;

/** The registered href for a key given the data on screen, or null. */
export function metricHref(key: MetricKey, data: DashboardData = {}): string | null {
  const def: MetricDef = DASHBOARD_METRICS[key];
  return def.href ? def.href(data) : null;
}
