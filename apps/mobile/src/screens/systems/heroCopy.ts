import type { Alert } from '../../services/api';
import type { MobileSummary } from '../../services/systems';
import type { FleetSegments } from '../../components/FleetBar';

export interface HeroState {
  copy: string;
  segments: FleetSegments | null;
  legend: string | null;
}

// Hero copy ladder, in priority order: empty → all healthy → 1 issue →
// {n} issues → {n} issues across {m} organizations. Segments and legend
// are derived from device counts (online / maintenance / offline) and the
// alert critical count.
export function deriveHeroState(
  summary: MobileSummary | null,
  activeIssues: Alert[],
): HeroState {
  if (!summary) {
    return { copy: '…', segments: null, legend: null };
  }

  const total = summary.devices.total;
  if (total === 0) {
    return {
      copy: 'No devices yet.',
      segments: null,
      legend: 'Pair your first device from the Breeze web portal.',
    };
  }

  const online = summary.devices.online;
  const offline = summary.devices.offline;
  const maintenance = summary.devices.maintenance;
  const issueCount = activeIssues.length;
  const orgCount = uniqueOrgCount(activeIssues);

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
      copy: `${total} devices, all healthy.`,
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
        ? `${total} devices · ${offline} offline.`
        : `${total} devices · ${maintenance} in maintenance.`,
      segments,
      legend: legendParts.length ? legendParts.join(' · ') : null,
    };
  }

  let copy: string;
  if (issueCount === 1) {
    copy = '1 issue.';
  } else if (orgCount <= 1) {
    copy = `${issueCount} issues.`;
  } else {
    copy = `${issueCount} issues across ${orgCount} organizations.`;
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

function uniqueOrgCount(alerts: Alert[]): number {
  const orgs = new Set<string>();
  for (const a of alerts) {
    const orgId = (a.metadata as Record<string, unknown> | undefined)?.orgId;
    if (typeof orgId === 'string') orgs.add(orgId);
  }
  // Fallback when alerts don't carry orgId metadata: assume single org so
  // copy reads "{n} issues" rather than "{n} issues across 0 organizations".
  return orgs.size === 0 ? 1 : orgs.size;
}
