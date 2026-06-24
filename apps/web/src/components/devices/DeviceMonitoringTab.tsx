import { useState, useEffect, useCallback } from 'react';
import { Activity, AlertTriangle, RefreshCw } from 'lucide-react';
import { formatDateTime as formatUserDateTime } from '@/lib/dateTimeFormat';
import { fetchWithAuth } from '../../stores/auth';

type CheckResult = {
  id: string;
  deviceId: string;
  watchType: 'service' | 'process' | string;
  name: string;
  status: string;
  cpuPercent: number | null;
  memoryMb: number | null;
  pid: number | null;
  autoRestartAttempted: boolean | null;
  autoRestartSucceeded: boolean | null;
  timestamp: string;
};

type DeviceMonitoringTabProps = {
  deviceId: string;
  timezone?: string;
};

// A status is "healthy" when the watched service/process is present and running.
// Anything else (stopped, missing, unknown) is surfaced as a problem so an
// operator can see at a glance which monitors are failing.
function isHealthy(status: string): boolean {
  const s = status.toLowerCase();
  return s === 'running' || s === 'ok' || s === 'healthy' || s === 'active';
}

function statusBadge(status: string): string {
  return isHealthy(status)
    ? 'bg-success/15 text-success border-success/30'
    : 'bg-destructive/15 text-destructive border-destructive/30';
}

function formatDateTime(value?: string, timezone?: string) {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : formatUserDateTime(d, timezone ? { timeZone: timezone } : undefined);
}

export default function DeviceMonitoringTab({ deviceId, timezone }: DeviceMonitoringTabProps) {
  const [results, setResults] = useState<CheckResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const fetchResults = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const response = await fetchWithAuth(`/monitoring/results?deviceId=${deviceId}&limit=200`);
      if (!response.ok) throw new Error('Failed to fetch monitoring results');
      const json = await response.json();
      const data: CheckResult[] = Array.isArray(json.data) ? json.data : Array.isArray(json) ? json : [];
      setResults(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, [deviceId]);

  useEffect(() => {
    fetchResults();
  }, [fetchResults]);

  // The endpoint returns rows newest-first. Collapse to the latest result per
  // monitored item so the table shows each service/process's current state.
  const latestByMonitor = (() => {
    const seen = new Map<string, CheckResult>();
    for (const r of results) {
      const key = `${r.watchType}:${r.name}`;
      if (!seen.has(key)) seen.set(key, r);
    }
    return Array.from(seen.values()).sort((a, b) => a.name.localeCompare(b.name));
  })();

  const monitoredCount = latestByMonitor.length;
  const failingCount = latestByMonitor.filter((r) => !isHealthy(r.status)).length;

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Summary cards */}
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-lg border bg-card p-4 shadow-sm">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Activity className="h-4 w-4" />
            Monitored services / processes
          </div>
          <p className="mt-2 text-2xl font-bold">{loading ? '—' : monitoredCount}</p>
        </div>
        <div className="rounded-lg border bg-card p-4 shadow-sm">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <AlertTriangle className="h-4 w-4" />
            Currently failing
          </div>
          <p className={`mt-2 text-2xl font-bold ${!loading && failingCount > 0 ? 'text-destructive' : ''}`}>
            {loading ? '—' : failingCount}
          </p>
        </div>
      </div>

      {/* Results table */}
      <div className="rounded-lg border bg-card shadow-sm">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h3 className="text-sm font-semibold">Service &amp; Process Monitoring</h3>
          <button
            type="button"
            onClick={fetchResults}
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition hover:bg-muted disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>

        {loading ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">Loading monitoring results…</p>
        ) : monitoredCount === 0 ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">
            No monitoring results for this device yet. Configure service/process monitors in a Configuration Policy and assign it to this device.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                  <th className="px-4 py-2 font-medium">Name</th>
                  <th className="px-4 py-2 font-medium">Type</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 font-medium">CPU %</th>
                  <th className="px-4 py-2 font-medium">Memory (MB)</th>
                  <th className="px-4 py-2 font-medium">Auto-restart</th>
                  <th className="px-4 py-2 font-medium">Last check</th>
                </tr>
              </thead>
              <tbody>
                {latestByMonitor.map((r) => (
                  <tr key={r.id} className="border-b last:border-0">
                    <td className="px-4 py-2 font-medium">{r.name}</td>
                    <td className="px-4 py-2 capitalize text-muted-foreground">{r.watchType}</td>
                    <td className="px-4 py-2">
                      <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium capitalize ${statusBadge(r.status)}`}>
                        {r.status}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-muted-foreground">{r.cpuPercent ?? '—'}</td>
                    <td className="px-4 py-2 text-muted-foreground">{r.memoryMb ?? '—'}</td>
                    <td className="px-4 py-2 text-muted-foreground">
                      {r.autoRestartAttempted
                        ? r.autoRestartSucceeded
                          ? 'Restarted'
                          : 'Restart failed'
                        : '—'}
                    </td>
                    <td className="px-4 py-2 text-muted-foreground">{formatDateTime(r.timestamp, timezone)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
