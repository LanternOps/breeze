import { useCallback, useEffect, useMemo, useState } from 'react';
import { Network } from 'lucide-react';

type NetworkConnection = {
  id?: string;
  protocol?: string;
  localAddress?: string;
  localPort?: number | string;
  remoteAddress?: string;
  remotePort?: number | string;
  state?: string;
  processName?: string;
  pid?: number | string;
};

type DeviceNetworkConnectionsProps = {
  deviceId: string;
};

export default function DeviceNetworkConnections({ deviceId }: DeviceNetworkConnectionsProps) {
  const [connections, setConnections] = useState<NetworkConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const fetchConnections = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const response = await fetch(`/api/devices/${deviceId}/connections`);
      if (!response.ok) throw new Error('Failed to fetch network connections');
      const json = await response.json();
      const payload = json?.data ?? json;
      setConnections(Array.isArray(payload) ? payload : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch network connections');
    } finally {
      setLoading(false);
    }
  }, [deviceId]);

  useEffect(() => {
    fetchConnections();
  }, [fetchConnections]);

  const rows = useMemo(() => {
    return connections.map((item, index) => ({
      id: item.id ?? `${item.localAddress ?? 'conn'}-${index}`,
      protocol: item.protocol ?? 'Unknown',
      local: `${item.localAddress ?? '0.0.0.0'}:${item.localPort ?? '-'}`,
      remote: `${item.remoteAddress ?? '0.0.0.0'}:${item.remotePort ?? '-'}`,
      state: item.state ?? 'Unknown',
      process: item.processName ?? 'Unknown',
      pid: item.pid ?? '-'
    }));
  }, [connections]);

  if (loading) {
    return (
      <div className="flex items-center justify-center rounded-lg border bg-card py-12 shadow-sm">
        <div className="text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <p className="mt-3 text-sm text-muted-foreground">Loading network connections...</p>
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
          onClick={fetchConnections}
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
        <Network className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-lg font-semibold">Active Network Connections</h3>
      </div>
      <div className="mt-4 overflow-hidden rounded-md border">
        <table className="min-w-full divide-y">
          <thead className="bg-muted/40">
            <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-3">Protocol</th>
              <th className="px-4 py-3">Local</th>
              <th className="px-4 py-3">Remote</th>
              <th className="px-4 py-3">State</th>
              <th className="px-4 py-3">Process</th>
              <th className="px-4 py-3">PID</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-sm text-muted-foreground">
                  No active network connections reported.
                </td>
              </tr>
            ) : (
              rows.map(row => (
                <tr key={row.id} className="text-sm">
                  <td className="px-4 py-3 font-medium">{row.protocol}</td>
                  <td className="px-4 py-3 text-muted-foreground">{row.local}</td>
                  <td className="px-4 py-3 text-muted-foreground">{row.remote}</td>
                  <td className="px-4 py-3 text-muted-foreground">{row.state}</td>
                  <td className="px-4 py-3 text-muted-foreground">{row.process}</td>
                  <td className="px-4 py-3 text-muted-foreground">{row.pid}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
