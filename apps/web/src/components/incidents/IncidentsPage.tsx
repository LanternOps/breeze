import { useState, useEffect, useCallback } from 'react';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import { formatDateTime } from '@/lib/dateTimeFormat';

type IncidentSeverity = 'p1' | 'p2' | 'p3' | 'p4';
type IncidentKind = 'tracked' | 'finding';
type IncidentSource = 'breeze' | 'huntress' | 's1';
type FeedFilter = '' | IncidentKind;

interface IncidentFeedRow {
  kind: IncidentKind;
  source: IncidentSource;
  sourceId: string;
  title: string;
  severity: IncidentSeverity;
  edrStatus: string | null;
  status: string | null;
  deviceId: string | null;
  detectedAt: string;
  trackedIncidentId: string | null;
}

interface Pagination {
  page: number;
  limit: number;
  total: number;
}

const severityColors: Record<IncidentSeverity, string> = {
  p1: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300',
  p2: 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300',
  p3: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300',
  p4: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
};

const sourceLabels: Record<IncidentSource, string> = {
  breeze: 'Breeze',
  huntress: 'Huntress',
  s1: 'SentinelOne',
};

const sourceBadge: Record<IncidentSource, string> = {
  breeze: 'bg-gray-100 text-gray-800 dark:bg-gray-700/40 dark:text-gray-200',
  huntress: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300',
  s1: 'bg-violet-100 text-violet-800 dark:bg-violet-900/30 dark:text-violet-300',
};

const statusBadge = 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300';

export default function IncidentsPage() {
  const [rows, setRows] = useState<IncidentFeedRow[]>([]);
  const [pagination, setPagination] = useState<Pagination>({ page: 1, limit: 25, total: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [kindFilter, setKindFilter] = useState<FeedFilter>('');
  const [severityFilter, setSeverityFilter] = useState<IncidentSeverity | ''>('');

  const fetchFeed = useCallback(async (page = 1) => {
    try {
      setLoading(true);
      setError(undefined);
      const params = new URLSearchParams({ page: String(page), limit: '25' });
      if (kindFilter) params.set('kind', kindFilter);

      const response = await fetchWithAuth(`/incidents/feed?${params.toString()}`);
      if (!response.ok) {
        if (response.status === 401) {
          void navigateTo('/login', { replace: true });
          return;
        }
        throw new Error('Failed to fetch incidents');
      }
      const data = await response.json();
      setRows(data.data ?? []);
      setPagination(data.pagination ?? { page: 1, limit: 25, total: 0 });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, [kindFilter]);

  useEffect(() => {
    fetchFeed();
  }, [fetchFeed]);

  const handleRowClick = (row: IncidentFeedRow) => {
    if (row.kind === 'tracked' && row.trackedIncidentId) {
      void navigateTo(`/incidents/${row.trackedIncidentId}`);
    }
  };

  const handlePrevious = () => {
    if (pagination.page > 1) fetchFeed(pagination.page - 1);
  };

  const handleNext = () => {
    const totalPages = Math.ceil(pagination.total / pagination.limit);
    if (pagination.page < totalPages) fetchFeed(pagination.page + 1);
  };

  // Client-side severity narrowing — the feed endpoint does not support a severity param.
  const visibleRows = severityFilter ? rows.filter((r) => r.severity === severityFilter) : rows;

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent mx-auto" />
          <p className="mt-4 text-sm text-muted-foreground">Loading incidents...</p>
        </div>
      </div>
    );
  }

  if (error && rows.length === 0) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <button
          type="button"
          onClick={() => fetchFeed()}
          className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          Try again
        </button>
      </div>
    );
  }

  const totalPages = Math.ceil(pagination.total / pagination.limit);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Incidents</h1>
          <p className="text-muted-foreground">
            Tracked incidents and EDR findings across your organization.
          </p>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Filters */}
      <div className="flex gap-3">
        <select
          value={kindFilter}
          onChange={(e) => setKindFilter(e.target.value as FeedFilter)}
          className="rounded-md border bg-background px-3 py-2 text-sm text-foreground"
        >
          <option value="">All</option>
          <option value="tracked">Tracked</option>
          <option value="finding">Findings</option>
        </select>
        <select
          value={severityFilter}
          onChange={(e) => setSeverityFilter(e.target.value as IncidentSeverity | '')}
          className="rounded-md border bg-background px-3 py-2 text-sm text-foreground"
        >
          <option value="">All severities</option>
          <option value="p1">P1 - Critical</option>
          <option value="p2">P2 - High</option>
          <option value="p3">P3 - Medium</option>
          <option value="p4">P4 - Low</option>
        </select>
      </div>

      {visibleRows.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <h2 className="text-lg font-semibold text-foreground mb-1">No incidents found</h2>
          <p className="text-sm text-muted-foreground max-w-md">
            {kindFilter || severityFilter
              ? 'No incidents match the current filters.'
              : 'No tracked incidents or EDR findings have been recorded yet.'}
          </p>
        </div>
      ) : (
        <>
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">Title</th>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">Source</th>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">Severity</th>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">Status</th>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">Detected</th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((row) => {
                  const isTracked = row.kind === 'tracked';
                  return (
                    <tr
                      key={`${row.source}:${row.sourceId}`}
                      onClick={() => handleRowClick(row)}
                      className={`border-b transition-colors ${
                        isTracked ? 'cursor-pointer hover:bg-muted/30' : ''
                      }`}
                    >
                      <td className="px-4 py-3 font-medium text-foreground">{row.title}</td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${sourceBadge[row.source]}`}>
                          {sourceLabels[row.source]}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${severityColors[row.severity]}`}>
                          {row.severity.toUpperCase()}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        {isTracked ? (
                          row.status ? (
                            <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium capitalize ${statusBadge}`}>
                              {row.status}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">-</span>
                          )
                        ) : (
                          <div className="flex flex-col gap-0.5">
                            <span className="capitalize text-muted-foreground">{row.edrStatus ?? '-'}</span>
                            <span className="text-xs text-muted-foreground">Promote from the EDR view</span>
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {formatDateTime(row.detectedAt)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">
                Page {pagination.page} of {totalPages} ({pagination.total} total)
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={handlePrevious}
                  disabled={pagination.page <= 1}
                  className="rounded-md border px-3 py-1.5 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed hover:bg-muted"
                >
                  Previous
                </button>
                <button
                  type="button"
                  onClick={handleNext}
                  disabled={pagination.page >= totalPages}
                  className="rounded-md border px-3 py-1.5 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed hover:bg-muted"
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
