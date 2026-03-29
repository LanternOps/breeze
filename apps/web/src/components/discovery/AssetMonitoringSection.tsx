import { useCallback, useEffect, useState } from 'react';
import EnableMonitoringForm from './EnableMonitoringForm';
import { fetchWithAuth } from '../../stores/auth';

type MonitoringStatus = {
  enabled: boolean;
  snmpDevice?: {
    id: string;
    snmpVersion: string;
    pollingInterval: number;
    isActive: boolean;
    lastPolled: string | null;
    lastStatus: string | null;
  } | null;
  networkMonitors?: {
    totalCount: number;
    activeCount: number;
  };
};

type AssetNetworkMonitor = {
  id: string;
  name: string;
  monitorType: string;
  target: string;
  isActive: boolean;
  lastStatus: string;
  lastChecked: string | null;
};

const monitorTypeLabels: Record<string, string> = {
  icmp_ping: 'ICMP Ping',
  tcp_port: 'TCP Port',
  http_check: 'HTTP',
  dns_check: 'DNS',
};

const monitorStatusStyles: Record<string, string> = {
  online: 'bg-success/15 text-success border-success/30',
  offline: 'bg-destructive/15 text-destructive border-destructive/30',
  degraded: 'bg-warning/15 text-warning border-warning/30',
  unknown: 'bg-muted text-muted-foreground border-muted',
};

type AssetMonitoringSectionProps = {
  assetId: string;
  ipAddress: string;
  open: boolean;
};

export default function AssetMonitoringSection({ assetId, ipAddress, open }: AssetMonitoringSectionProps) {
  const [monitoring, setMonitoring] = useState<MonitoringStatus | null>(null);
  const [networkMonitors, setNetworkMonitors] = useState<AssetNetworkMonitor[]>([]);
  const [monitoringLoading, setMonitoringLoading] = useState(false);
  const [networkMonitorsLoading, setNetworkMonitorsLoading] = useState(false);
  const [monitoringError, setMonitoringError] = useState<string>();
  const [networkMonitorsError, setNetworkMonitorsError] = useState<string>();
  const [showEnableForm, setShowEnableForm] = useState(false);
  const [disabling, setDisabling] = useState(false);
  const [disableError, setDisableError] = useState<string>();

  const refreshMonitoring = useCallback(async () => {
    setMonitoringLoading(true);
    setNetworkMonitorsLoading(true);
    setMonitoringError(undefined);
    setNetworkMonitorsError(undefined);

    try {
      const [monitoringRes, networkMonitorsRes] = await Promise.all([
        fetchWithAuth(`/monitoring/assets/${assetId}`),
        fetchWithAuth(`/monitors?assetId=${encodeURIComponent(assetId)}`),
      ]);

      if (monitoringRes.ok) {
        setMonitoring(await monitoringRes.json());
      } else {
        setMonitoringError('Failed to load monitoring status');
      }

      if (networkMonitorsRes.ok) {
        const data = await networkMonitorsRes.json();
        setNetworkMonitors(data.data ?? []);
      } else {
        setNetworkMonitorsError('Failed to load network monitors');
      }
    } catch {
      setMonitoringError('Failed to load monitoring status');
      setNetworkMonitorsError('Failed to load network monitors');
    } finally {
      setMonitoringLoading(false);
      setNetworkMonitorsLoading(false);
    }
  }, [assetId]);

  useEffect(() => {
    if (!open) {
      setMonitoring(null);
      setNetworkMonitors([]);
      setMonitoringError(undefined);
      setNetworkMonitorsError(undefined);
      return;
    }
    setShowEnableForm(false);
    refreshMonitoring();
  }, [open, assetId, refreshMonitoring]);

  const handleDisableMonitoring = async () => {
    setDisabling(true);
    setDisableError(undefined);
    try {
      const res = await fetchWithAuth(`/monitoring/assets/${assetId}`, { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? 'Failed to disable monitoring');
      }
      await refreshMonitoring();
    } catch (err) {
      setDisableError(err instanceof Error ? err.message : 'Failed to disable monitoring');
    } finally {
      setDisabling(false);
    }
  };

  const snmpDevice = monitoring?.snmpDevice ?? null;
  const activeNetworkMonitors = networkMonitors.filter((m) => m.isActive);
  const hasConfiguredMonitoring = Boolean(snmpDevice) || networkMonitors.length > 0;
  const hasActiveMonitoring = Boolean(snmpDevice?.isActive) || activeNetworkMonitors.length > 0;
  const totalMonitorCount = monitoring?.networkMonitors?.totalCount ?? networkMonitors.length;
  const activeMonitorCount = monitoring?.networkMonitors?.activeCount ?? activeNetworkMonitors.length;

  return (
    <div className="rounded-md border bg-muted/30 p-4">
      <h3 className="text-sm font-semibold">Monitoring</h3>
      {monitoringError && (
        <div className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {monitoringError}
        </div>
      )}
      {networkMonitorsError && (
        <div className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {networkMonitorsError}
        </div>
      )}
      {disableError && (
        <div className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {disableError}
        </div>
      )}

      {monitoringLoading || networkMonitorsLoading ? (
        <div className="mt-3 text-xs text-muted-foreground">Loading monitoring status...</div>
      ) : showEnableForm ? (
        <div className="mt-3">
          <EnableMonitoringForm
            assetId={assetId}
            ipAddress={ipAddress}
            onEnabled={() => {
              setShowEnableForm(false);
              refreshMonitoring();
            }}
            onCancel={() => setShowEnableForm(false)}
          />
        </div>
      ) : (
        <div className="mt-3 space-y-3">
          <div className="flex items-center gap-2">
            <span
              className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${
                hasActiveMonitoring
                  ? 'bg-success/15 text-success border-success/30'
                  : hasConfiguredMonitoring
                    ? 'bg-warning/15 text-warning border-warning/30'
                    : 'bg-muted text-muted-foreground border-muted'
              }`}
            >
              {hasActiveMonitoring ? 'Active' : hasConfiguredMonitoring ? 'Configured (Paused)' : 'Not Configured'}
            </span>
            <span className="text-xs text-muted-foreground">
              {totalMonitorCount > 0
                ? `${activeMonitorCount}/${totalMonitorCount} network checks active`
                : 'No network checks configured'}
            </span>
          </div>

          {snmpDevice && (
            <div className="rounded-md border bg-background px-3 py-2">
              <p className="text-xs font-medium">SNMP Device Monitor</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {snmpDevice.snmpVersion} &middot; every {snmpDevice.pollingInterval}s
                {snmpDevice.lastPolled ? ` • last polled ${new Date(snmpDevice.lastPolled).toLocaleString()}` : ''}
              </p>
            </div>
          )}

          {networkMonitors.length > 0 && (
            <div className="rounded-md border bg-background px-3 py-2">
              <p className="text-xs font-medium">Network Monitors ({networkMonitors.length})</p>
              <div className="mt-2 space-y-1.5">
                {networkMonitors.map((monitor) => (
                  <div key={monitor.id} className="flex items-center justify-between gap-3 text-xs">
                    <div className="min-w-0">
                      <p className="truncate font-medium">{monitor.name}</p>
                      <p className="truncate text-muted-foreground">
                        {monitorTypeLabels[monitor.monitorType] ?? monitor.monitorType} • {monitor.target}
                      </p>
                    </div>
                    <span
                      className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 ${
                        !monitor.isActive
                          ? 'bg-muted text-muted-foreground border-muted'
                          : (monitorStatusStyles[monitor.lastStatus] ?? monitorStatusStyles.unknown)
                      }`}
                    >
                      {!monitor.isActive ? 'Paused' : monitor.lastStatus}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setShowEnableForm(true)}
              className="h-8 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:opacity-90"
            >
              {hasConfiguredMonitoring ? 'Add / Update Monitoring' : 'Enable Monitoring'}
            </button>
            <a
              href={`/monitoring?assetId=${encodeURIComponent(assetId)}`}
              className="inline-flex items-center h-8 rounded-md border px-3 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted"
            >
              Open Monitoring
            </a>
            {hasActiveMonitoring && (
              <button
                type="button"
                onClick={handleDisableMonitoring}
                disabled={disabling}
                className="h-8 rounded-md border border-destructive/40 px-3 text-xs font-medium text-destructive hover:bg-destructive/10 disabled:opacity-70"
              >
                {disabling ? 'Disabling...' : 'Disable Active Monitoring'}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
