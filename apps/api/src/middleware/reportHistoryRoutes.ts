/**
 * #6771 — the routes that opt in to the report-history capability.
 *
 * `authMiddleware` computes `computeReportHistoryReach` (and so sets the
 * `breeze.report_history_org_ids` GUC) ONLY for a request this admits. It is
 * the whole route allowance from the #6771 design quorum:
 *
 *   GET /reports                 definitions (with ?orgId=)
 *   GET /reports/templates       definitions (with ?orgId=)
 *   GET /reports/:id             one definition + recent run metadata
 *   GET /reports/runs            run metadata (with ?orgId=)
 *   GET /reports/runs/:id        one run's metadata
 *
 * and nothing else: not /:id/recipients (live contact names and emails), not
 * /runs/:id/download or /data/* (exports, refused by decision B), and no
 * non-GET method. An exact-match allowlist, so a route added later is refused
 * until someone deliberately admits it here.
 */
const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';

const REPORT_HISTORY_READ_PATHS: readonly RegExp[] = [
  /^\/reports$/,
  /^\/reports\/templates$/,
  /^\/reports\/runs$/,
  new RegExp(`^/reports/${UUID}$`),
  new RegExp(`^/reports/runs/${UUID}$`),
];

export function isReportHistoryReadRoute(method: string, path: string): boolean {
  if (method !== 'GET') return false;
  // Strip the /api/v1 mount (absent when a suite mounts the router directly)
  // and one trailing slash.
  let rel = path.startsWith('/api/v1/') ? path.slice('/api/v1'.length) : path;
  if (rel.length > 1 && rel.endsWith('/')) rel = rel.slice(0, -1);
  return REPORT_HISTORY_READ_PATHS.some((pattern) => pattern.test(rel));
}
