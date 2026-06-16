import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import { handleActionError } from '../../lib/runAction';
import {
  listContracts,
  formatCadence,
  monthlyValue,
  CONTRACT_STATUS_COLORS,
  CONTRACT_STATUS_LABELS,
  type ContractStatus,
  type ContractSummary,
} from '../../lib/api/contracts';
import { formatMoney } from '../billing/invoiceTypes';
import { usePermissions } from '../../lib/permissions';

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

interface Props {
  /** When set (e.g. embedded in the org Contracts tab), the list is locked to
   *  this org: the org filter is hidden and the "New contract" CTA pre-selects
   *  it. Avoids fighting the host page's own hash-based tab routing. */
  lockedOrgId?: string;
}

export default function ContractsList({ lockedOrgId }: Props = {}) {
  const { can } = usePermissions();
  const [contracts, setContracts] = useState<ContractSummary[]>([]);
  const [orgs, setOrgs] = useState<Organization[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [filters, setFilters] = useState<Filters>(() =>
    lockedOrgId ? { ...EMPTY_FILTERS, orgId: lockedOrgId } : readFilters(),
  );

  const orgName = useCallback(
    (id: string) => orgs.find((o) => o.id === id)?.name ?? id.slice(0, 8),
    [orgs],
  );

  const loadOrgs = useCallback(async () => {
    const res = await fetchWithAuth('/orgs/organizations');
    if (res.status === 401) return UNAUTHORIZED();
    if (!res.ok) { handleActionError(new Error(res.statusText), 'Failed to load organizations.'); return; }
    const body = (await res.json().catch(() => null)) as { data?: Organization[]; organizations?: Organization[] } | null;
    if (!body) return;
    setOrgs(body.data ?? body.organizations ?? []);
  }, []);

  const loadContracts = useCallback(async (f: Filters) => {
    try {
      setLoading(true);
      setError(undefined);
      const res = await listContracts({ orgId: f.orgId || undefined, status: f.status || undefined });
      if (res.status === 401) return UNAUTHORIZED();
      if (!res.ok) throw new Error('Failed to load contracts');
      const body = (await res.json().catch(() => null)) as { data: ContractSummary[] } | null;
      if (!body) throw new Error('Failed to load contracts');
      setContracts(body.data ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load contracts');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadOrgs(); }, [loadOrgs]);
  useEffect(() => { void loadContracts(filters); }, [loadContracts, filters]);

  // React to back/forward hash changes — only when standalone. When locked to an
  // org (embedded in a hash-routed tab), the host owns the hash; ignore it.
  useEffect(() => {
    if (lockedOrgId) return;
    const onHash = () => setFilters(readFilters());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [lockedOrgId]);

  const applyFilter = useCallback((patch: Partial<Filters>) => {
    setFilters((prev) => {
      const next = { ...prev, ...patch };
      if (!lockedOrgId) writeFilters(next);
      return next;
    });
  }, [lockedOrgId]);

  const newContractHref = lockedOrgId ? `/contracts/new#orgId=${lockedOrgId}` : '/contracts/new';

  const rows = useMemo(() => contracts, [contracts]);

  // Estimated monthly recurring across active contracts (normalized by cadence).
  const mrr = useMemo(() => {
    const active = contracts.filter((c) => c.status === 'active');
    const total = active.reduce((sum, c) => sum + monthlyValue(c.estimatedPeriodValue, c.intervalMonths), 0);
    return { total, count: active.length, ccy: contracts[0]?.currencyCode || 'USD' };
  }, [contracts]);

  return (
    <div className="space-y-6" data-testid="contracts-page">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          {lockedOrgId ? (
            <h2 className="text-lg font-semibold">Contracts</h2>
          ) : (
            <h1 className="text-xl font-semibold">Contracts</h1>
          )}
          <p className="mt-1 text-sm text-muted-foreground">
            Recurring agreements that auto-generate draft invoices on a cadence.
          </p>
        </div>
        {can('contracts', 'write') && (
          <a
            href={newContractHref}
            data-testid="new-contract-btn"
            className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90"
          >
            New contract
          </a>
        )}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-end gap-3" data-testid="contracts-filters">
        {!lockedOrgId && (
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
        )}
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

      {/* Estimated monthly recurring */}
      {!loading && !error && rows.length > 0 && (
        <div className="inline-flex flex-col rounded-lg border bg-card px-4 py-3" data-testid="contracts-mrr-strip">
          <span className="text-xs text-muted-foreground">Est. monthly recurring</span>
          <span className="mt-0.5 text-lg font-semibold tabular-nums">{formatMoney(mrr.total, mrr.ccy)}</span>
          <span className="text-xs text-muted-foreground">{mrr.count} active contract{mrr.count === 1 ? '' : 's'}</span>
        </div>
      )}

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
                  <th className="px-3 py-3 text-right font-medium">Est. / period</th>
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
                    <td className="px-3 py-3 text-right tabular-nums" data-testid={`contract-estimate-${ctr.id}`}>
                      {ctr.estimatedPeriodValue != null ? formatMoney(ctr.estimatedPeriodValue, ctr.currencyCode) : '—'}
                    </td>
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
