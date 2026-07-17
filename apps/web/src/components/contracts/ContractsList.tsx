import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BULK_ID_LIMIT } from '@breeze/shared';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import '@/lib/i18n';
import { runAction, handleActionError } from '../../lib/runAction';
import { useHashState } from '@/lib/useHashState';
import {
  listContracts,
  monthlyValue,
  CONTRACT_STATUS_ROLES,
  type ContractStatus,
  type ContractSummary,
} from '../../lib/api/contracts';
import { formatMoney, formatDate, sumByCurrency } from '../billing/invoiceTypes';
import { StatusPill } from '../billing/shared/StatusPill';
import { StatCard } from '../billing/shared/StatCard';
import { SortableTh } from '../billing/shared/SortableTh';
import { TableSkeleton } from '../billing/shared/TableSkeleton';
import { ROW_LINK_CLASS, writeHashFilters } from '../billing/shared/listChrome';
import { usePermissions } from '../../lib/permissions';
import { showToast } from '../shared/Toast';
import { useLegacyOrgIdHashNotice } from '@/hooks/useLegacyOrgIdHashNotice';
import { useBulkSelection } from '../billing/bulk/useBulkSelection';
import { BulkActionBar } from '../billing/bulk/BulkActionBar';
import { ConfirmDialog } from '../shared/ConfirmDialog';
import AccessDenied from '../shared/AccessDenied';

interface Organization {
  id: string;
  name: string;
}

const STATUS_OPTIONS: { value: '' | ContractStatus; label: string }[] = [
  { value: '', label: 'contracts.contractsList.filters.allStatuses' },
  { value: 'draft', label: 'contracts.shared.status.draft' },
  { value: 'active', label: 'contracts.shared.status.active' },
  { value: 'paused', label: 'contracts.shared.status.paused' },
  { value: 'cancelled', label: 'contracts.shared.status.cancelled' },
  { value: 'expired', label: 'contracts.shared.status.expired' },
];

// ---- hash filter state (key=value&key=value) ----------------------------
// `orgId` exists solely for the lockedOrgId embed (an org detail page pinning
// its own contracts). The free-standing org filter is gone: the header
// switcher owns org scoping (fetchWithAuth injects the selected org), so the
// hash never reads or writes orgId — a deep-linked orgId would suppress that
// injection and silently disagree with the header.
interface Filters {
  orgId: string;
  status: '' | ContractStatus;
}
const EMPTY_FILTERS: Filters = { orgId: '', status: '' };

// Pure: takes the raw hash (leading `#` already stripped by useHashState, #2421).
function readFilters(hash: string): Filters {
  const params = new URLSearchParams(hash);
  const status = params.get('status') ?? '';
  return {
    orgId: '',
    status: (STATUS_OPTIONS.some((o) => o.value === status) ? status : '') as Filters['status'],
  };
}

function writeFilters(f: Filters): void {
  const params = new URLSearchParams();
  if (f.status) params.set('status', f.status);
  // Shared writer: clearing strips the fragment via replaceState so no bare '#'
  // is left dangling (quotes/invoices carried this fix; contracts now shares it).
  writeHashFilters(params);
}

// ---- client-side sort ----------------------------------------------------
type SortKey = 'name' | 'org' | 'status' | 'estimate' | 'start';
interface Sort { key: SortKey; dir: 'asc' | 'desc' }

const num = (s: string | null | undefined) => { const n = Number(s); return Number.isFinite(n) ? n : 0; };
const ts = (d: string | null | undefined) => (d ? new Date(d.length === 10 ? `${d}T00:00:00` : d).getTime() : null);

const UNAUTHORIZED = () => void navigateTo('/login', { replace: true });

interface Props {
  /** When set (e.g. embedded in the org Contracts tab), the list is locked to
   *  this org: the org filter is hidden and the "New contract" CTA pre-selects
   *  it. Avoids fighting the host page's own hash-based tab routing. */
  lockedOrgId?: string;
}

export function ContractsList({ lockedOrgId }: Props = {}) {
  const { t } = useTranslation('billing');
  const { can } = usePermissions();
  const bulk = useBulkSelection();
  const [contracts, setContracts] = useState<ContractSummary[]>([]);
  const [orgs, setOrgs] = useState<Organization[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  // A 403 from the contracts route is a permission denial, not a load failure, so
  // it renders the access-denied state rather than the retryable error.
  const [forbidden, setForbidden] = useState(false);
  // SSR-safe hash adoption + hashchange subscription live in the hook (#2421).
  // When locked to an org (embedded in a hash-routed tab) the host owns the
  // hash, so parse yields undefined and the locked default always wins.
  // An empty hash parses to undefined (not a fresh EMPTY_FILTERS object) so the
  // no-deep-link case keeps the default reference and never refetches.
  const [filters, setFilters] = useHashState<Filters>(
    lockedOrgId ? { ...EMPTY_FILTERS, orgId: lockedOrgId } : EMPTY_FILTERS,
    (h) => (lockedOrgId || !h ? undefined : readFilters(h)),
  );
  // Surface (and strip) a leftover `#orgId=` from a pre-header-scoping bookmark
  // — but NOT in the locked embed, where `#orgId=` is the host's own pin.
  useLegacyOrgIdHashNotice(t('common:layout.org.legacyFilterNotice'), !lockedOrgId);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<Sort | null>(null);
  // Monotonic id of the newest in-flight list request (see loadContracts).
  const fetchSeq = useRef(0);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);

  const orgName = useCallback(
    (id: string) => orgs.find((o) => o.id === id)?.name ?? id.slice(0, 8),
    [orgs],
  );

  const loadOrgs = useCallback(async () => {
    const res = await fetchWithAuth('/orgs/organizations');
    if (res.status === 401) return UNAUTHORIZED();
    if (!res.ok) { handleActionError(new Error(res.statusText), t('contracts.contractsList.errors.loadOrganizations')); return; }
    const body = (await res.json().catch(() => null)) as { data?: Organization[]; organizations?: Organization[] } | null;
    if (!body) return;
    setOrgs(body.data ?? body.organizations ?? []);
  }, [t]);

  const loadContracts = useCallback(async (f: Filters) => {
    // Latest-request-wins. A deep-linked load (`/contracts#status=active`) fires
    // this twice — once with the SSR-safe default filters, then again once
    // useHashState adopts the hash (#2421) — and the unfiltered query can
    // resolve last, painting the wrong list. Drop every response but the newest.
    const seq = ++fetchSeq.current;
    try {
      setLoading(true);
      setError(undefined);
      setForbidden(false);
      const res = await listContracts({ orgId: f.orgId || undefined, status: f.status || undefined });
      if (seq !== fetchSeq.current) return;
      if (res.status === 401) return UNAUTHORIZED();
      if (res.status === 403) { setForbidden(true); return; }
      if (!res.ok) throw new Error(t('contracts.contractsList.errors.loadContracts'));
      const body = (await res.json().catch(() => null)) as { data: ContractSummary[] } | null;
      if (seq !== fetchSeq.current) return;
      if (!body) throw new Error(t('contracts.contractsList.errors.loadContracts'));
      setContracts(body.data ?? []);
    } catch (err) {
      if (seq !== fetchSeq.current) return;
      setError(err instanceof Error ? err.message : t('contracts.contractsList.errors.loadContracts'));
    } finally {
      if (seq === fetchSeq.current) setLoading(false);
    }
  }, [t]);

  useEffect(() => { void loadOrgs(); }, [loadOrgs]);
  useEffect(() => { void loadContracts(filters); }, [loadContracts, filters]);

  // Clear bulk selection whenever the server-side filters or client-side search
  // change so stale, now-invisible rows are never acted on.
  useEffect(() => {
    bulk.clear();
  }, [filters.orgId, filters.status, search, bulk.clear]);

  const applyFilter = useCallback((patch: Partial<Filters>) => {
    setFilters((prev) => {
      const next = { ...prev, ...patch };
      if (!lockedOrgId) writeFilters(next);
      return next;
    });
  }, [lockedOrgId]);

  const newContractHref = lockedOrgId ? `/contracts/new#orgId=${lockedOrgId}` : '/contracts/new';

  // A fresh column sorts ASCending first (A→Z / oldest / smallest), then toggles.
  // This is intentionally the opposite of the quotes/invoices lists (which open
  // DESC-first): those lead with money/recency where "biggest/newest first" is
  // the useful default, whereas contracts lead with a name column where A→Z reads
  // more naturally.
  const toggleSort = (key: SortKey) =>
    setSort((s) => (s?.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }));

  // ---- derived rows: client-side search (name/org) then optional sort ------
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    let out = contracts.filter((c) => {
      if (!q) return true;
      return c.name.toLowerCase().includes(q) || orgName(c.orgId).toLowerCase().includes(q);
    });
    if (sort) {
      const dir = sort.dir === 'asc' ? 1 : -1;
      out = [...out].sort((a, b) => {
        switch (sort.key) {
          case 'name':
            return a.name.localeCompare(b.name) * dir;
          case 'org':
            return orgName(a.orgId).localeCompare(orgName(b.orgId)) * dir;
          case 'status':
            return a.status.localeCompare(b.status) * dir;
          case 'estimate':
            return (num(a.estimatedPeriodValue) - num(b.estimatedPeriodValue)) * dir;
          case 'start': {
            const av = ts(a.startDate);
            const bv = ts(b.startDate);
            if (av == null && bv == null) return 0;
            if (av == null) return 1;
            if (bv == null) return -1;
            return (av - bv) * dir;
          }
          default:
            return 0;
        }
      });
    }
    return out;
  }, [contracts, search, sort, orgName]);

  // Only DRAFT contracts can be bulk-deleted, so the action is offered only when
  // the selection actually contains one — otherwise it's a confusing no-op.
  const selectedDraftCount = useMemo(
    () => contracts.filter((c) => c.status === 'draft' && bulk.selectedIds.has(c.id)).length,
    [contracts, bulk.selectedIds],
  );

  // Distinguishes a filtered-empty result (offer "clear filters") from a genuine
  // first-run empty state (offer "create your first contract").
  const hasActiveFilters = Boolean(search.trim()) || Boolean(filters.status);

  // Estimated monthly recurring across active contracts (normalized by cadence).
  const mrr = useMemo(() => {
    const active = contracts.filter((c) => c.status === 'active');
    const total = active.reduce((sum, c) => sum + monthlyValue(c.estimatedPeriodValue, c.intervalMonths), 0);
    // Per-currency so a mixed-currency book isn't summed under one wrong code.
    const byCurrency = sumByCurrency(
      active.map((c) => ({ amount: monthlyValue(c.estimatedPeriodValue, c.intervalMonths), currencyCode: c.currencyCode })),
    );
    return { total, count: active.length, byCurrency, ccy: contracts[0]?.currencyCode || 'USD' };
  }, [contracts]);

  // '$12,300 + €4,100' across currencies. With one currency, label with the
  // SUMMED SUBSET's code (byCurrency[0]) — not contracts[0]'s (`mrr.ccy`), which
  // may come from a draft/cancelled contract in a different currency. The
  // contracts[0] fallback only applies when nothing is active ($0.00).
  const mrrDisplay = mrr.byCurrency.length === 0
    ? formatMoney(mrr.total, mrr.ccy)
    : mrr.byCurrency.map((e) => formatMoney(e.amount, e.code)).join(' + ');

  const runBulkContracts = useCallback(
    async (path: string, verb: string) => {
      const ids = Array.from(bulk.selectedIds);
      if (ids.length === 0) return;
      if (ids.length > BULK_ID_LIMIT) {
        showToast({ type: 'warning', message: t('contracts.contractsList.toast.bulkLimit', { limit: BULK_ID_LIMIT }) });
        return;
      }
      setBulkBusy(true);
      try {
        const result = await runAction<{ data: { succeeded: number; skipped: number; failed: number; skippedReasons?: Record<string, number> } }>({
          request: () => fetchWithAuth(path, { method: 'POST', body: JSON.stringify({ ids }) }),
          errorFallback: t('contracts.contractsList.toast.bulkFailed', { verb }),
          onUnauthorized: UNAUTHORIZED,
        });
        const { succeeded, skipped, failed } = result.data;
        showToast(
          skipped + failed > 0
            ? {
                type: 'warning',
                message: t('contracts.contractsList.toast.bulkPartial', {
                  succeeded,
                  verb,
                  skipped,
                  failedText: failed ? t('contracts.contractsList.toast.failedSuffix', { failed }) : '',
                }),
              }
            : { type: 'success', message: t('contracts.contractsList.toast.bulkSuccess', { succeeded, verb }) }
        );
        bulk.clear();
        void loadContracts(filters);
      } catch (err) {
        handleActionError(err, t('contracts.contractsList.toast.bulkFailed', { verb }));
      } finally {
        setBulkBusy(false);
      }
    },
    [bulk, loadContracts, filters, t],
  );

  if (forbidden) {
    return (
      <div className="space-y-6" data-testid="contracts-page">
        <AccessDenied message={t('contracts.contractsList.accessDenied')} />
      </div>
    );
  }

  return (
    <div className="space-y-6" data-testid="contracts-page">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          {lockedOrgId ? (
            <h2 className="text-lg font-semibold">{t('contracts.contractsList.title')}</h2>
          ) : (
            <h1 className="text-xl font-semibold">{t('contracts.contractsList.title')}</h1>
          )}
          <p className="mt-1 text-sm text-muted-foreground">
            {t('contracts.contractsList.description')}
          </p>
        </div>
        {can('contracts', 'write') && (
          <a
            href={newContractHref}
            data-testid="new-contract-btn"
            className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90"
          >
            {t('contracts.contractsList.newContract')}
          </a>
        )}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-end gap-3" data-testid="contracts-filters">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('contracts.contractsList.filters.searchPlaceholder')}
          aria-label={t('contracts.contractsList.filters.searchAria')}
          data-testid="contracts-search"
          className="h-10 min-w-[12rem] flex-1 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
        />
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {t('common:labels.status')}
          <select
            value={filters.status}
            onChange={(e) => applyFilter({ status: e.target.value as Filters['status'] })}
            data-testid="contracts-filter-status"
            className="h-10 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
          >
            {STATUS_OPTIONS.map((s) => (
              <option key={s.value} value={s.value}>{t(/* i18n-dynamic */ s.label)}</option>
            ))}
          </select>
        </label>
      </div>

      {/* Estimated monthly recurring */}
      {!loading && !error && rows.length > 0 && (
        <StatCard
          label={t('contracts.contractsList.stats.estimatedMonthlyRecurring')}
          value={mrrDisplay}
          hint={t('contracts.contractsList.stats.activeContractCount', { count: mrr.count })}
          className="inline-flex flex-col"
          testId="contracts-mrr-strip"
        />
      )}

      {/* Table */}
      <div className="rounded-lg border bg-card shadow-xs">
        {loading ? (
          <TableSkeleton cols={lockedOrgId ? 6 : 7} />
        ) : error ? (
          <div className="p-6 text-center text-sm text-destructive" data-testid="contracts-error">
            {error}
            <div>
              <button
                type="button"
                onClick={() => void loadContracts(filters)}
                className="mt-3 rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted"
              >
                {t('contracts.contractsList.actions.tryAgain')}
              </button>
            </div>
          </div>
        ) : rows.length === 0 ? (
          hasActiveFilters ? (
            <div className="px-4 py-12 text-center" data-testid="contracts-empty">
              <p className="text-sm text-muted-foreground">{t('contracts.contractsList.empty.noMatches')}</p>
              <button
                type="button"
                onClick={() => { setSearch(''); applyFilter({ status: '' }); }}
                data-testid="contracts-clear-filters"
                className="mt-3 rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted"
              >
                {t('contracts.contractsList.actions.clearFilters')}
              </button>
            </div>
          ) : (
            <div className="px-6 py-14 text-center" data-testid="contracts-empty">
              <h3 className="text-sm font-semibold">{t('contracts.contractsList.empty.title')}</h3>
              <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
                {t('contracts.contractsList.empty.description')}
              </p>
              {can('contracts', 'write') && (
                <a
                  href={newContractHref}
                  data-testid="contracts-empty-cta"
                  className="mt-4 inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90"
                >
                  {t('contracts.contractsList.empty.createFirst')}
                </a>
              )}
            </div>
          )
        ) : (
          <div className="relative">
            {/* BulkActionBar is an in-flow `sticky bottom-0` element (last child),
                so it reserves its own layout space and never occludes the last
                row — no bottom-padding hack is needed here. */}
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="contracts-list">
                <thead>
                  <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="w-8 px-3 py-3">
                      <input
                        type="checkbox"
                        aria-label={t('contracts.contractsList.table.selectAllAria')}
                        data-testid="contracts-select-all"
                        checked={rows.length > 0 && rows.every((r) => bulk.has(r.id))}
                        onChange={(e) => (e.target.checked ? bulk.selectAll(rows.map((r) => r.id)) : bulk.clear())}
                      />
                    </th>
                    <SortableTh label={t('common:labels.name')} sortKey="name" activeSort={sort?.key} direction={sort?.dir ?? 'asc'} onSort={toggleSort} testId="contracts-sort-name" />
                    {!lockedOrgId && (
                      <SortableTh label={t('common:labels.organization')} sortKey="org" activeSort={sort?.key} direction={sort?.dir ?? 'asc'} onSort={toggleSort} testId="contracts-sort-org" />
                    )}
                    <SortableTh label={t('common:labels.status')} sortKey="status" activeSort={sort?.key} direction={sort?.dir ?? 'asc'} onSort={toggleSort} testId="contracts-sort-status" />
                    <SortableTh label={t('contracts.contractsList.table.startDate')} sortKey="start" activeSort={sort?.key} direction={sort?.dir ?? 'asc'} onSort={toggleSort} testId="contracts-sort-start" />
                    <th className="px-3 py-3 font-medium">{t('contracts.contractsList.table.cadence')}</th>
                    <th className="px-3 py-3 font-medium">{t('contracts.contractsList.table.nextBill')}</th>
                    <SortableTh label={t('contracts.contractsList.table.estimatedPerPeriod')} sortKey="estimate" activeSort={sort?.key} direction={sort?.dir ?? 'asc'} onSort={toggleSort} align="right" testId="contracts-sort-estimate" />
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
                      <td className="px-3 py-3" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          aria-label={t('contracts.contractsList.table.selectContractAria', { name: ctr.name })}
                          data-testid={`contract-select-${ctr.id}`}
                          checked={bulk.has(ctr.id)}
                          onChange={() => bulk.toggle(ctr.id)}
                        />
                      </td>
                      <td className="px-3 py-3 font-medium">
                        <a
                          href={`/contracts/${ctr.id}`}
                          onClick={(e) => e.stopPropagation()}
                          data-testid={`contract-row-link-${ctr.id}`}
                          className={ROW_LINK_CLASS}
                        >
                          {ctr.name}
                        </a>
                      </td>
                      {!lockedOrgId && <td className="px-3 py-3">{orgName(ctr.orgId)}</td>}
                      <td className="px-3 py-3">
                        <StatusPill
                          role={CONTRACT_STATUS_ROLES[ctr.status].role}
                          label={t(/* i18n-dynamic */ `contracts.shared.status.${ctr.status}`)}
                          className={CONTRACT_STATUS_ROLES[ctr.status].className}
                          testId={`contract-status-${ctr.id}`}
                        />
                      </td>
                      <td className="px-3 py-3">{formatDate(ctr.startDate)}</td>
                      <td className="px-3 py-3">
                        {ctr.intervalMonths === 1
                          ? t('contracts.shared.cadence.monthly')
                          : ctr.intervalMonths === 3
                            ? t('contracts.shared.cadence.quarterly')
                            : ctr.intervalMonths === 12
                              ? t('contracts.shared.cadence.annual')
                              : t('contracts.shared.cadence.custom', { count: ctr.intervalMonths })}
                      </td>
                      <td className="px-3 py-3">{formatDate(ctr.nextBillingAt)}</td>
                      <td className="px-3 py-3 text-right tabular-nums" data-testid={`contract-estimate-${ctr.id}`}>
                        {ctr.estimatedPeriodValue != null ? formatMoney(ctr.estimatedPeriodValue, ctr.currencyCode) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <BulkActionBar
              count={bulk.size}
              onClear={bulk.clear}
              testIdPrefix="contracts"
              actions={[
                ...(can('contracts', 'manage') ? [{ key: 'cancel', label: t('common:actions.cancel'), variant: 'destructive' as const, disabled: bulkBusy, onClick: () => setCancelOpen(true) }] : []),
                ...(can('contracts', 'write') && selectedDraftCount > 0 ? [{ key: 'delete', label: t('contracts.contractsList.bulk.deleteDrafts', { count: selectedDraftCount }), variant: 'destructive' as const, disabled: bulkBusy, onClick: () => setDeleteOpen(true) }] : []),
              ]}
            />
          </div>
        )}
      </div>

      <ConfirmDialog
        open={cancelOpen}
        onClose={() => setCancelOpen(false)}
        onConfirm={() => { setCancelOpen(false); void runBulkContracts('/contracts/bulk-cancel', 'cancelled'); }}
        title={t('contracts.contractsList.cancelConfirm.title')}
        message={t('contracts.contractsList.cancelConfirm.message', { count: bulk.size })}
        confirmLabel={t('contracts.contractsList.cancelConfirm.confirm')}
        confirmTestId="contracts-bulk-cancel-confirm"
      />

      <ConfirmDialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        onConfirm={() => { setDeleteOpen(false); void runBulkContracts('/contracts/bulk-delete', 'deleted'); }}
        title={t('contracts.contractsList.deleteConfirm.title')}
        message={t('contracts.contractsList.deleteConfirm.message', {
          count: selectedDraftCount,
          untouched: bulk.size > selectedDraftCount ? t('contracts.contractsList.deleteConfirm.untouchedSuffix') : '',
        })}
        confirmLabel={t('contracts.contractsList.deleteConfirm.confirm')}
        confirmTestId="contracts-bulk-delete-confirm"
      />
    </div>
  );
}

export default ContractsList;
