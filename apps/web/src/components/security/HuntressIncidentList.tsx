import { useCallback, useEffect, useState } from 'react';
import { Loader2, RefreshCw, Search } from 'lucide-react';

import { navigateTo } from '@/lib/navigation';
import { cn, friendlyFetchError } from '../../lib/utils';
import { fetchHuntressIncidents, type HuntressIncident } from '../../lib/edr';
import { promoteToIncident, huntressIncidentToIncident } from '../../lib/incidents';
import { handleActionError } from '../../lib/runAction';
import { formatDateTime } from '../../lib/dateTimeFormat';
import { ResponsiveTable, DataCard, CardField } from '../shared/ResponsiveTable';

const severityBadge: Record<string, string> = {
  low: 'bg-blue-500/20 text-blue-700 border-blue-500/30',
  medium: 'bg-yellow-500/20 text-yellow-800 border-yellow-500/40',
  high: 'bg-orange-500/20 text-orange-700 border-orange-500/40',
  critical: 'bg-red-500/20 text-red-700 border-red-500/40',
};

const statusBadge: Record<string, string> = {
  open: 'bg-red-500/15 text-red-700 border-red-500/30',
  in_progress: 'bg-blue-500/15 text-blue-700 border-blue-500/30',
  resolved: 'bg-emerald-500/20 text-emerald-700 border-emerald-500/40',
  dismissed: 'bg-muted text-muted-foreground border-border',
};

function badgeClass(value: string | null | undefined, classes: Record<string, string>): string {
  return classes[(value ?? '').toLowerCase()] ?? 'bg-muted text-muted-foreground border-border';
}

function formatReported(value: string | null): string {
  if (!value) return '-';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '-' : formatDateTime(date);
}

export default function HuntressIncidentList() {
  const [query, setQuery] = useState('');
  const [severityFilter, setSeverityFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [incidents, setIncidents] = useState<HuntressIncident[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [promotingId, setPromotingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const result = await fetchHuntressIncidents({
        limit: 100,
        search: query.trim() || undefined,
        severity: severityFilter === 'all' ? undefined : severityFilter,
        status: statusFilter === 'all' ? undefined : statusFilter,
      });
      setIncidents(result.rows);
      setTotal(result.total);
    } catch (err) {
      setError(friendlyFetchError(err));
      setIncidents([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [query, severityFilter, statusFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  const openDevice = (incident: HuntressIncident) => {
    if (incident.deviceId) navigateTo(`/devices/${incident.deviceId}`);
  };

  const promote = async (incident: HuntressIncident) => {
    setPromotingId(incident.id);
    try {
      const { id } = await promoteToIncident(huntressIncidentToIncident(incident));
      navigateTo(`/incidents/${id}`);
    } catch (err) {
      handleActionError(err, 'Failed to create incident');
    } finally {
      setPromotingId(null);
    }
  };

  const renderSeverityBadge = (incident: HuntressIncident) => (
    <span className={cn('inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold', badgeClass(incident.severity, severityBadge))}>
      {incident.severity ?? 'unknown'}
    </span>
  );

  const renderStatusBadge = (incident: HuntressIncident) => (
    <span className={cn('inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold', badgeClass(incident.status, statusBadge))}>
      {incident.status}
    </span>
  );

  const deviceLabel = (incident: HuntressIncident) => incident.deviceHostname ?? incident.deviceId ?? '-';

  const renderActions = (incident: HuntressIncident) => (
    <button
      type="button"
      data-testid={`huntress-promote-${incident.id}`}
      onClick={(event) => {
        event.stopPropagation();
        void promote(incident);
      }}
      disabled={promotingId === incident.id}
      className="inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-xs font-medium hover:bg-muted disabled:opacity-60"
    >
      {promotingId === incident.id && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
      Promote to Incident
    </button>
  );

  return (
    <div className="rounded-lg border bg-card p-6 shadow-xs" data-testid="huntress-list">
      {error && (
        <div
          className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          data-testid="huntress-error"
        >
          {error}
        </div>
      )}

      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h2 className="text-lg font-semibold">Huntress Incidents</h2>
          <p className="text-sm text-muted-foreground">
            {loading ? 'Loading fleet incidents...' : `${total} incidents match your filters`}
          </p>
        </div>
        <div className="flex flex-1 flex-col gap-2 lg:flex-row lg:items-center lg:justify-end">
          <div className="relative w-full lg:w-64">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              type="search"
              data-testid="huntress-filter-search"
              placeholder="Search incidents"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="h-10 w-full rounded-md border bg-background pl-9 pr-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <select
              data-testid="huntress-filter-severity"
              value={severityFilter}
              onChange={(event) => setSeverityFilter(event.target.value)}
              className="h-10 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
            >
              <option value="all">All severities</option>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="critical">Critical</option>
            </select>
            <select
              data-testid="huntress-filter-status"
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value)}
              className="h-10 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
            >
              <option value="all">All statuses</option>
              <option value="open">Open</option>
              <option value="in_progress">In progress</option>
              <option value="resolved">Resolved</option>
              <option value="dismissed">Dismissed</option>
            </select>
            <button
              type="button"
              onClick={() => void load()}
              className="inline-flex h-10 items-center gap-2 rounded-md border bg-background px-3 text-sm hover:bg-muted"
            >
              <RefreshCw className="h-4 w-4" />
              Refresh
            </button>
          </div>
        </div>
      </div>

      <ResponsiveTable
        className="mt-6"
        table={
          <table className="min-w-full divide-y">
            <thead className="bg-muted/40">
              <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-3">Device</th>
                <th className="px-4 py-3">Title</th>
                <th className="px-4 py-3">Category</th>
                <th className="px-4 py-3">Severity</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Reported</th>
                <th className="px-4 py-3">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {loading ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-sm text-muted-foreground">
                    <span className="inline-flex items-center gap-2">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Loading Huntress incidents...
                    </span>
                  </td>
                </tr>
              ) : incidents.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-sm text-muted-foreground">
                    No Huntress incidents found.
                  </td>
                </tr>
              ) : (
                incidents.map((incident) => (
                  <tr
                    key={incident.id}
                    data-testid={`huntress-row-${incident.id}`}
                    onClick={() => openDevice(incident)}
                    className={cn('text-sm transition hover:bg-muted/40', incident.deviceId && 'cursor-pointer')}
                  >
                    <td className="px-4 py-3 font-medium">{deviceLabel(incident)}</td>
                    <td className="px-4 py-3">{incident.title}</td>
                    <td className="px-4 py-3">{incident.category ?? '-'}</td>
                    <td className="px-4 py-3">{renderSeverityBadge(incident)}</td>
                    <td className="px-4 py-3">{renderStatusBadge(incident)}</td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">{formatReported(incident.reportedAt)}</td>
                    <td className="px-4 py-3" onClick={(event) => event.stopPropagation()}>
                      {renderActions(incident)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        }
        cards={
          loading ? (
            <DataCard>
              <p className="inline-flex items-center justify-center gap-2 py-2 text-center text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading Huntress incidents...
              </p>
            </DataCard>
          ) : incidents.length === 0 ? (
            <DataCard>
              <p className="py-2 text-center text-sm text-muted-foreground">No Huntress incidents found.</p>
            </DataCard>
          ) : (
            incidents.map((incident) => (
              <DataCard key={incident.id} onClick={incident.deviceId ? () => openDevice(incident) : undefined}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate font-semibold">{incident.title}</div>
                    <div className="truncate text-xs text-muted-foreground">{deviceLabel(incident)}</div>
                  </div>
                  <div className="shrink-0">{renderSeverityBadge(incident)}</div>
                </div>
                <div className="mt-3 space-y-2 border-t pt-3">
                  <CardField label="Category">
                    <span>{incident.category ?? '-'}</span>
                  </CardField>
                  <CardField label="Status">{renderStatusBadge(incident)}</CardField>
                  <CardField label="Reported">
                    <span className="text-xs text-muted-foreground">{formatReported(incident.reportedAt)}</span>
                  </CardField>
                  <CardField label="Actions">
                    <div onClick={(event) => event.stopPropagation()}>{renderActions(incident)}</div>
                  </CardField>
                </div>
              </DataCard>
            ))
          )
        }
      />
    </div>
  );
}
