import { useCallback, useEffect, useMemo, useState } from 'react';
import { BULK_ID_LIMIT } from '@breeze/shared';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import { runAction, handleActionError } from '../../lib/runAction';
import {
  listContracts,
  formatCadence,
  monthlyValue,
  CONTRACT_STATUS_ROLES,
  type ContractStatus,
  type ContractSummary,
} from '../../lib/api/contracts';
import { formatMoney, formatDate } from '../billing/invoiceTypes';
import { StatusPill } from '../billing/shared/StatusPill';
import { SortableTh } from '../billing/shared/SortableTh';
import { TableSkeleton } from '../billing/shared/TableSkeleton';
import { usePermissions } from '../../lib/permissions';
import { showToast } from '../shared/Toast';
import { useBulkSelection } from '../billing/bulk/useBulkSelection';
import { BulkActionBar } from '../billing/bulk/BulkActionBar';
import { ConfirmDialog } from '../shared/ConfirmDialog';

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
  const { can } = usePermissions();
  const bulk = useBulkSelection();
  const [contracts, setContracts] = useState<ContractSummary[]>([]);
  const [orgs, setOrgs] = useState<Organization[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [filters, setFilters] = useState<Filters>(() =>
    lockedOrgId ? { ...EMPTY_FILTERS, orgId: lockedOrgId } : readFilters(),
  );
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<Sort | null>(null);
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
  const hasActiveFilters =
    Boolean(search.trim()) || Boolean(filters.status) || (!lockedOrgId && Boolean(filters.orgId));

  // Estimated monthly recurring across active contracts (normalized by cadence).
  const mrr = useMemo(() => {
    const active = contracts.filter((c) => c.status === 'active');
    const total = active.reduce((sum, c) => sum + monthlyValue(c.estimatedPeriodValue, c.intervalMonths), 0);
    return { total, count: active.length, ccy: contracts[0]?.currencyCode || 'USD' };
  }, [contracts]);

  const runBulkContracts = useCallback(
    async (path: string, verb: string) => {
      const ids = Array.from(bulk.selectedIds);
      if (ids.length === 0) return;
      if (ids.length > BULK_ID_LIMIT) {
        showToast({ type: 'warning', message: `Select up to ${BULK_ID_LIMIT} at a time.` });
        return;
      }
      setBulkBusy(true);
      try {
        const result = await runAction<{ data: { succeeded: number; skipped: number; failed: number; skippedReasons?: Record<string, number> } }>({
          request: () => fetchWithAuth(path, { method: 'POST', body: JSON.stringify({ ids }) }),
          errorFallback: `Bulk ${verb} failed. Retry.`,
          onUnauthorized: UNAUTHORIZED,
        });
        const { succeeded, skipped, failed } = result.data;
        showToast(
          skipped + failed > 0
            ? { type: 'warning', message: `${succeeded} ${verb}, ${skipped} skipped${failed ? `, ${failed} failed` : ''}` }
            : { type: 'success', message: `${succeeded} ${verb}` }
        );
        bulk.clear();
        void loadContracts(filters);
      } catch (err) {
        handleActionError(err, `Bulk ${verb} failed. Retry.`);
      } finally {
        setBulkBusy(false);
      }
    },
    [bulk, loadContracts, filters],
  );

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
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search name or org"
          aria-label="Search contracts"
          data-testid="contracts-search"
          className="h-10 min-w-[12rem] flex-1 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
        />
        {!lockedOrgId && (
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            Organization
            <select
              value={filters.orgId}
              onChange={(e) => applyFilter({ orgId: e.target.value })}
              data-testid="contracts-filter-org"
              className="h-10 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
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
            className="h-10 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
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
                Try again
              </button>
            </div>
          </div>
        ) : rows.length === 0 ? (
          hasActiveFilters ? (
            <div className="px-4 py-12 text-center" data-testid="contracts-empty">
              <p className="text-sm text-muted-foreground">No contracts match these filters.</p>
              <button
                type="button"
                onClick={() => { setSearch(''); applyFilter(lockedOrgId ? { status: '' } : { status: '', orgId: '' }); }}
                data-testid="contracts-clear-filters"
                className="mt-3 rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted"
              >
                Clear filters
              </button>
            </div>
          ) : (
            <div className="px-6 py-14 text-center" data-testid="contracts-empty">
              <h3 className="text-sm font-semibold">No contracts yet</h3>
              <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
                Contracts bill an organization on a repeating cadence and auto-generate the invoices for you.
              </p>
              {can('contracts', 'write') && (
                <a
                  href={newContractHref}
                  data-testid="contracts-empty-cta"
                  className="mt-4 inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90"
                >
                  Create your first contract
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
                        aria-label="Select all contracts"
                        data-testid="contracts-select-all"
                        checked={rows.length > 0 && rows.every((r) => bulk.has(r.id))}
                        onChange={(e) => (e.target.checked ? bulk.selectAll(rows.map((r) => r.id)) : bulk.clear())}
                      />
                    </th>
                    <SortableTh label="Name" sortKey="name" activeSort={sort?.key} direction={sort?.dir ?? 'asc'} onSort={toggleSort} testId="contracts-sort-name" />
                    {!lockedOrgId && (
                      <SortableTh label="Organization" sortKey="org" activeSort={sort?.key} direction={sort?.dir ?? 'asc'} onSort={toggleSort} testId="contracts-sort-org" />
                    )}
                    <SortableTh label="Status" sortKey="status" activeSort={sort?.key} direction={sort?.dir ?? 'asc'} onSort={toggleSort} testId="contracts-sort-status" />
                    <SortableTh label="Start date" sortKey="start" activeSort={sort?.key} direction={sort?.dir ?? 'asc'} onSort={toggleSort} testId="contracts-sort-start" />
                    <th className="px-3 py-3 font-medium">Cadence</th>
                    <th className="px-3 py-3 font-medium">Next bill</th>
                    <SortableTh label="Est. / period" sortKey="estimate" activeSort={sort?.key} direction={sort?.dir ?? 'asc'} onSort={toggleSort} align="right" testId="contracts-sort-estimate" />
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
                          aria-label={`Select contract ${ctr.name}`}
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
                          className="rounded-xs text-foreground hover:underline focus:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                        >
                          {ctr.name}
                        </a>
                      </td>
                      {!lockedOrgId && <td className="px-3 py-3">{orgName(ctr.orgId)}</td>}
                      <td className="px-3 py-3">
                        <StatusPill
                          role={CONTRACT_STATUS_ROLES[ctr.status].role}
                          label={CONTRACT_STATUS_ROLES[ctr.status].label}
                          className={CONTRACT_STATUS_ROLES[ctr.status].className}
                          testId={`contract-status-${ctr.id}`}
                        />
                      </td>
                      <td className="px-3 py-3">{formatDate(ctr.startDate)}</td>
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
            <BulkActionBar
              count={bulk.size}
              onClear={bulk.clear}
              testIdPrefix="contracts"
              actions={[
                ...(can('contracts', 'manage') ? [{ key: 'cancel', label: 'Cancel', variant: 'destructive' as const, disabled: bulkBusy, onClick: () => setCancelOpen(true) }] : []),
                ...(can('contracts', 'write') && selectedDraftCount > 0 ? [{ key: 'delete', label: `Delete draft${selectedDraftCount === 1 ? '' : 's'}`, variant: 'destructive' as const, disabled: bulkBusy, onClick: () => setDeleteOpen(true) }] : []),
              ]}
            />
          </div>
        )}
      </div>

      <ConfirmDialog
        open={cancelOpen}
        onClose={() => setCancelOpen(false)}
        onConfirm={() => { setCancelOpen(false); void runBulkContracts('/contracts/bulk-cancel', 'cancelled'); }}
        title="Cancel contracts"
        message={`Cancel ${bulk.size} selected contract(s)? Active and paused contracts will be cancelled; this cannot be undone.`}
        confirmLabel="Cancel contracts"
        confirmTestId="contracts-bulk-cancel-confirm"
      />

      <ConfirmDialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        onConfirm={() => { setDeleteOpen(false); void runBulkContracts('/contracts/bulk-delete', 'deleted'); }}
        title="Delete draft contracts"
        message={`Delete ${selectedDraftCount} draft contract${selectedDraftCount === 1 ? '' : 's'}? Only drafts are deleted${bulk.size > selectedDraftCount ? ' — any active or paused contracts in your selection are left untouched' : ''}; this cannot be undone.`}
        confirmLabel="Delete drafts"
        confirmTestId="contracts-bulk-delete-confirm"
      />
    </div>
  );
}

export default ContractsList;
