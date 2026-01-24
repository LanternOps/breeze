import { useCallback, useEffect, useMemo, useState } from 'react';
import { Terminal } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';

type ScriptExecution = {
  id?: string;
  scriptName?: string;
  name?: string;
  status?: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  durationSeconds?: number;
  outputSnippet?: string;
};

type DeviceScriptHistoryProps = {
  deviceId: string;
};

const statusStyles: Record<string, string> = {
  success: 'bg-green-500/20 text-green-700 border-green-500/40',
  completed: 'bg-green-500/20 text-green-700 border-green-500/40',
  failed: 'bg-red-500/20 text-red-700 border-red-500/40',
  running: 'bg-yellow-500/20 text-yellow-700 border-yellow-500/40',
  queued: 'bg-blue-500/20 text-blue-700 border-blue-500/40'
};

function formatDateTime(value?: string) {
  if (!value) return 'Not reported';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function formatDuration(ms?: number, seconds?: number) {
  const totalSeconds = seconds ?? (ms ? Math.round(ms / 1000) : undefined);
  if (!totalSeconds && totalSeconds !== 0) return 'Not reported';
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const remaining = totalSeconds % 60;
  return `${minutes}m ${remaining}s`;
}

export default function DeviceScriptHistory({ deviceId }: DeviceScriptHistoryProps) {
  const [executions, setExecutions] = useState<ScriptExecution[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const fetchHistory = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const response = await fetchWithAuth(`/devices/${deviceId}/scripts`);
      if (!response.ok) throw new Error('Failed to fetch script history');
      const json = await response.json();
      const payload = json?.data ?? json;
      setExecutions(Array.isArray(payload) ? payload : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch script history');
    } finally {
      setLoading(false);
    }
  }, [deviceId]);

  useEffect(() => {
    fetchHistory();
  }, [fetchHistory]);

  const rows = useMemo(() => {
    return executions.map((item, index) => {
      const status = (item.status || 'unknown').toLowerCase();
      return {
        id: item.id ?? `${item.scriptName ?? item.name ?? 'script'}-${index}`,
        name: item.scriptName ?? item.name ?? 'Unnamed script',
        status,
        startedAt: formatDateTime(item.startedAt),
        completedAt: formatDateTime(item.completedAt),
        duration: formatDuration(item.durationMs, item.durationSeconds)
      };
    });
  }, [executions]);

  if (loading) {
    return (
      <div className="flex items-center justify-center rounded-lg border bg-card py-12 shadow-sm">
        <div className="text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <p className="mt-3 text-sm text-muted-foreground">Loading script history...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <button
          type="button"
          onClick={fetchHistory}
          className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="rounded-lg border bg-card p-6 shadow-sm">
      <div className="flex items-center gap-2">
        <Terminal className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-lg font-semibold">Script Execution History</h3>
      </div>
      <div className="mt-4 overflow-hidden rounded-md border">
        <table className="min-w-full divide-y">
          <thead className="bg-muted/40">
            <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-3">Script</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Started</th>
              <th className="px-4 py-3">Completed</th>
              <th className="px-4 py-3">Duration</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-sm text-muted-foreground">
                  No script executions reported.
                </td>
              </tr>
            ) : (
              rows.map(row => (
                <tr key={row.id} className="text-sm">
                  <td className="px-4 py-3 font-medium">{row.name}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${statusStyles[row.status] || 'bg-muted/40 text-muted-foreground border-muted'}`}>
                      {row.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">{row.startedAt}</td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">{row.completedAt}</td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">{row.duration}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
