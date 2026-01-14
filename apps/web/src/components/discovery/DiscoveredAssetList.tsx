import { useCallback, useEffect, useState } from 'react';
import { EyeOff, Link2 } from 'lucide-react';
import AssetDetailModal, { type AssetDetail } from './AssetDetailModal';

export type DiscoveredAssetStatus = 'new' | 'linked' | 'ignored';
export type DiscoveredAssetType =
  | 'server'
  | 'workstation'
  | 'network'
  | 'printer'
  | 'router'
  | 'switch'
  | 'device'
  | 'unknown';

export type DiscoveredAsset = {
  id: string;
  ip: string;
  mac: string;
  hostname: string;
  type: DiscoveredAssetType;
  status: DiscoveredAssetStatus;
  manufacturer: string;
  lastSeen?: string;
  openPorts?: number[];
  osFingerprint?: string;
  snmpData?: Record<string, string>;
  linkedDeviceId?: string | null;
};

type ApiDiscoveryAsset = {
  id: string;
  assetType?: string;
  status: DiscoveredAssetStatus;
  hostname?: string | null;
  ipAddress?: string | null;
  macAddress?: string | null;
  manufacturer?: string | null;
  openPorts?: number[];
  osFingerprint?: string | null;
  snmpData?: Record<string, string> | null;
  linkedDeviceId?: string | null;
  createdAt?: string;
  updatedAt?: string;
};

type DeviceOption = { id: string; name: string };

const typeConfig: Record<DiscoveredAssetType, { label: string; color: string }> = {
  server: { label: 'Server', color: 'bg-blue-500/20 text-blue-700 border-blue-500/40' },
  workstation: { label: 'Workstation', color: 'bg-indigo-500/20 text-indigo-700 border-indigo-500/40' },
  network: { label: 'Network', color: 'bg-teal-500/20 text-teal-700 border-teal-500/40' },
  printer: { label: 'Printer', color: 'bg-orange-500/20 text-orange-700 border-orange-500/40' },
  router: { label: 'Router', color: 'bg-emerald-500/20 text-emerald-700 border-emerald-500/40' },
  switch: { label: 'Switch', color: 'bg-cyan-500/20 text-cyan-700 border-cyan-500/40' },
  device: { label: 'Device', color: 'bg-slate-500/20 text-slate-700 border-slate-500/40' },
  unknown: { label: 'Unknown', color: 'bg-muted text-muted-foreground border-muted' }
};

const statusConfig: Record<DiscoveredAssetStatus, { label: string; color: string }> = {
  new: { label: 'New', color: 'bg-green-500/20 text-green-700 border-green-500/40' },
  linked: { label: 'Linked', color: 'bg-blue-500/20 text-blue-700 border-blue-500/40' },
  ignored: { label: 'Ignored', color: 'bg-yellow-500/20 text-yellow-700 border-yellow-500/40' }
};

const assetTypeMap: Record<string, DiscoveredAssetType> = {
  server: 'server',
  workstation: 'workstation',
  network: 'network',
  printer: 'printer',
  router: 'router',
  switch: 'switch',
  device: 'device',
  unknown: 'unknown'
};

function formatLastSeen(value?: string) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
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
    lastSeen: asset.updatedAt ?? asset.createdAt,
    openPorts: asset.openPorts ?? [],
    osFingerprint: asset.osFingerprint ?? undefined,
    snmpData: asset.snmpData ?? undefined,
    linkedDeviceId: asset.linkedDeviceId
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

export default function DiscoveredAssetList() {
  const [assets, setAssets] = useState<DiscoveredAsset[]>([]);
  const [devices, setDevices] = useState<DeviceOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [selectedAsset, setSelectedAsset] = useState<AssetDetail | null>(null);

  const fetchAssets = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);
      const response = await fetch('/api/discovery/assets');
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
  }, []);

  const fetchDevices = useCallback(async () => {
    try {
      const response = await fetch('/api/devices');
      if (!response.ok) return;
      const data = await response.json();
      setDevices(data.devices ?? data.data ?? data ?? []);
    } catch {
      // Silently fail
    }
  }, []);

  useEffect(() => {
    fetchAssets();
    fetchDevices();
  }, [fetchAssets, fetchDevices]);

  const handleIgnore = async (asset: DiscoveredAsset) => {
    try {
      setError(undefined);
      const response = await fetch(`/api/discovery/assets/${asset.id}/ignore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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

      <div className="mt-6 overflow-hidden rounded-md border">
        <table className="min-w-full divide-y">
          <thead className="bg-muted/40">
            <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-3">IP Address</th>
              <th className="px-4 py-3">MAC</th>
              <th className="px-4 py-3">Hostname</th>
              <th className="px-4 py-3">Type</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Manufacturer</th>
              <th className="px-4 py-3">Last Seen</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {assets.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-6 text-center text-sm text-muted-foreground">
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
                  <td className="px-4 py-3 text-sm">{asset.manufacturer}</td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">{formatLastSeen(asset.lastSeen)}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-2">
                      <button
                        type="button"
                        onClick={event => {
                          event.stopPropagation();
                          setSelectedAsset(toDetail(asset));
                        }}
                        className="flex h-8 w-8 items-center justify-center rounded-md border hover:bg-muted"
                        title="Link asset"
                      >
                        <Link2 className="h-4 w-4" />
                      </button>
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
