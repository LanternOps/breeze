import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import { handleActionError } from '../../lib/runAction';
import {
  listContracts,
  formatCadence,
  CONTRACT_STATUS_COLORS,
  CONTRACT_STATUS_LABELS,
  type ContractStatus,
  type ContractSummary,
} from '../../lib/api/contracts';

interface Organization {
  id: string;
  name: string;
}

const STATUS_OPTIONS: { value: '' | ContractStatus; label: string }[] = [
  { value: '', label: 'All statuses' },
  { value: 'draft', label: 'Draft' },
  { value: 'active', label: 'Active' },
  { value: 'paused', label: 'Paused' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'expired', label: 'Expired' },
];

// ---- hash filter state (key=value&key=value) ----------------------------
interface Filters {
  orgId: string;
  status: '' | ContractStatus;
}
const EMPTY_FILTERS: Filters = { orgId: '', status: '' };

function readFilters(): Filters {
  if (typeof window === 'undefined') return EMPTY_FILTERS;
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const status = params.get('status') ?? '';
  return {
    orgId: params.get('orgId') ?? '',
    status: (STATUS_OPTIONS.some((o) => o.value === status) ? status : '') as Filters['status'],
  };
}

function writeFilters(f: Filters): void {
  if (typeof window === 'undefined') return;
  const params = new URLSearchParams();
  if (f.orgId) params.set('orgId', f.orgId);
  if (f.status) params.set('status', f.status);
  const next = params.toString();
  window.location.hash = next ? `#${next}` : '';
}

/** Render an ISO date (YYYY-MM-DD or timestamp) as a short locale date, '—' if absent. */
function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value.length === 10 ? `${value}T00:00:00` : value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString();
}

const UNAUTHORIZED = () => void navigateTo('/login', { replace: true });

export default function ContractsList() {
  const [contracts, setContracts] = useState<ContractSummary[]>([]);
  const [orgs, setOrgs] = useState<Organization[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [filters, setFilters] = useState<Filters>(() => readFilters());

  const orgName = useCallback(
    (id: string) => orgs.find((o) => o.id === id)?.name ?? id.slice(0, 8),
    [orgs],
  );

  const loadOrgs = useCallback(async () => {
    const res = await fetchWithAuth('/orgs/organizations');
    if (res.status === 401) return UNAUTHORIZED();
    if (!res.ok) { handleActionError(new Error(res.statusText), 'Failed to load organizations.'); return; }
    const body = (await res.json()) as { data?: Organization[]; organizations?: Organization[] };
    setOrgs(body.data ?? body.organizations ?? []);
  }, []);

  const loadContracts = useCallback(async (f: Filters) => {
    try {
      setLoading(true);
      setError(undefined);
      const res = await listContracts({ orgId: f.orgId || undefined, status: f.status || undefined });
      if (res.status === 401) return UNAUTHORIZED();
      if (!res.ok) throw new Error('Failed to load contracts');
      const body = (await res.json()) as { data: ContractSummary[] };
      setContracts(body.data ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load contracts');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadOrgs(); }, [loadOrgs]);
  useEffect(() => { void loadContracts(filters); }, [loadContracts, filters]);

  // React to back/forward hash changes.
  useEffect(() => {
    const onHash = () => setFilters(readFilters());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const applyFilter = useCallback((patch: Partial<Filters>) => {
    setFilters((prev) => {
      const next = { ...prev, ...patch };
      writeFilters(next);
      return next;
    });
  }, []);

  const rows = useMemo(() => contracts, [contracts]);

  return (
    <div className="space-y-6" data-testid="contracts-page">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Contracts</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Recurring agreements that auto-generate draft invoices on a cadence.
          </p>
        </div>
        <a
          href="/contracts/new"
          data-testid="new-contract-btn"
          className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90"
        >
          New contract
        </a>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-end gap-3" data-testid="contracts-filters">
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Organization
          <select
            value={filters.orgId}
            onChange={(e) => applyFilter({ orgId: e.target.value })}
            data-testid="contracts-filter-org"
            className="h-10 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <option value="">All organizations</option>
            {orgs.map((o) => (
              <option key={o.id} value={o.id}>{o.name}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Status
          <select
            value={filters.status}
            onChange={(e) => applyFilter({ status: e.target.value as Filters['status'] })}
            data-testid="contracts-filter-status"
            className="h-10 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          >
            {STATUS_OPTIONS.map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
        </label>
      </div>

      {/* Table */}
      <div className="rounded-lg border bg-card shadow-sm">
        {loading ? (
          <div className="flex items-center justify-center py-12" data-testid="contracts-loading">
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          </div>
        ) : error ? (
          <div className="p-6 text-center text-sm text-destructive" data-testid="contracts-error">
            {error}
            <div>
              <button
                type="button"
                onClick={() => void loadContracts(filters)}
                className="mt-3 rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted"
              >
                Try again
              </button>
            </div>
          </div>
        ) : rows.length === 0 ? (
          <div className="px-4 py-12 text-center text-sm text-muted-foreground" data-testid="contracts-empty">
            No contracts match these filters.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="contracts-list">
              <thead>
                <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-3 py-3 font-medium">Name</th>
                  <th className="px-3 py-3 font-medium">Organization</th>
                  <th className="px-3 py-3 font-medium">Status</th>
                  <th className="px-3 py-3 font-medium">Cadence</th>
                  <th className="px-3 py-3 font-medium">Next bill</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((ctr) => (
                  <tr
                    key={ctr.id}
                    onClick={() => void navigateTo(`/contracts/${ctr.id}`)}
                    data-testid={`contract-row-${ctr.id}`}
                    className="cursor-pointer border-t transition hover:bg-muted/40"
                  >
                    <td className="px-3 py-3 font-medium">{ctr.name}</td>
                    <td className="px-3 py-3">{orgName(ctr.orgId)}</td>
                    <td className="px-3 py-3">
                      <span
                        className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${CONTRACT_STATUS_COLORS[ctr.status]}`}
                        data-testid={`contract-status-${ctr.id}`}
                      >
                        {CONTRACT_STATUS_LABELS[ctr.status]}
                      </span>
                    </td>
                    <td className="px-3 py-3">{formatCadence(ctr.intervalMonths)}</td>
                    <td className="px-3 py-3">{formatDate(ctr.nextBillingAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
