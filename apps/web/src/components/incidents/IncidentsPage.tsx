import { useState, useEffect, useCallback } from 'react';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';

type IncidentSeverity = 'p1' | 'p2' | 'p3' | 'p4';
type IncidentStatus = 'detected' | 'analyzing' | 'contained' | 'recovering' | 'closed';

interface Incident {
  id: string;
  title: string;
  severity: IncidentSeverity;
  status: IncidentStatus;
  classification: string | null;
  detectedAt: string;
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

const statusColors: Record<IncidentStatus, string> = {
  detected: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300',
  analyzing: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300',
  contained: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
  recovering: 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300',
  closed: 'bg-gray-100 text-gray-800 dark:bg-gray-700/30 dark:text-gray-300',
};

export default function IncidentsPage() {
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [pagination, setPagination] = useState<Pagination>({ page: 1, limit: 25, total: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [statusFilter, setStatusFilter] = useState<IncidentStatus | ''>('');
  const [severityFilter, setSeverityFilter] = useState<IncidentSeverity | ''>('');

  const fetchIncidents = useCallback(async (page = 1) => {
    try {
      setLoading(true);
      setError(undefined);
      const params = new URLSearchParams({ page: String(page), limit: '25' });
      if (statusFilter) params.set('status', statusFilter);
      if (severityFilter) params.set('severity', severityFilter);

      const response = await fetchWithAuth(`/incidents?${params.toString()}`);
      if (!response.ok) {
        if (response.status === 401) {
          void navigateTo('/login', { replace: true });
          return;
        }
        throw new Error('Failed to fetch incidents');
      }
      const data = await response.json();
      setIncidents(data.data ?? []);
      setPagination(data.pagination ?? { page: 1, limit: 25, total: 0 });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, [statusFilter, severityFilter]);

  useEffect(() => {
    fetchIncidents();
  }, [fetchIncidents]);

  const handleRowClick = (id: string) => {
    void navigateTo(`/incidents/${id}`);
  };

  const handlePrevious = () => {
    if (pagination.page > 1) fetchIncidents(pagination.page - 1);
  };

  const handleNext = () => {
    const totalPages = Math.ceil(pagination.total / pagination.limit);
    if (pagination.page < totalPages) fetchIncidents(pagination.page + 1);
  };

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

  if (error && incidents.length === 0) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <button
          type="button"
          onClick={() => fetchIncidents()}
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
            Security and operational incidents across your organization.
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
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as IncidentStatus | '')}
          className="rounded-md border bg-background px-3 py-2 text-sm text-foreground"
        >
          <option value="">All statuses</option>
          <option value="detected">Detected</option>
          <option value="analyzing">Analyzing</option>
          <option value="contained">Contained</option>
          <option value="recovering">Recovering</option>
          <option value="closed">Closed</option>
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

      {incidents.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <h2 className="text-lg font-semibold text-foreground mb-1">No incidents found</h2>
          <p className="text-sm text-muted-foreground max-w-md">
            {statusFilter || severityFilter
              ? 'No incidents match the current filters.'
              : 'No incidents have been recorded yet.'}
          </p>
        </div>
      ) : (
        <>
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">Title</th>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">Severity</th>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">Status</th>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">Classification</th>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">Detected</th>
                </tr>
              </thead>
              <tbody>
                {incidents.map((incident) => (
                  <tr
                    key={incident.id}
                    onClick={() => handleRowClick(incident.id)}
                    className="border-b cursor-pointer hover:bg-muted/30 transition-colors"
                  >
                    <td className="px-4 py-3 font-medium text-foreground">{incident.title}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${severityColors[incident.severity]}`}>
                        {incident.severity.toUpperCase()}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium capitalize ${statusColors[incident.status]}`}>
                        {incident.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {incident.classification ?? '-'}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {new Date(incident.detectedAt).toLocaleString()}
                    </td>
                  </tr>
                ))}
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
