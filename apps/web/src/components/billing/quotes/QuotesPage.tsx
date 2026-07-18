import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '../../../lib/i18n';
import { fetchWithAuth } from '../../../stores/auth';
import { useOrgStore } from '../../../stores/orgStore';
import { navigateTo } from '@/lib/navigation';
import { runAction, handleActionError, ActionError } from '../../../lib/runAction';
import { useHashState } from '@/lib/useHashState';
import { usePermissions } from '../../../lib/permissions';
import { Dialog } from '../../shared/Dialog';
import { ConfirmDialog } from '../../shared/ConfirmDialog';
import { listQuotes, createQuote } from '../../../lib/api/quotes';
import { showToast } from '../../shared/Toast';
import { useLegacyOrgIdHashNotice } from '@/hooks/useLegacyOrgIdHashNotice';
import { useBulkSelection } from '../bulk/useBulkSelection';
import { BulkActionBar } from '../bulk/BulkActionBar';
import { SortableTh } from '../shared/SortableTh';
import {
  type Quote,
  type QuoteStatus,
  STATUS_ROLES,
  formatDate,
  formatMoney,
  sumByCurrency,
} from './quoteTypes';
import { StatusPill } from '../shared/StatusPill';
import { StatCard } from '../shared/StatCard';
import { ROW_LINK_CLASS, writeHashFilters } from '../shared/listChrome';
import AccessDenied from '../../shared/AccessDenied';
import { BULK_ID_LIMIT } from '@breeze/shared';

interface Organization {
  id: string;
  name: string;
}
interface Site {
  id: string;
  name: string;
}

const STATUS_OPTION_VALUES: ('' | QuoteStatus)[] = ['', 'draft', 'sent', 'viewed', 'accepted', 'declined', 'expired', 'converted'];

type SortKey = 'created' | 'total';
interface Sort { key: SortKey; dir: 'asc' | 'desc' }

// ---- hash filter state (key=value&key=value) ----------------------------
// Org scoping deliberately absent: the header switcher owns it (fetchWithAuth
// injects the selected org), and a page-local orgId — typed or deep-linked —
// would suppress that injection and silently disagree with the header.
interface Filters {
  status: '' | QuoteStatus;
}
const EMPTY_FILTERS: Filters = { status: '' };

// Pure: takes the raw hash (leading `#` already stripped by useHashState, #2421).
function readFilters(hash: string): Filters {
  const params = new URLSearchParams(hash);
  const status = params.get('status') ?? '';
  return {
    status: (STATUS_OPTION_VALUES.some((value) => value === status) ? status : '') as Filters['status'],
  };
}

function writeFilters(f: Filters): void {
  const params = new URLSearchParams();
  if (f.status) params.set('status', f.status);
  writeHashFilters(params);
}

const UNAUTHORIZED = () => void navigateTo('/login', { replace: true });
const num = (s: string | null | undefined) => { const n = Number(s); return Number.isFinite(n) ? n : 0; };
const cents = (s: string | null | undefined) => Math.round(num(s) * 100);
const ts = (d: string | null) => (d ? new Date(d.length === 10 ? `${d}T00:00:00` : d).getTime() : null);

// Deposit chip for a quote row. `null` = no chip (no deposit configured). A
// converted quote whose invoice carries a deposit shows the money state
// (paid/unpaid, compared in cents); an unconverted quote with a deposit shows a
// neutral "Deposit" marker.
function quoteDepositBadge(q: Quote, t: ReturnType<typeof useTranslation<'billing'>>['t']): { label: string; className: string } | null {
  if (q.status === 'converted' && q.invoiceDepositDue != null) {
    const paid = cents(q.invoiceAmountPaid) >= cents(q.invoiceDepositDue);
    return paid
      ? { label: t('quotes.page.deposit.paid'), className: 'bg-success/10 text-success' }
      : { label: t('quotes.page.deposit.unpaid'), className: 'bg-warning/10 text-warning' };
  }
  if ((q.depositType ?? 'none') !== 'none') {
    return { label: t('quotes.page.deposit.deposit'), className: 'bg-muted text-muted-foreground' };
  }
  return null;
}

export function QuotesPage() {
  const { t } = useTranslation('billing');
  const { can } = usePermissions();
  const canWrite = can('quotes', 'write');
  const bulk = useBulkSelection();
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [orgs, setOrgs] = useState<Organization[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  // A 403 from the quotes route is a permission denial, not a load failure, so it
  // renders the access-denied state rather than the retryable error.
  const [forbidden, setForbidden] = useState(false);
  // SSR-safe hash adoption + hashchange subscription live in the hook (#2421).
  // An empty hash parses to undefined (not a fresh EMPTY_FILTERS object) so the
  // no-deep-link case keeps the default reference and never refetches.
  const [filters, setFilters] = useHashState<Filters>(EMPTY_FILTERS, (h) => (h ? readFilters(h) : undefined));
  // Surface (and strip) a leftover `#orgId=` from a pre-header-scoping bookmark
  // so it doesn't silently widen the quote view to every org.
  useLegacyOrgIdHashNotice(t('common:layout.org.legacyFilterNotice'));
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<Sort | null>(null);
  // Monotonic id of the newest in-flight list request (see loadQuotes).
  const fetchSeq = useRef(0);

  const [deleteOpen, setDeleteOpen] = useState(false);
  const [sendOpen, setSendOpen] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);

  // New-quote dialog state
  const [createOpen, setCreateOpen] = useState(false);
  const [newOrgId, setNewOrgId] = useState('');
  const [newSiteId, setNewSiteId] = useState('');
  const [newTitle, setNewTitle] = useState('');
  const [newSites, setNewSites] = useState<Site[]>([]);
  const [creating, setCreating] = useState(false);

  const orgName = useCallback(
    (id: string) => orgs.find((o) => o.id === id)?.name ?? id.slice(0, 8),
    [orgs],
  );

  const loadOrgs = useCallback(async () => {
    const res = await fetchWithAuth('/orgs/organizations');
    if (res.status === 401) return UNAUTHORIZED();
    if (!res.ok) { handleActionError(new Error(res.statusText), t('quotes.page.errors.loadOrganizations')); return; }
    const body = (await res.json()) as { data?: Organization[]; organizations?: Organization[] };
    setOrgs(body.data ?? body.organizations ?? []);
  }, [t]);

  const loadQuotes = useCallback(async (f: Filters) => {
    // Latest-request-wins. A deep-linked load (`/quotes#status=sent`) fires this
    // twice — once with the SSR-safe default filters, then again once
    // useHashState adopts the hash (#2421) — and the unfiltered query can
    // resolve last, painting the wrong list. Drop every response but the newest.
    const seq = ++fetchSeq.current;
    try {
      setLoading(true);
      setError(undefined);
      setForbidden(false);
      const res = await listQuotes({ status: f.status || undefined });
      if (seq !== fetchSeq.current) return;
      if (res.status === 401) return UNAUTHORIZED();
      if (res.status === 403) { setForbidden(true); return; }
      if (!res.ok) throw new Error(t('quotes.page.errors.loadQuotes'));
      const body = (await res.json()) as { data: Quote[] };
      if (seq !== fetchSeq.current) return;
      setQuotes(body.data ?? []);
    } catch (err) {
      if (seq !== fetchSeq.current) return;
      setError(err instanceof Error ? err.message : t('quotes.page.errors.loadQuotes'));
    } finally {
      if (seq === fetchSeq.current) setLoading(false);
    }
  }, [t]);

  useEffect(() => { void loadOrgs(); }, [loadOrgs]);
  useEffect(() => { void loadQuotes(filters); }, [loadQuotes, filters]);

  // Clear bulk selection whenever the server-side filters or client-side search
  // change so stale invisible rows are never acted on.
  useEffect(() => {
    bulk.clear();
  }, [filters.status, search, bulk.clear]);

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

  // Distinguishes a filtered-empty result (offer "clear filters") from a genuine
  // first-run empty state (offer "create your first quote").
  const hasActiveFilters = !!(filters.status || search.trim());

  // Load sites for the org picker in the dialog.
  const loadNewSites = useCallback(async (orgId: string) => {
    setNewSiteId('');
    setNewSites([]);
    if (!orgId) return;
    const res = await fetchWithAuth(`/orgs/sites?organizationId=${orgId}`);
    if (res.status === 401) return UNAUTHORIZED();
    if (!res.ok) { handleActionError(new Error(res.statusText), t('quotes.page.errors.loadSites')); return; }
    const body = (await res.json()) as { data?: Site[]; sites?: Site[] };
    setNewSites(body.data ?? body.sites ?? []);
  }, [t]);

  const openCreate = useCallback(() => {
    // Default the target org to the header's context when one is selected.
    const contextOrgId = useOrgStore.getState().currentOrgId ?? '';
    setNewOrgId(contextOrgId);
    setNewSiteId('');
    setNewSites([]);
    setCreateOpen(true);
    if (contextOrgId) void loadNewSites(contextOrgId);
  }, [loadNewSites]);

  const submitCreate = useCallback(async () => {
    if (creating || !newOrgId) return;
    setCreating(true);
    try {
      const result = await runAction<{ data: { id?: string; quote?: { id?: string } } }>({
        request: () => createQuote({ orgId: newOrgId, siteId: newSiteId || undefined, title: newTitle.trim() || undefined, currencyCode: 'USD' }),
        errorFallback: t('quotes.page.create.error'),
        successMessage: t('quotes.page.create.success'),
        onUnauthorized: UNAUTHORIZED,
      });
      setCreateOpen(false);
      setNewTitle('');
      const newId = result?.data?.quote?.id ?? result?.data?.id;
      if (newId) void navigateTo(`/billing/quotes/${newId}`);
      else void loadQuotes(filters);
    } catch (err) {
      handleActionError(err, t('quotes.page.create.genericError'));
    } finally {
      setCreating(false);
    }
  }, [creating, newOrgId, newSiteId, newTitle, filters, loadQuotes, t]);

  const toggleSort = (key: SortKey) =>
    setSort((s) => (s?.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'desc' }));

  // Aggregate value awaiting the customer's signature (sent + viewed), mirroring
  // the invoice list's Outstanding strip. Single-currency partners are the norm;
  // label with the first quote's currency.
  const summary = useMemo(() => {
    const awaiting = quotes.filter((qt) => qt.status === 'sent' || qt.status === 'viewed');
    const outForSignature = awaiting.reduce((sum, qt) => sum + num(qt.total), 0);
    const draftCount = quotes.filter((qt) => qt.status === 'draft').length;
    // Per-currency so a mixed-currency pipeline isn't summed under one wrong code.
    const byCurrency = sumByCurrency(awaiting.map((qt) => ({ amount: num(qt.total), currencyCode: qt.currencyCode })));
    const ccy = quotes[0]?.currencyCode || 'USD';
    return { outForSignature, awaitingCount: awaiting.length, draftCount, byCurrency, ccy };
  }, [quotes]);

  // '$12,300 + €4,100' across currencies. With one currency, label with the
  // SUMMED SUBSET's code (byCurrency[0]) — not quotes[0]'s (`summary.ccy`),
  // which may come from a draft/expired quote in a different currency. The
  // quotes[0] fallback only applies when nothing is awaiting ($0.00; the card
  // is hidden then anyway).
  const outForSignatureDisplay = summary.byCurrency.length === 0
    ? formatMoney(summary.outForSignature, summary.ccy)
    : summary.byCurrency.map((e) => formatMoney(e.amount, e.code)).join(' + ');

  // ---- derived rows: search filter (client) then optional sort ------------
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    let out = quotes.filter((qt) => {
      if (!q) return true;
      return (qt.quoteNumber ?? '').toLowerCase().includes(q)
        || (qt.title ?? '').toLowerCase().includes(q)
        || orgName(qt.orgId).toLowerCase().includes(q);
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

  // The quotes staged for a bulk send, resolved from the loaded list so the
  // confirm can show WHAT is about to go out (number, customer, amount) rather
  // than a blind count — bulk send is the page's highest-stakes action and the
  // single-send flow makes its recipient explicit; this is the bulk equivalent.
  const selectedQuotes = useMemo(
    () => quotes.filter((q) => bulk.selectedIds.has(q.id)),
    [quotes, bulk.selectedIds],
  );

  const runBulkQuotes = useCallback(
    async (path: string, verb: string) => {
      const ids = Array.from(bulk.selectedIds);
      if (ids.length === 0) return;
      if (ids.length > BULK_ID_LIMIT) {
        showToast({ type: 'warning', message: t('quotes.page.bulk.limit', { limit: BULK_ID_LIMIT }) });
        return;
      }
      setBulkBusy(true);
      try {
        const result = await runAction<{ data: { succeeded: number; skipped: number; failed: number; skippedReasons?: Record<string, number> } }>({
          request: () => fetchWithAuth(path, { method: 'POST', body: JSON.stringify({ ids }) }),
          errorFallback: t('quotes.page.bulk.failed', { verb }),
          onUnauthorized: UNAUTHORIZED,
        });
        const { succeeded, skipped, failed } = result.data;
        showToast(
          skipped + failed > 0
            ? { type: 'warning', message: t('quotes.page.bulk.partial', { succeeded, verb, skipped, failedText: failed ? `, ${failed} failed` : '' }) }
            : { type: 'success', message: t('quotes.page.bulk.success', { succeeded, verb }) }
        );
        bulk.clear();
        void loadQuotes(filters);
      } catch (err) {
        handleActionError(err, t('quotes.page.bulk.failed', { verb }));
      } finally {
        setBulkBusy(false);
      }
    },
    [bulk, loadQuotes, filters, t],
  );

  if (forbidden) {
    return (
      <div className="space-y-5" data-testid="quotes-page">
        <AccessDenied message={t('quotes.page.accessDenied')} />
      </div>
    );
  }

  return (
    <div className="space-y-5" data-testid="quotes-page">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{t('quotes.page.title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('quotes.page.subtitle')}
          </p>
        </div>
        {canWrite && (
          <button
            type="button"
            onClick={openCreate}
            data-testid="quotes-create-open"
            className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90"
          >
            {t('quotes.page.newQuote')}
          </button>
        )}
      </div>

      {/* Out-for-signature + drafts summary */}
      {!loading && !error && (summary.awaitingCount > 0 || summary.draftCount > 0) && (
        <div className="flex flex-wrap gap-3" data-testid="quotes-outstanding-strip">
          {summary.awaitingCount > 0 && (
            <StatCard
              label={t('quotes.page.stats.outForSignature')}
              value={outForSignatureDisplay}
              hint={t('quotes.page.stats.awaiting', { count: summary.awaitingCount })}
            />
          )}
          {summary.draftCount > 0 && (
            <StatCard
              label={t('quotes.page.stats.drafts')}
              value={summary.draftCount}
              hint={t('quotes.page.stats.notYetSent')}
              onClick={() => applyFilter({ status: 'draft' })}
              active={filters.status === 'draft'}
              testId="quotes-drafts-card"
            />
          )}
        </div>
      )}

      {/* Toolbar: search + filters */}
      <div className="flex flex-wrap items-end gap-2" data-testid="quotes-filters">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('quotes.page.filters.searchPlaceholder')}
          aria-label={t('quotes.page.filters.searchAria')}
          className="h-10 min-w-[12rem] flex-1 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
          data-testid="quotes-search"
        />
        <select
          value={filters.status}
          onChange={(e) => applyFilter({ status: e.target.value as Filters['status'] })}
          data-testid="quotes-filter-status"
          aria-label={t('quotes.page.filters.statusAria')}
          className="h-10 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
        >
          {STATUS_OPTION_VALUES.map((status) => (
            <option key={status} value={status}>{status === '' ? t('quotes.page.filters.allStatuses') : t(/* i18n-dynamic */ `quotes.status.${status}`)}</option>
          ))}
        </select>
      </div>

      {/* Table */}
      <div className="rounded-lg border bg-card shadow-xs">
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
                {t('quotes.page.tryAgain')}
              </button>
            </div>
          </div>
        ) : rows.length === 0 ? (
          hasActiveFilters ? (
            <div className="px-4 py-12 text-center" data-testid="quotes-filtered-empty">
              <p className="text-sm text-muted-foreground">{t('quotes.page.empty.filtered')}</p>
              <button
                type="button"
                onClick={clearFilters}
                data-testid="quotes-clear-filters"
                className="mt-3 rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted"
              >
                {t('quotes.page.empty.clearFilters')}
              </button>
            </div>
          ) : (
            <div className="px-4 py-14 text-center" data-testid="quotes-empty">
              <h3 className="text-sm font-semibold">{t('quotes.page.empty.title')}</h3>
              <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
                {t('quotes.page.empty.description')}
              </p>
              {canWrite && (
                <button
                  type="button"
                  onClick={openCreate}
                  className="mt-4 inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90"
                  data-testid="quotes-empty-new"
                >
                  {t('quotes.page.newQuote')}
                </button>
              )}
            </div>
          )
        ) : (
          <div className="relative">
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="quotes-table">
                <thead>
                  <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="w-8 px-3 py-3">
                      <input
                        type="checkbox"
                        aria-label={t('quotes.page.table.selectAll')}
                        data-testid="quotes-select-all"
                        checked={rows.length > 0 && rows.every((r) => bulk.has(r.id))}
                        onChange={(e) => (e.target.checked ? bulk.selectAll(rows.map((r) => r.id)) : bulk.clear())}
                      />
                    </th>
                    <th className="px-3 py-3 font-medium">{t('quotes.page.table.number')}</th>
                    <th className="px-3 py-3 font-medium">{t('common:labels.organization')}</th>
                    <th className="px-3 py-3 font-medium">{t('common:labels.status')}</th>
                    <SortableTh label={t('quotes.page.table.total')} sortKey="total" activeSort={sort?.key} direction={sort?.dir ?? 'desc'} onSort={toggleSort} align="right" testId="quotes-sort-total" />
                    <SortableTh label={t('quotes.page.table.created')} sortKey="created" activeSort={sort?.key} direction={sort?.dir ?? 'desc'} onSort={toggleSort} testId="quotes-sort-created" />
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
                      <td className="px-3 py-3" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          aria-label={t('quotes.page.table.selectQuote', { quote: qt.quoteNumber ?? qt.id })}
                          data-testid={`quotes-select-${qt.id}`}
                          checked={bulk.has(qt.id)}
                          onChange={() => bulk.toggle(qt.id)}
                        />
                      </td>
                      <td className="px-3 py-3 font-medium">
                        <a
                          href={`/billing/quotes/${qt.id}`}
                          onClick={(e) => e.stopPropagation()}
                          data-testid={`quotes-row-link-${qt.id}`}
                          // Unnumbered drafts show an em-dash (the Status column
                          // already carries the "Draft" pill, so a DRAFT chip here
                          // was redundant). The dash is decorative — give the link
                          // an accessible name so it doesn't read as just "—".
                          aria-label={qt.quoteNumber ? undefined : t('quotes.page.table.draftQuote')}
                          className={ROW_LINK_CLASS}
                        >
                          {qt.quoteNumber ?? <span aria-hidden="true" className="text-muted-foreground">—</span>}
                        </a>
                        {qt.title?.trim() && (
                          <div className="mt-0.5 max-w-[18rem] truncate text-xs text-muted-foreground" data-testid={`quotes-title-${qt.id}`}>
                            {qt.title}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-3">{orgName(qt.orgId)}</td>
                      <td className="px-3 py-3">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <StatusPill
                            role={STATUS_ROLES[qt.status].role}
                            label={t(/* i18n-dynamic */ `quotes.status.${qt.status}`)}
                            className={STATUS_ROLES[qt.status].className}
                            testId={`quotes-status-${qt.id}`}
                          />
                          {(() => {
                            const badge = quoteDepositBadge(qt, t);
                            if (!badge) return null;
                            return (
                              <span
                                className={`inline-flex rounded-full px-2 py-1 text-xs font-medium ${badge.className}`}
                                data-testid={`quotes-deposit-badge-${qt.id}`}
                              >
                                {badge.label}
                              </span>
                            );
                          })()}
                        </div>
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums">{formatMoney(qt.total, qt.currencyCode)}</td>
                      <td className="px-3 py-3 text-muted-foreground">{formatDate(qt.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <BulkActionBar
              count={bulk.size}
              onClear={bulk.clear}
              testIdPrefix="quotes"
              actions={[
                ...(can('quotes', 'send') ? [{ key: 'send', label: t('quotes.page.bulk.send'), disabled: bulkBusy, onClick: () => setSendOpen(true) }] : []),
                ...(can('quotes', 'write') ? [{ key: 'delete', label: t('quotes.page.bulk.deleteDrafts'), variant: 'destructive' as const, disabled: bulkBusy, onClick: () => setDeleteOpen(true) }] : []),
              ]}
            />
          </div>
        )}
      </div>

      <ConfirmDialog
        open={sendOpen}
        onClose={() => setSendOpen(false)}
        onConfirm={() => { setSendOpen(false); void runBulkQuotes('/quotes/bulk-send', t('quotes.page.bulk.sentVerb')); }}
        title={t('quotes.page.bulkSend.title')}
        message={t('quotes.page.bulkSend.message', { count: bulk.size })}
        variant="warning"
        confirmLabel={t('quotes.page.bulk.send')}
        confirmTestId="quotes-bulk-send-confirm"
      >
        {/* Reviewable manifest of what's about to go out — number, customer,
            amount per quote — so bulk send is never a blind count. */}
        <ul
          className="max-h-48 space-y-1 overflow-y-auto rounded-md border bg-muted/30 p-2 text-sm"
          data-testid="quotes-bulk-send-review"
        >
          {selectedQuotes.map((q) => (
            <li key={q.id} className="flex items-baseline justify-between gap-3">
              <span className="min-w-0 truncate">
                <span className="font-medium">{q.quoteNumber ?? t('quotes.page.bulkSend.unnumbered')}</span>
                <span className="text-muted-foreground"> · {orgName(q.orgId)}</span>
              </span>
              <span className="shrink-0 tabular-nums text-muted-foreground">{formatMoney(q.total, q.currencyCode)}</span>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-xs text-muted-foreground">{t('quotes.page.bulkSend.recipients')}</p>
      </ConfirmDialog>

      <ConfirmDialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        onConfirm={() => { setDeleteOpen(false); void runBulkQuotes('/quotes/bulk-delete', t('quotes.page.bulk.deletedVerb')); }}
        title={t('quotes.page.bulkDelete.title')}
        message={t('quotes.page.bulkDelete.message', { count: bulk.size })}
        confirmLabel={t('quotes.page.bulk.deleteDrafts')}
        confirmTestId="quotes-bulk-delete-confirm"
      >
        {/* Same reviewable manifest as bulk send — both dialogs are destructive
            and deserve the same rigor. Non-draft rows in the selection are
            skipped server-side; the pill marks which rows will actually delete. */}
        <ul
          className="max-h-48 space-y-1 overflow-y-auto rounded-md border bg-muted/30 p-2 text-sm"
          data-testid="quotes-bulk-delete-review"
        >
          {selectedQuotes.map((q) => (
            <li key={q.id} className="flex items-baseline justify-between gap-3">
              <span className="min-w-0 truncate">
                <span className="font-medium">{q.quoteNumber ?? t('quotes.page.bulkSend.unnumbered')}</span>
                <span className="text-muted-foreground"> · {orgName(q.orgId)}</span>
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {q.status === 'draft' ? formatMoney(q.total, q.currencyCode) : t('quotes.page.bulkDelete.skippedNotDraft')}
              </span>
            </li>
          ))}
        </ul>
      </ConfirmDialog>

      {/* New-quote dialog */}
      <Dialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title={t('quotes.page.create.title')}
        maxWidth="md"
        className="p-6"
      >
        <div className="space-y-4" data-testid="quotes-create-dialog">
          <div>
            <h2 className="text-lg font-semibold">{t('quotes.page.create.title')}</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {t('quotes.page.create.description')}
            </p>
          </div>

          <label className="flex flex-col gap-1 text-sm">
            {t('common:labels.organization')}
            <select
              value={newOrgId}
              onChange={(e) => { setNewOrgId(e.target.value); void loadNewSites(e.target.value); }}
              data-testid="quotes-create-org"
              className="h-10 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
            >
              <option value="">{t('quotes.page.create.selectOrganization')}</option>
              {orgs.map((o) => (
                <option key={o.id} value={o.id}>{o.name}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            {t('quotes.page.create.titleOptional')}
            <input
              type="text"
              value={newTitle}
              maxLength={200}
              placeholder={t('quotes.page.create.titlePlaceholder')}
              onChange={(e) => setNewTitle(e.target.value)}
              data-testid="quotes-create-title"
              className="h-10 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            {t('quotes.page.create.siteOptional')}
            <select
              value={newSiteId}
              onChange={(e) => setNewSiteId(e.target.value)}
              data-testid="quotes-create-site"
              disabled={!newOrgId || newSites.length === 0}
              className="h-10 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring disabled:opacity-50"
            >
              <option value="">{t('quotes.page.create.noSpecificSite')}</option>
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
              {t('common:actions.cancel')}
            </button>
            <button
              type="button"
              onClick={() => void submitCreate()}
              disabled={!newOrgId || creating}
              data-testid="quotes-create-submit"
              className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
            >
              {creating ? t('quotes.page.create.working') : t('quotes.page.create.submit')}
            </button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}

// re-exported for tests that need the error type
export { ActionError };

export default QuotesPage;
