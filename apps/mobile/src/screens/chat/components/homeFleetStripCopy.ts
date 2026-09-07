import type { MobileSummary } from '../../../services/systems';

// Pure copy for the Home empty-state fleet strip (#5141, decision 3 of
// #5117): "{online} online · {offline} offline · {issues}", where the issues
// clause pluralizes and collapses to "no issues" at zero. `issues` is
// `alerts.active` (unacknowledged active alerts) — the same field the
// Systems hero's breakdown is built from, so the count on Home never reads
// higher than what tapping through actually shows.
export function formatFleetStripCopy(summary: MobileSummary): string {
  const { online, offline } = summary.devices;
  const issues = summary.alerts.active;
  const issuesPart = issues === 0 ? 'no issues' : `${issues} ${issues === 1 ? 'issue' : 'issues'}`;
  return `${online} online · ${offline} offline · ${issuesPart}`;
}
