import { useOrgStore, type Organization } from '../stores/orgStore';

// The three states of the org context, made explicit. Bare `currentOrgId`
// reads conflate "user chose All organizations" with "fresh session before the
// first org auto-selects", which is how pages flash their fleet/partner UI on
// cold load. Read this hook instead:
//
//   ready:false          — context not resolved yet; render a skeleton.
//   scope:'all'          — explicit fleet view (the allOrgs intent flag).
//   scope:'org' + orgId  — one organization selected.
export type OrgScopeState =
  | { ready: false; scope: null; orgId: null; org: null }
  | { ready: true; scope: 'all'; orgId: null; org: null }
  | { ready: true; scope: 'org'; orgId: string; org: Organization | null };

export function useOrgScope(): OrgScopeState {
  const currentOrgId = useOrgStore((s) => s.currentOrgId);
  const allOrgs = useOrgStore((s) => s.allOrgs);
  const org = useOrgStore((s) =>
    s.currentOrgId ? (s.organizations.find((o) => o.id === s.currentOrgId) ?? null) : null
  );

  if (currentOrgId) return { ready: true, scope: 'org', orgId: currentOrgId, org };
  if (allOrgs) return { ready: true, scope: 'all', orgId: null, org: null };
  return { ready: false, scope: null, orgId: null, org: null };
}

/** Non-hook variant for event handlers and imperative code paths. */
export function getOrgScope(): OrgScopeState {
  const { currentOrgId, allOrgs, organizations } = useOrgStore.getState();
  if (currentOrgId) {
    return {
      ready: true,
      scope: 'org',
      orgId: currentOrgId,
      org: organizations.find((o) => o.id === currentOrgId) ?? null,
    };
  }
  if (allOrgs) return { ready: true, scope: 'all', orgId: null, org: null };
  return { ready: false, scope: null, orgId: null, org: null };
}
