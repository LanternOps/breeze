import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '../../lib/i18n';
import { fetchWithAuth } from '../../stores/auth';
import { useOrgStore } from '../../stores/orgStore';
import { navigateTo } from '@/lib/navigation';
import { runAction, handleActionError, ActionError } from '../../lib/runAction';
import { useHashState } from '@/lib/useHashState';
import { usePermissions } from '../../lib/permissions';
import { Dialog } from '../shared/Dialog';
import { ConfirmDialog } from '../shared/ConfirmDialog';
import { showToast } from '../shared/Toast';
import { useLegacyOrgIdHashNotice } from '@/hooks/useLegacyOrgIdHashNotice';
import { useBulkSelection } from './bulk/useBulkSelection';
import { BulkActionBar } from './bulk/BulkActionBar';
import { SortableTh } from './shared/SortableTh';
import { DataCard, CardField } from '../shared/ResponsiveTable';
import AccessDenied from '../shared/AccessDenied';
import {
  type InvoiceStatus,
  type InvoiceSummary,
  STATUS_ROLES,
  formatDate,
  formatMoney,
  sumByCurrency,
} from './invoiceTypes';
import { StatusPill } from './shared/StatusPill';
import { StatCard } from './shared/StatCard';
import { ROW_LINK_CLASS, writeHashFilters } from './shared/listChrome';
import { INVOICE_STATUSES, BULK_ID_LIMIT } from '@breeze/shared';

interface Organization {
  id: string;
  name: string;
}
interface Site {
  id: string;
  name: string;
}

const STATUS_OPTION_VALUES: ('' | InvoiceStatus)[] = ['', ...INVOICE_STATUSES];

type SortKey = 'issued' | 'due' | 'total' | 'balance';
interface Sort { key: SortKey; dir: 'asc' | 'desc' }

// ---- hash filter state (key=value&key=value) ----------------------------
// Org scoping deliberately absent: the header switcher owns it (fetchWithAuth
// injects the selected org), and a page-local orgId — typed or deep-linked —
// would suppress that injection and silently disagree with the header.
interface Filters {
  status: '' | InvoiceStatus;
  from: string;
  to: string;
}
const EMPTY_FILTERS: Filters = { status: '', from: '', to: '' };

// Pure: takes the raw hash (leading `#` already stripped by useHashState, #2421).
function readFilters(hash: string): Filters {
  const params = new URLSearchParams(hash);
  const status = params.get('status') ?? '';
  return {
    status: (STATUS_OPTION_VALUES.some((value) => value === status) ? status : '') as Filters['status'],
    from: params.get('from') ?? '',
    to: params.get('to') ?? '',
  };
}

function writeFilters(f: Filters): void {
  const params = new URLSearchParams();
  if (f.status) params.set('status', f.status);
  if (f.from) params.set('from', f.from);
  if (f.to) params.set('to', f.to);
  writeHashFilters(params);
}

const UNAUTHORIZED = () => void navigateTo('/login', { replace: true });
const num = (s: string | null | undefined) => { const n = Number(s); return Number.isFinite(n) ? n : 0; };
const cents = (s: string | null | undefined) => Math.round(num(s) * 100);
const ts = (d: string | null) => (d ? new Date(d.length === 10 ? `${d}T00:00:00` : d).getTime() : null);

// Deposit list-badge state (mirrors the portal invoice list): 'unpaid' while
// amountPaid < depositDue, 'paid' once met, null when the invoice carries no
// deposit (no badge, zero visual change). Compared in cents.
function invoiceDepositBadge(inv: InvoiceSummary): 'unpaid' | 'paid' | null {
  if (inv.depositDue == null) return null;
  return cents(inv.amountPaid) < cents(inv.depositDue) ? 'unpaid' : 'paid';
}

export function InvoicesPage() {
  const { t } = useTranslation('billing');
  const { can } = usePermissions();
  const bulk = useBulkSelection();
  const [invoices, setInvoices] = useState<InvoiceSummary[]>([]);
  const [orgs, setOrgs] = useState<Organization[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  // A 403 from the invoices route is a permission denial, not a load failure,
  // so it renders the access-denied state rather than the retryable error.
  const [forbidden, setForbidden] = useState(false);
  // SSR-safe hash adoption + hashchange subscription live in the hook (#2421).
  // An empty hash parses to undefined (not a fresh EMPTY_FILTERS object) so the
  // no-deep-link case keeps the default reference and never refetches.
  const [filters, setFilters] = useHashState<Filters>(EMPTY_FILTERS, (h) => (h ? readFilters(h) : undefined));
  // Surface (and strip) a leftover `#orgId=` from a pre-header-scoping bookmark
  // so it doesn't silently widen the invoice view to every org.
  useLegacyOrgIdHashNotice(t('common:layout.org.legacyFilterNotice'));
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<Sort | null>(null);
  // Monotonic id of the newest in-flight list request (see loadInvoices).
  const fetchSeq = useRef(0);

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
    if (!res.ok) { handleActionError(new Error(res.statusText), t('invoicesPage.errors.loadOrganizations')); return; }
    const body = (await res.json()) as { data?: Organization[]; organizations?: Organization[] };
    setOrgs(body.data ?? body.organizations ?? []);
  }, [t]);

  const loadInvoices = useCallback(async (f: Filters) => {
    // Latest-request-wins. A deep-linked load (`/invoices#status=paid`) fires
    // this twice — once with the SSR-safe default filters, then again once
    // useHashState adopts the hash (#2421) — and the unfiltered query can
    // resolve last, painting the wrong list. Drop every response but the newest.
    const seq = ++fetchSeq.current;
    try {
      setLoading(true);
      setError(undefined);
      setForbidden(false);
      const params = new URLSearchParams();
      if (f.status) params.set('status', f.status);
      if (f.from) params.set('from', f.from);
      if (f.to) params.set('to', f.to);
      const qs = params.toString();
      const res = await fetchWithAuth(`/invoices${qs ? `?${qs}` : ''}`);
      if (seq !== fetchSeq.current) return;
      if (res.status === 401) return UNAUTHORIZED();
      if (res.status === 403) { setForbidden(true); return; }
      if (!res.ok) throw new Error(t('invoicesPage.errors.loadInvoices'));
      const body = (await res.json()) as { data: InvoiceSummary[] };
      if (seq !== fetchSeq.current) return;
      setInvoices(body.data ?? []);
    } catch (err) {
      if (seq !== fetchSeq.current) return;
      setError(err instanceof Error ? err.message : t('invoicesPage.errors.loadInvoices'));
    } finally {
      if (seq === fetchSeq.current) setLoading(false);
    }
  }, [t]);

  useEffect(() => { void loadOrgs(); }, [loadOrgs]);
  useEffect(() => { void loadInvoices(filters); }, [loadInvoices, filters]);

  // Clear bulk selection whenever the server-side filters or client-side search
  // change so stale invisible rows are never acted on.
  useEffect(() => {
    bulk.clear();
  }, [filters.status, filters.from, filters.to, search, bulk.clear]);

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
    if (!res.ok) { handleActionError(new Error(res.statusText), t('invoicesPage.errors.loadSites')); return; }
    const body = (await res.json()) as { data?: Site[]; sites?: Site[] };
    setAssembleSites(body.data ?? body.sites ?? []);
  }, [t]);

  const openAssemble = useCallback(() => {
    setMode('assemble');
    // Default the target org to the header's context when one is selected.
    const contextOrgId = useOrgStore.getState().currentOrgId ?? '';
    setAssembleOrgId(contextOrgId);
    setAssembleSiteId('');
    setAssembleSites([]);
    const today = new Date();
    const monthAgo = new Date(today.getTime() - 30 * 86400000);
    setAssembleFrom(monthAgo.toISOString().slice(0, 10));
    setAssembleTo(today.toISOString().slice(0, 10));
    setAssembleOpen(true);
    if (contextOrgId) void loadAssembleSites(contextOrgId);
  }, [loadAssembleSites]);

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
          ? t('invoicesPage.dialog.assembleError')
          : t('invoicesPage.dialog.createError'),
        successMessage: mode === 'assemble' ? t('invoicesPage.dialog.assembleSuccess') : t('invoicesPage.dialog.createSuccess'),
        onUnauthorized: UNAUTHORIZED,
      });
      setAssembleOpen(false);
      // assemble nests under data.invoice.id; blank create returns the row at data.id.
      const newId = result?.data?.invoice?.id ?? result?.data?.id;
      if (newId) void navigateTo(`/billing/invoices/${newId}`);
      else void loadInvoices(filters);
    } catch (err) {
      handleActionError(err, t('invoicesPage.dialog.createGenericError'));
    } finally {
      setAssembling(false);
    }
  }, [assembling, mode, assembleOrgId, assembleSiteId, assembleFrom, assembleTo, filters, loadInvoices, t]);

  const toggleSort = (key: SortKey) =>
    setSort((s) => (s?.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'desc' }));

  const runBulkInvoices = useCallback(
    async (path: string, verb: string, extraBody?: Record<string, unknown>): Promise<boolean> => {
      const ids = Array.from(bulk.selectedIds);
      if (ids.length === 0) return false;
      if (ids.length > BULK_ID_LIMIT) {
        showToast({ type: 'warning', message: t('invoicesPage.bulk.limit', { limit: BULK_ID_LIMIT }) });
        return false;
      }
      setBulkBusy(true);
      try {
        const result = await runAction<{ data: { succeeded: number; skipped: number; failed: number } }>({
          request: () => fetchWithAuth(path, { method: 'POST', body: JSON.stringify({ ids, ...extraBody }) }),
          errorFallback: t('invoicesPage.bulk.failed', { verb }),
          onUnauthorized: UNAUTHORIZED,
        });
        const { succeeded, skipped, failed } = result.data;
        showToast(
          skipped + failed > 0
            ? { type: 'warning', message: t('invoicesPage.bulk.partial', { succeeded, verb, skipped, failedText: failed ? `, ${failed} failed` : '' }) }
            : { type: 'success', message: t('invoicesPage.bulk.success', { succeeded, verb }) },
        );
        bulk.clear();
        void loadInvoices(filters);
        return true;
      } catch (err) {
        handleActionError(err, t('invoicesPage.bulk.failed', { verb }));
        return false;
      } finally {
        setBulkBusy(false);
      }
    },
    [bulk, loadInvoices, filters, t],
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
    // Per-currency outstanding so a mixed-currency book isn't summed under one
    // (wrong) currency label. Single-currency partners (the norm) get one entry
    // that renders exactly as a plain total did.
    const byCurrency = sumByCurrency(open.map((i) => ({ amount: num(i.balance), currencyCode: i.currencyCode })));
    const ccy = (invoices[0]?.currencyCode) || 'USD';
    return { outstanding, overdue, draftCount, openCount: open.length, byCurrency, ccy };
  }, [invoices]);

  // '$12,300 + €4,100' when the outstanding book spans currencies. With one
  // currency, label with the SUMMED SUBSET's code (byCurrency[0]) — not rows[0]'s
  // (`summary.ccy`), which may come from a void/settled invoice in a different
  // currency. The rows[0] fallback only applies when nothing is open ($0.00).
  const outstandingDisplay = summary.byCurrency.length === 0
    ? formatMoney(summary.outstanding, summary.ccy)
    : summary.byCurrency.map((e) => formatMoney(e.amount, e.code)).join(' + ');

  // Any server- or client-side filter narrowing the list. Drives both the Clear
  // affordance and whether the toolbar shows on an otherwise-empty list.
  const filtersActive = !!(filters.status || filters.from || filters.to || search.trim());

  if (forbidden) {
    return (
      <div className="space-y-5" data-testid="invoices-page">
        <AccessDenied message={t('invoicesPage.accessDenied')} />
      </div>
    );
  }

  return (
    <div className="space-y-5" data-testid="invoices-page">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{t('invoicesPage.title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('invoicesPage.subtitle')}
          </p>
        </div>
        {can('invoices', 'write') && (
          <button
            type="button"
            onClick={openAssemble}
            data-testid="invoices-assemble-open"
            className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90"
          >
            {t('invoicesPage.newInvoice')}
          </button>
        )}
      </div>

      {/* Outstanding summary */}
      {!loading && !error && invoices.length > 0 && (
        <div className="flex flex-wrap gap-3" data-testid="invoices-outstanding-strip">
          <StatCard label={t('invoicesPage.stats.outstanding')} value={outstandingDisplay} hint={t('invoicesPage.stats.open', { count: summary.openCount })} />
          {summary.draftCount > 0 && (
            <StatCard
              label={t('invoicesPage.stats.drafts')}
              value={summary.draftCount}
              hint={t('invoicesPage.stats.notYetIssued')}
              onClick={() => applyFilter({ status: 'draft' })}
              active={filters.status === 'draft'}
              testId="invoices-drafts-card"
            />
          )}
          {summary.overdue > 0 && (
            <StatCard
              label={t('invoicesPage.stats.overdue')}
              value={summary.overdue}
              hint={t('invoicesPage.stats.needsFollowUp')}
              tone="destructive"
              onClick={() => applyFilter({ status: 'overdue' })}
              active={filters.status === 'overdue'}
              testId="invoices-overdue-card"
            />
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
          placeholder={t('invoicesPage.filters.searchPlaceholder')}
          aria-label={t('invoicesPage.filters.searchAria')}
          className="h-10 min-w-[12rem] flex-1 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
          data-testid="invoices-search"
        />
        <select
          value={filters.status}
          onChange={(e) => applyFilter({ status: e.target.value as Filters['status'] })}
          data-testid="invoices-filter-status"
          aria-label={t('invoicesPage.filters.statusAria')}
          className="h-10 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
        >
          {STATUS_OPTION_VALUES.map((status) => (
            <option key={status} value={status}>{status === '' ? t('invoicesPage.filters.allStatuses') : t(/* i18n-dynamic */ `invoice.status.${status}`)}</option>
          ))}
        </select>
        <input
          type="date"
          value={filters.from}
          onChange={(e) => applyFilter({ from: e.target.value })}
          data-testid="invoices-filter-from"
          aria-label={t('invoicesPage.filters.issuedFrom')}
          className="h-10 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
        />
        <input
          type="date"
          value={filters.to}
          onChange={(e) => applyFilter({ to: e.target.value })}
          data-testid="invoices-filter-to"
          aria-label={t('invoicesPage.filters.issuedTo')}
          className="h-10 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
        />
        {filtersActive && (
          <button
            type="button"
            onClick={clearFilters}
            data-testid="invoices-filters-clear"
            className="inline-flex h-10 items-center rounded-md px-3 text-sm font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground"
          >
            {t('common:actions.clear')}
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
                {t('invoicesPage.tryAgain')}
              </button>
            </div>
          </div>
        ) : rows.length === 0 ? (
          filtersActive ? (
            // Filtered to nothing. The toolbar above stays mounted (it renders
            // whenever a filter is active) so its existing Clear control is the
            // recovery affordance — no redundant button here.
            <div className="px-4 py-12 text-center text-sm text-muted-foreground" data-testid="invoices-filtered-empty">
              {t('invoicesPage.empty.filtered')}
            </div>
          ) : (
            <div className="px-4 py-14 text-center" data-testid="invoices-empty">
              <h3 className="text-sm font-semibold">{t('invoicesPage.empty.title')}</h3>
              <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
                {t('invoicesPage.empty.description')}
              </p>
              {can('invoices', 'write') && (
                <button
                  type="button"
                  onClick={openAssemble}
                  className="mt-4 inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90"
                  data-testid="invoices-empty-new"
                >
                  {t('invoicesPage.newInvoice')}
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
                        aria-label={t('invoicesPage.table.selectAll')}
                        data-testid="invoices-select-all"
                        checked={rows.length > 0 && rows.every((r) => bulk.has(r.id))}
                        onChange={(e) => (e.target.checked ? bulk.selectAll(rows.map((r) => r.id)) : bulk.clear())}
                      />
                    </th>
                    <th className="px-3 py-3 font-medium">{t('invoicesPage.table.number')}</th>
                    <th className="px-3 py-3 font-medium">{t('common:labels.organization')}</th>
                    <SortableTh label={t('invoicesPage.table.issued')} sortKey="issued" activeSort={sort?.key} direction={sort?.dir ?? 'desc'} onSort={toggleSort} testId="invoices-sort-issued" />
                    <SortableTh label={t('invoicesPage.table.due')} sortKey="due" activeSort={sort?.key} direction={sort?.dir ?? 'desc'} onSort={toggleSort} testId="invoices-sort-due" />
                    <SortableTh label={t('invoicesPage.table.total')} sortKey="total" activeSort={sort?.key} direction={sort?.dir ?? 'desc'} onSort={toggleSort} align="right" testId="invoices-sort-total" />
                    <SortableTh label={t('invoicesPage.table.balance')} sortKey="balance" activeSort={sort?.key} direction={sort?.dir ?? 'desc'} onSort={toggleSort} align="right" testId="invoices-sort-balance" />
                    <th className="px-3 py-3 font-medium">{t('common:labels.status')}</th>
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
                            aria-label={t('invoicesPage.table.selectInvoice', { invoice: inv.invoiceNumber ?? inv.id })}
                            data-testid={`invoices-select-${inv.id}`}
                            checked={bulk.has(inv.id)}
                            onChange={() => bulk.toggle(inv.id)}
                          />
                        </td>
                        <td className="px-3 py-3 font-medium">
                          <span className="flex items-center gap-2">
                            <span className={`h-1.5 w-1.5 rounded-full ${overdue ? 'bg-destructive' : 'bg-transparent'}`} aria-hidden="true" />
                            <a
                              href={`/billing/invoices/${inv.id}`}
                              onClick={(e) => e.stopPropagation()}
                              data-testid={`invoices-row-link-${inv.id}`}
                              // Unnumbered drafts show an em-dash (the Status column
                              // already carries the "Draft" pill, so a DRAFT chip here
                              // was redundant). The dash is decorative — give the link
                              // an accessible name so it doesn't read as just "—".
                              aria-label={inv.invoiceNumber ? undefined : t('invoicesPage.table.draftInvoice')}
                              className={ROW_LINK_CLASS}
                            >
                              {inv.invoiceNumber ?? <span aria-hidden="true" className="text-muted-foreground">—</span>}
                            </a>
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
                          <div className="flex flex-wrap items-center gap-1.5">
                            <StatusPill
                              role={STATUS_ROLES[inv.status].role}
                              label={inv.status === 'sent' && !inv.sentAt ? t('invoice.status.issued') : t(/* i18n-dynamic */ `invoice.status.${inv.status}`)}
                              className={STATUS_ROLES[inv.status].className}
                              testId={`invoices-status-${inv.id}`}
                            />
                            {(() => {
                              const deposit = invoiceDepositBadge(inv);
                              if (!deposit) return null;
                              return deposit === 'unpaid' ? (
                                <span className="inline-flex rounded-full px-2 py-1 text-xs font-medium bg-warning/10 text-warning" data-testid={`invoices-deposit-unpaid-${inv.id}`}>
                                  {t('invoicesPage.deposit.unpaid')}
                                </span>
                              ) : (
                                <span className="inline-flex rounded-full px-2 py-1 text-xs font-medium bg-success/10 text-success" data-testid={`invoices-deposit-paid-${inv.id}`}>
                                  {t('invoicesPage.deposit.paid')}
                                </span>
                              );
                            })()}
                          </div>
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
                      <div className="flex items-center gap-2 font-medium">
                        <label onClick={(e) => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            aria-label={t('invoicesPage.table.selectInvoice', { invoice: inv.invoiceNumber ?? inv.id })}
                            data-testid={`invoices-card-select-${inv.id}`}
                            checked={bulk.has(inv.id)}
                            onChange={() => bulk.toggle(inv.id)}
                          />
                        </label>
                        <a
                          href={`/billing/invoices/${inv.id}`}
                          onClick={(e) => e.stopPropagation()}
                          data-testid={`invoices-card-link-${inv.id}`}
                          aria-label={inv.invoiceNumber ? undefined : t('invoicesPage.table.draftInvoice')}
                          className={ROW_LINK_CLASS}
                        >
                          {inv.invoiceNumber ?? <span aria-hidden="true" className="text-muted-foreground">—</span>}
                        </a>
                      </div>
                      <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
                        <StatusPill
                          role={STATUS_ROLES[inv.status].role}
                          label={inv.status === 'sent' && !inv.sentAt ? t('invoice.status.issued') : t(/* i18n-dynamic */ `invoice.status.${inv.status}`)}
                          className={['shrink-0', STATUS_ROLES[inv.status].className].filter(Boolean).join(' ')}
                          testId={`invoices-card-status-${inv.id}`}
                        />
                        {(() => {
                          const deposit = invoiceDepositBadge(inv);
                          if (!deposit) return null;
                          return (
                            <span
                              className={`inline-flex rounded-full px-2 py-1 text-xs font-medium ${deposit === 'unpaid' ? 'bg-warning/10 text-warning' : 'bg-success/10 text-success'}`}
                              data-testid={`invoices-card-deposit-${inv.id}`}
                            >
                              {deposit === 'unpaid' ? t('invoicesPage.deposit.unpaid') : t('invoicesPage.deposit.paid')}
                            </span>
                          );
                        })()}
                      </div>
                    </div>
                    <div className="mt-3 space-y-1.5">
                      <CardField label={t('common:labels.organization')}>{orgName(inv.orgId)}</CardField>
                      <CardField label={t('invoicesPage.table.issued')}>{formatDate(inv.issueDate)}</CardField>
                      <CardField label={t('invoicesPage.table.due')}>
                        <span className={overdue ? 'font-medium text-destructive' : undefined}>{formatDate(inv.dueDate)}</span>
                      </CardField>
                      <CardField label={t('invoicesPage.table.total')}><span className="tabular-nums">{formatMoney(inv.total, inv.currencyCode)}</span></CardField>
                      <CardField label={t('invoicesPage.table.balance')}>
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
                ...(can('invoices', 'send') ? [{ key: 'issue', label: t('invoicesPage.bulk.issue'), disabled: bulkBusy, onClick: () => void runBulkInvoices('/invoices/bulk-issue', t('invoicesPage.bulk.issuedVerb')) }] : []),
                ...(can('invoices', 'send') ? [{ key: 'void', label: t('invoicesPage.bulk.void'), variant: 'destructive' as const, disabled: bulkBusy, onClick: () => { setVoidReason(''); setVoidOpen(true); } }] : []),
                ...(can('invoices', 'write') ? [{ key: 'delete', label: t('invoicesPage.bulk.deleteDrafts'), variant: 'destructive' as const, disabled: bulkBusy, onClick: () => setDeleteOpen(true) }] : []),
              ]}
            />
          </div>
        )}
      </div>

      {/* Bulk void dialog */}
      <Dialog open={voidOpen} onClose={() => setVoidOpen(false)} title={t('invoicesPage.bulkVoid.title')} labelledBy="invoices-bulk-void-title" maxWidth="md" className="p-6">
        <div className="space-y-4" data-testid="invoices-bulk-void-dialog">
          <div>
            <h2 id="invoices-bulk-void-title" className="text-lg font-semibold">{t('invoicesPage.bulkVoid.title')}</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {t('invoicesPage.bulkVoid.description')}
            </p>
          </div>
          <label className="flex flex-col gap-1 text-sm">
            {t('invoicesPage.bulkVoid.reason')}
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
              {t('common:actions.cancel')}
            </button>
            <button
              type="button"
              onClick={async () => { const ok = await runBulkInvoices('/invoices/bulk-void', t('invoicesPage.bulk.voidedVerb'), { reason: voidReason.trim() }); if (ok) setVoidOpen(false); }}
              disabled={!voidReason.trim() || bulkBusy}
              data-testid="invoices-bulk-void-submit"
              className="inline-flex items-center justify-center rounded-md border border-destructive/40 px-4 py-2 text-sm font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50"
            >
              {t('invoicesPage.bulkVoid.submit')}
            </button>
          </div>
        </div>
      </Dialog>

      <ConfirmDialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        onConfirm={() => { setDeleteOpen(false); void runBulkInvoices('/invoices/bulk-delete', t('invoicesPage.bulk.deletedVerb')); }}
        title={t('invoicesPage.bulkDelete.title')}
        message={t('invoicesPage.bulkDelete.message', { count: bulk.size })}
        confirmLabel={t('invoicesPage.bulk.deleteDrafts')}
        confirmTestId="invoices-bulk-delete-confirm"
      />

      {/* New-invoice dialog (assemble | blank) */}
      <Dialog
        open={assembleOpen}
        onClose={() => setAssembleOpen(false)}
        title={t('invoicesPage.dialog.title')}
        labelledBy="invoices-assemble-title"
        maxWidth="lg"
        className="p-6"
      >
        <div className="space-y-4" data-testid="invoices-assemble-dialog">
          <div>
            <h2 id="invoices-assemble-title" className="text-lg font-semibold">{t('invoicesPage.dialog.title')}</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {t('invoicesPage.dialog.description')}
            </p>
          </div>

          {/* Mode toggle */}
          <div className="flex gap-1 rounded-md border bg-muted/40 p-1" role="group" aria-label={t('invoicesPage.dialog.sourceAria')}>
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
                {m === 'assemble' ? t('invoicesPage.dialog.assembleFromWork') : t('invoicesPage.dialog.blankInvoice')}
              </button>
            ))}
          </div>

          <label className="flex flex-col gap-1 text-sm">
            {t('common:labels.organization')}
            <select
              value={assembleOrgId}
              onChange={(e) => { setAssembleOrgId(e.target.value); void loadAssembleSites(e.target.value); }}
              data-testid="invoices-assemble-org"
              className="h-10 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
            >
              <option value="">{t('invoicesPage.dialog.selectOrganization')}</option>
              {orgs.map((o) => (
                <option key={o.id} value={o.id}>{o.name}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            {t('invoicesPage.dialog.siteOptional')}
            <select
              value={assembleSiteId}
              onChange={(e) => setAssembleSiteId(e.target.value)}
              data-testid="invoices-assemble-site"
              disabled={!assembleOrgId || assembleSites.length === 0}
              className="h-10 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring disabled:opacity-50"
            >
              <option value="">{t('invoicesPage.dialog.allSites')}</option>
              {assembleSites.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </label>

          {mode === 'assemble' && (
            <div className="grid grid-cols-2 gap-3">
              <label className="flex flex-col gap-1 text-sm">
                {t('invoicesPage.dialog.from')}
                <input
                  type="date"
                  value={assembleFrom}
                  onChange={(e) => setAssembleFrom(e.target.value)}
                  data-testid="invoices-assemble-from"
                  className="h-10 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                {t('invoicesPage.dialog.to')}
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
              {t('common:actions.cancel')}
            </button>
            {can('invoices', 'write') && (
              <button
                type="button"
                onClick={() => void submitDialog()}
                disabled={!assembleOrgId || (mode === 'assemble' && (!assembleFrom || !assembleTo)) || assembling}
                data-testid="invoices-assemble-submit"
                className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
              >
                {assembling ? t('invoicesPage.dialog.working') : mode === 'assemble' ? t('invoicesPage.dialog.assemble') : t('invoicesPage.dialog.createDraft')}
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
