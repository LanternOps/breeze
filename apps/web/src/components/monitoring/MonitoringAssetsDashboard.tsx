import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  CheckCircle,
  Loader2,
  Power,
  PowerOff,
  RefreshCw,
  Settings,
  X,
  XCircle
} from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';
import { useOrgStore } from '../../stores/orgStore';
import CreateMonitorForm from '../monitors/CreateMonitorForm';

type MonitoringAsset = {
  id: string;
  hostname: string | null;
  ipAddress: string;
  assetType: string;
  lastSeenAt: string | null;
  monitoring: {
    configured: boolean;
    active: boolean;
  };
  snmp: {
    configured: boolean;
    deviceId: string | null;
    snmpVersion: string | null;
    templateId: string | null;
    pollingInterval: number | null;
    port: number | null;
    isActive: boolean;
    lastPolled: string | null;
    lastStatus: string | null;
  };
  network: {
    configured: boolean;
    totalCount: number;
    activeCount: number;
  };
};

type SNMPTemplate = {
  id: string;
  name: string;
  vendor?: string;
  deviceType?: string;
};

type AssetMonitoringDetail = {
  enabled: boolean;
  snmpDevice: {
    id: string;
    snmpVersion: string;
    templateId: string | null;
    pollingInterval: number;
    port?: number;
    isActive: boolean;
    lastPolled: string | null;
    lastStatus: string | null;
    username?: string | null;
  } | null;
  networkMonitors: {
    totalCount: number;
    activeCount: number;
  };
  recentMetrics: Array<{
    id: string;
    oid: string;
    name: string;
    value: string;
    valueType: string;
    timestamp: string;
  }>;
};

const statusColors: Record<string, string> = {
  online: 'bg-green-500/20 text-green-700 border-green-500/40',
  warning: 'bg-yellow-500/20 text-yellow-700 border-yellow-500/40',
  offline: 'bg-red-500/20 text-red-700 border-red-500/40',
  maintenance: 'bg-blue-500/20 text-blue-700 border-blue-500/40',
  unknown: 'bg-muted text-muted-foreground border-muted'
};

const statusLabel: Record<string, string> = {
  online: 'Online',
  warning: 'Warning',
  offline: 'Offline',
  maintenance: 'Maintenance',
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

function formatInterval(seconds: number | null) {
  if (!seconds || seconds <= 0) return '—';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}

type Props = {
  initialAssetId?: string | null;
  onOpenChecks?: () => void;
};

export default function MonitoringAssetsDashboard({ initialAssetId, onOpenChecks }: Props) {
  const { currentOrgId } = useOrgStore();
  const [assets, setAssets] = useState<MonitoringAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [showAll, setShowAll] = useState(false);

  const [templates, setTemplates] = useState<SNMPTemplate[]>([]);

  const [editingAssetId, setEditingAssetId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AssetMonitoringDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string>();

  const fetchAssets = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);
      const params = new URLSearchParams();
      if (showAll) params.set('includeUnconfigured', 'true');
      if (currentOrgId) params.set('orgId', currentOrgId);
      const qs = params.toString() ? `?${params.toString()}` : '';
      const res = await fetchWithAuth(`/monitoring/assets${qs}`);
      if (!res.ok) throw new Error('Failed to fetch monitoring assets');
      const data = await res.json();
      setAssets(data.data ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, [showAll, currentOrgId]);

  useEffect(() => {
    fetchAssets();
  }, [fetchAssets]);

  useEffect(() => {
    fetchWithAuth('/snmp/templates')
      .then(async (res) => {
        if (!res.ok) {
          console.warn(`[MonitoringAssetsDashboard] Failed to load SNMP templates: HTTP ${res.status}`);
          return;
        }
        const data = await res.json();
        setTemplates(data.data ?? data.templates ?? data ?? []);
      })
      .catch((err) => {
        console.error('[MonitoringAssetsDashboard] Error loading SNMP templates:', err);
      });
  }, []);

  useEffect(() => {
    if (!initialAssetId) return;
    // If deep-linked to an asset, switch to "show all" mode (so unconfigured
    // assets are included) and open its editing panel.
    setShowAll(true);
    setEditingAssetId(initialAssetId);
  }, [initialAssetId]);

  const openEdit = useCallback(async (assetId: string) => {
    setEditingAssetId(assetId);
    setDetail(null);
    setDetailLoading(true);
    setActionError(undefined);
    try {
      const res = await fetchWithAuth(`/monitoring/assets/${assetId}`);
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? 'Failed to load monitoring details');
      }
      setDetail(await res.json());
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to load monitoring details');
    } finally {
      setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!editingAssetId) return;
    void openEdit(editingAssetId);
  }, [editingAssetId, openEdit]);

  const configuredCount = useMemo(() => assets.filter((a) => a.monitoring.configured).length, [assets]);
  const activeCount = useMemo(() => assets.filter((a) => a.monitoring.active).length, [assets]);
  const pausedCount = useMemo(() => assets.filter((a) => a.monitoring.configured && !a.monitoring.active).length, [assets]);
  const snmpWarningOrOffline = useMemo(() => assets.filter((a) => {
    if (!a.snmp.configured || !a.snmp.isActive) return false;
    return a.snmp.lastStatus === 'warning' || a.snmp.lastStatus === 'offline';
  }).length, [assets]);

  const handleToggleSnmpActive = async (assetId: string, nextActive: boolean) => {
    setActionLoading(assetId);
    setActionError(undefined);
    try {
      const res = await fetchWithAuth(`/monitoring/assets/${assetId}/snmp`, {
        method: 'PATCH',
        body: JSON.stringify({ isActive: nextActive })
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? 'Failed to update');
      }
      await fetchAssets();
      if (editingAssetId === assetId) {
        await openEdit(assetId);
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setActionLoading(null);
    }
  };

  const handleDisableAll = async (assetId: string) => {
    setActionLoading(assetId);
    setActionError(undefined);
    try {
      const res = await fetchWithAuth(`/monitoring/assets/${assetId}`, { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? 'Failed to disable monitoring');
      }
      await fetchAssets();
      if (editingAssetId === assetId) {
        setEditingAssetId(null);
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setActionLoading(null);
    }
  };

  if (loading && assets.length === 0) {
    return (
      <div className="flex items-center justify-center rounded-lg border bg-card p-10 shadow-sm">
        <div className="text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <p className="mt-4 text-sm text-muted-foreground">Loading monitoring assets...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {actionError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {actionError}
        </div>
      )}

      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setShowAll((v) => !v)}
            className="h-9 rounded-md border px-3 text-sm font-medium hover:bg-muted"
          >
            {showAll ? 'Showing all discovered assets' : 'Showing monitored assets'}
          </button>
          {onOpenChecks && (
            <button
              type="button"
              onClick={onOpenChecks}
              className="h-9 rounded-md border px-3 text-sm font-medium hover:bg-muted"
            >
              Manage network checks
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={fetchAssets}
          className="flex h-9 items-center gap-2 rounded-md border px-3 text-sm text-muted-foreground hover:text-foreground"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Refresh
        </button>
      </div>

      {/* Summary */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <div className="rounded-lg border bg-card p-4 shadow-sm">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
              <Activity className="h-5 w-5 text-primary" />
            </div>
            <div>
              <p className="text-2xl font-bold">{configuredCount}</p>
              <p className="text-xs text-muted-foreground">Configured</p>
            </div>
          </div>
        </div>
        <div className="rounded-lg border bg-card p-4 shadow-sm">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-green-500/10">
              <CheckCircle className="h-5 w-5 text-green-600" />
            </div>
            <div>
              <p className="text-2xl font-bold">{activeCount}</p>
              <p className="text-xs text-muted-foreground">Active</p>
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
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-yellow-500/10">
              <AlertTriangle className="h-5 w-5 text-yellow-600" />
            </div>
            <div>
              <p className="text-2xl font-bold">{snmpWarningOrOffline}</p>
              <p className="text-xs text-muted-foreground">SNMP Warnings</p>
            </div>
          </div>
        </div>
        <div className="rounded-lg border bg-card p-4 shadow-sm">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
              <Activity className="h-5 w-5 text-primary" />
            </div>
            <div>
              <p className="text-2xl font-bold">{assets.length}</p>
              <p className="text-xs text-muted-foreground">Shown</p>
            </div>
          </div>
        </div>
      </div>

      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold">Assets</h2>
            <p className="text-sm text-muted-foreground">
              Unified view of SNMP polling and network checks per discovered asset.
            </p>
          </div>
        </div>

        <div className="mt-6 overflow-hidden rounded-md border">
          <table className="min-w-full divide-y">
            <thead className="bg-muted/40">
              <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-3">Asset</th>
                <th className="px-4 py-3">IP</th>
                <th className="px-4 py-3">Type</th>
                <th className="px-4 py-3">Overall</th>
                <th className="px-4 py-3">SNMP</th>
                <th className="px-4 py-3">Network Checks</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {assets.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-6 text-center text-sm text-muted-foreground">
                    No assets found.
                  </td>
                </tr>
              ) : (
                assets.map((asset) => {
                  const isLoadingAction = actionLoading === asset.id;
                  const overall = asset.monitoring.configured
                    ? (asset.monitoring.active ? 'active' : 'paused')
                    : 'unconfigured';
                  return (
                    <tr key={asset.id} className="transition hover:bg-muted/40">
                      <td className="px-4 py-3">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">
                            {asset.hostname || asset.ipAddress || '—'}
                          </p>
                          <p className="truncate text-xs text-muted-foreground">
                            Last seen {formatRelativeTime(asset.lastSeenAt)}
                          </p>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-sm font-mono">{asset.ipAddress || '—'}</td>
                      <td className="px-4 py-3 text-sm capitalize">{asset.assetType}</td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${
                          overall === 'active'
                            ? 'bg-green-500/20 text-green-700 border-green-500/40'
                            : overall === 'paused'
                              ? 'bg-yellow-500/20 text-yellow-700 border-yellow-500/40'
                              : 'bg-muted text-muted-foreground border-muted'
                        }`}>
                          {overall === 'active' ? 'Active' : overall === 'paused' ? 'Configured (Paused)' : 'Not configured'}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        {!asset.snmp.configured ? (
                          <span className="text-xs text-muted-foreground">Not configured</span>
                        ) : (
                          <div className="space-y-1">
                            <div className="flex items-center gap-2">
                              <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${
                                !asset.snmp.isActive
                                  ? statusColors.unknown
                                  : statusColors[asset.snmp.lastStatus ?? 'unknown'] ?? statusColors.unknown
                              }`}>
                                {!asset.snmp.isActive
                                  ? 'Paused'
                                  : statusLabel[asset.snmp.lastStatus ?? 'unknown'] ?? 'Unknown'}
                              </span>
                              <span className="text-xs text-muted-foreground">
                                {asset.snmp.snmpVersion ?? '—'} • every {formatInterval(asset.snmp.pollingInterval)}
                              </span>
                            </div>
                            <div className="text-xs text-muted-foreground">
                              Last polled {formatRelativeTime(asset.snmp.lastPolled)}
                            </div>
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-sm text-muted-foreground">
                        {asset.network.totalCount > 0
                          ? `${asset.network.activeCount}/${asset.network.totalCount} active`
                          : '—'}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-1">
                          <button
                            type="button"
                            onClick={() => setEditingAssetId(asset.id)}
                            className="flex h-8 w-8 items-center justify-center rounded-md border hover:bg-muted"
                            title="Configure monitoring"
                          >
                            <Settings className="h-4 w-4" />
                          </button>
                          {asset.snmp.configured && (
                            <button
                              type="button"
                              onClick={() => handleToggleSnmpActive(asset.id, !asset.snmp.isActive)}
                              disabled={isLoadingAction}
                              className="flex h-8 w-8 items-center justify-center rounded-md border hover:bg-muted disabled:opacity-50"
                              title={asset.snmp.isActive ? 'Pause SNMP polling' : 'Resume SNMP polling'}
                            >
                              {isLoadingAction ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : asset.snmp.isActive ? (
                                <PowerOff className="h-4 w-4 text-yellow-600" />
                              ) : (
                                <Power className="h-4 w-4 text-green-600" />
                              )}
                            </button>
                          )}
                          {asset.monitoring.active && (
                            <button
                              type="button"
                              onClick={() => handleDisableAll(asset.id)}
                              disabled={isLoadingAction}
                              className="flex h-8 w-8 items-center justify-center rounded-md border border-destructive/30 text-destructive hover:bg-destructive/10 disabled:opacity-50"
                              title="Disable all active monitoring for this asset"
                            >
                              <XCircle className="h-4 w-4" />
                            </button>
                          )}
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

      {editingAssetId && (
        <EditMonitoringModal
          asset={assets.find((a) => a.id === editingAssetId) ?? null}
          detail={detail}
          loading={detailLoading}
          templates={templates}
          onClose={() => setEditingAssetId(null)}
          onDisable={() => handleDisableAll(editingAssetId)}
          disabling={actionLoading === editingAssetId}
          onSaved={async () => {
            await fetchAssets();
            await openEdit(editingAssetId);
          }}
        />
      )}
    </div>
  );
}

type EditModalProps = {
  asset: MonitoringAsset | null;
  detail: AssetMonitoringDetail | null;
  loading: boolean;
  templates: SNMPTemplate[];
  onClose: () => void;
  onSaved: () => void;
  onDisable: () => void;
  disabling: boolean;
};

function EditMonitoringModal({
  asset,
  detail,
  loading,
  templates,
  onClose,
  onSaved,
  onDisable,
  disabling
}: EditModalProps) {
  const snmp = detail?.snmpDevice ?? null;

  const [snmpVersion, setSnmpVersion] = useState<'v1' | 'v2c' | 'v3'>((snmp?.snmpVersion as any) ?? 'v2c');
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
  const [showCreateMonitorForm, setShowCreateMonitorForm] = useState(false);

  useEffect(() => {
    setSnmpVersion((snmp?.snmpVersion as any) ?? 'v2c');
    setUsername(snmp?.username ?? '');
    setTemplateId(snmp?.templateId ?? '');
    setPollingInterval(snmp?.pollingInterval ?? 300);
    setCommunity('');
    setAuthPassword('');
    setPrivPassword('');
    setError(undefined);
    setConfirmRemove(false);
    setShowCreateMonitorForm(false);
  }, [snmp?.id]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!asset) return;

    setError(undefined);
    setSaving(true);

    try {
      const payload: Record<string, unknown> = {
        snmpVersion,
        pollingInterval,
        templateId: templateId || null
      };

      if (snmpVersion === 'v1' || snmpVersion === 'v2c') {
        if (!snmp?.id && !community.trim()) {
          throw new Error('Community string is required for SNMP v1/v2c');
        }
        if (community.trim()) payload.community = community;
      } else {
        if (!snmp?.id && !username.trim()) {
          throw new Error('Username is required for SNMP v3');
        }
        if (username.trim()) payload.username = username;
        if (authProtocol) payload.authProtocol = authProtocol;
        if (authPassword) payload.authPassword = authPassword;
        if (privProtocol) payload.privProtocol = privProtocol;
        if (privPassword) payload.privPassword = privPassword;
      }

      const method = snmp?.id ? 'PATCH' : 'PUT';
      const res = await fetchWithAuth(`/monitoring/assets/${asset.id}/snmp`, {
        method,
        body: JSON.stringify(payload)
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? 'Failed to save monitoring settings');
      }
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setSaving(false);
    }
  };

  if (!asset) return null;

  const recentMetrics = detail?.recentMetrics ?? [];
  const networkSummary = detail?.networkMonitors ?? null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
      <div className="w-full max-w-3xl max-h-[90vh] overflow-y-auto rounded-lg border bg-card p-6 shadow-sm">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold">Configure Monitoring</h2>
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

        {loading && (
          <div className="mt-6 flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading monitoring details...
          </div>
        )}

        {!loading && detail && (
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <div className="rounded-md border bg-muted/30 px-4 py-3">
              <p className="text-xs text-muted-foreground">SNMP</p>
              <p className="mt-1 text-sm font-medium">
                {detail.snmpDevice
                  ? `${detail.snmpDevice.snmpVersion} • every ${detail.snmpDevice.pollingInterval}s`
                  : 'Not configured'}
              </p>
              {detail.snmpDevice && (
                <p className="mt-1 text-xs text-muted-foreground">
                  Status: {detail.snmpDevice.isActive ? (statusLabel[detail.snmpDevice.lastStatus ?? 'unknown'] ?? 'Unknown') : 'Paused'}
                  {' • '}
                  Last polled {formatRelativeTime(detail.snmpDevice.lastPolled)}
                </p>
              )}
            </div>
            <div className="rounded-md border bg-muted/30 px-4 py-3">
              <p className="text-xs text-muted-foreground">Network Checks</p>
              <p className="mt-1 text-sm font-medium">
                {networkSummary ? `${networkSummary.activeCount}/${networkSummary.totalCount} active` : '—'}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">Create and manage checks per asset.</p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => setShowCreateMonitorForm(true)}
                  className="h-8 rounded-md border px-3 text-xs font-medium hover:bg-muted"
                >
                  Add network check
                </button>
                <a
                  href={`/monitoring?tab=checks&assetId=${encodeURIComponent(asset.id)}`}
                  className="inline-flex items-center h-8 rounded-md border px-3 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  Open checks
                </a>
              </div>
            </div>
          </div>
        )}

        <form onSubmit={handleSave} className="mt-6 space-y-5">
          <div className="rounded-md border p-4">
            <h3 className="text-sm font-semibold">SNMP Polling</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Configure per-asset SNMP polling. Secrets are not shown; leave blank to keep existing values.
            </p>

            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">SNMP Version</label>
                <select
                  value={snmpVersion}
                  onChange={(e) => setSnmpVersion(e.target.value as any)}
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
              <div className="mt-4">
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
              <div className="mt-4 space-y-4">
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
              </div>
            )}

            <div className="mt-4">
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

            {recentMetrics.length > 0 && (
              <div className="mt-4">
                <h3 className="text-sm font-semibold mb-2">Recent SNMP Metrics</h3>
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
          </div>

          {error && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </div>
          )}

          <div className="flex items-center justify-between border-t pt-4">
            <div>
              {detail?.enabled ? (
                !confirmRemove ? (
                  <button
                    type="button"
                    onClick={() => setConfirmRemove(true)}
                    className="text-xs text-destructive hover:underline"
                  >
                    Disable active monitoring
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
                      {disabling ? 'Disabling...' : 'Yes, disable'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmRemove(false)}
                      className="h-7 rounded-md border px-3 text-xs font-medium text-muted-foreground hover:text-foreground"
                    >
                      Cancel
                    </button>
                  </div>
                )
              ) : (
                <span className="text-xs text-muted-foreground">
                  Monitoring is not active for this asset.
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                className="h-9 rounded-md border px-4 text-sm font-medium text-muted-foreground hover:text-foreground"
              >
                Close
              </button>
              <button
                type="submit"
                disabled={saving}
                className="h-9 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-70 flex items-center gap-2"
              >
                {saving && <Loader2 className="h-3 w-3 animate-spin" />}
                {saving ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        </form>
      </div>

      {showCreateMonitorForm && (
        <CreateMonitorForm
          assetId={asset.id}
          defaultTarget={asset.ipAddress}
          onCreated={() => {
            setShowCreateMonitorForm(false);
            void onSaved();
          }}
          onCancel={() => setShowCreateMonitorForm(false)}
        />
      )}
    </div>
  );
}
