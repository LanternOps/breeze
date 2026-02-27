import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowUpDown,
  ChevronDown,
  ChevronUp,
  Eye,
  Filter,
  Globe,
  List,
  Server,
  ShieldCheck,
  User,
  X
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { fetchWithAuth } from '../../stores/auth';
import AuditLogDetail, { type AuditLogEntry } from './AuditLogDetail';
import AuditFilters from './AuditFilters';

type SortKey = 'timestamp' | 'user' | 'action' | 'resource' | 'details' | 'ipAddress';

type SortConfig = {
  key: SortKey;
  direction: 'asc' | 'desc';
};

type DatePreset = 'today' | '7d' | '30d' | 'custom';

type ActiveFilters = {
  datePreset: DatePreset;
  startDate?: string;
  endDate?: string;
  userId?: string;
  userEmail?: string;
  actions: string[];
  resources: string[];
  search: string;
};

const actionStyles: Record<string, string> = {
  login: 'bg-emerald-100 text-emerald-700 border-emerald-200',
  update: 'bg-blue-100 text-blue-700 border-blue-200',
  delete: 'bg-rose-100 text-rose-700 border-rose-200',
  create: 'bg-indigo-100 text-indigo-700 border-indigo-200',
  export: 'bg-amber-100 text-amber-700 border-amber-200',
  access: 'bg-slate-100 text-slate-700 border-slate-200'
};

const columnLabels: Record<SortKey, string> = {
  timestamp: 'Timestamp',
  user: 'User',
  action: 'Action',
  resource: 'Resource',
  details: 'Details',
  ipAddress: 'IP'
};

const getSortValue = (entry: AuditLogEntry, key: SortKey) => {
  switch (key) {
    case 'timestamp':
      return new Date(entry.timestamp).getTime();
    case 'user':
      return entry.user.name.toLowerCase();
    case 'action':
      return entry.action.toLowerCase();
    case 'resource':
      return entry.resource.toLowerCase();
    case 'details':
      return entry.details.toLowerCase();
    case 'ipAddress':
      return entry.ipAddress;
    default:
      return '';
  }
};

function computeDateRange(filters: ActiveFilters): { from?: string; to?: string } {
  const now = new Date();
  const to = now.toISOString();
  switch (filters.datePreset) {
    case 'today': {
      const start = new Date(now);
      start.setHours(0, 0, 0, 0);
      return { from: start.toISOString(), to };
    }
    case '7d': {
      const start = new Date(now);
      start.setDate(start.getDate() - 7);
      return { from: start.toISOString(), to };
    }
    case '30d': {
      const start = new Date(now);
      start.setDate(start.getDate() - 30);
      return { from: start.toISOString(), to };
    }
    case 'custom': {
      const result: { from?: string; to?: string } = {};
      if (filters.startDate) result.from = new Date(filters.startDate).toISOString();
      if (filters.endDate) {
        const end = new Date(filters.endDate);
        end.setHours(23, 59, 59, 999);
        result.to = end.toISOString();
      }
      return result;
    }
    default:
      return {};
  }
}

function hasActiveFilters(filters: ActiveFilters | null): boolean {
  if (!filters) return false;
  return !!(
    filters.userEmail ||
    filters.actions.length > 0 ||
    filters.resources.length > 0 ||
    filters.search
  );
}

interface AuditLogViewerProps {
  timezone?: string;
}

export default function AuditLogViewer({ timezone }: AuditLogViewerProps) {
  const [entries, setEntries] = useState<AuditLogEntry[]>([]);
  const [sortConfig, setSortConfig] = useState<SortConfig>({
    key: 'timestamp',
    direction: 'desc'
  });
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [totalCount, setTotalCount] = useState(0);
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const [selectedEntry, setSelectedEntry] = useState<AuditLogEntry | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showFilters, setShowFilters] = useState(false);
  const [activeFilters, setActiveFilters] = useState<ActiveFilters | null>(null);

  const pageSize = 25;

  const fetchAuditLogs = useCallback(async (page: number, filters: ActiveFilters | null) => {
    setIsLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams();
      params.set('page', String(page));
      params.set('limit', String(pageSize));

      if (filters) {
        const { from, to } = computeDateRange(filters);
        if (from) params.set('from', from);
        if (to) params.set('to', to);
        if (filters.userEmail) params.set('user', filters.userEmail);
        if (filters.actions.length > 0) params.set('action', filters.actions.join(','));
        if (filters.resources.length > 0) params.set('resource', filters.resources.join(','));
        if (filters.search) params.set('q', filters.search);
      }

      const endpoint = params.has('q') ? '/audit-logs/search' : '/audit-logs';
      const response = await fetchWithAuth(`${endpoint}?${params.toString()}`);

      if (response.status === 401) {
        window.location.href = '/login';
        return;
      }

      if (!response.ok) {
        throw new Error('Failed to fetch audit logs');
      }

      const data = await response.json();
      setEntries(data.entries || data.data || data.logs || []);
      if (data.pagination) {
        setTotalPages(data.pagination.totalPages || 1);
        setTotalCount(data.pagination.total || 0);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load audit logs');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAuditLogs(currentPage, activeFilters);
  }, [fetchAuditLogs, currentPage, activeFilters]);

  const sortedEntries = useMemo(() => {
    const sorted = [...entries];
    sorted.sort((a, b) => {
      const first = getSortValue(a, sortConfig.key);
      const second = getSortValue(b, sortConfig.key);
      if (first < second) return sortConfig.direction === 'asc' ? -1 : 1;
      if (first > second) return sortConfig.direction === 'asc' ? 1 : -1;
      return 0;
    });
    return sorted;
  }, [entries, sortConfig]);

  const handleSort = (key: SortKey) => {
    setSortConfig(prev => {
      if (prev.key === key) {
        return { key, direction: prev.direction === 'asc' ? 'desc' : 'asc' };
      }
      return { key, direction: 'asc' };
    });
  };

  const handleApplyFilters = (filters: ActiveFilters) => {
    setActiveFilters(filters);
    setCurrentPage(1);
    setShowFilters(false);
  };

  const handleClearFilters = () => {
    setActiveFilters(null);
    setCurrentPage(1);
  };

  const toggleExpanded = (id: string) => {
    setExpandedRows(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const renderSortIcon = (key: SortKey) => {
    if (sortConfig.key !== key) {
      return <ArrowUpDown className="h-4 w-4 text-muted-foreground" />;
    }
    return sortConfig.direction === 'asc' ? (
      <ChevronUp className="h-4 w-4 text-foreground" />
    ) : (
      <ChevronDown className="h-4 w-4 text-foreground" />
    );
  };

  const handleExportLogs = async () => {
    try {
      const response = await fetchWithAuth('/audit-logs/export');

      if (response.status === 401) {
        window.location.href = '/login';
        return;
      }

      if (response.ok) {
        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `audit-logs-${new Date().toISOString().split('T')[0]}.csv`;
        a.click();
        window.URL.revokeObjectURL(url);
      }
    } catch {
      // Handle error silently or show notification
    }
  };

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold">Audit Log</h1>
            <p className="text-muted-foreground">
              Track user actions, sensitive operations, and system changes.
            </p>
          </div>
        </div>
        <div className="overflow-hidden rounded-lg border bg-card">
          <div className="flex h-48 items-center justify-center">
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold">Audit Log</h1>
            <p className="text-muted-foreground">
              Track user actions, sensitive operations, and system changes.
            </p>
          </div>
        </div>
        <div className="overflow-hidden rounded-lg border bg-card">
          <div className="flex h-48 flex-col items-center justify-center gap-2 text-muted-foreground">
            <p>{error}</p>
            <button
              type="button"
              onClick={() => fetchAuditLogs(currentPage, activeFilters)}
              className="text-sm text-primary hover:underline"
            >
              Try again
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Audit Log</h1>
          <p className="text-muted-foreground">
            Track user actions, sensitive operations, and system changes.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowFilters(prev => !prev)}
            className={cn(
              'inline-flex h-10 items-center gap-2 rounded-md border px-4 text-sm font-medium',
              showFilters || hasActiveFilters(activeFilters)
                ? 'border-primary bg-primary/10 text-primary'
                : 'bg-background text-muted-foreground hover:text-foreground'
            )}
          >
            <Filter className="h-4 w-4" />
            Filters
            {hasActiveFilters(activeFilters) && (
              <span className="ml-1 inline-flex h-5 w-5 items-center justify-center rounded-full bg-primary text-xs text-primary-foreground">
                {(activeFilters!.actions.length > 0 ? 1 : 0) +
                  (activeFilters!.resources.length > 0 ? 1 : 0) +
                  (activeFilters!.userEmail ? 1 : 0) +
                  (activeFilters!.search ? 1 : 0)}
              </span>
            )}
          </button>
          {hasActiveFilters(activeFilters) && (
            <button
              type="button"
              onClick={handleClearFilters}
              className="inline-flex h-10 items-center gap-1.5 rounded-md border border-rose-200 bg-rose-50 px-3 text-sm font-medium text-rose-600 hover:bg-rose-100"
            >
              <X className="h-3.5 w-3.5" />
              Clear
            </button>
          )}
          <button
            type="button"
            onClick={handleExportLogs}
            className="inline-flex h-10 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            <List className="h-4 w-4" />
            Export Logs
          </button>
        </div>
      </div>

      {showFilters && (
        <AuditFilters
          onApply={handleApplyFilters}
          onClear={handleClearFilters}
        />
      )}

      <div className="overflow-hidden rounded-lg border bg-card">
        <table className="min-w-full divide-y">
          <thead className="bg-muted/40">
            <tr>
              {Object.entries(columnLabels).map(([key, label]) => (
                <th key={key} className="px-4 py-3 text-left text-xs font-semibold uppercase">
                  <button
                    type="button"
                    onClick={() => handleSort(key as SortKey)}
                    className="inline-flex items-center gap-2 text-muted-foreground hover:text-foreground"
                  >
                    {label}
                    {renderSortIcon(key as SortKey)}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y">
            {sortedEntries.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-sm text-muted-foreground">
                  No audit logs found.
                </td>
              </tr>
            ) : (
              sortedEntries.map(entry => {
                const isExpanded = expandedRows.has(entry.id);
                const badgeClass = actionStyles[entry.action] ?? actionStyles.access;
                return (
                  <Fragment key={entry.id}>
                    <tr className="hover:bg-muted/30">
                      <td className="px-4 py-4 text-sm">
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => toggleExpanded(entry.id)}
                            className="inline-flex h-6 w-6 items-center justify-center rounded-md border text-muted-foreground hover:text-foreground"
                          >
                            <ChevronDown
                              className={cn(
                                'h-4 w-4 transition-transform',
                                isExpanded ? 'rotate-180' : 'rotate-0'
                              )}
                            />
                          </button>
                          <div>
                            <p className="font-medium text-foreground">
                              {new Date(entry.timestamp).toLocaleString([], { timeZone: timezone })}
                            </p>
                            <p className="text-xs text-muted-foreground">{entry.resourceType}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-4 text-sm">
                        <div className="flex items-center gap-2">
                          <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-muted">
                            <User className="h-4 w-4 text-muted-foreground" />
                          </span>
                          <div>
                            <p className="font-medium text-foreground">{entry.user.name}</p>
                            <p className="text-xs text-muted-foreground">{entry.user.email}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-4 text-sm">
                        <span
                          className={cn(
                            'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium',
                            badgeClass
                          )}
                        >
                          <ShieldCheck className="h-3.5 w-3.5" />
                          {entry.action}
                        </span>
                      </td>
                      <td className="px-4 py-4 text-sm">
                        <div className="flex items-center gap-2">
                          <Server className="h-4 w-4 text-muted-foreground" />
                          <span className="font-medium text-foreground">{entry.resource}</span>
                        </div>
                      </td>
                      <td className="px-4 py-4 text-sm">
                        <div className="flex flex-col gap-2">
                          <p className="max-w-[220px] truncate text-muted-foreground">{entry.details}</p>
                          <button
                            type="button"
                            onClick={() => setSelectedEntry(entry)}
                            className="inline-flex items-center gap-1 text-xs font-semibold text-primary hover:underline"
                          >
                            <Eye className="h-3.5 w-3.5" />
                            View details
                          </button>
                        </div>
                      </td>
                      <td className="px-4 py-4 text-sm text-muted-foreground">
                        <span className="flex items-center gap-2">
                        <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-muted">
                          <Globe className="h-3.5 w-3.5 text-muted-foreground" />
                        </span>
                        {entry.ipAddress}
                      </span>
                    </td>
                    </tr>
                    {isExpanded && (
                      <tr className="bg-muted/20">
                        <td colSpan={6} className="px-4 pb-4 pt-2 text-sm text-muted-foreground">
                          <div className="grid gap-4 lg:grid-cols-3">
                            <div className="rounded-md border bg-background p-3">
                              <p className="text-xs font-semibold uppercase text-muted-foreground">
                                Full Details
                              </p>
                              <p className="mt-2 text-sm text-foreground">{entry.details}</p>
                            </div>
                            <div className="rounded-md border bg-background p-3">
                              <p className="text-xs font-semibold uppercase text-muted-foreground">
                                Session
                              </p>
                              <p className="mt-2 text-sm text-foreground">{entry.sessionId}</p>
                              <p className="mt-1 text-xs text-muted-foreground">{entry.userAgent}</p>
                            </div>
                            <div className="rounded-md border bg-background p-3">
                              <p className="text-xs font-semibold uppercase text-muted-foreground">
                                Changes
                              </p>
                              <p className="mt-2 text-sm text-foreground">
                                {Object.keys(entry.changes?.after || {}).length} fields updated
                              </p>
                              <button
                                type="button"
                                onClick={() => setSelectedEntry(entry)}
                                className="mt-2 text-xs font-semibold text-primary hover:underline"
                              >
                                Review full snapshot
                              </button>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {totalCount > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="text-sm text-muted-foreground">
            Showing {(currentPage - 1) * pageSize + 1}-{Math.min(currentPage * pageSize, totalCount)} of{' '}
            {totalCount}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setCurrentPage(prev => Math.max(1, prev - 1))}
              disabled={currentPage === 1}
              className="h-9 rounded-md border px-3 text-sm font-medium text-muted-foreground transition hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
            >
              Previous
            </button>
            {Array.from({ length: Math.min(totalPages, 7) }, (_, index) => {
              let page: number;
              if (totalPages <= 7) {
                page = index + 1;
              } else if (currentPage <= 4) {
                page = index + 1;
              } else if (currentPage >= totalPages - 3) {
                page = totalPages - 6 + index;
              } else {
                page = currentPage - 3 + index;
              }
              return (
                <button
                  key={page}
                  type="button"
                  onClick={() => setCurrentPage(page)}
                  className={cn(
                    'h-9 w-9 rounded-md border text-sm font-medium',
                    currentPage === page
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  {page}
                </button>
              );
            })}
            <button
              type="button"
              onClick={() => setCurrentPage(prev => Math.min(totalPages, prev + 1))}
              disabled={currentPage === totalPages}
              className="h-9 rounded-md border px-3 text-sm font-medium text-muted-foreground transition hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
            >
              Next
            </button>
          </div>
        </div>
      )}

      {selectedEntry && (
        <AuditLogDetail
          entry={selectedEntry}
          isOpen={Boolean(selectedEntry)}
          onClose={() => setSelectedEntry(null)}
        />
      )}
    </div>
  );
}
