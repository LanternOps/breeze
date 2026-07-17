import { useOrgStore, type Organization } from '../stores/orgStore';

// The states of the org context, made explicit. Bare `currentOrgId` reads
// conflate "user chose All organizations" with "fresh session before the first
// org auto-selects" (which is how pages flash their fleet/partner UI on cold
// load) AND with "the org list failed to load" (which is how a network failure
// on /orgs/organizations renders as a silent empty page). Read this hook and
// switch on `status` instead:
//
//   status:'loading'   — context not resolved yet; render a skeleton.
//   status:'error'     — the org list failed to load; show the error + retry.
//   status:'empty'     — the list loaded but this partner has zero orgs.
//   status:'resolved'  — scope:'all' (explicit fleet view, the allOrgs intent
//                        flag) or scope:'org' + orgId (one org selected).
//
// The `ready` boolean is kept as a convenience: it is true iff status is
// 'resolved'. Narrowing on `scope` still gives you `orgId: string` for free.
export type OrgScopeState =
  | { ready: false; status: 'loading'; scope: null; orgId: null; org: null; error: null }
  | { ready: false; status: 'error'; scope: null; orgId: null; org: null; error: string }
  | { ready: false; status: 'empty'; scope: null; orgId: null; org: null; error: null }
  | { ready: true; status: 'resolved'; scope: 'all'; orgId: null; org: null; error: null }
  | { ready: true; status: 'resolved'; scope: 'org'; orgId: string; org: Organization | null; error: null };

interface OrgScopeInputs {
  currentOrgId: string | null;
  allOrgs: boolean;
  error: string | null;
  organizationsLoaded: boolean;
  orgCount: number;
  org: Organization | null;
}

// Precedence: a concrete selection or explicit fleet intent always wins (even
// if a later refetch failed, the current selection is still usable); only when
// there is no selection at all do error/empty/loading apply.
function deriveOrgScope(i: OrgScopeInputs): OrgScopeState {
  if (i.currentOrgId) {
    return { ready: true, status: 'resolved', scope: 'org', orgId: i.currentOrgId, org: i.org, error: null };
  }
  if (i.allOrgs) return { ready: true, status: 'resolved', scope: 'all', orgId: null, org: null, error: null };
  if (i.error) return { ready: false, status: 'error', scope: null, orgId: null, org: null, error: i.error };
  if (i.organizationsLoaded && i.orgCount === 0) {
    return { ready: false, status: 'empty', scope: null, orgId: null, org: null, error: null };
  }
  return { ready: false, status: 'loading', scope: null, orgId: null, org: null, error: null };
}

export function useOrgScope(): OrgScopeState {
  // Select primitives (+ the stable org record) individually so the
  // useSyncExternalStore snapshot stays cached; assemble the union in the
  // render body, matching the store's per-field subscription pattern.
  const currentOrgId = useOrgStore((s) => s.currentOrgId);
  const allOrgs = useOrgStore((s) => s.allOrgs);
  const error = useOrgStore((s) => s.error);
  const organizationsLoaded = useOrgStore((s) => s.organizationsLoaded);
  const orgCount = useOrgStore((s) => s.organizations.length);
  const org = useOrgStore((s) =>
    s.currentOrgId ? (s.organizations.find((o) => o.id === s.currentOrgId) ?? null) : null
  );
  return deriveOrgScope({ currentOrgId, allOrgs, error, organizationsLoaded, orgCount, org });
}

/** Non-hook variant for event handlers and imperative code paths. */
export function getOrgScope(): OrgScopeState {
  const { currentOrgId, allOrgs, error, organizationsLoaded, organizations } = useOrgStore.getState();
  const org = currentOrgId ? (organizations.find((o) => o.id === currentOrgId) ?? null) : null;
  return deriveOrgScope({
    currentOrgId,
    allOrgs,
    error,
    organizationsLoaded,
    orgCount: organizations.length,
    org,
  });
}
