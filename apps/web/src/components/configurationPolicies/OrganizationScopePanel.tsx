import { useState, useEffect, useCallback, useMemo } from 'react';
import { Search } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';
import { useOrgStore } from '../../stores/orgStore';
import { extractApiError } from '@/lib/apiError';

type Assignment = { id: string; level: string; targetId: string; priority: number };

type Props = { policyId: string; partnerId: string };

// Partner-owned policies (#2280) are a reusable library. "All organizations"
// (a single partner-level assignment) and a subset (N organization-level
// assignments) are mutually exclusive: turning on All orgs removes per-org
// rows; checking any org removes the partner row. Site/group/device precision
// lives in the advanced Assignments tab.
export default function OrganizationScopePanel({ policyId, partnerId }: Props) {
  const organizations = useOrgStore((s) => s.organizations);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null); // org id or '__all__'
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string>();

  const fetchAssignments = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetchWithAuth(`/configuration-policies/${policyId}/assignments`);
      if (!res.ok) throw new Error(extractApiError(await res.json().catch(() => null), 'Failed to load assignments'));
      const data = await res.json();
      setAssignments(Array.isArray(data.data) ? data.data : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, [policyId]);

  useEffect(() => { fetchAssignments(); }, [fetchAssignments]);

  const partnerAssignment = assignments.find((a) => a.level === 'partner');
  const allOrgs = !!partnerAssignment;
  const orgAssignmentByOrgId = useMemo(() => {
    const m = new Map<string, Assignment>();
    assignments.filter((a) => a.level === 'organization').forEach((a) => m.set(a.targetId, a));
    return m;
  }, [assignments]);

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
    try { await fn(); await fetchAssignments(); }
    catch (err) { setError(err instanceof Error ? err.message : 'An error occurred'); }
    finally { setBusyId(null); }
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

  const filtered = organizations.filter((o) =>
    o.name.toLowerCase().includes(search.toLowerCase()));

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
            disabled={busyId !== null}
            onChange={toggleAllOrgs}
          />
          <span className="text-sm font-medium">All organizations (partner-wide)</span>
        </label>

        <div className="mt-4 flex items-center rounded-md border px-3 py-2">
          <Search className="mr-2 h-4 w-4 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search organizations..."
            className="w-full bg-transparent text-sm outline-hidden placeholder:text-muted-foreground"
          />
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-8">
            <div className="h-6 w-6 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          </div>
        ) : (
          <div className="mt-3 max-h-80 divide-y overflow-y-auto rounded-md border">
            {filtered.map((org) => (
              <label key={org.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                <input
                  type="checkbox"
                  aria-label={org.name}
                  checked={allOrgs || orgAssignmentByOrgId.has(org.id)}
                  disabled={allOrgs || busyId !== null}
                  onChange={() => toggleOrg(org.id)}
                />
                <span>{org.name}</span>
              </label>
            ))}
            {filtered.length === 0 && (
              <p className="px-3 py-4 text-sm text-muted-foreground">No organizations match your search.</p>
            )}
          </div>
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
