import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchWithAuth } from '../../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import { runAction, handleActionError, ActionError } from '../../../lib/runAction';
import { usePermissions } from '../../../lib/permissions';
import { Dialog } from '../../shared/Dialog';
import { listQuotes, createQuote } from '../../../lib/api/quotes';
import {
  type Quote,
  type QuoteStatus,
  STATUS_COLORS,
  statusLabel,
  formatDate,
  formatMoney,
} from './quoteTypes';

interface Organization {
  id: string;
  name: string;
}
interface Site {
  id: string;
  name: string;
}

const STATUS_OPTIONS: { value: '' | QuoteStatus; label: string }[] = [
  { value: '', label: 'All statuses' },
  { value: 'draft', label: 'Draft' },
  { value: 'sent', label: 'Sent' },
  { value: 'viewed', label: 'Viewed' },
  { value: 'accepted', label: 'Accepted' },
  { value: 'declined', label: 'Declined' },
  { value: 'expired', label: 'Expired' },
  { value: 'converted', label: 'Converted' },
];

type SortKey = 'created' | 'total';
interface Sort { key: SortKey; dir: 'asc' | 'desc' }

// ---- hash filter state (key=value&key=value) ----------------------------
interface Filters {
  orgId: string;
  status: '' | QuoteStatus;
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

const UNAUTHORIZED = () => void navigateTo('/login', { replace: true });
const num = (s: string | null | undefined) => { const n = Number(s); return Number.isFinite(n) ? n : 0; };
const ts = (d: string | null) => (d ? new Date(d.length === 10 ? `${d}T00:00:00` : d).getTime() : null);

export default function QuotesPage() {
  const { can } = usePermissions();
  const canWrite = can('quotes', 'write');
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [orgs, setOrgs] = useState<Organization[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [filters, setFilters] = useState<Filters>(() => readFilters());
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<Sort | null>(null);

  // New-quote dialog state
  const [createOpen, setCreateOpen] = useState(false);
  const [newOrgId, setNewOrgId] = useState('');
  const [newSiteId, setNewSiteId] = useState('');
  const [newSites, setNewSites] = useState<Site[]>([]);
  const [creating, setCreating] = useState(false);

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

  const loadQuotes = useCallback(async (f: Filters) => {
    try {
      setLoading(true);
      setError(undefined);
      const res = await listQuotes({ orgId: f.orgId || undefined, status: f.status || undefined });
      if (res.status === 401) return UNAUTHORIZED();
      if (!res.ok) throw new Error('Failed to load quotes');
      const body = (await res.json()) as { data: Quote[] };
      setQuotes(body.data ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load quotes');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadOrgs(); }, [loadOrgs]);
  useEffect(() => { void loadQuotes(filters); }, [loadQuotes, filters]);

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

  // Load sites for the org picker in the dialog.
  const loadNewSites = useCallback(async (orgId: string) => {
    setNewSiteId('');
    setNewSites([]);
    if (!orgId) return;
    const res = await fetchWithAuth(`/orgs/sites?organizationId=${orgId}`);
    if (res.status === 401) return UNAUTHORIZED();
    if (!res.ok) { handleActionError(new Error(res.statusText), 'Failed to load sites.'); return; }
    const body = (await res.json()) as { data?: Site[]; sites?: Site[] };
    setNewSites(body.data ?? body.sites ?? []);
  }, []);

  const openCreate = useCallback(() => {
    setNewOrgId(filters.orgId || '');
    setNewSiteId('');
    setNewSites([]);
    setCreateOpen(true);
    if (filters.orgId) void loadNewSites(filters.orgId);
  }, [filters.orgId, loadNewSites]);

  const submitCreate = useCallback(async () => {
    if (creating || !newOrgId) return;
    setCreating(true);
    try {
      const result = await runAction<{ data: { id?: string; quote?: { id?: string } } }>({
        request: () => createQuote({ orgId: newOrgId, siteId: newSiteId || undefined, currencyCode: 'USD' }),
        errorFallback: 'Could not create a draft quote.',
        successMessage: 'Draft quote created',
        onUnauthorized: UNAUTHORIZED,
      });
      setCreateOpen(false);
      const newId = result?.data?.quote?.id ?? result?.data?.id;
      if (newId) void navigateTo(`/billing/quotes/${newId}`);
      else void loadQuotes(filters);
    } catch (err) {
      handleActionError(err, 'Could not create the quote.');
    } finally {
      setCreating(false);
    }
  }, [creating, newOrgId, newSiteId, filters, loadQuotes]);

  const toggleSort = (key: SortKey) =>
    setSort((s) => (s?.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'desc' }));

  // ---- derived rows: search filter (client) then optional sort ------------
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    let out = quotes.filter((qt) => {
      if (!q) return true;
      return (qt.quoteNumber ?? '').toLowerCase().includes(q) || orgName(qt.orgId).toLowerCase().includes(q);
    });
    if (sort) {
      const dir = sort.dir === 'asc' ? 1 : -1;
      out = [...out].sort((a, b) => {
        if (sort.key === 'total') return (num(a.total) - num(b.total)) * dir;
        const av = ts(a.createdAt);
        const bv = ts(b.createdAt);
        if (av == null && bv == null) return 0;
        if (av == null) return 1;
        if (bv == null) return -1;
        return (av - bv) * dir;
      });
    }
    return out;
  }, [quotes, search, sort, orgName]);

  const SortHeader = ({ label, sortKey }: { label: string; sortKey: SortKey }) => (
    <th className="px-3 py-3 text-right font-medium">
      <button
        type="button"
        onClick={() => toggleSort(sortKey)}
        className="inline-flex flex-row-reverse items-center gap-1 hover:text-foreground"
        data-testid={`quotes-sort-${sortKey}`}
      >
        {label}
        <span className="text-[10px] leading-none">{sort?.key === sortKey ? (sort.dir === 'asc' ? '▲' : '▼') : '↕'}</span>
      </button>
    </th>
  );

  return (
    <div className="space-y-5" data-testid="quotes-page">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Quotes</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Build proposals with rich blocks and recurring pricing, then send them to customers.
          </p>
        </div>
        {canWrite && (
          <button
            type="button"
            onClick={openCreate}
            data-testid="quotes-create-open"
            className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90"
          >
            New quote
          </button>
        )}
      </div>

      {/* Toolbar: search + filters */}
      <div className="flex flex-wrap items-end gap-2" data-testid="quotes-filters">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search number or org"
          aria-label="Search quotes"
          className="h-10 min-w-[12rem] flex-1 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          data-testid="quotes-search"
        />
        <select
          value={filters.orgId}
          onChange={(e) => applyFilter({ orgId: e.target.value })}
          data-testid="quotes-filter-org"
          aria-label="Filter by organization"
          className="h-10 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        >
          <option value="">All organizations</option>
          {orgs.map((o) => (
            <option key={o.id} value={o.id}>{o.name}</option>
          ))}
        </select>
        <select
          value={filters.status}
          onChange={(e) => applyFilter({ status: e.target.value as Filters['status'] })}
          data-testid="quotes-filter-status"
          aria-label="Filter by status"
          className="h-10 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        >
          {STATUS_OPTIONS.map((s) => (
            <option key={s.value} value={s.value}>{s.label}</option>
          ))}
        </select>
      </div>

      {/* Table */}
      <div className="rounded-lg border bg-card shadow-sm">
        {loading ? (
          <div className="divide-y" data-testid="quotes-loading">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="flex items-center gap-4 px-4 py-3.5">
                <div className="h-4 w-20 animate-pulse rounded bg-muted" />
                <div className="h-4 w-1/4 animate-pulse rounded bg-muted" />
                <div className="ml-auto h-4 w-24 animate-pulse rounded bg-muted" />
                <div className="h-5 w-16 animate-pulse rounded-full bg-muted" />
              </div>
            ))}
          </div>
        ) : error ? (
          <div className="p-6 text-center text-sm text-destructive" data-testid="quotes-error">
            {error}
            <div>
              <button
                type="button"
                onClick={() => void loadQuotes(filters)}
                className="mt-3 rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted"
              >
                Try again
              </button>
            </div>
          </div>
        ) : quotes.length === 0 ? (
          <div className="px-4 py-14 text-center" data-testid="quotes-empty">
            <h3 className="text-sm font-semibold">No quotes yet</h3>
            <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
              Draft a proposal with headings, rich text, and a pricing table, then send it for acceptance.
            </p>
            {canWrite && (
              <button
                type="button"
                onClick={openCreate}
                className="mt-4 inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90"
                data-testid="quotes-empty-new"
              >
                New quote
              </button>
            )}
          </div>
        ) : rows.length === 0 ? (
          <div className="px-4 py-12 text-center text-sm text-muted-foreground" data-testid="quotes-no-match">
            No quotes match these filters.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="quotes-table">
              <thead>
                <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-3 py-3 font-medium">Number</th>
                  <th className="px-3 py-3 font-medium">Organization</th>
                  <th className="px-3 py-3 font-medium">Status</th>
                  <SortHeader label="Total" sortKey="total" />
                  <SortHeaderLeft label="Created" sortKey="created" sort={sort} onSort={toggleSort} />
                </tr>
              </thead>
              <tbody>
                {rows.map((qt) => (
                  <tr
                    key={qt.id}
                    onClick={() => void navigateTo(`/billing/quotes/${qt.id}`)}
                    data-testid={`quotes-row-${qt.id}`}
                    className="cursor-pointer border-t transition hover:bg-muted/40"
                  >
                    <td className="px-3 py-3 font-medium">
                      {qt.quoteNumber ?? (
                        <span className="rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                          Draft
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-3">{orgName(qt.orgId)}</td>
                    <td className="px-3 py-3">
                      <span
                        className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${STATUS_COLORS[qt.status]}`}
                        data-testid={`quotes-status-${qt.id}`}
                      >
                        {statusLabel(qt)}
                      </span>
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums">{formatMoney(qt.total, qt.currencyCode)}</td>
                    <td className="px-3 py-3 text-muted-foreground">{formatDate(qt.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* New-quote dialog */}
      <Dialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="New quote"
        maxWidth="md"
        className="p-6"
      >
        <div className="space-y-4" data-testid="quotes-create-dialog">
          <div>
            <h2 className="text-lg font-semibold">New quote</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Pick the customer this proposal is for. You can add blocks and pricing next.
            </p>
          </div>

          <label className="flex flex-col gap-1 text-sm">
            Organization
            <select
              value={newOrgId}
              onChange={(e) => { setNewOrgId(e.target.value); void loadNewSites(e.target.value); }}
              data-testid="quotes-create-org"
              className="h-10 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="">Select an organization…</option>
              {orgs.map((o) => (
                <option key={o.id} value={o.id}>{o.name}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Site (optional)
            <select
              value={newSiteId}
              onChange={(e) => setNewSiteId(e.target.value)}
              data-testid="quotes-create-site"
              disabled={!newOrgId || newSites.length === 0}
              className="h-10 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
            >
              <option value="">No specific site</option>
              {newSites.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </label>

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={() => setCreateOpen(false)}
              className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void submitCreate()}
              disabled={!newOrgId || creating}
              data-testid="quotes-create-submit"
              className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
            >
              {creating ? 'Working…' : 'Create draft'}
            </button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}

// Left-aligned sortable header (Created). Right-aligned headers use the inline
// SortHeader defined in the component.
function SortHeaderLeft({
  label, sortKey, sort, onSort,
}: { label: string; sortKey: SortKey; sort: Sort | null; onSort: (k: SortKey) => void }) {
  return (
    <th className="px-3 py-3 font-medium">
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className="inline-flex items-center gap-1 hover:text-foreground"
        data-testid={`quotes-sort-${sortKey}`}
      >
        {label}
        <span className="text-[10px] leading-none">{sort?.key === sortKey ? (sort.dir === 'asc' ? '▲' : '▼') : '↕'}</span>
      </button>
    </th>
  );
}

// re-exported for tests that need the error type
export { ActionError };
