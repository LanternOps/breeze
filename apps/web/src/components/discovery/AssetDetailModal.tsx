import { useCallback, useEffect, useState } from 'react';
import type { DiscoveredAsset, OpenPortEntry } from './DiscoveredAssetList';
import { typeConfig, statusConfig } from './DiscoveredAssetList';
import EnableMonitoringForm from './EnableMonitoringForm';
import { fetchWithAuth } from '../../stores/auth';

export type AssetDetail = DiscoveredAsset & {
  openPorts?: OpenPortEntry[];
  osFingerprint?: string;
  snmpData?: Record<string, string>;
  linkedDeviceId?: string | null;
};

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
  dns_check: 'DNS'
};

const monitorStatusStyles: Record<string, string> = {
  online: 'bg-green-500/20 text-green-700 border-green-500/40',
  offline: 'bg-red-500/20 text-red-700 border-red-500/40',
  degraded: 'bg-yellow-500/20 text-yellow-700 border-yellow-500/40',
  unknown: 'bg-muted text-muted-foreground border-muted'
};

type AssetDetailModalProps = {
  open: boolean;
  asset?: AssetDetail | null;
  devices?: { id: string; name: string }[];
  onClose: () => void;
  onLinked?: (assetId: string) => void;
  onDeleted?: (assetId: string) => void;
};

export default function AssetDetailModal({
  open,
  asset,
  devices = [],
  onClose,
  onLinked,
  onDeleted
}: AssetDetailModalProps) {
  const [selectedDevice, setSelectedDevice] = useState(asset?.linkedDeviceId ?? '');
  const [linking, setLinking] = useState(false);
  const [linkError, setLinkError] = useState<string>();
  const [monitoring, setMonitoring] = useState<MonitoringStatus | null>(null);
  const [networkMonitors, setNetworkMonitors] = useState<AssetNetworkMonitor[]>([]);
  const [monitoringLoading, setMonitoringLoading] = useState(false);
  const [networkMonitorsLoading, setNetworkMonitorsLoading] = useState(false);
  const [monitoringError, setMonitoringError] = useState<string>();
  const [networkMonitorsError, setNetworkMonitorsError] = useState<string>();
  const [showEnableForm, setShowEnableForm] = useState(false);
  const [disabling, setDisabling] = useState(false);
  const [disableError, setDisableError] = useState<string>();
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string>();

  useEffect(() => {
    if (asset?.linkedDeviceId) {
      setSelectedDevice(asset.linkedDeviceId);
    } else if (asset) {
      setSelectedDevice('');
    }
    setLinkError(undefined);
    setShowEnableForm(false);
    setDeleteError(undefined);
  }, [asset]);

  const refreshMonitoring = useCallback(async (assetId: string) => {
    setMonitoringLoading(true);
    setNetworkMonitorsLoading(true);
    setMonitoringError(undefined);
    setNetworkMonitorsError(undefined);

    try {
      const [monitoringRes, networkMonitorsRes] = await Promise.all([
        fetchWithAuth(`/discovery/assets/${assetId}/monitoring`),
        fetchWithAuth(`/monitors?assetId=${encodeURIComponent(assetId)}`)
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
  }, []);

  useEffect(() => {
    if (!asset || !open) {
      setMonitoring(null);
      setNetworkMonitors([]);
      setMonitoringError(undefined);
      setNetworkMonitorsError(undefined);
      return;
    }
    refreshMonitoring(asset.id);
  }, [asset, open, refreshMonitoring]);

  const handleDisableMonitoring = async () => {
    if (!asset) return;
    setDisabling(true);
    setDisableError(undefined);
    try {
      const res = await fetchWithAuth(`/discovery/assets/${asset.id}/disable-monitoring`, {
        method: 'DELETE'
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? 'Failed to disable monitoring');
      }
      await refreshMonitoring(asset.id);
    } catch (err) {
      setDisableError(err instanceof Error ? err.message : 'Failed to disable monitoring');
    } finally {
      setDisabling(false);
    }
  };

  if (!open || !asset) return null;

  const handleLink = async () => {
    if (!selectedDevice) {
      setLinkError('Select a device to link.');
      return;
    }

    try {
      setLinking(true);
      setLinkError(undefined);
      const response = await fetchWithAuth(`/discovery/assets/${asset.id}/link`, {
        method: 'POST',
        body: JSON.stringify({ deviceId: selectedDevice })
      });

      if (!response.ok) {
        throw new Error('Failed to link asset');
      }

      onLinked?.(asset.id);
    } catch (err) {
      setLinkError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLinking(false);
    }
  };

  const handleDelete = async () => {
    const name = asset.hostname || asset.ip;
    if (!confirm(`Delete discovered asset "${name}"?`)) {
      return;
    }

    try {
      setDeleting(true);
      setDeleteError(undefined);
      const response = await fetchWithAuth(`/discovery/assets/${asset.id}`, {
        method: 'DELETE'
      });

      if (!response.ok) {
        throw new Error('Failed to delete asset');
      }

      onDeleted?.(asset.id);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setDeleting(false);
    }
  };

  const openPorts = asset.openPorts ?? [];
  const osFingerprint = asset.osFingerprint ?? '—';
  const snmpData = asset.snmpData ?? {};
  const snmpDevice = monitoring?.snmpDevice ?? null;
  const activeNetworkMonitors = networkMonitors.filter((monitor) => monitor.isActive);
  const hasConfiguredMonitoring = Boolean(snmpDevice) || networkMonitors.length > 0;
  const hasActiveMonitoring = Boolean(snmpDevice?.isActive) || activeNetworkMonitors.length > 0;
  const totalMonitorCount = monitoring?.networkMonitors?.totalCount ?? networkMonitors.length;
  const activeMonitorCount = monitoring?.networkMonitors?.activeCount ?? activeNetworkMonitors.length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
      <div className="w-full max-w-3xl rounded-lg border bg-card p-6 shadow-sm">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold">{asset.hostname || asset.ip}</h2>
              <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${typeConfig[asset.type].color}`}>
                {typeConfig[asset.type].label}
              </span>
              <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${statusConfig[asset.status].color}`}>
                {statusConfig[asset.status].label}
              </span>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {asset.ip} • {asset.mac !== '—' ? asset.mac : 'No MAC'}
              {asset.lastSeen && (
                <> • Last seen {new Date(asset.lastSeen).toLocaleString()}</>
              )}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border px-2 py-1 text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            Close
          </button>
        </div>

        <div className="mt-6 grid gap-6 lg:grid-cols-2">
          <div className="space-y-4">
            <div className="rounded-md border bg-muted/30 p-4">
              <h3 className="text-sm font-semibold">Overview</h3>
              <dl className="mt-3 space-y-2 text-sm">
                <div className="flex items-center justify-between">
                  <dt className="text-muted-foreground">IP Address</dt>
                  <dd className="font-medium">{asset.ip}</dd>
                </div>
                <div className="flex items-center justify-between">
                  <dt className="text-muted-foreground">MAC Address</dt>
                  <dd className="font-medium">{asset.mac}</dd>
                </div>
                <div className="flex items-center justify-between">
                  <dt className="text-muted-foreground">Manufacturer</dt>
                  <dd className="font-medium">{asset.manufacturer}</dd>
                </div>
                <div className="flex items-center justify-between">
                  <dt className="text-muted-foreground">Ping</dt>
                  <dd className="font-mono font-medium">
                    {asset.responseTimeMs != null
                      ? asset.responseTimeMs < 1
                        ? '<1 ms'
                        : `${asset.responseTimeMs.toFixed(1)} ms`
                      : '—'}
                  </dd>
                </div>
                <div className="flex items-center justify-between">
                  <dt className="text-muted-foreground">OS Fingerprint</dt>
                  <dd className="font-medium">{osFingerprint}</dd>
                </div>
              </dl>
            </div>

            <div className="rounded-md border bg-muted/30 p-4">
              <h3 className="text-sm font-semibold">Open Ports</h3>
              <div className="mt-3 flex flex-wrap gap-2">
                {openPorts.length === 0 ? (
                  <span className="text-xs text-muted-foreground">No ports detected.</span>
                ) : (
                  openPorts.map((p) => (
                    <span
                      key={p.port}
                      className="rounded-full border border-muted bg-background px-2 py-1 text-xs"
                    >
                      {p.port}{p.service ? ` (${p.service})` : ''}
                    </span>
                  ))
                )}
              </div>
            </div>
          </div>

          <div className="space-y-4">
            <div className="rounded-md border bg-muted/30 p-4">
              <h3 className="text-sm font-semibold">SNMP Data</h3>
              <dl className="mt-3 space-y-2 text-sm">
                {Object.keys(snmpData).length === 0 ? (
                  <div className="text-xs text-muted-foreground">No SNMP data available.</div>
                ) : (
                  Object.entries(snmpData).map(([key, value]) => (
                    <div key={key} className="flex items-center justify-between">
                      <dt className="text-muted-foreground">{key}</dt>
                      <dd className="font-medium text-right">{value}</dd>
                    </div>
                  ))
                )}
              </dl>
            </div>

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
                    assetId={asset.id}
                    ipAddress={asset.ip}
                    onEnabled={() => {
                      setShowEnableForm(false);
                      refreshMonitoring(asset.id);
                    }}
                    onCancel={() => setShowEnableForm(false)}
                  />
                </div>
              ) : (
                <div className="mt-3 space-y-3">
                  <div className="flex items-center gap-2">
                    <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${
                      hasActiveMonitoring
                        ? 'bg-green-500/20 text-green-700 border-green-500/40'
                        : hasConfiguredMonitoring
                          ? 'bg-yellow-500/20 text-yellow-700 border-yellow-500/40'
                          : 'bg-muted text-muted-foreground border-muted'
                    }`}>
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
                                {(monitorTypeLabels[monitor.monitorType] ?? monitor.monitorType)} • {monitor.target}
                              </p>
                            </div>
                            <span className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 ${
                              !monitor.isActive
                                ? 'bg-muted text-muted-foreground border-muted'
                                : monitorStatusStyles[monitor.lastStatus] ?? monitorStatusStyles.unknown
                            }`}>
                              {!monitor.isActive ? 'Paused' : monitor.lastStatus}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setShowEnableForm(true)}
                      className="h-8 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:opacity-90"
                    >
                      {hasConfiguredMonitoring ? 'Add / Update Monitoring' : 'Enable Monitoring'}
                    </button>
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

            <div className="rounded-md border bg-muted/30 p-4">
              <h3 className="text-sm font-semibold">Link to Device</h3>
              <div className="mt-3 flex items-center gap-3">
                <select
                  value={selectedDevice}
                  onChange={event => setSelectedDevice(event.target.value)}
                  className="h-10 flex-1 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                >
                  <option value="">Select device</option>
                  {devices.map(device => (
                    <option key={device.id} value={device.id}>
                      {device.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={handleLink}
                  disabled={linking}
                  className="h-10 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-70"
                >
                  {linking ? 'Linking...' : 'Link'}
                </button>
              </div>
              {linkError && (
                <div className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  {linkError}
                </div>
              )}

              <div className="mt-4 border-t pt-4">
                <p className="text-xs text-muted-foreground">Remove this discovered asset from discovery results.</p>
                <button
                  type="button"
                  onClick={handleDelete}
                  disabled={deleting}
                  className="mt-2 h-8 rounded-md border border-destructive/40 px-3 text-xs font-medium text-destructive hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {deleting ? 'Deleting...' : 'Delete Asset'}
                </button>
                {deleteError && (
                  <div className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                    {deleteError}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
