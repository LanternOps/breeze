import { useCallback, useEffect, useState } from 'react';
import { EyeOff, Info, Signal, CheckCircle2 } from 'lucide-react';
import AssetDetailModal, { type AssetDetail } from './AssetDetailModal';
import { fetchWithAuth } from '../../stores/auth';

export type DiscoveredAssetStatus = 'new' | 'identified' | 'managed' | 'ignored' | 'offline';
export type DiscoveredAssetType =
  | 'workstation'
  | 'server'
  | 'printer'
  | 'router'
  | 'switch'
  | 'firewall'
  | 'access_point'
  | 'phone'
  | 'iot'
  | 'camera'
  | 'nas'
  | 'unknown';

export type OpenPortEntry = { port: number; service: string };

export type DiscoveredAsset = {
  id: string;
  ip: string;
  mac: string;
  hostname: string;
  type: DiscoveredAssetType;
  status: DiscoveredAssetStatus;
  manufacturer: string;
  lastSeen?: string;
  openPorts?: OpenPortEntry[];
  osFingerprint?: string;
  snmpData?: Record<string, string>;
  responseTimeMs?: number | null;
  linkedDeviceId?: string | null;
  linkedDeviceName?: string;
  monitoringEnabled?: boolean;
  discoveryMethods?: string[];
};

type ApiDiscoveryAsset = {
  id: string;
  assetType?: string;
  status: DiscoveredAssetStatus;
  hostname?: string | null;
  ipAddress?: string | null;
  macAddress?: string | null;
  manufacturer?: string | null;
  openPorts?: Array<{ port: number; service: string } | number> | null;
  osFingerprint?: string | null;
  snmpData?: Record<string, string> | null;
  responseTimeMs?: number | null;
  linkedDeviceId?: string | null;
  linkedDeviceName?: string | null;
  monitoringEnabled?: boolean;
  discoveryMethods?: string[] | null;
  lastSeenAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
};

type DeviceOption = { id: string; name: string };

export const typeConfig: Record<DiscoveredAssetType, { label: string; color: string }> = {
  workstation: { label: 'Workstation', color: 'bg-indigo-500/20 text-indigo-700 border-indigo-500/40' },
  server: { label: 'Server', color: 'bg-blue-500/20 text-blue-700 border-blue-500/40' },
  printer: { label: 'Printer', color: 'bg-orange-500/20 text-orange-700 border-orange-500/40' },
  router: { label: 'Router', color: 'bg-emerald-500/20 text-emerald-700 border-emerald-500/40' },
  switch: { label: 'Switch', color: 'bg-cyan-500/20 text-cyan-700 border-cyan-500/40' },
  firewall: { label: 'Firewall', color: 'bg-red-500/20 text-red-700 border-red-500/40' },
  access_point: { label: 'Access Point', color: 'bg-teal-500/20 text-teal-700 border-teal-500/40' },
  phone: { label: 'Phone', color: 'bg-violet-500/20 text-violet-700 border-violet-500/40' },
  iot: { label: 'IoT', color: 'bg-amber-500/20 text-amber-700 border-amber-500/40' },
  camera: { label: 'Camera', color: 'bg-pink-500/20 text-pink-700 border-pink-500/40' },
  nas: { label: 'NAS', color: 'bg-sky-500/20 text-sky-700 border-sky-500/40' },
  unknown: { label: 'Unknown', color: 'bg-muted text-muted-foreground border-muted' }
};

export const statusConfig: Record<DiscoveredAssetStatus, { label: string; color: string }> = {
  new: { label: 'New', color: 'bg-green-500/20 text-green-700 border-green-500/40' },
  identified: { label: 'Identified', color: 'bg-purple-500/20 text-purple-700 border-purple-500/40' },
  managed: { label: 'Managed', color: 'bg-blue-500/20 text-blue-700 border-blue-500/40' },
  ignored: { label: 'Ignored', color: 'bg-yellow-500/20 text-yellow-700 border-yellow-500/40' },
  offline: { label: 'Offline', color: 'bg-gray-500/20 text-gray-700 border-gray-500/40' }
};

const assetTypeMap: Record<string, DiscoveredAssetType> = {
  workstation: 'workstation',
  server: 'server',
  printer: 'printer',
  router: 'router',
  switch: 'switch',
  firewall: 'firewall',
  access_point: 'access_point',
  phone: 'phone',
  iot: 'iot',
  camera: 'camera',
  nas: 'nas',
  unknown: 'unknown'
};

function formatLastSeen(value?: string, timezone?: string) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString([], { timeZone: timezone });
}

function formatPing(ms?: number | null) {
  if (ms == null) return '—';
  if (ms < 1) return '<1 ms';
  return `${ms.toFixed(1)} ms`;
}

function pingColor(ms?: number | null) {
  if (ms == null) return 'text-muted-foreground';
  if (ms < 5) return 'text-green-600';
  if (ms < 50) return 'text-emerald-600';
  if (ms < 200) return 'text-yellow-600';
  return 'text-red-600';
}

function normalizeOpenPorts(raw: ApiDiscoveryAsset['openPorts']): OpenPortEntry[] {
  if (!raw) return [];
  return raw.map((p: any) =>
    typeof p === 'number' ? { port: p, service: '' } : { port: p.port, service: p.service ?? '' }
  );
}

function mapAsset(asset: ApiDiscoveryAsset): DiscoveredAsset {
  return {
    id: asset.id,
    ip: asset.ipAddress ?? '—',
    mac: asset.macAddress ?? '—',
    hostname: asset.hostname ?? '',
    type: assetTypeMap[(asset.assetType ?? 'unknown').toLowerCase()] ?? 'unknown',
    status: asset.status,
    manufacturer: asset.manufacturer ?? '—',
    lastSeen: asset.lastSeenAt ?? asset.updatedAt ?? asset.createdAt,
    openPorts: normalizeOpenPorts(asset.openPorts),
    osFingerprint: asset.osFingerprint ?? undefined,
    snmpData: asset.snmpData ?? undefined,
    responseTimeMs: asset.responseTimeMs ?? null,
    linkedDeviceId: asset.linkedDeviceId,
    linkedDeviceName: asset.linkedDeviceName ?? undefined,
    monitoringEnabled: asset.monitoringEnabled ?? false,
    discoveryMethods: asset.discoveryMethods ?? undefined
  };
}

function toDetail(asset: DiscoveredAsset): AssetDetail {
  return {
    ...asset,
    openPorts: asset.openPorts ?? [],
    osFingerprint: asset.osFingerprint ?? '—',
    snmpData: asset.snmpData ?? {},
    linkedDeviceId: asset.linkedDeviceId ?? undefined
  };
}

interface DiscoveredAssetListProps {
  timezone?: string;
}

export default function DiscoveredAssetList({ timezone }: DiscoveredAssetListProps) {
  const [assets, setAssets] = useState<DiscoveredAsset[]>([]);
  const [devices, setDevices] = useState<DeviceOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [selectedAsset, setSelectedAsset] = useState<AssetDetail | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [typeFilter, setTypeFilter] = useState<string>('all');

  const fetchAssets = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);
      const params = new URLSearchParams();
      if (statusFilter !== 'all') params.set('status', statusFilter);
      if (typeFilter !== 'all') params.set('assetType', typeFilter);
      const qs = params.toString();
      const response = await fetchWithAuth(`/discovery/assets${qs ? `?${qs}` : ''}`);
      if (!response.ok) {
        throw new Error('Failed to fetch discovered assets');
      }
      const data = await response.json();
      const items = data.data ?? data.assets ?? data ?? [];
      setAssets(items.map(mapAsset));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, [statusFilter, typeFilter]);

  const fetchDevices = useCallback(async () => {
    try {
      const response = await fetchWithAuth('/devices');
      if (!response.ok) {
        console.warn('[DiscoveredAssetList] Failed to fetch devices:', response.status);
        return;
      }
      const data = await response.json();
      setDevices(data.devices ?? data.data ?? data ?? []);
    } catch (err) {
      console.warn('[DiscoveredAssetList] Failed to fetch devices:', err);
    }
  }, []);

  useEffect(() => {
    fetchAssets();
    fetchDevices();
  }, [fetchAssets, fetchDevices]);

  const handleIgnore = async (asset: DiscoveredAsset) => {
    try {
      setError(undefined);
      const response = await fetchWithAuth(`/discovery/assets/${asset.id}/ignore`, {
        method: 'POST',
        body: JSON.stringify({})
      });

      if (!response.ok) {
        throw new Error('Failed to ignore asset');
      }

      await fetchAssets();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    }
  };

  if (loading && assets.length === 0) {
    return (
      <div className="flex items-center justify-center rounded-lg border bg-card p-10 shadow-sm">
        <div className="text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <p className="mt-4 text-sm text-muted-foreground">Loading discovered assets...</p>
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
          onClick={fetchAssets}
          className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          Try again
        </button>
      </div>
    );
  }

  return (
    <div className="rounded-lg border bg-card p-6 shadow-sm">
      <div>
        <h2 className="text-lg font-semibold">Discovered Assets</h2>
        <p className="text-sm text-muted-foreground">Review assets detected in your environment.</p>
      </div>

      {error && assets.length > 0 && (
        <div className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <select
          value={statusFilter}
          onChange={e => setStatusFilter(e.target.value)}
          className="h-9 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        >
          <option value="all">All statuses</option>
          {(Object.keys(statusConfig) as DiscoveredAssetStatus[]).map(key => (
            <option key={key} value={key}>{statusConfig[key].label}</option>
          ))}
        </select>
        <select
          value={typeFilter}
          onChange={e => setTypeFilter(e.target.value)}
          className="h-9 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        >
          <option value="all">All types</option>
          {(Object.keys(typeConfig) as DiscoveredAssetType[]).map(key => (
            <option key={key} value={key}>{typeConfig[key].label}</option>
          ))}
        </select>
        {(statusFilter !== 'all' || typeFilter !== 'all') && (
          <button
            type="button"
            onClick={() => { setStatusFilter('all'); setTypeFilter('all'); }}
            className="h-9 rounded-md border px-3 text-sm text-muted-foreground hover:text-foreground"
          >
            Clear filters
          </button>
        )}
      </div>

      <div className="mt-4 overflow-hidden rounded-md border">
        <table className="min-w-full divide-y">
          <thead className="bg-muted/40">
            <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-3">IP Address</th>
              <th className="px-4 py-3">MAC</th>
              <th className="px-4 py-3">Hostname</th>
              <th className="px-4 py-3">Type</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Ping</th>
              <th className="px-4 py-3">Monitoring</th>
              <th className="px-4 py-3">Manufacturer</th>
              <th className="px-4 py-3">Last Seen</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {assets.length === 0 ? (
              <tr>
                <td colSpan={10} className="px-4 py-6 text-center text-sm text-muted-foreground">
                  No assets discovered yet.
                </td>
              </tr>
            ) : (
              assets.map(asset => (
                <tr
                  key={asset.id}
                  onClick={() => setSelectedAsset(toDetail(asset))}
                  className="cursor-pointer transition hover:bg-muted/40"
                >
                  <td className="px-4 py-3 text-sm font-medium">{asset.ip}</td>
                  <td className="px-4 py-3 text-sm text-muted-foreground">{asset.mac}</td>
                  <td className="px-4 py-3 text-sm">{asset.hostname || '—'}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${typeConfig[asset.type].color}`}>
                      {typeConfig[asset.type].label}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${statusConfig[asset.status].color}`}>
                      {statusConfig[asset.status].label}
                    </span>
                  </td>
                  <td className={`px-4 py-3 text-xs font-mono ${pingColor(asset.responseTimeMs)}`}>
                    {formatPing(asset.responseTimeMs)}
                  </td>
                  <td className="px-4 py-3">
                    <Signal className={`h-4 w-4 ${asset.monitoringEnabled ? 'text-green-600' : 'text-muted-foreground/40'}`} />
                  </td>
                  <td className="px-4 py-3 text-sm">{asset.manufacturer}</td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">{formatLastSeen(asset.lastSeen, timezone)}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-2">
                      {asset.linkedDeviceId ? (
                        <span className="inline-flex items-center gap-1 text-xs text-green-700" title={asset.linkedDeviceName || asset.linkedDeviceId}>
                          <CheckCircle2 className="h-3.5 w-3.5" />
                          {asset.linkedDeviceName || 'Linked'}
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={event => {
                            event.stopPropagation();
                            setSelectedAsset(toDetail(asset));
                          }}
                          className="flex h-8 w-8 items-center justify-center rounded-md border hover:bg-muted"
                          title="View details"
                        >
                          <Info className="h-4 w-4" />
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={event => {
                          event.stopPropagation();
                          handleIgnore(asset);
                        }}
                        className="flex h-8 w-8 items-center justify-center rounded-md border border-muted text-muted-foreground hover:bg-muted"
                        title="Ignore asset"
                      >
                        <EyeOff className="h-4 w-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <AssetDetailModal
        open={selectedAsset !== null}
        asset={selectedAsset}
        devices={devices}
        onClose={() => setSelectedAsset(null)}
        onLinked={async () => {
          setSelectedAsset(null);
          await fetchAssets();
        }}
      />
    </div>
  );
}
