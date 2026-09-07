import type { Alert } from '../../services/api';
import type { MobileSummary } from '../../services/systems';
import type { FleetSegments } from '../../components/FleetBar';

export interface HeroState {
  copy: string;
  segments: FleetSegments | null;
  legend: string | null;
}

/**
 * Scopes the hero to one organization's own device counts instead of the
 * fleet-wide summary. `activeIssues` is expected to already be filtered to
 * this org by the caller (useSystemsData) — this only changes which device
 * totals the copy and segments describe.
 */
export interface OrgHeroScope {
  name: string;
  devices: MobileSummary['devices'];
}

// Hero copy ladder, in priority order: empty → all healthy → 1 issue →
// {n} issues → {n} issues across {m} organizations. Segments and legend
// are derived from device counts (online / maintenance / offline) and the
// alert critical count. Passing `orgScope` describes that org's own devices
// instead of the fleet (#5105 — the hero used to stay fleet-wide even with
// an org filter active, e.g. "77 devices" while only "Morning Fresh Dairy"
// was filtered).
export function deriveHeroState(
  summary: MobileSummary | null,
  activeIssues: Alert[],
  orgScope: OrgHeroScope | null = null,
  // Open fleet-hygiene finding count (#5139 / #5117 decision 1), already
  // scoped by the caller to match `orgScope` (fleet-wide total when
  // `orgScope` is null, that org's own count otherwise) — this function does
  // no org filtering of its own, same contract as `activeIssues`. Findings
  // carry no severity here (only a count), so they add to the issue count and
  // copy ladder but do NOT contribute to the critical/warning bar segments
  // below, which stay alert-severity-driven.
  findingsCount = 0,
  // Org ids the findings above belong to (fleet-wide only — pass [] when
  // `orgScope` is set, since `orgCount` is forced to 1 there regardless).
  // Merged with `activeIssues`' own org ids to compute "across N
  // organizations": deriving `orgCount` from `activeIssues` alone undercounts
  // a fleet with open findings but zero active alerts, e.g. 0 alerts + 3
  // findings across 3 orgs used to render "3 issues." instead of "3 issues
  // across 3 organizations."
  findingsOrgIds: readonly string[] = [],
): HeroState {
  const deviceCounts = orgScope ? orgScope.devices : summary?.devices ?? null;
  if (!deviceCounts) {
    return { copy: '…', segments: null, legend: null };
  }

  // Prefixes every branch below with "Org name: " when scoped, otherwise a
  // no-op — every fleet-wide test in this file passes orgScope=null.
  const prefix = orgScope ? `${orgScope.name}: ` : '';

  const total = deviceCounts.total;
  if (total === 0) {
    return {
      copy: `${prefix}No devices yet.`,
      segments: null,
      legend: orgScope ? null : 'Pair your first device from the Breeze web portal.',
    };
  }

  const online = deviceCounts.online;
  const offline = deviceCounts.offline;
  const maintenance = deviceCounts.maintenance;
  const issueCount = activeIssues.length + findingsCount;
  // Scoped to a single org by construction — "issues across N organizations"
  // never applies once a filter is active.
  const orgCount = orgScope ? 1 : uniqueOrgCount(activeIssues, findingsOrgIds);

  // Bar segments must match the headline. We derive critical / warning
  // from the *unacked* activeIssues (same source the headline counts), not
  // from summary.alerts.critical (which includes acknowledged criticals
  // and would paint a red slice while the headline says "all healthy").
  // Offline + maintenance devices also contribute to warning even without
  // alerts, since they're degraded fleet state.
  const criticalAlerts = activeIssues.filter(
    (a) => a.severity === 'critical' || a.severity === 'high',
  ).length;
  const warningAlerts = activeIssues.filter(
    (a) => a.severity === 'medium' || a.severity === 'low',
  ).length;
  const degradedDevices = Math.max(0, offline + maintenance);

  const criticalSlice = Math.min(criticalAlerts, total);
  const warningSlice = Math.min(warningAlerts + degradedDevices, total - criticalSlice);
  const healthySlice = Math.max(0, total - criticalSlice - warningSlice);
  const segments: FleetSegments = {
    healthy: healthySlice,
    warning: warningSlice,
    critical: criticalSlice,
  };

  if (issueCount === 0 && degradedDevices === 0) {
    const legendParts: string[] = [];
    if (online > 0) legendParts.push(`${online} online`);
    if (maintenance > 0) legendParts.push(`${maintenance} maintenance`);
    return {
      copy: `${prefix}${total} devices, all healthy.`,
      segments,
      legend: legendParts.length ? legendParts.join(' · ') : null,
    };
  }

  // No active alerts but devices are offline / in maintenance.
  if (issueCount === 0) {
    const legendParts: string[] = [];
    if (online > 0) legendParts.push(`${online} online`);
    if (offline > 0) legendParts.push(`${offline} offline`);
    if (maintenance > 0) legendParts.push(`${maintenance} maintenance`);
    return {
      copy: offline > 0
        ? `${prefix}${total} devices · ${offline} offline.`
        : `${prefix}${total} devices · ${maintenance} in maintenance.`,
      segments,
      legend: legendParts.length ? legendParts.join(' · ') : null,
    };
  }

  let copy: string;
  if (issueCount === 1) {
    copy = `${prefix}1 issue.`;
  } else if (orgCount <= 1) {
    copy = `${prefix}${issueCount} issues.`;
  } else {
    copy = `${prefix}${issueCount} issues across ${orgCount} organizations.`;
  }

  const legendParts: string[] = [];
  if (online > 0) legendParts.push(`${online} online`);
  if (degradedDevices > 0) {
    legendParts.push(
      offline > 0 && degradedDevices === offline
        ? `${offline} offline`
        : `${degradedDevices} warning`,
    );
  }

  return {
    copy,
    segments,
    legend: legendParts.length ? legendParts.join(' · ') : null,
  };
}

function uniqueOrgCount(alerts: Alert[], findingsOrgIds: readonly string[] = []): number {
  const orgs = new Set<string>();
  for (const a of alerts) {
    const orgId = (a.metadata as Record<string, unknown> | undefined)?.orgId;
    if (typeof orgId === 'string') orgs.add(orgId);
  }
  for (const orgId of findingsOrgIds) orgs.add(orgId);
  // Fallback when neither source carries an org id: assume single org so
  // copy reads "{n} issues" rather than "{n} issues across 0 organizations".
  return orgs.size === 0 ? 1 : orgs.size;
}
