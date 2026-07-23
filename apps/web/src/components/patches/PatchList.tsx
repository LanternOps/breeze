import { useMemo, useState, useCallback } from 'react';
import {
  Search,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ChevronDown,
  ChevronsUpDown,
  CheckCircle,
  XCircle,
  Clock,
  Eye,
  Download,
  Loader2,
  CheckSquare,
  Square,
  Minus
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { ResponsiveTable, DataCard, CardField, CardActions } from '../shared/ResponsiveTable';
import { usePatchSelection } from './usePatchSelection';

export type PatchSeverity = 'critical' | 'important' | 'moderate' | 'low';
export type PatchApprovalStatus = 'pending' | 'approved' | 'declined' | 'deferred';

export type Patch = {
  id: string;
  title: string;
  severity: PatchSeverity;
  source: string;
  os: string;
  releaseDate: string;
  approvalStatus: PatchApprovalStatus;
  description?: string;
  vendor?: string | null;
  cveIds?: string[];
};

type PatchListProps = {
  patches: Patch[];
  onReview?: (patch: Patch) => void;
  onDeploy?: (patch: Patch) => void;
  onView?: (patch: Patch) => void;
  onBulkApprove?: (patchIds: string[]) => Promise<void>;
  onBulkDecline?: (patchIds: string[]) => Promise<void>;
  /** Initial rows-per-page; user can change it via the page-size selector. */
  initialPageSize?: number;
  loading?: boolean;
  error?: string;
  onRetry?: () => void;
};

const severityConfig: Record<PatchSeverity, { labelKey: string; color: string }> = {
  critical: { labelKey: 'patchList.severity.critical', color: 'bg-red-500/20 text-red-700 border-red-500/40' },
  important: { labelKey: 'patchList.severity.important', color: 'bg-orange-500/20 text-orange-700 border-orange-500/40' },
  moderate: { labelKey: 'patchList.severity.moderate', color: 'bg-yellow-500/20 text-yellow-700 border-yellow-500/40' },
  low: { labelKey: 'patchList.severity.low', color: 'bg-blue-500/20 text-blue-700 border-blue-500/40' }
};

const approvalConfig: Record<PatchApprovalStatus, { labelKey: string; color: string; icon: typeof CheckCircle }> = {
  pending: { labelKey: 'patchList.approval.pending', color: 'bg-warning/15 text-warning border-warning/30', icon: Clock },
  approved: { labelKey: 'patchList.approval.approved', color: 'bg-success/15 text-success border-success/30', icon: CheckCircle },
  declined: { labelKey: 'patchList.approval.declined', color: 'bg-destructive/15 text-destructive border-destructive/30', icon: XCircle },
  deferred: { labelKey: 'patchList.approval.deferred', color: 'bg-blue-500/20 text-blue-700 border-blue-500/40', icon: Clock }
};

function formatDate(dateString: string): string {
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return dateString;
  return date.toLocaleDateString();
}

type SortKey = 'title' | 'severity' | 'source' | 'os' | 'releaseDate' | 'approvalStatus';
type SortDir = 'asc' | 'desc';

const PAGE_SIZE_OPTIONS = [25, 50, 100, 200] as const;
const DEFAULT_PAGE_SIZE = 25;

// Semantic ordering for severity / approval so a sort reflects priority rather
// than raw alphabetical order of the enum value.
//
// WARNING (sort divergence): this client-side severity sort uses SEMANTIC
// priority (critical=0 … low=3), whereas the API sorts severity ALPHABETICALLY
// (asc(patches.severity) in routes/patches/list.ts). These currently never
// disagree because the web does 100% client-side sort/paginate over a fixed
// `limit=200` fetch and never sends sortBy/sortDir. Whoever later pushes
// sorting down to the server (via fetchPatches) MUST reconcile the two or
// severity ordering will silently change. Note also that `os` and
// `approvalStatus` are SortKeys here with no matching column in the API's
// PATCH_SORT_COLUMNS — they can't be pushed down without server-side support.
const severityRank: Record<PatchSeverity, number> = {
  critical: 0,
  important: 1,
  moderate: 2,
  low: 3
};

const approvalRank: Record<PatchApprovalStatus, number> = {
  pending: 0,
  deferred: 1,
  approved: 2,
  declined: 3
};

function compareBySort(a: Patch, b: Patch, key: SortKey): number {
  switch (key) {
    case 'severity':
      return severityRank[a.severity] - severityRank[b.severity];
    case 'approvalStatus':
      return approvalRank[a.approvalStatus] - approvalRank[b.approvalStatus];
    case 'releaseDate': {
      const at = new Date(a.releaseDate).getTime();
      const bt = new Date(b.releaseDate).getTime();
      const aValid = Number.isNaN(at) ? -Infinity : at;
      const bValid = Number.isNaN(bt) ? -Infinity : bt;
      return aValid - bValid;
    }
    default:
      return String(a[key] ?? '').localeCompare(String(b[key] ?? ''), undefined, {
        sensitivity: 'base'
      });
  }
}

export default function PatchList({
  patches,
  onReview,
  onDeploy,
  onView,
  onBulkApprove,
  onBulkDecline,
  initialPageSize = DEFAULT_PAGE_SIZE,
  loading,
  error,
  onRetry
}: PatchListProps) {
  const { t } = useTranslation('patches');
  const [query, setQuery] = useState('');
  const [severityFilter, setSeverityFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [osFilter, setOsFilter] = useState<string>('all');
  const [sourceFilter, setSourceFilter] = useState<string>('all');
  const [showMoreFilters, setShowMoreFilters] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(initialPageSize);
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [bulkLoading, setBulkLoading] = useState(false);

  // Clicking a header toggles direction when it's already the active sort,
  // otherwise selects that column ascending. Resetting to page 1 keeps the
  // user from landing on an out-of-range page after a re-sort.
  const handleSort = useCallback((key: SortKey) => {
    setSortKey(prevKey => {
      if (prevKey === key) {
        setSortDir(prevDir => (prevDir === 'asc' ? 'desc' : 'asc'));
        return key;
      }
      setSortDir('asc');
      return key;
    });
    setCurrentPage(1);
  }, []);

  const availableSources = useMemo(() => {
    const sources = new Set(patches.map(patch => patch.source));
    return Array.from(sources).sort();
  }, [patches]);

  const availableOs = useMemo(() => {
    const osList = new Set(patches.map(patch => patch.os));
    return Array.from(osList).sort();
  }, [patches]);

  const filteredPatches = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    return patches.filter(patch => {
      const matchesQuery =
        normalizedQuery.length === 0
          ? true
          : patch.title.toLowerCase().includes(normalizedQuery) ||
            patch.description?.toLowerCase().includes(normalizedQuery);
      const matchesSeverity = severityFilter === 'all' ? true : patch.severity === severityFilter;
      const matchesStatus = statusFilter === 'all' ? true : patch.approvalStatus === statusFilter;
      const matchesOs = osFilter === 'all' ? true : patch.os === osFilter;
      const matchesSource = sourceFilter === 'all' ? true : patch.source === sourceFilter;

      return matchesQuery && matchesSeverity && matchesStatus && matchesOs && matchesSource;
    });
  }, [patches, query, severityFilter, statusFilter, osFilter, sourceFilter]);

  const sortedPatches = useMemo(() => {
    if (!sortKey) return filteredPatches;
    const dirFactor = sortDir === 'asc' ? 1 : -1;
    // Copy before sort so we don't mutate the memoized filtered array.
    return [...filteredPatches].sort((a, b) => compareBySort(a, b, sortKey) * dirFactor);
  }, [filteredPatches, sortKey, sortDir]);

  const totalPages = Math.max(1, Math.ceil(sortedPatches.length / pageSize));
  const startIndex = (currentPage - 1) * pageSize;
  const paginatedPatches = sortedPatches.slice(startIndex, startIndex + pageSize);

  const paginatedIds = useMemo(() => paginatedPatches.map(p => p.id), [paginatedPatches]);
  const { selectedIds, allPageSelected, somePageSelected, toggleSelect, toggleSelectAll, clearSelection } = usePatchSelection(paginatedIds);

  const selectedPatches = useMemo(
    () => patches.filter(p => selectedIds.has(p.id)),
    [patches, selectedIds]
  );

  const selectedPendingIds = useMemo(
    () => selectedPatches.filter(p => p.approvalStatus !== 'approved' && p.approvalStatus !== 'declined').map(p => p.id),
    [selectedPatches]
  );

  const selectedApprovedIds = useMemo(
    () => selectedPatches.filter(p => p.approvalStatus === 'approved').map(p => p.id),
    [selectedPatches]
  );

  const [bulkError, setBulkError] = useState<string>();

  const handleBulkApprove = useCallback(async () => {
    if (!onBulkApprove || selectedPendingIds.length === 0) return;
    setBulkLoading(true);
    setBulkError(undefined);
    try {
      await onBulkApprove(selectedPendingIds);
      clearSelection();
    } catch (err) {
      setBulkError(err instanceof Error ? err.message : t('patchList.errors.approvePatches'));
    } finally {
      setBulkLoading(false);
    }
  }, [onBulkApprove, selectedPendingIds, clearSelection, t]);

  const handleBulkDecline = useCallback(async () => {
    if (!onBulkDecline || selectedPendingIds.length === 0) return;
    setBulkLoading(true);
    setBulkError(undefined);
    try {
      await onBulkDecline(selectedPendingIds);
      clearSelection();
    } catch (err) {
      setBulkError(err instanceof Error ? err.message : t('patchList.errors.declinePatches'));
    } finally {
      setBulkLoading(false);
    }
  }, [onBulkDecline, selectedPendingIds, clearSelection, t]);

  // Row pieces shared by the desktop table and the mobile cards so the two
  // surfaces can't drift.
  const renderTitleCell = (patch: Patch) => (
    <>
      <div className="font-medium text-foreground">
        {patch.title}
        {patch.source === 'third_party' && patch.vendor && (
          <span
            data-testid={`patch-row-${patch.id}-vendor`}
            className="ml-2 text-xs text-muted-foreground font-normal"
          >
            {t('patchList.vendorBy', { vendor: patch.vendor })}
          </span>
        )}
      </div>
      {patch.cveIds && patch.cveIds.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {patch.cveIds.slice(0, 3).map((cve) => (
            <a
              key={cve}
              data-testid={`patch-row-${patch.id}-cve-${cve}`}
              href={`https://nvd.nist.gov/vuln/detail/${cve}`}
              target="_blank"
              rel="noreferrer"
              className="inline-block px-1.5 py-0.5 rounded text-[10px] bg-red-100 text-red-700 hover:bg-red-200"
            >
              {cve}
            </a>
          ))}
          {patch.cveIds.length > 3 && (
            <span className="text-[10px] text-muted-foreground">
              {t('patchList.moreCves', { count: patch.cveIds.length - 3 })}
            </span>
          )}
        </div>
      )}
      {patch.description && (
        <div className="text-xs text-muted-foreground">{patch.description}</div>
      )}
    </>
  );

  const renderSeverityBadge = (patch: Patch) => {
    const severity = severityConfig[patch.severity];
    return (
      <span className={cn('inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium', severity.color)}>
        {t(/* i18n-dynamic */ severity.labelKey)}
      </span>
    );
  };

  const renderApprovalBadge = (patch: Patch) => {
    const approval = approvalConfig[patch.approvalStatus];
    const ApprovalIcon = approval.icon;
    return (
      <span className={cn('inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium', approval.color)}>
        <ApprovalIcon className="h-3.5 w-3.5" />
        {t(/* i18n-dynamic */ approval.labelKey)}
      </span>
    );
  };

  const renderRowActions = (patch: Patch) => (
    <div className="flex items-center justify-end gap-2">
      {patch.approvalStatus === 'approved' ? (
        <button
          type="button"
          onClick={() => onDeploy?.(patch)}
          data-testid={`patch-row-${patch.id}-deploy`}
          className="inline-flex h-8 items-center gap-1 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:opacity-90"
        >
          <Download className="h-3.5 w-3.5" />
          {t('patchList.actions.deploy')}
        </button>
      ) : (
        <button
          type="button"
          onClick={() => onReview?.(patch)}
          data-testid={`patch-row-${patch.id}-review`}
          className="inline-flex h-8 items-center gap-1 rounded-md border px-3 text-xs font-medium hover:bg-muted"
        >
          <Eye className="h-3.5 w-3.5" />
          {t('patchList.actions.review')}
        </button>
      )}
      <button
        type="button"
        onClick={() => onView?.(patch)}
        data-testid={`patch-row-${patch.id}-details`}
        className="inline-flex h-8 items-center gap-1 rounded-md border px-3 text-xs font-medium text-muted-foreground hover:text-foreground"
      >
        {t('patchList.actions.details')}
      </button>
    </div>
  );

  return (
    <div className="rounded-lg border bg-card p-6 shadow-xs">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold">{t('patchList.title')}</h2>
          <p className="text-sm text-muted-foreground">
            {t('patchList.summary', { shown: filteredPatches.length, total: patches.length })}
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center flex-wrap">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              type="search"
              placeholder={t('patchList.searchPlaceholder')}
              value={query}
              onChange={event => {
                setQuery(event.target.value);
                setCurrentPage(1);
              }}
              className="h-10 w-full rounded-md border bg-background pl-9 pr-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring sm:w-48"
            />
          </div>
          <select
            value={severityFilter}
            onChange={event => {
              setSeverityFilter(event.target.value);
              setCurrentPage(1);
            }}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring sm:w-36"
          >
            <option value="all">{t('patchList.filters.allSeverities')}</option>
            <option value="critical">{t('patchList.severity.critical')}</option>
            <option value="important">{t('patchList.severity.important')}</option>
            <option value="moderate">{t('patchList.severity.moderate')}</option>
            <option value="low">{t('patchList.severity.low')}</option>
          </select>
          <select
            value={statusFilter}
            onChange={event => {
              setStatusFilter(event.target.value);
              setCurrentPage(1);
            }}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring sm:w-36"
          >
            <option value="all">{t('patchList.filters.allStatus')}</option>
            <option value="pending">{t('patchList.approval.pending')}</option>
            <option value="approved">{t('patchList.approval.approved')}</option>
            <option value="declined">{t('patchList.approval.declined')}</option>
            <option value="deferred">{t('patchList.approval.deferred')}</option>
          </select>
          <button
            type="button"
            onClick={() => setShowMoreFilters(prev => !prev)}
            className={cn(
              'h-10 rounded-md px-3 text-sm font-medium',
              showMoreFilters || sourceFilter !== 'all' || osFilter !== 'all'
                ? 'text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {showMoreFilters ? t('patchList.filters.lessFilters') : t('patchList.filters.moreFilters')}
            {(sourceFilter !== 'all' || osFilter !== 'all') && !showMoreFilters && (
              <span className="ml-1 inline-flex h-4 w-4 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-primary-foreground">
                {(sourceFilter !== 'all' ? 1 : 0) + (osFilter !== 'all' ? 1 : 0)}
              </span>
            )}
          </button>
          {showMoreFilters && (
            <>
              <select
                value={sourceFilter}
                onChange={event => {
                  setSourceFilter(event.target.value);
                  setCurrentPage(1);
                }}
                className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring sm:w-40"
              >
                <option value="all">{t('patchList.filters.allSources')}</option>
                {availableSources.map(source => (
                  <option key={source} value={source}>
                    {source}
                  </option>
                ))}
              </select>
              <select
                value={osFilter}
                onChange={event => {
                  setOsFilter(event.target.value);
                  setCurrentPage(1);
                }}
                className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring sm:w-32"
              >
                <option value="all">{t('patchList.filters.allOs')}</option>
                {availableOs.map(os => (
                  <option key={os} value={os}>
                    {os}
                  </option>
                ))}
              </select>
            </>
          )}
        </div>
      </div>

      {/* Bulk action toolbar */}
      {selectedIds.size > 0 && (
        <div className="mt-4 flex flex-wrap items-center gap-3 rounded-lg border bg-muted/50 px-4 py-3">
          <span className="text-sm font-medium">
            {t('patchList.selection.selected', { count: selectedIds.size })}
          </span>
          <div className="h-4 w-px bg-border" />
          {onBulkApprove && selectedPendingIds.length > 0 && (
            <button
              type="button"
              onClick={handleBulkApprove}
              disabled={bulkLoading}
              data-testid="patch-bulk-approve"
              className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              {bulkLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle className="h-3.5 w-3.5" />}
              {t('patchList.actions.approveCount', { count: selectedPendingIds.length })}
            </button>
          )}
          {onBulkDecline && selectedPendingIds.length > 0 && (
            <button
              type="button"
              onClick={handleBulkDecline}
              disabled={bulkLoading}
              data-testid="patch-bulk-decline"
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-destructive/40 bg-destructive/10 px-3 text-xs font-medium text-destructive hover:bg-destructive/20 disabled:opacity-50"
            >
              {bulkLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <XCircle className="h-3.5 w-3.5" />}
              {t('patchList.actions.declineCount', { count: selectedPendingIds.length })}
            </button>
          )}
          {onDeploy && selectedApprovedIds.length > 0 && (
            <button
              type="button"
              onClick={() => {
                for (const p of selectedPatches.filter(p => p.approvalStatus === 'approved')) {
                  onDeploy(p);
                }
              }}
              disabled={bulkLoading}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border px-3 text-xs font-medium hover:bg-muted disabled:opacity-50"
            >
              <Download className="h-3.5 w-3.5" />
              {t('patchList.actions.deployCount', { count: selectedApprovedIds.length })}
            </button>
          )}
          <button
            type="button"
            onClick={clearSelection}
            className="ml-auto h-8 rounded-md px-3 text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            {t('patchList.actions.clearSelection')}
          </button>
        </div>
      )}

      {bulkError && (
        <div className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive">
          {bulkError}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <div className="text-center">
            <Loader2 className="mx-auto h-8 w-8 animate-spin text-muted-foreground" />
            <p className="mt-4 text-sm text-muted-foreground">{t('patchList.loading')}</p>
          </div>
        </div>
      ) : error && patches.length === 0 ? (
        <div className="mt-6 rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
          <p className="text-sm text-destructive">{error}</p>
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
            >
              {t('patchList.actions.tryAgain')}
            </button>
          )}
        </div>
      ) : (
        <ResponsiveTable
          className="mt-6"
          table={
          <table className="min-w-full divide-y">
            <thead className="bg-muted/40">
              <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <th className="w-10 px-4 py-3">
                  <button
                    type="button"
                    onClick={toggleSelectAll}
                    className="flex items-center justify-center text-muted-foreground hover:text-foreground"
                    title={allPageSelected ? t('patchList.selection.deselectAll') : t('patchList.selection.selectAll')}
                    aria-label={allPageSelected ? t('patchList.selection.deselectAllPatches') : t('patchList.selection.selectAllPatches')}
                  >
                    {allPageSelected ? (
                      <CheckSquare className="h-4 w-4" />
                    ) : somePageSelected ? (
                      <Minus className="h-4 w-4" />
                    ) : (
                      <Square className="h-4 w-4" />
                    )}
                  </button>
                </th>
                {([
                  ['title', 'patchList.table.patch'],
                  ['severity', 'patchList.table.severity'],
                  ['source', 'patchList.table.source'],
                  ['os', 'patchList.table.os'],
                  ['releaseDate', 'patchList.table.release'],
                  ['approvalStatus', 'patchList.table.approval']
                ] as Array<[SortKey, string]>).map(([key, label]) => {
                  const active = sortKey === key;
                  const SortIcon = active
                    ? sortDir === 'asc'
                      ? ChevronUp
                      : ChevronDown
                    : ChevronsUpDown;
                  return (
                    <th key={key} className="px-4 py-3" aria-sort={active ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                      <button
                        type="button"
                        onClick={() => handleSort(key)}
                        data-testid={`patch-sort-${key}`}
                        className={cn(
                          'group flex items-center gap-1 uppercase tracking-wide hover:text-foreground',
                          active ? 'text-foreground' : 'text-muted-foreground'
                        )}
                        title={t('patchList.sortBy', { label: t(/* i18n-dynamic */ label) })}
                      >
                        {t(/* i18n-dynamic */ label)}
                        <SortIcon className={cn('h-3.5 w-3.5', active ? 'opacity-100' : 'opacity-40 group-hover:opacity-70')} />
                      </button>
                    </th>
                  );
                })}
                <th className="px-4 py-3 text-right">{t('patchList.table.actions')}</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {paginatedPatches.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-6 text-center text-sm text-muted-foreground">
                    {t('patchList.empty')}
                  </td>
                </tr>
              ) : (
                paginatedPatches.map(patch => {
                  const isSelected = selectedIds.has(patch.id);

                  return (
                    <tr key={patch.id} className={cn('text-sm', isSelected && 'bg-primary/5')}>
                      <td className="w-10 px-4 py-3">
                        <button
                          type="button"
                          onClick={() => toggleSelect(patch.id)}
                          className="flex items-center justify-center text-muted-foreground hover:text-foreground"
                          aria-label={
                            isSelected
                              ? t('patchList.selection.deselectPatch', { title: patch.title })
                              : t('patchList.selection.selectPatch', { title: patch.title })
                          }
                        >
                          {isSelected ? (
                            <CheckSquare className="h-4 w-4 text-primary" />
                          ) : (
                            <Square className="h-4 w-4" />
                          )}
                        </button>
                      </td>
                      <td className="px-4 py-3">{renderTitleCell(patch)}</td>
                      <td className="px-4 py-3">{renderSeverityBadge(patch)}</td>
                      <td className="px-4 py-3 text-muted-foreground">{patch.source}</td>
                      <td className="px-4 py-3 text-muted-foreground">{patch.os}</td>
                      <td className="px-4 py-3 text-muted-foreground">{formatDate(patch.releaseDate)}</td>
                      <td className="px-4 py-3">{renderApprovalBadge(patch)}</td>
                      <td className="px-4 py-3">{renderRowActions(patch)}</td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
          }
          cards={
            paginatedPatches.length === 0 ? (
              <DataCard>
                <p className="py-2 text-center text-sm text-muted-foreground">
                  {t('patchList.empty')}
                </p>
              </DataCard>
            ) : (
              paginatedPatches.map(patch => {
                const isSelected = selectedIds.has(patch.id);
                return (
                  <DataCard key={patch.id} className={isSelected ? 'bg-primary/5' : undefined}>
                    <div className="flex items-start gap-3">
                      <button
                        type="button"
                        onClick={() => toggleSelect(patch.id)}
                        className="mt-0.5 flex shrink-0 items-center justify-center text-muted-foreground hover:text-foreground"
                        aria-label={
                          isSelected
                            ? t('patchList.selection.deselectPatch', { title: patch.title })
                            : t('patchList.selection.selectPatch', { title: patch.title })
                        }
                      >
                        {isSelected ? (
                          <CheckSquare className="h-4 w-4 text-primary" />
                        ) : (
                          <Square className="h-4 w-4" />
                        )}
                      </button>
                      <div className="min-w-0 flex-1">{renderTitleCell(patch)}</div>
                    </div>
                    <div className="mt-3 space-y-2 border-t pt-3">
                      <CardField label={t('patchList.table.severity')}>{renderSeverityBadge(patch)}</CardField>
                      <CardField label={t('patchList.table.source')}>
                        <span className="text-muted-foreground">{patch.source}</span>
                      </CardField>
                      <CardField label={t('patchList.table.os')}>
                        <span className="text-muted-foreground">{patch.os}</span>
                      </CardField>
                      <CardField label={t('patchList.table.release')}>
                        <span className="text-muted-foreground">{formatDate(patch.releaseDate)}</span>
                      </CardField>
                      <CardField label={t('patchList.table.approval')}>{renderApprovalBadge(patch)}</CardField>
                    </div>
                    <CardActions>{renderRowActions(patch)}</CardActions>
                  </DataCard>
                );
              })
            )
          }
        />
      )}

      {!loading && !(error && patches.length === 0) && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
          <div className="flex items-center gap-2">
            <label htmlFor="patch-page-size" className="whitespace-nowrap">
              {t('patchList.pagination.rowsPerPage')}
            </label>
            <select
              id="patch-page-size"
              data-testid="patch-page-size"
              value={pageSize}
              onChange={event => {
                setPageSize(Number(event.target.value));
                setCurrentPage(1);
              }}
              className="h-8 rounded-md border bg-background px-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
            >
              {PAGE_SIZE_OPTIONS.map(size => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
          </div>
          {totalPages > 1 && (
            <div className="flex items-center gap-3">
              <span>
                {t('patchList.pagination.pageStatus', { current: currentPage, total: totalPages })}
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setCurrentPage(prev => Math.max(prev - 1, 1))}
                  disabled={currentPage === 1}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-md border disabled:opacity-50"
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => setCurrentPage(prev => Math.min(prev + 1, totalPages))}
                  disabled={currentPage === totalPages}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-md border disabled:opacity-50"
                >
                  <ChevronRight className="h-4 w-4" />
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
