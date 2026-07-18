//
// Single source of truth for how every page relates to the org context
// switcher. Each route claims exactly one RouteScopeKind; the shell renders
// scope indicators, prompts, and gating from that claim instead of every page
// inventing its own behavior. To classify a new page, add its pattern here —
// the routeScope contract test fails on any page missing from this registry.
//
// Kinds and what the shell does with them:
//   org-or-all       Fleet-state page. Honors the selected org; aggregates
//                    fleet-wide in All-organizations view (org column appears).
//   org-required     Meaningless without one org (network discovery, org
//                    settings). In fleet view the shell shows a standard
//                    "choose an organization" affordance.
//   catalog          Partner-wide library (scripts, alert templates). The org
//                    selection never narrows it: fetchWithAuth injects NO
//                    orgId here, and the scope line states the page is shared.
//   partner-settings MSP-level configuration; the org selection is not the
//                    page's subject (it may still be a create-target inside
//                    forms).
//   device           Scoped to a single device/session (remote surfaces).
//   self             The signed-in user's own surface (profile, account).
//   auth             Unauthenticated / auth flows.
//   platform         Hosting-platform admin surfaces.
//
// Scope test for future pages: "what's the state of my fleet?" → org-or-all;
// "what's in my catalog / what tools have I configured?" → catalog or
// partner-settings; "this only makes sense inside one customer" → org-required.

export type RouteScopeKind =
  | 'org-or-all'
  | 'org-required'
  | 'catalog'
  | 'partner-settings'
  | 'device'
  | 'self'
  | 'auth'
  | 'platform';

// First match wins — put narrow exceptions before their broader prefix.
// Exported for the routeScope contract test (reachability / shadowing check).
// Not for runtime consumers — classification goes through getRouteScope.
export const ROUTE_SCOPES: Array<{ pattern: RegExp; kind: RouteScopeKind }> = [
  // --- exceptions that must precede broader prefixes ---
  // Execution history is device/org state living under the global /scripts prefix.
  { pattern: /^\/scripts\/[^/]+\/executions(\/.*)?$/, kind: 'org-or-all' },
  { pattern: /^\/settings\/alert-templates(\/.*)?$/, kind: 'catalog' }, // partner-wide alert-template catalog (#1425)
  // The organizations LIST is the org picker itself (works fleet-wide); the
  // per-org detail pages need one org. The singular /settings/organization is a
  // 301 stub to the LIST, so it takes the LIST's kind (it never renders its own
  // shell — the classification only has to be self-consistent).
  { pattern: /^\/settings\/organizations\/[^/]+(\/.*)?$/, kind: 'org-required' },
  { pattern: /^\/settings\/organizations$/, kind: 'partner-settings' },
  { pattern: /^\/settings\/organization$/, kind: 'partner-settings' },
  { pattern: /^\/settings\/profile$/, kind: 'self' },
  { pattern: /^\/account\/inactive$/, kind: 'auth' },
  { pattern: /^\/account(\/.*)?$/, kind: 'self' },

  // --- catalog (the only kind that suppresses orgId injection) ---
  { pattern: /^\/scripts(\/.*)?$/, kind: 'catalog' }, // script library / new / detail+edit
  { pattern: /^\/alert-templates(\/.*)?$/, kind: 'catalog' },

  // --- org-required ---
  { pattern: /^\/discovery(\/.*)?$/, kind: 'org-required' },
  { pattern: /^\/monitoring(\/.*)?$/, kind: 'org-required' },
  // Their APIs 400 without an org (backup dashboard, C2C connections/jobs,
  // DR plans) — the pages render OrgRequiredState in fleet view.
  { pattern: /^\/backup(\/.*)?$/, kind: 'org-required' },
  { pattern: /^\/c2c(\/.*)?$/, kind: 'org-required' },
  { pattern: /^\/dr(\/.*)?$/, kind: 'org-required' },

  // --- fleet-state (org-or-all) ---
  // NOTE: /patches is intentionally org-or-all, NOT catalog. It honours the org
  // switcher so single-org actions (approve/decline/defer, compliance export,
  // create-ring) can attach an explicit orgId when a specific org is selected,
  // while the patch list + compliance READ views still work in All-orgs mode
  // (partner scope). Marking it catalog made the orgId provider return null,
  // stripping the auto-injected ?orgId= and 400ing every partner action with
  // >1 accessible org.
  { pattern: /^\/$/, kind: 'org-or-all' },
  { pattern: /^\/devices(\/.*)?$/, kind: 'org-or-all' },
  { pattern: /^\/alerts(\/.*)?$/, kind: 'org-or-all' },
  { pattern: /^\/patches(\/.*)?$/, kind: 'org-or-all' },
  { pattern: /^\/automations(\/.*)?$/, kind: 'org-or-all' },
  { pattern: /^\/vulnerabilities$/, kind: 'org-or-all' },
  { pattern: /^\/security(\/.*)?$/, kind: 'org-or-all' },
  { pattern: /^\/sensitive-data(\/.*)?$/, kind: 'org-or-all' },
  { pattern: /^\/peripherals(\/.*)?$/, kind: 'org-or-all' },
  { pattern: /^\/pam$/, kind: 'org-or-all' },
  { pattern: /^\/ai-risk$/, kind: 'org-or-all' },
  { pattern: /^\/ai-for-office$/, kind: 'org-or-all' },
  { pattern: /^\/incidents(\/.*)?$/, kind: 'org-or-all' },
  { pattern: /^\/fleet(\/.*)?$/, kind: 'org-or-all' },
  { pattern: /^\/cis-hardening(\/.*)?$/, kind: 'org-or-all' },
  { pattern: /^\/analytics(\/.*)?$/, kind: 'org-or-all' },
  { pattern: /^\/audit(\/.*)?$/, kind: 'org-or-all' },
  { pattern: /^\/audit-baselines(\/.*)?$/, kind: 'org-or-all' },
  { pattern: /^\/logs(\/.*)?$/, kind: 'org-or-all' },
  { pattern: /^\/tickets(\/.*)?$/, kind: 'org-or-all' },
  { pattern: /^\/billing(\/.*)?$/, kind: 'org-or-all' },
  { pattern: /^\/contracts(\/.*)?$/, kind: 'org-or-all' },
  { pattern: /^\/reports(\/.*)?$/, kind: 'org-or-all' },
  { pattern: /^\/configuration-policies(\/.*)?$/, kind: 'org-or-all' },
  { pattern: /^\/policies(\/.*)?$/, kind: 'org-or-all' },
  { pattern: /^\/software(\/.*)?$/, kind: 'org-or-all' },
  { pattern: /^\/software-inventory(\/.*)?$/, kind: 'org-or-all' },
  { pattern: /^\/software-policies(\/.*)?$/, kind: 'org-or-all' },
  { pattern: /^\/snmp(\/.*)?$/, kind: 'org-or-all' },
  { pattern: /^\/dns-security$/, kind: 'org-or-all' },
  { pattern: /^\/onedrive$/, kind: 'org-or-all' },
  { pattern: /^\/workspace$/, kind: 'org-or-all' },

  // --- partner-settings ---
  { pattern: /^\/settings(\/.*)?$/, kind: 'partner-settings' },
  { pattern: /^\/integrations(\/.*)?$/, kind: 'partner-settings' },
  { pattern: /^\/partner(\/.*)?$/, kind: 'partner-settings' },

  // --- device / self / auth / platform ---
  { pattern: /^\/remote(\/.*)?$/, kind: 'device' },
  { pattern: /^\/profile$/, kind: 'self' },
  { pattern: /^\/timesheet$/, kind: 'self' },
  { pattern: /^\/admin(\/.*)?$/, kind: 'platform' },
  { pattern: /^\/(login|register|register-partner|forgot-password|reset-password|accept-invite|setup|auth|404|500)(\/.*)?$/, kind: 'auth' },
  { pattern: /^\/oauth(\/.*)?$/, kind: 'auth' },
];

function normalize(pathname: string): string {
  return pathname.replace(/\/+$/, '') || '/';
}

/**
 * Classify a pathname against the registry. Returns null for unregistered
 * routes — the contract test keeps that set empty for real pages, so a null
 * at runtime means "a route we don't know", which callers should treat as
 * org-or-all-like (inject the org, show nothing special).
 */
export function getRouteScope(pathname: string): RouteScopeKind | null {
  const normalized = normalize(pathname);
  for (const { pattern, kind } of ROUTE_SCOPES) {
    if (pattern.test(normalized)) return kind;
  }
  return null;
}

/**
 * Back-compat predicate used by the org-id injection chokepoint
 * (stores/orgStore.ts registerOrgIdProvider): catalog routes ignore the org
 * selector entirely, so no orgId is injected. Injection semantics are
 * deliberately unchanged from the pre-registry routeScope: ONLY catalog routes
 * skip injection.
 */
export function isGlobalScopeRoute(pathname: string): boolean {
  return getRouteScope(pathname) === 'catalog';
}
