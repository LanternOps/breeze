import { useState, useEffect, useCallback } from 'react';
import { Plus, RefreshCw } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';
import { SCAN_STATUS_COLORS } from './constants';
import CreateScanModal from './CreateScanModal';

type Scan = {
  id: string;
  orgId: string;
  deviceId: string;
  deviceName?: string;
  policyId: string | null;
  status: string;
  startedAt: string | null;
  completedAt: string | null;
  summary: Record<string, unknown>;
  createdAt: string | null;
  findings?: { total: number };
};

export default function ScansTab() {
  const [scans, setScans] = useState<Scan[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [showCreateModal, setShowCreateModal] = useState(false);

  // Track scan IDs we've loaded details for
  const [detailCache, setDetailCache] = useState<Record<string, Scan>>({});

  const fetchRecentScans = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);

      // There is no list-scans endpoint yet, so we fetch the dashboard which
      // gives us aggregate counts.  In the future a dedicated GET /scans
      // endpoint should be added.  For now show a helpful empty state.
      const res = await fetchWithAuth('/sensitive-data/dashboard');
      if (!res.ok) throw new Error('Failed to fetch scan data');

      // We don't get individual scans from the dashboard endpoint,
      // so we'll show scans from the detailCache or an empty state.
      setScans(Object.values(detailCache));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, [detailCache]);

  useEffect(() => {
    fetchRecentScans();
  }, []);

  const handleScanCreated = (newScans: Array<{ id: string; deviceId: string; orgId: string }>) => {
    // Fetch details for each created scan
    Promise.all(
      newScans.map(async (s) => {
        try {
          const res = await fetchWithAuth(`/sensitive-data/scans/${s.id}`);
          if (!res.ok) return null;
          const json = await res.json();
          return json.data as Scan;
        } catch {
          return null;
        }
      })
    ).then((results) => {
      const valid = results.filter(Boolean) as Scan[];
      setDetailCache((prev) => {
        const next = { ...prev };
        for (const scan of valid) next[scan.id] = scan;
        return next;
      });
      setScans((prev) => [...valid, ...prev]);
    });
    setShowCreateModal(false);
  };

  const formatDuration = (start: string | null, end: string | null): string => {
    if (!start) return '-';
    if (!end) return 'Running...';
    const ms = new Date(end).getTime() - new Date(start).getTime();
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${Math.round(ms / 60000)}m`;
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Scans</h2>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={fetchRecentScans}
            className="inline-flex h-9 items-center gap-2 rounded-md border px-3 text-sm font-medium hover:bg-muted"
          >
            <RefreshCw className="h-4 w-4" /> Refresh
          </button>
          <button
            type="button"
            onClick={() => setShowCreateModal(true)}
            className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            <Plus className="h-4 w-4" /> New Scan
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>
      )}

      <div className="overflow-hidden rounded-lg border">
        <table className="min-w-full divide-y">
          <thead className="bg-muted/40">
            <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-3">Scan ID</th>
              <th className="px-4 py-3">Device</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Findings</th>
              <th className="px-4 py-3">Started</th>
              <th className="px-4 py-3">Duration</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {loading && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center">
                  <div className="mx-auto h-6 w-6 animate-spin rounded-full border-4 border-primary border-t-transparent" />
                </td>
              </tr>
            )}
            {!loading && scans.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-sm text-muted-foreground">
                  No scans yet. Create a new scan to get started.
                </td>
              </tr>
            )}
            {!loading && scans.map((scan) => (
              <tr key={scan.id} className="text-sm hover:bg-muted/20">
                <td className="px-4 py-3 font-mono text-xs">{scan.id.slice(0, 8)}</td>
                <td className="px-4 py-3 text-xs">{scan.deviceName ?? scan.deviceId.slice(0, 8)}</td>
                <td className="px-4 py-3">
                  <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium capitalize ${SCAN_STATUS_COLORS[scan.status] ?? ''}`}>
                    {scan.status}
                  </span>
                </td>
                <td className="px-4 py-3 text-xs">{scan.findings?.total ?? '-'}</td>
                <td className="px-4 py-3 text-xs text-muted-foreground">
                  {scan.startedAt ? new Date(scan.startedAt).toLocaleString() : scan.createdAt ? new Date(scan.createdAt).toLocaleString() : '-'}
                </td>
                <td className="px-4 py-3 text-xs text-muted-foreground">
                  {formatDuration(scan.startedAt, scan.completedAt)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showCreateModal && (
        <CreateScanModal
          onClose={() => setShowCreateModal(false)}
          onCreated={handleScanCreated}
        />
      )}
    </div>
  );
}
