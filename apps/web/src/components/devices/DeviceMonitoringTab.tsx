import { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, RefreshCw } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';

type WatchResult = {
  id: string;
  deviceId: string;
  watchType: 'service' | 'process' | string;
  name: string;
  status: 'running' | 'stopped' | 'not_found' | 'error' | string;
  cpuPercent?: number | null;
  memoryMb?: number | null;
  pid?: number | null;
  autoRestartAttempted?: boolean | null;
  autoRestartSucceeded?: boolean | null;
  timestamp: string;
};

type DeviceMonitoringTabProps = {
  deviceId: string;
  timezone?: string;
};

const STATUS_STYLES: Record<string, string> = {
  running: 'bg-success/15 text-success border-success/30',
  stopped: 'bg-destructive/15 text-destructive border-destructive/30',
  not_found: 'bg-warning/15 text-warning border-warning/30',
  error: 'bg-destructive/15 text-destructive border-destructive/30',
};

const STATUS_LABELS: Record<string, string> = {
  running: 'Running',
  stopped: 'Stopped',
  not_found: 'Not found',
  error: 'Error',
};

function formatTimestamp(value: string, timezone?: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString([], timezone ? { timeZone: timezone } : undefined);
}

export default function DeviceMonitoringTab({ deviceId, timezone }: DeviceMonitoringTabProps) {
  const [results, setResults] = useState<WatchResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const fetchResults = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const response = await fetchWithAuth(`/monitoring/results/${deviceId}/summary`);
      if (!response.ok) throw new Error('Failed to load monitoring results');
      const json = await response.json();
      setResults(Array.isArray(json?.data) ? json.data : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load monitoring results');
    } finally {
      setLoading(false);
    }
  }, [deviceId]);

  useEffect(() => {
    fetchResults();
  }, [fetchResults]);

  const rows = useMemo(
    () =>
      [...results].sort((a, b) => {
        // Surface not-running watches first, then alphabetical by name.
        const aBad = a.status !== 'running' ? 0 : 1;
        const bBad = b.status !== 'running' ? 0 : 1;
        if (aBad !== bBad) return aBad - bBad;
        return (a.name ?? '').localeCompare(b.name ?? '');
      }),
    [results]
  );

  if (loading) {
    return (
      <div
        data-testid="device-monitoring-loading"
        className="flex items-center justify-center rounded-lg border bg-card py-12 shadow-xs"
      >
        <div className="text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <p className="mt-3 text-sm text-muted-foreground">Loading monitoring results...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div
        data-testid="device-monitoring-error"
        className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center"
      >
        <p className="text-sm text-destructive">{error}</p>
        <button
          type="button"
          onClick={fetchResults}
          className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div data-testid="device-monitoring-tab" className="rounded-lg border bg-card p-6 shadow-xs">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-lg font-semibold">Service &amp; Process Monitoring</h3>
          <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">{rows.length}</span>
        </div>
        <button
          type="button"
          onClick={fetchResults}
          className="flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Refresh
        </button>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        Latest result for each service/process watch configured by an assigned Configuration Policy.
      </p>

      <div className="mt-4 overflow-hidden rounded-md border">
        <div className="max-h-[500px] overflow-auto">
          <table className="min-w-full divide-y">
            <thead className="bg-muted/40 sticky top-0">
              <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Type</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">CPU</th>
                <th className="px-4 py-3">Memory</th>
                <th className="px-4 py-3">PID</th>
                <th className="px-4 py-3">Last Checked</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.length === 0 ? (
                <tr>
                  <td
                    colSpan={7}
                    data-testid="device-monitoring-empty"
                    className="px-4 py-6 text-center text-sm text-muted-foreground"
                  >
                    No monitoring results reported. Assign a Configuration Policy with service/process
                    watches to this device, or wait for the next check interval.
                  </td>
                </tr>
              ) : (
                rows.map((row) => (
                  <tr key={row.id} data-testid="device-monitoring-row" className="text-sm hover:bg-muted/30">
                    <td className="px-4 py-3 font-medium">{row.name}</td>
                    <td className="px-4 py-3 capitalize text-muted-foreground">{row.watchType}</td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${
                          STATUS_STYLES[row.status] ?? 'bg-muted text-muted-foreground border-border'
                        }`}
                      >
                        {STATUS_LABELS[row.status] ?? row.status}
                      </span>
                      {row.autoRestartAttempted ? (
                        <span className="ml-2 text-xs text-muted-foreground">
                          {row.autoRestartSucceeded ? 'auto-restarted' : 'restart failed'}
                        </span>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 tabular-nums text-muted-foreground">
                      {typeof row.cpuPercent === 'number' ? `${row.cpuPercent.toFixed(1)}%` : '—'}
                    </td>
                    <td className="px-4 py-3 tabular-nums text-muted-foreground">
                      {typeof row.memoryMb === 'number' ? `${row.memoryMb.toFixed(0)} MB` : '—'}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{row.pid ?? '—'}</td>
                    <td className="px-4 py-3 whitespace-nowrap text-muted-foreground">
                      {formatTimestamp(row.timestamp, timezone)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
