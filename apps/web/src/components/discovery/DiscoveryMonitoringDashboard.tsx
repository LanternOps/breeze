import { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  CheckCircle,
  XCircle,
  Settings,
  Power,
  PowerOff,
  RefreshCw,
  Loader2,
  X
} from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';

type MonitoredAsset = {
  id: string;
  hostname: string;
  ipAddress: string;
  assetType: string;
  lastSeenAt: string | null;
};

type SNMPDeviceInfo = {
  id: string;
  snmpVersion: string;
  templateId: string | null;
  pollingInterval: number;
  port?: number;
  isActive: boolean;
  lastPolled: string | null;
  lastStatus: string | null;
  community?: string | null;
  username?: string | null;
};

type MonitoringStatus = {
  enabled: boolean;
  snmpDevice?: SNMPDeviceInfo | null;
  recentMetrics?: Array<{
    id: string;
    oid: string;
    name: string;
    value: string;
    valueType: string;
    timestamp: string;
  }>;
};

type SNMPTemplate = {
  id: string;
  name: string;
  vendor?: string;
  deviceType?: string;
};

const statusColors: Record<string, string> = {
  ok: 'bg-green-500/20 text-green-700 border-green-500/40',
  warning: 'bg-yellow-500/20 text-yellow-700 border-yellow-500/40',
  error: 'bg-red-500/20 text-red-700 border-red-500/40',
  unknown: 'bg-muted text-muted-foreground border-muted'
};

const statusLabel: Record<string, string> = {
  ok: 'Online',
  warning: 'Warning',
  error: 'Error',
  unknown: 'Unknown'
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

function formatInterval(seconds: number) {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}

interface DiscoveryMonitoringDashboardProps {
  onViewAssets?: () => void;
}

export default function DiscoveryMonitoringDashboard({ onViewAssets }: DiscoveryMonitoringDashboardProps) {
  const [assets, setAssets] = useState<MonitoredAsset[]>([]);
  const [monitoringMap, setMonitoringMap] = useState<Map<string, MonitoringStatus>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [fetchFailures, setFetchFailures] = useState(0);
  const [editingAssetId, setEditingAssetId] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string>();
  const [templates, setTemplates] = useState<SNMPTemplate[]>([]);

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
          lastSeenAt: (a.lastSeenAt ?? null) as string | null
        }));

      setAssets(monitored);

      const statusMap = new Map<string, MonitoringStatus>();
      let failures = 0;
      const monitoringPromises = monitored.map(async (asset: MonitoredAsset) => {
        try {
          const res = await fetchWithAuth(`/discovery/assets/${asset.id}/monitoring`);
          if (res.ok) {
            const status = await res.json();
            statusMap.set(asset.id, status);
          } else {
            failures++;
          }
        } catch {
          failures++;
        }
      });

      await Promise.all(monitoringPromises);
      setMonitoringMap(statusMap);
      setFetchFailures(failures);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchMonitoredAssets();
  }, [fetchMonitoredAssets]);

  useEffect(() => {
    fetchWithAuth('/snmp/templates')
      .then(async (res) => {
        if (res.ok) {
          const data = await res.json();
          setTemplates(data.data ?? data.templates ?? data ?? []);
        }
      })
      .catch(() => {});
  }, []);

  const handleToggleActive = async (assetId: string, currentlyActive: boolean) => {
    setActionLoading(assetId);
    setActionError(undefined);
    try {
      const res = await fetchWithAuth(`/discovery/assets/${assetId}/monitoring`, {
        method: 'PATCH',
        body: JSON.stringify({ isActive: !currentlyActive })
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? 'Failed to update');
      }
      await fetchMonitoredAssets();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setActionLoading(null);
    }
  };

  const handleDisable = async (assetId: string) => {
    setActionLoading(assetId);
    setActionError(undefined);
    try {
      const res = await fetchWithAuth(`/discovery/assets/${assetId}/disable-monitoring`, {
        method: 'DELETE'
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? 'Failed to disable monitoring');
      }
      await fetchMonitoredAssets();
      setEditingAssetId(null);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setActionLoading(null);
    }
  };

  const onlineCount = Array.from(monitoringMap.values()).filter(
    (s) => s.snmpDevice?.lastStatus === 'ok'
  ).length;
  const warningCount = Array.from(monitoringMap.values()).filter(
    (s) => s.snmpDevice?.lastStatus === 'warning'
  ).length;
  const pausedCount = Array.from(monitoringMap.values()).filter(
    (s) => s.snmpDevice && !s.snmpDevice.isActive
  ).length;
  const offlineCount = assets.length - onlineCount - warningCount - pausedCount;

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

  if (error && assets.length === 0) {
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

  const editingAsset = editingAssetId ? assets.find((a) => a.id === editingAssetId) : null;
  const editingStatus = editingAssetId ? monitoringMap.get(editingAssetId) : null;

  return (
    <div className="space-y-6">
      {/* Summary Cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
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
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted">
              <PowerOff className="h-5 w-5 text-muted-foreground" />
            </div>
            <div>
              <p className="text-2xl font-bold">{pausedCount}</p>
              <p className="text-xs text-muted-foreground">Paused</p>
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

      {fetchFailures > 0 && (
        <div className="rounded-md border border-yellow-500/40 bg-yellow-500/10 px-4 py-3 text-sm text-yellow-700">
          Failed to load monitoring details for {fetchFailures} asset{fetchFailures > 1 ? 's' : ''}. Status may be incomplete.
        </div>
      )}

      {actionError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {actionError}
        </div>
      )}

      {/* Main Table */}
      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold">Monitored Devices</h2>
            <p className="text-sm text-muted-foreground">
              Manage SNMP monitoring for discovered assets.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={fetchMonitoredAssets}
              className="flex h-9 items-center gap-2 rounded-md border px-3 text-sm text-muted-foreground hover:text-foreground"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Refresh
            </button>
          </div>
        </div>

        <div className="mt-6 overflow-hidden rounded-md border">
          <table className="min-w-full divide-y">
            <thead className="bg-muted/40">
              <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-3">Device</th>
                <th className="px-4 py-3">IP Address</th>
                <th className="px-4 py-3">Type</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Version</th>
                <th className="px-4 py-3">Interval</th>
                <th className="px-4 py-3">Last Polled</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {assets.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-6 text-center text-sm text-muted-foreground">
                    No monitored assets.{' '}
                    {onViewAssets ? (
                      <button
                        type="button"
                        onClick={onViewAssets}
                        className="text-primary underline-offset-2 hover:underline"
                      >
                        Enable monitoring from the Assets tab.
                      </button>
                    ) : (
                      'Enable monitoring from the Assets tab.'
                    )}
                  </td>
                </tr>
              ) : (
                assets.map((asset) => {
                  const status = monitoringMap.get(asset.id);
                  const snmp = status?.snmpDevice;
                  const lastStatus = snmp?.lastStatus ?? 'unknown';
                  const colorClass = statusColors[lastStatus] ?? statusColors.unknown;
                  const isActive = snmp?.isActive ?? true;
                  const isLoadingAction = actionLoading === asset.id;

                  return (
                    <tr
                      key={asset.id}
                      className={`transition hover:bg-muted/40 ${!isActive ? 'opacity-60' : ''}`}
                    >
                      <td className="px-4 py-3">
                        <div>
                          <p className="text-sm font-medium">{asset.hostname || '—'}</p>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-sm font-mono">{asset.ipAddress || '—'}</td>
                      <td className="px-4 py-3 text-sm capitalize">{asset.assetType}</td>
                      <td className="px-4 py-3">
                        {!isActive ? (
                          <span className="inline-flex items-center rounded-full border bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground">
                            Paused
                          </span>
                        ) : (
                          <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${colorClass}`}>
                            {statusLabel[lastStatus] ?? 'Unknown'}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-sm text-muted-foreground">
                        {snmp?.snmpVersion ?? '—'}
                      </td>
                      <td className="px-4 py-3 text-sm text-muted-foreground">
                        {snmp?.pollingInterval ? formatInterval(snmp.pollingInterval) : '—'}
                      </td>
                      <td className="px-4 py-3 text-xs text-muted-foreground">
                        {formatRelativeTime(snmp?.lastPolled ?? null)}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-1">
                          <button
                            type="button"
                            onClick={() => setEditingAssetId(asset.id)}
                            className="flex h-8 w-8 items-center justify-center rounded-md border hover:bg-muted"
                            title="Edit settings"
                          >
                            <Settings className="h-4 w-4" />
                          </button>
                          <button
                            type="button"
                            onClick={() => handleToggleActive(asset.id, isActive)}
                            disabled={isLoadingAction}
                            className="flex h-8 w-8 items-center justify-center rounded-md border hover:bg-muted disabled:opacity-50"
                            title={isActive ? 'Pause monitoring' : 'Resume monitoring'}
                          >
                            {isLoadingAction ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : isActive ? (
                              <PowerOff className="h-4 w-4 text-yellow-600" />
                            ) : (
                              <Power className="h-4 w-4 text-green-600" />
                            )}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Edit Modal */}
      {editingAssetId && editingAsset && (
        <EditMonitoringModal
          asset={editingAsset}
          status={editingStatus ?? null}
          templates={templates}
          onClose={() => setEditingAssetId(null)}
          onSaved={() => {
            setEditingAssetId(null);
            fetchMonitoredAssets();
          }}
          onDisable={() => handleDisable(editingAssetId)}
          disabling={actionLoading === editingAssetId}
        />
      )}
    </div>
  );
}

// ---- Edit Modal Component ----

type EditMonitoringModalProps = {
  asset: MonitoredAsset;
  status: MonitoringStatus | null;
  templates: SNMPTemplate[];
  onClose: () => void;
  onSaved: () => void;
  onDisable: () => void;
  disabling: boolean;
};

function EditMonitoringModal({
  asset,
  status,
  templates,
  onClose,
  onSaved,
  onDisable,
  disabling
}: EditMonitoringModalProps) {
  const snmp = status?.snmpDevice;
  const [snmpVersion, setSnmpVersion] = useState<'v1' | 'v2c' | 'v3'>(
    (snmp?.snmpVersion as 'v1' | 'v2c' | 'v3') ?? 'v2c'
  );
  const [community, setCommunity] = useState('');
  const [username, setUsername] = useState(snmp?.username ?? '');
  const [authProtocol, setAuthProtocol] = useState('sha');
  const [authPassword, setAuthPassword] = useState('');
  const [privProtocol, setPrivProtocol] = useState('aes');
  const [privPassword, setPrivPassword] = useState('');
  const [templateId, setTemplateId] = useState(snmp?.templateId ?? '');
  const [pollingInterval, setPollingInterval] = useState(snmp?.pollingInterval ?? 300);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [confirmRemove, setConfirmRemove] = useState(false);

  const recentMetrics = status?.recentMetrics ?? [];

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(undefined);
    setSaving(true);

    try {
      const payload: Record<string, unknown> = {
        snmpVersion,
        pollingInterval,
        templateId: templateId || null
      };

      if (snmpVersion === 'v1' || snmpVersion === 'v2c') {
        if (community.trim()) payload.community = community;
      } else {
        if (username.trim()) payload.username = username;
        if (authProtocol) payload.authProtocol = authProtocol;
        if (authPassword) payload.authPassword = authPassword;
        if (privProtocol) payload.privProtocol = privProtocol;
        if (privPassword) payload.privPassword = privPassword;
      }

      const res = await fetchWithAuth(`/discovery/assets/${asset.id}/monitoring`, {
        method: 'PATCH',
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? 'Failed to update monitoring settings');
      }

      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
      <div className="w-full max-w-3xl max-h-[90vh] overflow-y-auto rounded-lg border bg-card p-6 shadow-sm">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold">Edit Monitoring Settings</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {asset.hostname || asset.ipAddress} &middot; {asset.assetType}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-md border hover:bg-muted"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Current status summary */}
        {snmp && (
          <div className="mt-4 flex items-center gap-4 rounded-md border bg-muted/30 px-4 py-3">
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Status:</span>
              <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${
                !snmp.isActive
                  ? 'bg-muted text-muted-foreground'
                  : statusColors[snmp.lastStatus ?? 'unknown'] ?? statusColors.unknown
              }`}>
                {!snmp.isActive ? 'Paused' : statusLabel[snmp.lastStatus ?? 'unknown'] ?? 'Unknown'}
              </span>
            </div>
            <div className="text-xs text-muted-foreground">
              Last polled: {formatRelativeTime(snmp.lastPolled)}
            </div>
            <div className="text-xs text-muted-foreground">
              Device ID: <span className="font-mono">{snmp.id.slice(0, 8)}</span>
            </div>
          </div>
        )}

        <form onSubmit={handleSave} className="mt-6 space-y-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">SNMP Version</label>
              <select
                value={snmpVersion}
                onChange={(e) => setSnmpVersion(e.target.value as 'v1' | 'v2c' | 'v3')}
                className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              >
                <option value="v1">v1</option>
                <option value="v2c">v2c</option>
                <option value="v3">v3</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">Polling Interval (seconds)</label>
              <input
                type="number"
                value={pollingInterval}
                onChange={(e) => setPollingInterval(Number(e.target.value))}
                min={30}
                max={86400}
                className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
          </div>

          {(snmpVersion === 'v1' || snmpVersion === 'v2c') && (
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">
                Community String
                <span className="ml-1 text-muted-foreground/60">(leave blank to keep current)</span>
              </label>
              <input
                type="text"
                value={community}
                onChange={(e) => setCommunity(e.target.value)}
                className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                placeholder="public"
              />
            </div>
          )}

          {snmpVersion === 'v3' && (
            <>
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">
                  Username
                  <span className="ml-1 text-muted-foreground/60">(leave blank to keep current)</span>
                </label>
                <input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1">Auth Protocol</label>
                  <select
                    value={authProtocol}
                    onChange={(e) => setAuthProtocol(e.target.value)}
                    className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  >
                    <option value="md5">MD5</option>
                    <option value="sha">SHA</option>
                    <option value="sha256">SHA-256</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1">Auth Password</label>
                  <input
                    type="password"
                    value={authPassword}
                    onChange={(e) => setAuthPassword(e.target.value)}
                    className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    placeholder="Leave blank to keep"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1">Privacy Protocol</label>
                  <select
                    value={privProtocol}
                    onChange={(e) => setPrivProtocol(e.target.value)}
                    className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  >
                    <option value="des">DES</option>
                    <option value="aes">AES</option>
                    <option value="aes256">AES-256</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1">Privacy Password</label>
                  <input
                    type="password"
                    value={privPassword}
                    onChange={(e) => setPrivPassword(e.target.value)}
                    className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    placeholder="Leave blank to keep"
                  />
                </div>
              </div>
            </>
          )}

          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">Template</label>
            <select
              value={templateId}
              onChange={(e) => setTemplateId(e.target.value)}
              className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="">No template</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}{t.vendor ? ` (${t.vendor})` : ''}
                </option>
              ))}
            </select>
          </div>

          {/* Recent Metrics */}
          {recentMetrics.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold mb-2">Recent Metrics</h3>
              <div className="max-h-40 overflow-y-auto rounded-md border">
                <table className="min-w-full divide-y text-xs">
                  <thead className="bg-muted/40 sticky top-0">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium text-muted-foreground">Name</th>
                      <th className="px-3 py-2 text-left font-medium text-muted-foreground">OID</th>
                      <th className="px-3 py-2 text-right font-medium text-muted-foreground">Value</th>
                      <th className="px-3 py-2 text-right font-medium text-muted-foreground">Time</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {recentMetrics.map((m) => (
                      <tr key={m.id}>
                        <td className="px-3 py-1.5">{m.name}</td>
                        <td className="px-3 py-1.5 font-mono text-muted-foreground">{m.oid}</td>
                        <td className="px-3 py-1.5 text-right font-mono">{m.value}</td>
                        <td className="px-3 py-1.5 text-right text-muted-foreground">
                          {formatRelativeTime(m.timestamp)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {error && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center justify-between border-t pt-4">
            <div>
              {!confirmRemove ? (
                <button
                  type="button"
                  onClick={() => setConfirmRemove(true)}
                  className="text-xs text-destructive hover:underline"
                >
                  Remove monitoring
                </button>
              ) : (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-destructive">Are you sure?</span>
                  <button
                    type="button"
                    onClick={onDisable}
                    disabled={disabling}
                    className="h-7 rounded-md border border-destructive/40 px-3 text-xs font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50"
                  >
                    {disabling ? 'Removing...' : 'Yes, remove'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmRemove(false)}
                    className="h-7 rounded-md border px-3 text-xs font-medium text-muted-foreground hover:text-foreground"
                  >
                    Cancel
                  </button>
                </div>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                className="h-9 rounded-md border px-4 text-sm font-medium text-muted-foreground hover:text-foreground"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={saving}
                className="h-9 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-70 flex items-center gap-2"
              >
                {saving && <Loader2 className="h-3 w-3 animate-spin" />}
                {saving ? 'Saving...' : 'Save Changes'}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
