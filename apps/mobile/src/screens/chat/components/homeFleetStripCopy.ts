import type { MobileSummary } from '../../../services/systems';
import type { FleetSegments } from '../../../components/FleetBar';
import { deriveFleetBarSegments } from '../../../components/fleetBarSegments';

// Pure copy for the Home empty-state fleet strip (#5141, decision 3 of
// #5117): "{online} online · {offline} offline · {issues}", where the issues
// clause pluralizes and collapses to "no issues" at zero.
//
// `issues` is active alerts PLUS open fleet-hygiene findings — the same two
// terms the Systems hero sums (`heroCopy.ts`, `activeIssues.length +
// findingsCount`). Alerts alone is what this used to count, which made Home
// read "36 online · 15 offline · no issues" while Systems read "3 issues
// across 3 organizations" for the same fleet at the same moment (#5364).
// `findingsCount` defaults to 0 so a failed `/fleet/findings/counts` fetch
// degrades to the old alerts-only number instead of hiding the strip (#5177).
export function formatFleetStripCopy(summary: MobileSummary, findingsCount = 0): string {
  const { online, offline } = summary.devices;
  const issues = summary.alerts.active + findingsCount;
  const issuesPart = issues === 0 ? 'no issues' : `${issues} ${issues === 1 ? 'issue' : 'issues'}`;
  return `${online} online · ${offline} offline · ${issuesPart}`;
}

/**
 * The strip's bar segments, through the same mapping the Systems hero uses
 * (#5364) — offline devices are amber on both surfaces now, where the strip
 * previously painted them red.
 *
 * `/mobile/summary` carries no severity split of the *unacknowledged* alerts:
 * `alerts.critical` counts active AND acknowledged criticals (see the
 * `/summary` handler in `apps/api/src/routes/mobile.ts`), which is exactly
 * the source the hero refuses because it paints red under an "all healthy"
 * headline. So every active alert enters as warning-tier here. That can
 * under-state severity on a 6px bar whose only job is to be tapped through to
 * Systems, which shows the real breakdown — the honest error direction, and
 * strictly better than the previous mapping, which called every offline
 * device critical.
 *
 * Findings are deliberately absent: like the hero, they carry no severity
 * here (only a count), so they move the issue *copy* but not the bar.
 */
export function deriveStripFleetSegments(summary: MobileSummary): FleetSegments {
  const { total, offline, maintenance } = summary.devices;
  return deriveFleetBarSegments({
    total,
    offline,
    maintenance,
    criticalAlerts: 0,
    warningAlerts: summary.alerts.active,
  });
}
