import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import { runAction, handleActionError, ActionError } from '../../lib/runAction';
import { usePermissions } from '../../lib/permissions';
import { Dialog } from '../shared/Dialog';
import { ConfirmDialog } from '../shared/ConfirmDialog';
import { showToast } from '../shared/Toast';
import { useBulkSelection } from './bulk/useBulkSelection';
import { BulkActionBar } from './bulk/BulkActionBar';
import { SortableTh } from './shared/SortableTh';
import { DataCard, CardField } from '../shared/ResponsiveTable';
import AccessDenied from '../shared/AccessDenied';
import {
  type InvoiceStatus,
  type InvoiceSummary,
  STATUS_ROLES,
  STATUS_LABELS,
  statusLabel,
  formatDate,
  formatMoney,
} from './invoiceTypes';
import { StatusPill } from './shared/StatusPill';
import { INVOICE_STATUSES, BULK_ID_LIMIT } from '@breeze/shared';

interface Organization {
  id: string;
  name: string;
}
interface Site {
  id: string;
  name: string;
}

const STATUS_OPTIONS: { value: '' | InvoiceStatus; label: string }[] = [
  { value: '', label: 'All statuses' },
  ...INVOICE_STATUSES.map((s) => ({ value: s, label: STATUS_LABELS[s] })),
];

type SortKey = 'issued' | 'due' | 'total' | 'balance';
interface Sort { key: SortKey; dir: 'asc' | 'desc' }

// ---- hash filter state (key=value&key=value) ----------------------------
interface Filters {
  orgId: string;
  status: '' | InvoiceStatus;
  from: string;
  to: string;
}
const EMPTY_FILTERS: Filters = { orgId: '', status: '', from: '', to: '' };

function readFilters(): Filters {
  if (typeof window === 'undefined') return EMPTY_FILTERS;
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const status = params.get('status') ?? '';
  return {
    orgId: params.get('orgId') ?? '',
    status: (STATUS_OPTIONS.some((o) => o.value === status) ? status : '') as Filters['status'],
    from: params.get('from') ?? '',
    to: params.get('to') ?? '',
  };
}

function writeFilters(f: Filters): void {
  if (typeof window === 'undefined') return;
  const params = new URLSearchParams();
  if (f.orgId) params.set('orgId', f.orgId);
  if (f.status) params.set('status', f.status);
  if (f.from) params.set('from', f.from);
  if (f.to) params.set('to', f.to);
  const next = params.toString();
  if (next) {
    window.location.hash = `#${next}`;
  } else if (window.location.hash) {
    // Clearing: plain `location.hash = ''` can leave a bare '#' dangling in the
    // URL. replaceState strips the fragment cleanly without a history entry.
    history.replaceState(null, '', window.location.pathname + window.location.search);
  }
}

const UNAUTHORIZED = () => void navigateTo('/login', { replace: true });
const num = (s: string | null | undefined) => { const n = Number(s); return Number.isFinite(n) ? n : 0; };
const ts = (d: string | null) => (d ? new Date(d.length === 10 ? `${d}T00:00:00` : d).getTime() : null);

export function InvoicesPage() {
  const { can } = usePermissions();
  const bulk = useBulkSelection();
  const [invoices, setInvoices] = useState<InvoiceSummary[]>([]);
  const [orgs, setOrgs] = useState<Organization[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  // A 403 from the invoices route is a permission denial, not a load failure,
  // so it renders the access-denied state rather than the retryable error.
  const [forbidden, setForbidden] = useState(false);
  const [filters, setFilters] = useState<Filters>(() => readFilters());
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<Sort | null>(null);

  const [deleteOpen, setDeleteOpen] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);

  // Bulk void dialog state
  const [voidOpen, setVoidOpen] = useState(false);
  const [voidReason, setVoidReason] = useState('');

  // New-invoice dialog state
  const [assembleOpen, setAssembleOpen] = useState(false);
  const [mode, setMode] = useState<'assemble' | 'blank'>('assemble');
  const [assembleOrgId, setAssembleOrgId] = useState('');
  const [assembleSiteId, setAssembleSiteId] = useState('');
  const [assembleFrom, setAssembleFrom] = useState('');
  const [assembleTo, setAssembleTo] = useState('');
  const [assembleSites, setAssembleSites] = useState<Site[]>([]);
  const [assembling, setAssembling] = useState(false);

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

  const loadInvoices = useCallback(async (f: Filters) => {
    try {
      setLoading(true);
      setError(undefined);
      setForbidden(false);
      const params = new URLSearchParams();
      if (f.orgId) params.set('orgId', f.orgId);
      if (f.status) params.set('status', f.status);
      if (f.from) params.set('from', f.from);
      if (f.to) params.set('to', f.to);
      const qs = params.toString();
      const res = await fetchWithAuth(`/invoices${qs ? `?${qs}` : ''}`);
      if (res.status === 401) return UNAUTHORIZED();
      if (res.status === 403) { setForbidden(true); return; }
      if (!res.ok) throw new Error('Failed to load invoices');
      const body = (await res.json()) as { data: InvoiceSummary[] };
      setInvoices(body.data ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load invoices');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadOrgs(); }, [loadOrgs]);
  useEffect(() => { void loadInvoices(filters); }, [loadInvoices, filters]);

  // React to back/forward hash changes.
  useEffect(() => {
    const onHash = () => setFilters(readFilters());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // Clear bulk selection whenever the server-side filters or client-side search
  // change so stale invisible rows are never acted on.
  useEffect(() => {
    bulk.clear();
  }, [filters.orgId, filters.status, filters.from, filters.to, search, bulk.clear]);

  const applyFilter = useCallback((patch: Partial<Filters>) => {
    setFilters((prev) => {
      const next = { ...prev, ...patch };
      writeFilters(next);
      return next;
    });
  }, []);

  const clearFilters = useCallback(() => {
    setFilters(EMPTY_FILTERS);
    writeFilters(EMPTY_FILTERS);
    setSearch('');
  }, []);

  // Load sites for the org picker in the dialog.
  const loadAssembleSites = useCallback(async (orgId: string) => {
    setAssembleSiteId('');
    setAssembleSites([]);
    if (!orgId) return;
    const res = await fetchWithAuth(`/orgs/sites?organizationId=${orgId}`);
    if (res.status === 401) return UNAUTHORIZED();
    if (!res.ok) { handleActionError(new Error(res.statusText), 'Failed to load sites.'); return; }
    const body = (await res.json()) as { data?: Site[]; sites?: Site[] };
    setAssembleSites(body.data ?? body.sites ?? []);
  }, []);

  const openAssemble = useCallback(() => {
    setMode('assemble');
    setAssembleOrgId(filters.orgId || '');
    setAssembleSiteId('');
    setAssembleSites([]);
    const today = new Date();
    const monthAgo = new Date(today.getTime() - 30 * 86400000);
    setAssembleFrom(monthAgo.toISOString().slice(0, 10));
    setAssembleTo(today.toISOString().slice(0, 10));
    setAssembleOpen(true);
    if (filters.orgId) void loadAssembleSites(filters.orgId);
  }, [filters.orgId, loadAssembleSites]);

  const submitDialog = useCallback(async () => {
    if (assembling || !assembleOrgId) return;
    if (mode === 'assemble' && (!assembleFrom || !assembleTo)) return;
    setAssembling(true);
    try {
      const result = await runAction<{ data: { id?: string; invoice?: { id?: string } } }>({
        request: () =>
          mode === 'assemble'
            ? fetchWithAuth(`/orgs/${assembleOrgId}/invoices/assemble`, {
                method: 'POST',
                body: JSON.stringify({ siteId: assembleSiteId || undefined, from: assembleFrom, to: assembleTo }),
              })
            : fetchWithAuth('/invoices', {
                method: 'POST',
                body: JSON.stringify({ orgId: assembleOrgId, siteId: assembleSiteId || undefined }),
              }),
        errorFallback: mode === 'assemble'
          ? 'Could not assemble an invoice for that range.'
          : 'Could not create a draft invoice.',
        successMessage: mode === 'assemble' ? 'Draft invoice assembled' : 'Draft invoice created',
        onUnauthorized: UNAUTHORIZED,
      });
      setAssembleOpen(false);
      // assemble nests under data.invoice.id; blank create returns the row at data.id.
      const newId = result?.data?.invoice?.id ?? result?.data?.id;
      if (newId) void navigateTo(`/billing/invoices/${newId}`);
      else void loadInvoices(filters);
    } catch (err) {
      handleActionError(err, 'Could not create the invoice.');
    } finally {
      setAssembling(false);
    }
  }, [assembling, mode, assembleOrgId, assembleSiteId, assembleFrom, assembleTo, filters, loadInvoices]);

  const toggleSort = (key: SortKey) =>
    setSort((s) => (s?.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'desc' }));

  const runBulkInvoices = useCallback(
    async (path: string, verb: string, extraBody?: Record<string, unknown>): Promise<boolean> => {
      const ids = Array.from(bulk.selectedIds);
      if (ids.length === 0) return false;
      if (ids.length > BULK_ID_LIMIT) {
        showToast({ type: 'warning', message: `Select up to ${BULK_ID_LIMIT} at a time.` });
        return false;
      }
      setBulkBusy(true);
      try {
        const result = await runAction<{ data: { succeeded: number; skipped: number; failed: number } }>({
          request: () => fetchWithAuth(path, { method: 'POST', body: JSON.stringify({ ids, ...extraBody }) }),
          errorFallback: `Bulk ${verb} failed. Retry.`,
          onUnauthorized: UNAUTHORIZED,
        });
        const { succeeded, skipped, failed } = result.data;
        showToast(
          skipped + failed > 0
            ? { type: 'warning', message: `${succeeded} ${verb}, ${skipped} skipped${failed ? `, ${failed} failed` : ''}` }
            : { type: 'success', message: `${succeeded} ${verb}` },
        );
        bulk.clear();
        void loadInvoices(filters);
        return true;
      } catch (err) {
        handleActionError(err, `Bulk ${verb} failed. Retry.`);
        return false;
      } finally {
        setBulkBusy(false);
      }
    },
    [bulk, loadInvoices, filters],
  );

  // ---- derived rows: search filter (client) then optional sort ------------
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    let out = invoices.filter((inv) => {
      if (!q) return true;
      return (inv.invoiceNumber ?? '').toLowerCase().includes(q) || orgName(inv.orgId).toLowerCase().includes(q);
    });
    if (sort) {
      const dir = sort.dir === 'asc' ? 1 : -1;
      out = [...out].sort((a, b) => {
        if (sort.key === 'total') return (num(a.total) - num(b.total)) * dir;
        if (sort.key === 'balance') return (num(a.balance) - num(b.balance)) * dir;
        const av = ts(sort.key === 'issued' ? a.issueDate : a.dueDate);
        const bv = ts(sort.key === 'issued' ? b.issueDate : b.dueDate);
        if (av == null && bv == null) return 0;
        if (av == null) return 1; // nulls (drafts) always last
        if (bv == null) return -1;
        return (av - bv) * dir;
      });
    }
    return out;
  }, [invoices, search, sort, orgName]);

  // ---- outstanding summary (open balance + overdue count) -----------------
  const summary = useMemo(() => {
    const open = invoices.filter((i) => i.status !== 'void' && num(i.balance) > 0);
    const outstanding = open.reduce((sum, i) => sum + num(i.balance), 0);
    const overdue = invoices.filter((i) => i.status === 'overdue').length;
    const draftCount = invoices.filter((i) => i.status === 'draft').length;
    // Single-currency partners are the norm; label the strip with the first
    // invoice's currency. Multi-currency outstanding totals are not split in v1.
    const ccy = (invoices[0]?.currencyCode) || 'USD';
    return { outstanding, overdue, draftCount, openCount: open.length, ccy };
  }, [invoices]);

  // Any server- or client-side filter narrowing the list. Drives both the Clear
  // affordance and whether the toolbar shows on an otherwise-empty list.
  const filtersActive = !!(filters.orgId || filters.status || filters.from || filters.to || search.trim());

  if (forbidden) {
    return (
      <div className="space-y-5" data-testid="invoices-page">
        <AccessDenied message="You don't have permission to view invoices." />
      </div>
    );
  }

  return (
    <div className="space-y-5" data-testid="invoices-page">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Invoices</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Assemble, issue, and track customer invoices.
          </p>
        </div>
        {can('invoices', 'write') && (
          <button
            type="button"
            onClick={openAssemble}
            data-testid="invoices-assemble-open"
            className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90"
          >
            New invoice
          </button>
        )}
      </div>

      {/* Outstanding summary */}
      {!loading && !error && invoices.length > 0 && (
        <div className="flex flex-wrap gap-3" data-testid="invoices-outstanding-strip">
          <div className="rounded-lg border bg-card px-4 py-3">
            <div className="text-xs text-muted-foreground">Outstanding</div>
            <div className="mt-0.5 text-lg font-semibold tabular-nums">{formatMoney(summary.outstanding, summary.ccy)}</div>
            <div className="text-xs text-muted-foreground">{summary.openCount} open</div>
          </div>
          {summary.draftCount > 0 && (
            <button
              type="button"
              onClick={() => applyFilter({ status: 'draft' })}
              className="rounded-lg border bg-card px-4 py-3 text-left transition hover:bg-muted/40"
              data-testid="invoices-drafts-card"
            >
              <div className="text-xs text-muted-foreground">Drafts</div>
              <div className="mt-0.5 text-lg font-semibold tabular-nums">{summary.draftCount}</div>
              <div className="text-xs text-muted-foreground">not yet issued</div>
            </button>
          )}
          {summary.overdue > 0 && (
            <button
              type="button"
              onClick={() => applyFilter({ status: 'overdue' })}
              className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-left transition hover:bg-destructive/10"
              data-testid="invoices-overdue-card"
            >
              <div className="text-xs text-destructive">Overdue</div>
              <div className="mt-0.5 text-lg font-semibold tabular-nums text-destructive">{summary.overdue}</div>
              <div className="text-xs text-muted-foreground">needs follow-up</div>
            </button>
          )}
        </div>
      )}

      {/* Toolbar: search + filters. Hidden on a genuinely-empty list (no invoices
          and nothing filtered) — controls with nothing to act on are just noise. */}
      {(invoices.length > 0 || filtersActive) && (
      <div className="flex flex-wrap items-end gap-2" data-testid="invoices-filters">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search number or org"
          aria-label="Search invoices"
          className="h-10 min-w-[12rem] flex-1 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
          data-testid="invoices-search"
        />
        <select
          value={filters.orgId}
          onChange={(e) => applyFilter({ orgId: e.target.value })}
          data-testid="invoices-filter-org"
          aria-label="Filter by organization"
          className="h-10 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
        >
          <option value="">All organizations</option>
          {orgs.map((o) => (
            <option key={o.id} value={o.id}>{o.name}</option>
          ))}
        </select>
        <select
          value={filters.status}
          onChange={(e) => applyFilter({ status: e.target.value as Filters['status'] })}
          data-testid="invoices-filter-status"
          aria-label="Filter by status"
          className="h-10 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
        >
          {STATUS_OPTIONS.map((s) => (
            <option key={s.value} value={s.value}>{s.label}</option>
          ))}
        </select>
        <input
          type="date"
          value={filters.from}
          onChange={(e) => applyFilter({ from: e.target.value })}
          data-testid="invoices-filter-from"
          aria-label="Issued from"
          className="h-10 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
        />
        <input
          type="date"
          value={filters.to}
          onChange={(e) => applyFilter({ to: e.target.value })}
          data-testid="invoices-filter-to"
          aria-label="Issued to"
          className="h-10 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
        />
        {filtersActive && (
          <button
            type="button"
            onClick={clearFilters}
            data-testid="invoices-filters-clear"
            className="inline-flex h-10 items-center rounded-md px-3 text-sm font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground"
          >
            Clear
          </button>
        )}
      </div>
      )}

      {/* Table. The card chrome is desktop-only: on mobile the stacked DataCards
          carry their own borders, so a wrapping card here would nest borders. */}
      <div className="sm:rounded-lg sm:border sm:bg-card sm:shadow-xs">
        {loading ? (
          <div className="divide-y" data-testid="invoices-loading">
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
          <div className="p-6 text-center text-sm text-destructive" data-testid="invoices-error">
            {error}
            <div>
              <button
                type="button"
                onClick={() => void loadInvoices(filters)}
                className="mt-3 rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted"
              >
                Try again
              </button>
            </div>
          </div>
        ) : rows.length === 0 ? (
          filtersActive ? (
            // Filtered to nothing. The toolbar above stays mounted (it renders
            // whenever a filter is active) so its existing Clear control is the
            // recovery affordance — no redundant button here.
            <div className="px-4 py-12 text-center text-sm text-muted-foreground" data-testid="invoices-filtered-empty">
              No invoices match these filters.
            </div>
          ) : (
            <div className="px-4 py-14 text-center" data-testid="invoices-empty">
              <h3 className="text-sm font-semibold">No invoices yet</h3>
              <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
                Assemble unbilled time and parts into a draft, or start a blank invoice.
              </p>
              {can('invoices', 'write') && (
                <button
                  type="button"
                  onClick={openAssemble}
                  className="mt-4 inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90"
                  data-testid="invoices-empty-new"
                >
                  New invoice
                </button>
              )}
            </div>
          )
        ) : (
          <div className="relative">
            {/* Desktop: scrollable table from `sm` up. Below `sm` a 8-column table
                pushes Balance + Status into horizontal overflow, so the phone gets
                a stacked card list instead (same rows, same data, same actions). */}
            <div className="hidden overflow-x-auto sm:block" data-testid="invoices-table-desktop">
              <table className="w-full text-sm" data-testid="invoices-table">
                <thead>
                  <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="w-8 px-3 py-3">
                      <input
                        type="checkbox"
                        aria-label="Select all invoices"
                        data-testid="invoices-select-all"
                        checked={rows.length > 0 && rows.every((r) => bulk.has(r.id))}
                        onChange={(e) => (e.target.checked ? bulk.selectAll(rows.map((r) => r.id)) : bulk.clear())}
                      />
                    </th>
                    <th className="px-3 py-3 font-medium">Number</th>
                    <th className="px-3 py-3 font-medium">Organization</th>
                    <SortableTh label="Issued" sortKey="issued" activeSort={sort?.key} direction={sort?.dir ?? 'desc'} onSort={toggleSort} testId="invoices-sort-issued" />
                    <SortableTh label="Due" sortKey="due" activeSort={sort?.key} direction={sort?.dir ?? 'desc'} onSort={toggleSort} testId="invoices-sort-due" />
                    <SortableTh label="Total" sortKey="total" activeSort={sort?.key} direction={sort?.dir ?? 'desc'} onSort={toggleSort} align="right" testId="invoices-sort-total" />
                    <SortableTh label="Balance" sortKey="balance" activeSort={sort?.key} direction={sort?.dir ?? 'desc'} onSort={toggleSort} align="right" testId="invoices-sort-balance" />
                    <th className="px-3 py-3 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((inv) => {
                    const overdue = inv.status === 'overdue';
                    const hasBalance = num(inv.balance) > 0 && inv.status !== 'void';
                    return (
                      <tr
                        key={inv.id}
                        onClick={() => void navigateTo(`/billing/invoices/${inv.id}`)}
                        data-testid={`invoices-row-${inv.id}`}
                        className="cursor-pointer border-t transition hover:bg-muted/40"
                      >
                        <td className="px-3 py-3" onClick={(e) => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            aria-label={`Select invoice ${inv.invoiceNumber ?? inv.id}`}
                            data-testid={`invoices-select-${inv.id}`}
                            checked={bulk.has(inv.id)}
                            onChange={() => bulk.toggle(inv.id)}
                          />
                        </td>
                        <td className="px-3 py-3 font-medium">
                          <span className="flex items-center gap-2">
                            <span className={`h-1.5 w-1.5 rounded-full ${overdue ? 'bg-destructive' : 'bg-transparent'}`} aria-hidden="true" />
                            {inv.invoiceNumber ?? (
                              <span className="rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                                Draft
                              </span>
                            )}
                          </span>
                        </td>
                        <td className="px-3 py-3">{orgName(inv.orgId)}</td>
                        <td className="px-3 py-3 text-muted-foreground">{formatDate(inv.issueDate)}</td>
                        <td className={`px-3 py-3 ${overdue ? 'font-medium text-destructive' : 'text-muted-foreground'}`}>
                          {formatDate(inv.dueDate)}
                        </td>
                        <td className="px-3 py-3 text-right tabular-nums">{formatMoney(inv.total, inv.currencyCode)}</td>
                        <td className={`px-3 py-3 text-right tabular-nums ${hasBalance ? 'font-medium' : 'text-muted-foreground'}`}>
                          {formatMoney(inv.balance, inv.currencyCode)}
                        </td>
                        <td className="px-3 py-3">
                          <StatusPill
                            role={STATUS_ROLES[inv.status].role}
                            label={statusLabel(inv)}
                            className={STATUS_ROLES[inv.status].className}
                            testId={`invoices-status-${inv.id}`}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Mobile: stacked cards (the table hides below `sm`). */}
            <div className="space-y-2 sm:hidden" data-testid="invoices-table-cards">
              {rows.map((inv) => {
                const overdue = inv.status === 'overdue';
                const hasBalance = num(inv.balance) > 0 && inv.status !== 'void';
                return (
                  <DataCard
                    key={inv.id}
                    onClick={() => void navigateTo(`/billing/invoices/${inv.id}`)}
                    className={overdue ? 'border-destructive/30' : undefined}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <label className="flex items-center gap-2 font-medium" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          aria-label={`Select invoice ${inv.invoiceNumber ?? inv.id}`}
                          data-testid={`invoices-card-select-${inv.id}`}
                          checked={bulk.has(inv.id)}
                          onChange={() => bulk.toggle(inv.id)}
                        />
                        {inv.invoiceNumber ?? (
                          <span className="rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                            Draft
                          </span>
                        )}
                      </label>
                      <StatusPill
                        role={STATUS_ROLES[inv.status].role}
                        label={statusLabel(inv)}
                        className={['shrink-0', STATUS_ROLES[inv.status].className].filter(Boolean).join(' ')}
                        testId={`invoices-card-status-${inv.id}`}
                      />
                    </div>
                    <div className="mt-3 space-y-1.5">
                      <CardField label="Organization">{orgName(inv.orgId)}</CardField>
                      <CardField label="Issued">{formatDate(inv.issueDate)}</CardField>
                      <CardField label="Due">
                        <span className={overdue ? 'font-medium text-destructive' : undefined}>{formatDate(inv.dueDate)}</span>
                      </CardField>
                      <CardField label="Total"><span className="tabular-nums">{formatMoney(inv.total, inv.currencyCode)}</span></CardField>
                      <CardField label="Balance">
                        <span className={`tabular-nums ${hasBalance ? 'font-medium' : 'text-muted-foreground'}`}>{formatMoney(inv.balance, inv.currencyCode)}</span>
                      </CardField>
                    </div>
                  </DataCard>
                );
              })}
            </div>

            <BulkActionBar
              count={bulk.size}
              onClear={bulk.clear}
              testIdPrefix="invoices"
              actions={[
                ...(can('invoices', 'send') ? [{ key: 'issue', label: 'Issue', disabled: bulkBusy, onClick: () => void runBulkInvoices('/invoices/bulk-issue', 'issued') }] : []),
                ...(can('invoices', 'send') ? [{ key: 'void', label: 'Void', variant: 'destructive' as const, disabled: bulkBusy, onClick: () => { setVoidReason(''); setVoidOpen(true); } }] : []),
                ...(can('invoices', 'write') ? [{ key: 'delete', label: 'Delete drafts', variant: 'destructive' as const, disabled: bulkBusy, onClick: () => setDeleteOpen(true) }] : []),
              ]}
            />
          </div>
        )}
      </div>

      {/* Bulk void dialog */}
      <Dialog open={voidOpen} onClose={() => setVoidOpen(false)} title="Void invoices" labelledBy="invoices-bulk-void-title" maxWidth="md" className="p-6">
        <div className="space-y-4" data-testid="invoices-bulk-void-dialog">
          <div>
            <h2 id="invoices-bulk-void-title" className="text-lg font-semibold">Void invoices</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Voiding releases billed work so it can be re-invoiced. This cannot be undone.
            </p>
          </div>
          <label className="flex flex-col gap-1 text-sm">
            Reason
            <textarea
              value={voidReason}
              onChange={(e) => setVoidReason(e.target.value)}
              rows={3}
              data-testid="invoices-bulk-void-reason"
              className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
            />
          </label>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setVoidOpen(false)}
              className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={async () => { const ok = await runBulkInvoices('/invoices/bulk-void', 'voided', { reason: voidReason.trim() }); if (ok) setVoidOpen(false); }}
              disabled={!voidReason.trim() || bulkBusy}
              data-testid="invoices-bulk-void-submit"
              className="inline-flex items-center justify-center rounded-md border border-destructive/40 px-4 py-2 text-sm font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50"
            >
              Void invoices
            </button>
          </div>
        </div>
      </Dialog>

      <ConfirmDialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        onConfirm={() => { setDeleteOpen(false); void runBulkInvoices('/invoices/bulk-delete', 'deleted'); }}
        title="Delete draft invoices"
        message={`Delete ${bulk.size} selected invoice(s)? Only DRAFT invoices will be deleted; this cannot be undone.`}
        confirmLabel="Delete drafts"
        confirmTestId="invoices-bulk-delete-confirm"
      />

      {/* New-invoice dialog (assemble | blank) */}
      <Dialog
        open={assembleOpen}
        onClose={() => setAssembleOpen(false)}
        title="New invoice"
        labelledBy="invoices-assemble-title"
        maxWidth="lg"
        className="p-6"
      >
        <div className="space-y-4" data-testid="invoices-assemble-dialog">
          <div>
            <h2 id="invoices-assemble-title" className="text-lg font-semibold">New invoice</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Assemble unbilled work into a draft, or start a blank invoice.
            </p>
          </div>

          {/* Mode toggle */}
          <div className="flex gap-1 rounded-md border bg-muted/40 p-1" role="group" aria-label="Invoice source">
            {(['assemble', 'blank'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                aria-pressed={mode === m}
                className={`flex-1 rounded px-3 py-1.5 text-sm font-medium transition ${
                  mode === m ? 'bg-card text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground'
                }`}
                data-testid={`invoices-mode-${m}`}
              >
                {m === 'assemble' ? 'Assemble from work' : 'Blank invoice'}
              </button>
            ))}
          </div>

          <label className="flex flex-col gap-1 text-sm">
            Organization
            <select
              value={assembleOrgId}
              onChange={(e) => { setAssembleOrgId(e.target.value); void loadAssembleSites(e.target.value); }}
              data-testid="invoices-assemble-org"
              className="h-10 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
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
              value={assembleSiteId}
              onChange={(e) => setAssembleSiteId(e.target.value)}
              data-testid="invoices-assemble-site"
              disabled={!assembleOrgId || assembleSites.length === 0}
              className="h-10 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring disabled:opacity-50"
            >
              <option value="">All sites</option>
              {assembleSites.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </label>

          {mode === 'assemble' && (
            <div className="grid grid-cols-2 gap-3">
              <label className="flex flex-col gap-1 text-sm">
                From
                <input
                  type="date"
                  value={assembleFrom}
                  onChange={(e) => setAssembleFrom(e.target.value)}
                  data-testid="invoices-assemble-from"
                  className="h-10 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                To
                <input
                  type="date"
                  value={assembleTo}
                  onChange={(e) => setAssembleTo(e.target.value)}
                  data-testid="invoices-assemble-to"
                  className="h-10 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                />
              </label>
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={() => setAssembleOpen(false)}
              className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted"
            >
              Cancel
            </button>
            {can('invoices', 'write') && (
              <button
                type="button"
                onClick={() => void submitDialog()}
                disabled={!assembleOrgId || (mode === 'assemble' && (!assembleFrom || !assembleTo)) || assembling}
                data-testid="invoices-assemble-submit"
                className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
              >
                {assembling ? 'Working…' : mode === 'assemble' ? 'Assemble' : 'Create draft'}
              </button>
            )}
          </div>
        </div>
      </Dialog>
    </div>
  );
}


// re-exported for tests that need the error type
export { ActionError };

export default InvoicesPage;
