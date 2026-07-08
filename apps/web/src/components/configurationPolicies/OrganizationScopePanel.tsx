import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Search } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';
import { extractApiError } from '@/lib/apiError';

type Assignment = { id: string; level: string; targetId: string; priority: number };
type OrgSummary = { id: string; name: string };

type Props = { policyId: string; partnerId: string };

const PAGE_SIZE = 100;
const SEARCH_DEBOUNCE_MS = 300;

// Partner-owned policies (#2280) are a reusable library. "All organizations"
// (a single partner-level assignment) and a subset (N organization-level
// assignments) are mutually exclusive: turning on All orgs removes per-org
// rows; checking any org removes the partner row. Site/group/device precision
// lives in the advanced Assignments tab.
//
// This panel fetches its OWN paginated, server-searched org list (never the
// nav org store, which silently truncates at 50) — see #2285 review: a
// partner with >50 orgs couldn't reach or un-assign orgs beyond #50. Every
// org with an existing organization-level assignment is resolved and always
// rendered in the "Assigned" section at the top, regardless of whether it's
// in the currently loaded/searched page, so an assignment can never become
// invisible or un-removable.
export default function OrganizationScopePanel({ policyId, partnerId }: Props) {
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [assignmentsLoading, setAssignmentsLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null); // org id or '__all__'
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [error, setError] = useState<string>();

  const [orgs, setOrgs] = useState<OrgSummary[]>([]);
  const [orgsLoading, setOrgsLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);

  // Names resolved (by id lookup) for assigned orgs that fall outside the
  // currently loaded/searched page — the fix for the invisible-assignment bug.
  const [assignedOrgNames, setAssignedOrgNames] = useState<Record<string, string>>({});

  const fetchAssignments = useCallback(async () => {
    setAssignmentsLoading(true);
    try {
      const res = await fetchWithAuth(`/configuration-policies/${policyId}/assignments`);
      if (!res.ok) throw new Error(extractApiError(await res.json().catch(() => null), 'Failed to load assignments'));
      const data = await res.json();
      setAssignments(Array.isArray(data.data) ? data.data : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setAssignmentsLoading(false);
    }
  }, [policyId]);

  useEffect(() => { fetchAssignments(); }, [fetchAssignments]);

  // Debounce the search box, then reset paging to page 1.
  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedSearch(search);
      setPage(1);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [search]);

  // Guards against out-of-order responses: a "Load more" (page N, append)
  // fetch that resolves AFTER a later search-triggered page-1 fetch must not
  // clobber/append onto the fresher list (#2280 re-review). Each call claims
  // the next id; a response only commits state if it's still the latest.
  const reqIdRef = useRef(0);

  const fetchOrgs = useCallback(async (pageToFetch: number, searchTerm: string, append: boolean) => {
    const myReq = ++reqIdRef.current;
    setOrgsLoading(true);
    try {
      const params = new URLSearchParams({
        partnerId,
        limit: String(PAGE_SIZE),
        page: String(pageToFetch),
      });
      if (searchTerm.trim()) params.set('search', searchTerm.trim());
      const res = await fetchWithAuth(`/orgs/organizations?${params.toString()}`);
      if (!res.ok) throw new Error(extractApiError(await res.json().catch(() => null), 'Failed to load organizations'));
      const data = await res.json();
      if (myReq !== reqIdRef.current) return;
      const rows: OrgSummary[] = Array.isArray(data.data) ? data.data : [];
      setOrgs((prev) => (append ? [...prev, ...rows] : rows));
      setTotal(Number(data.pagination?.total ?? rows.length));
    } catch (err) {
      if (myReq !== reqIdRef.current) return;
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      if (myReq === reqIdRef.current) setOrgsLoading(false);
    }
  }, [partnerId]);

  useEffect(() => { fetchOrgs(1, debouncedSearch, false); }, [fetchOrgs, debouncedSearch]);

  const loadMore = () => {
    const nextPage = page + 1;
    setPage(nextPage);
    fetchOrgs(nextPage, debouncedSearch, true);
  };

  const partnerAssignment = assignments.find((a) => a.level === 'partner');
  const allOrgs = !!partnerAssignment;
  const orgAssignmentByOrgId = useMemo(() => {
    const m = new Map<string, Assignment>();
    assignments.filter((a) => a.level === 'organization').forEach((a) => m.set(a.targetId, a));
    return m;
  }, [assignments]);

  const orgsById = useMemo(() => {
    const m = new Map<string, OrgSummary>();
    orgs.forEach((o) => m.set(o.id, o));
    return m;
  }, [orgs]);

  // Resolve names for assigned orgs the current page/search doesn't cover —
  // e.g. org #51+ when only the first 100 are loaded. Best-effort: if a
  // lookup fails the org still renders (keyed by id) and remains removable.
  useEffect(() => {
    const missingIds = Array.from(orgAssignmentByOrgId.keys())
      .filter((id) => !orgsById.has(id) && !(id in assignedOrgNames));
    if (missingIds.length === 0) return;
    let cancelled = false;
    (async () => {
      for (const id of missingIds) {
        if (cancelled) break;
        try {
          const res = await fetchWithAuth(`/orgs/organizations/${id}`);
          if (!res.ok) continue;
          const org = await res.json();
          if (!cancelled && org?.id) {
            setAssignedOrgNames((prev) => ({ ...prev, [org.id]: org.name ?? org.id }));
          }
        } catch {
          // Swallow — the row still renders below via the `?? id` fallback.
        }
      }
    })();
    return () => { cancelled = true; };
  }, [orgAssignmentByOrgId, orgsById, assignedOrgNames]);

  const post = (body: Record<string, unknown>) =>
    fetchWithAuth(`/configuration-policies/${policyId}/assignments`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  const del = (aid: string) =>
    fetchWithAuth(`/configuration-policies/${policyId}/assignments/${aid}`, { method: 'DELETE' });

  const run = async (id: string, fn: () => Promise<void>) => {
    setBusyId(id);
    setError(undefined);
    try { await fn(); }
    catch (err) { setError(err instanceof Error ? err.message : 'An error occurred'); }
    finally { await fetchAssignments(); setBusyId(null); }
  };

  const toggleAllOrgs = () =>
    run('__all__', async () => {
      if (allOrgs) {
        if (partnerAssignment) {
          const r = await del(partnerAssignment.id);
          if (!r.ok) throw new Error(extractApiError(await r.json().catch(() => null), 'Failed to remove'));
        }
      } else {
        // Clear any per-org rows first, then apply partner-wide.
        for (const a of orgAssignmentByOrgId.values()) {
          const r = await del(a.id);
          if (!r.ok) throw new Error(extractApiError(await r.json().catch(() => null), 'Failed to remove'));
        }
        const r = await post({ level: 'partner', priority: 0 }); // server derives targetId (#1724)
        if (!r.ok) throw new Error(extractApiError(await r.json().catch(() => null), 'Failed to assign all orgs'));
      }
    });

  const toggleOrg = (orgId: string) =>
    run(orgId, async () => {
      const existing = orgAssignmentByOrgId.get(orgId);
      if (existing) {
        const r = await del(existing.id);
        if (!r.ok) throw new Error(extractApiError(await r.json().catch(() => null), 'Failed to remove'));
      } else {
        // Checking a specific org drops the all-orgs row so the two never coexist.
        if (partnerAssignment) {
          const r = await del(partnerAssignment.id);
          if (!r.ok) throw new Error(extractApiError(await r.json().catch(() => null), 'Failed to narrow'));
        }
        const r = await post({ level: 'organization', targetId: orgId, priority: 0 });
        if (!r.ok) throw new Error(extractApiError(await r.json().catch(() => null), 'Failed to assign org'));
      }
    });

  // Assigned section: every org with a current organization-level assignment,
  // regardless of whether it's in the loaded/searched page. This is what
  // guarantees an assignment to org #51+ is always visible and removable.
  const assignedOrgs = useMemo(
    () => Array.from(orgAssignmentByOrgId.keys()).map((id) => ({
      id,
      name: orgsById.get(id)?.name ?? assignedOrgNames[id] ?? id,
    })),
    [orgAssignmentByOrgId, orgsById, assignedOrgNames]
  );
  const assignedIds = useMemo(() => new Set(assignedOrgs.map((o) => o.id)), [assignedOrgs]);

  // Browsable list excludes orgs already surfaced in the Assigned section above.
  const browsableOrgs = orgs.filter((o) => !assignedIds.has(o.id));

  const rowsDisabled = assignmentsLoading || busyId !== null;
  const initialLoading = assignmentsLoading || (orgs.length === 0 && orgsLoading);

  return (
    <div className="space-y-4">
      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">{error}</div>
      )}
      <div className="rounded-lg border bg-card p-6 shadow-xs">
        <h2 className="text-lg font-semibold">Organizations</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          This partner library policy applies only to the organizations you select.
        </p>

        <label className="mt-4 flex items-center gap-3 rounded-md border bg-muted/30 p-3">
          <input
            type="checkbox"
            aria-label="All organizations (partner-wide)"
            checked={allOrgs}
            disabled={rowsDisabled}
            onChange={toggleAllOrgs}
          />
          <span className="text-sm font-medium">All organizations (partner-wide)</span>
        </label>

        {!allOrgs && assignedOrgs.length > 0 && (
          <div className="mt-4">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Assigned</h3>
            <div className="mt-2 divide-y rounded-md border">
              {assignedOrgs.map((org) => (
                <label key={org.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                  <input
                    type="checkbox"
                    aria-label={org.name}
                    checked
                    disabled={rowsDisabled}
                    onChange={() => toggleOrg(org.id)}
                  />
                  <span>{org.name}</span>
                </label>
              ))}
            </div>
          </div>
        )}

        <div className="mt-4 flex items-center rounded-md border px-3 py-2">
          <Search className="mr-2 h-4 w-4 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search organizations..."
            className="w-full bg-transparent text-sm outline-hidden placeholder:text-muted-foreground"
          />
        </div>

        {initialLoading ? (
          <div className="flex items-center justify-center py-8">
            <div className="h-6 w-6 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          </div>
        ) : (
          <>
            <div className="mt-3 max-h-80 divide-y overflow-y-auto rounded-md border">
              {browsableOrgs.map((org) => (
                <label key={org.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                  <input
                    type="checkbox"
                    aria-label={org.name}
                    checked={allOrgs || orgAssignmentByOrgId.has(org.id)}
                    disabled={allOrgs || rowsDisabled}
                    onChange={() => toggleOrg(org.id)}
                  />
                  <span>{org.name}</span>
                </label>
              ))}
              {browsableOrgs.length === 0 && assignedOrgs.length === 0 && (
                <p className="px-3 py-4 text-sm text-muted-foreground">No organizations match your search.</p>
              )}
            </div>
            {orgs.length < total && (
              <div className="mt-2 flex justify-center">
                <button
                  type="button"
                  onClick={loadMore}
                  disabled={orgsLoading || rowsDisabled}
                  className="rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted/50 disabled:opacity-50"
                >
                  {orgsLoading ? 'Loading…' : 'Load more organizations'}
                </button>
              </div>
            )}
          </>
        )}
        {allOrgs && (
          <p className="mt-2 text-xs text-muted-foreground">
            Applied to all organizations. Uncheck &ldquo;All organizations&rdquo; to pick a subset.
          </p>
        )}
      </div>
    </div>
  );
}
