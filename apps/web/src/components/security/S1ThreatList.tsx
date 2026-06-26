import { useCallback, useEffect, useState } from 'react';
import { Filter, Loader2, RefreshCw, Search } from 'lucide-react';

import { navigateTo } from '@/lib/navigation';
import { cn, friendlyFetchError } from '../../lib/utils';
import { handleActionError } from '../../lib/runAction';
import { fetchS1Threats, runS1ThreatAction, type S1Threat, type S1ThreatActionType } from '../../lib/edr';
import { formatDateTime } from '../../lib/dateTimeFormat';
import { ResponsiveTable, DataCard, CardField } from '../shared/ResponsiveTable';

const severityBadge: Record<string, string> = {
  low: 'bg-blue-500/20 text-blue-700 border-blue-500/30',
  medium: 'bg-yellow-500/20 text-yellow-800 border-yellow-500/40',
  high: 'bg-orange-500/20 text-orange-700 border-orange-500/40',
  critical: 'bg-red-500/20 text-red-700 border-red-500/40',
};

const statusBadge: Record<string, string> = {
  active: 'bg-red-500/15 text-red-700 border-red-500/30',
  in_progress: 'bg-blue-500/15 text-blue-700 border-blue-500/30',
  quarantined: 'bg-amber-500/20 text-amber-800 border-amber-500/40',
  resolved: 'bg-emerald-500/20 text-emerald-700 border-emerald-500/40',
};

function badgeClass(value: string | null | undefined, classes: Record<string, string>): string {
  return classes[(value ?? '').toLowerCase()] ?? 'bg-muted text-muted-foreground border-border';
}

function formatDetected(value: string | null): string {
  if (!value) return '-';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '-' : formatDateTime(date);
}

function toStartIso(value: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function toEndIso(value: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  date.setHours(23, 59, 59, 999);
  return date.toISOString();
}

export default function S1ThreatList() {
  const [query, setQuery] = useState('');
  const [severityFilter, setSeverityFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [threats, setThreats] = useState<S1Threat[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [actingId, setActingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const result = await fetchS1Threats({
        limit: 100,
        search: query.trim() || undefined,
        severity: severityFilter === 'all' ? undefined : severityFilter,
        status: statusFilter === 'all' ? undefined : statusFilter,
        start: toStartIso(startDate),
        end: toEndIso(endDate),
      });
      setThreats(result.rows);
      setTotal(result.total);
    } catch (err) {
      setError(friendlyFetchError(err));
      setThreats([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [endDate, query, severityFilter, startDate, statusFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  const doThreatAction = async (threat: S1Threat, action: S1ThreatActionType) => {
    setActingId(threat.id);
    try {
      await runS1ThreatAction(threat.orgId, threat.id, action);
      await load();
    } catch (err) {
      handleActionError(err, `Failed to ${action} threat`);
    } finally {
      setActingId(null);
    }
  };

  const openDevice = (threat: S1Threat) => {
    if (threat.deviceId) navigateTo(`/devices/${threat.deviceId}`);
  };

  const renderSeverityBadge = (threat: S1Threat) => (
    <span className={cn('inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold', badgeClass(threat.severity, severityBadge))}>
      {threat.severity ?? 'unknown'}
    </span>
  );

  const renderStatusBadge = (threat: S1Threat) => (
    <span className={cn('inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold', badgeClass(threat.status, statusBadge))}>
      {threat.status}
    </span>
  );

  const renderActions = (threat: S1Threat) => {
    if (threat.status !== 'active') return <span className="text-xs text-muted-foreground">-</span>;
    return (
      <div className="flex flex-wrap items-center gap-2">
        {(['kill', 'quarantine', 'rollback'] as const).map((action) => (
          <button
            key={action}
            type="button"
            data-testid={`s1-threat-${action}-${threat.id}`}
            onClick={(event) => {
              event.stopPropagation();
              void doThreatAction(threat, action);
            }}
            disabled={actingId === threat.id}
            className="inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-xs font-medium capitalize hover:bg-muted disabled:opacity-60"
          >
            {actingId === threat.id && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {action}
          </button>
        ))}
      </div>
    );
  };

  return (
    <div className="rounded-lg border bg-card p-6 shadow-sm" data-testid="s1-list">
      {error && (
        <div
          className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          data-testid="s1-error"
        >
          {error}
        </div>
      )}

      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h2 className="text-lg font-semibold">SentinelOne Threats</h2>
          <p className="text-sm text-muted-foreground">
            {loading ? 'Loading fleet threats...' : `${total} threats match your filters`}
          </p>
        </div>
        <div className="flex flex-1 flex-col gap-2 lg:flex-row lg:items-center lg:justify-end">
          <div className="relative w-full lg:w-64">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              type="search"
              data-testid="s1-filter-search"
              placeholder="Search threats"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="h-10 w-full rounded-md border bg-background pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <select
              data-testid="s1-filter-severity"
              value={severityFilter}
              onChange={(event) => setSeverityFilter(event.target.value)}
              className="h-10 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="all">All severities</option>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="critical">Critical</option>
            </select>
            <select
              data-testid="s1-filter-status"
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value)}
              className="h-10 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="all">All statuses</option>
              <option value="active">Active</option>
              <option value="in_progress">In progress</option>
              <option value="quarantined">Quarantined</option>
              <option value="resolved">Resolved</option>
            </select>
            <div className="flex items-center gap-2 rounded-md border bg-background px-3 py-2 text-sm">
              <Filter className="h-4 w-4 text-muted-foreground" />
              <input
                type="date"
                aria-label="Start date"
                value={startDate}
                onChange={(event) => setStartDate(event.target.value)}
                className="bg-transparent text-sm focus:outline-none"
              />
              <span className="text-muted-foreground">to</span>
              <input
                type="date"
                aria-label="End date"
                value={endDate}
                onChange={(event) => setEndDate(event.target.value)}
                className="bg-transparent text-sm focus:outline-none"
              />
            </div>
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
                <th className="px-4 py-3">Threat</th>
                <th className="px-4 py-3">Severity</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Detected</th>
                <th className="px-4 py-3">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {loading ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-sm text-muted-foreground">
                    <span className="inline-flex items-center gap-2">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Loading SentinelOne threats...
                    </span>
                  </td>
                </tr>
              ) : threats.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-sm text-muted-foreground">
                    No SentinelOne threats found.
                  </td>
                </tr>
              ) : (
                threats.map((threat) => (
                  <tr
                    key={threat.id}
                    data-testid={`s1-row-${threat.id}`}
                    onClick={() => openDevice(threat)}
                    className={cn('text-sm transition hover:bg-muted/40', threat.deviceId && 'cursor-pointer')}
                  >
                    <td className="px-4 py-3 font-medium">{threat.deviceName ?? threat.deviceId ?? '-'}</td>
                    <td className="px-4 py-3">{threat.threatName ?? 'Unknown threat'}</td>
                    <td className="px-4 py-3">{renderSeverityBadge(threat)}</td>
                    <td className="px-4 py-3">{renderStatusBadge(threat)}</td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">{formatDetected(threat.detectedAt)}</td>
                    <td className="px-4 py-3" onClick={(event) => event.stopPropagation()}>
                      {renderActions(threat)}
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
                Loading SentinelOne threats...
              </p>
            </DataCard>
          ) : threats.length === 0 ? (
            <DataCard>
              <p className="py-2 text-center text-sm text-muted-foreground">No SentinelOne threats found.</p>
            </DataCard>
          ) : (
            threats.map((threat) => (
              <DataCard key={threat.id} onClick={threat.deviceId ? () => openDevice(threat) : undefined}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate font-semibold">{threat.threatName ?? 'Unknown threat'}</div>
                    <div className="truncate text-xs text-muted-foreground">{threat.deviceName ?? threat.deviceId ?? '-'}</div>
                  </div>
                  <div className="shrink-0">{renderSeverityBadge(threat)}</div>
                </div>
                <div className="mt-3 space-y-2 border-t pt-3">
                  <CardField label="Status">{renderStatusBadge(threat)}</CardField>
                  <CardField label="Detected">
                    <span className="text-xs text-muted-foreground">{formatDetected(threat.detectedAt)}</span>
                  </CardField>
                  <CardField label="Actions">
                    <div onClick={(event) => event.stopPropagation()}>{renderActions(threat)}</div>
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
