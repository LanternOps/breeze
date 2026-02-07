import { useCallback, useEffect, useState } from 'react';
import { Activity, AlertTriangle, CheckCircle, XCircle } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';

type MonitoredAsset = {
  id: string;
  hostname: string;
  ipAddress: string;
  assetType: string;
  monitoringEnabled: boolean;
  lastSeenAt: string | null;
};

type MonitoringStatus = {
  enabled: boolean;
  snmpDevice?: {
    id: string;
    snmpVersion: string;
    templateId: string | null;
    pollingInterval: number;
    isActive: boolean;
    lastPolled: string | null;
    lastStatus: string | null;
  } | null;
};

const statusColors: Record<string, string> = {
  ok: 'bg-green-500/20 text-green-700 border-green-500/40',
  warning: 'bg-yellow-500/20 text-yellow-700 border-yellow-500/40',
  error: 'bg-red-500/20 text-red-700 border-red-500/40',
  unknown: 'bg-muted text-muted-foreground border-muted'
};

function formatRelativeTime(dateString: string | null) {
  if (!dateString) return 'Never';
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return dateString;
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / (1000 * 60));
  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

export default function DiscoveryMonitoringDashboard() {
  const [assets, setAssets] = useState<MonitoredAsset[]>([]);
  const [monitoringMap, setMonitoringMap] = useState<Map<string, MonitoringStatus>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const fetchMonitoredAssets = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);
      const response = await fetchWithAuth('/discovery/assets');
      if (!response.ok) throw new Error('Failed to fetch assets');
      const data = await response.json();
      const items = data.data ?? data.assets ?? data ?? [];

      const monitored = items
        .filter((a: Record<string, unknown>) => a.monitoringEnabled === true)
        .map((a: Record<string, unknown>) => ({
          id: a.id as string,
          hostname: (a.hostname ?? '') as string,
          ipAddress: (a.ipAddress ?? '') as string,
          assetType: (a.assetType ?? 'unknown') as string,
          monitoringEnabled: true,
          lastSeenAt: (a.lastSeenAt ?? null) as string | null
        }));

      setAssets(monitored);

      // Fetch monitoring details for each asset
      const statusMap = new Map<string, MonitoringStatus>();
      const monitoringPromises = monitored.map(async (asset: MonitoredAsset) => {
        try {
          const res = await fetchWithAuth(`/discovery/assets/${asset.id}/monitoring`);
          if (res.ok) {
            const status = await res.json();
            statusMap.set(asset.id, status);
          }
        } catch {
          // Silently skip individual failures
        }
      });

      await Promise.all(monitoringPromises);
      setMonitoringMap(statusMap);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchMonitoredAssets();
  }, [fetchMonitoredAssets]);

  const onlineCount = Array.from(monitoringMap.values()).filter(
    (s) => s.snmpDevice?.lastStatus === 'ok'
  ).length;
  const warningCount = Array.from(monitoringMap.values()).filter(
    (s) => s.snmpDevice?.lastStatus === 'warning'
  ).length;
  const offlineCount = assets.length - onlineCount - warningCount;

  if (loading) {
    return (
      <div className="flex items-center justify-center rounded-lg border bg-card p-10 shadow-sm">
        <div className="text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <p className="mt-4 text-sm text-muted-foreground">Loading monitoring data...</p>
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
          onClick={fetchMonitoredAssets}
          className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          Try again
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-lg border bg-card p-4 shadow-sm">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
              <Activity className="h-5 w-5 text-primary" />
            </div>
            <div>
              <p className="text-2xl font-bold">{assets.length}</p>
              <p className="text-xs text-muted-foreground">Total Monitored</p>
            </div>
          </div>
        </div>
        <div className="rounded-lg border bg-card p-4 shadow-sm">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-green-500/10">
              <CheckCircle className="h-5 w-5 text-green-600" />
            </div>
            <div>
              <p className="text-2xl font-bold">{onlineCount}</p>
              <p className="text-xs text-muted-foreground">Online</p>
            </div>
          </div>
        </div>
        <div className="rounded-lg border bg-card p-4 shadow-sm">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-yellow-500/10">
              <AlertTriangle className="h-5 w-5 text-yellow-600" />
            </div>
            <div>
              <p className="text-2xl font-bold">{warningCount}</p>
              <p className="text-xs text-muted-foreground">Warning</p>
            </div>
          </div>
        </div>
        <div className="rounded-lg border bg-card p-4 shadow-sm">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-red-500/10">
              <XCircle className="h-5 w-5 text-red-600" />
            </div>
            <div>
              <p className="text-2xl font-bold">{offlineCount}</p>
              <p className="text-xs text-muted-foreground">Offline / Unknown</p>
            </div>
          </div>
        </div>
      </div>

      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <h2 className="text-lg font-semibold">Monitored Assets</h2>
        <p className="text-sm text-muted-foreground">
          Discovered assets with active SNMP monitoring.
        </p>

        <div className="mt-6 overflow-hidden rounded-md border">
          <table className="min-w-full divide-y">
            <thead className="bg-muted/40">
              <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-3">IP Address</th>
                <th className="px-4 py-3">Hostname</th>
                <th className="px-4 py-3">Type</th>
                <th className="px-4 py-3">SNMP Status</th>
                <th className="px-4 py-3">Last Polled</th>
                <th className="px-4 py-3">Version</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {assets.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-6 text-center text-sm text-muted-foreground">
                    No monitored assets. Enable monitoring from the Assets tab.
                  </td>
                </tr>
              ) : (
                assets.map((asset) => {
                  const status = monitoringMap.get(asset.id);
                  const lastStatus = status?.snmpDevice?.lastStatus ?? 'unknown';
                  const colorClass = statusColors[lastStatus] ?? statusColors.unknown;

                  return (
                    <tr key={asset.id} className="transition hover:bg-muted/40">
                      <td className="px-4 py-3 text-sm font-medium">{asset.ipAddress || '—'}</td>
                      <td className="px-4 py-3 text-sm">{asset.hostname || '—'}</td>
                      <td className="px-4 py-3 text-sm capitalize">{asset.assetType}</td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${colorClass}`}>
                          {lastStatus === 'ok' ? 'Online' : lastStatus === 'warning' ? 'Warning' : lastStatus === 'error' ? 'Error' : 'Unknown'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-xs text-muted-foreground">
                        {formatRelativeTime(status?.snmpDevice?.lastPolled ?? null)}
                      </td>
                      <td className="px-4 py-3 text-sm text-muted-foreground">
                        {status?.snmpDevice?.snmpVersion ?? '—'}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
