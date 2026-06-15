//
// Single source of truth for which routes are partner-wide ("global") catalog
// surfaces vs per-org ("scoped") state surfaces. Global routes ignore the org
// selector entirely: fetchWithAuth omits the orgId param and the selector
// renders "All Organizations". To classify a new page, add its pattern here —
// no other file needs to change.

const GLOBAL_ROUTE_PATTERNS: RegExp[] = [
  /^\/scripts(\/.*)?$/, // script library / new / detail+edit
  /^\/patches(\/.*)?$/, // approvals + compliance derive org from the selected ring
  /^\/alert-templates(\/.*)?$/,
];

// Routes that share a global prefix but are genuinely per-org state.
// Execution history is scoped to a specific script+org: /scripts/:id/executions
const SCOPED_EXCEPTIONS: RegExp[] = [
  /^\/scripts\/[^/]+\/executions(\/.*)?$/, // execution history is device/org state
];

export function isGlobalScopeRoute(pathname: string): boolean {
  const normalized = pathname.replace(/\/+$/, '') || '/';
  if (SCOPED_EXCEPTIONS.some((re) => re.test(normalized))) return false;
  return GLOBAL_ROUTE_PATTERNS.some((re) => re.test(normalized));
}
