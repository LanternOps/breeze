import { useCallback, useEffect, useState } from 'react';
import { Info, Signal, CheckCircle2, XCircle } from 'lucide-react';
import AssetDetailModal, { type AssetDetail } from './AssetDetailModal';
import { fetchWithAuth } from '../../stores/auth';

export type DiscoveredAssetApprovalStatus = 'pending' | 'approved' | 'dismissed';
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
  label?: string | null;
  type: DiscoveredAssetType;
  approvalStatus: DiscoveredAssetApprovalStatus;
  isOnline: boolean;
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
  notes?: string | null;
  tags?: string[];
};

type ApiDiscoveryAsset = {
  id: string;
  assetType?: string;
  approvalStatus?: DiscoveredAssetApprovalStatus;
  isOnline?: boolean;
  hostname?: string | null;
  label?: string | null;
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
  notes?: string | null;
  tags?: string[] | null;
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

export const approvalStatusConfig: Record<DiscoveredAssetApprovalStatus, { label: string; color: string }> = {
  pending:   { label: 'Pending',   color: 'bg-amber-500/20 text-amber-700 border-amber-500/40' },
  approved:  { label: 'Approved',  color: 'bg-green-500/20 text-green-700 border-green-500/40' },
  dismissed: { label: 'Dismissed', color: 'bg-muted text-muted-foreground border-muted' }
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
    label: asset.label ?? null,
    type: assetTypeMap[(asset.assetType ?? 'unknown').toLowerCase()] ?? 'unknown',
    approvalStatus: asset.approvalStatus ?? 'pending',
    isOnline: asset.isOnline ?? false,
    manufacturer: asset.manufacturer ?? '—',
    lastSeen: asset.lastSeenAt ?? asset.updatedAt ?? asset.createdAt,
    openPorts: normalizeOpenPorts(asset.openPorts),
    osFingerprint: asset.osFingerprint ?? undefined,
    snmpData: asset.snmpData ?? undefined,
    responseTimeMs: asset.responseTimeMs ?? null,
    linkedDeviceId: asset.linkedDeviceId,
    linkedDeviceName: asset.linkedDeviceName ?? undefined,
    monitoringEnabled: asset.monitoringEnabled ?? false,
    discoveryMethods: asset.discoveryMethods ?? undefined,
    notes: asset.notes ?? null,
    tags: asset.tags ?? undefined
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
  const [approvalFilter, setApprovalFilter] = useState<string>('all');
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [selectedAssetIds, setSelectedAssetIds] = useState<Set<string>>(new Set());
  const [bulkActing, setBulkActing] = useState(false);

  const fetchAssets = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);
      const params = new URLSearchParams();
      if (approvalFilter !== 'all') params.set('approvalStatus', approvalFilter);
      if (typeFilter !== 'all') params.set('assetType', typeFilter);
      const qs = params.toString();
      const response = await fetchWithAuth(`/discovery/assets${qs ? `?${qs}` : ''}`);
      if (!response.ok) {
        throw new Error('Failed to fetch discovered assets');
      }
      const data = await response.json();
      const items = data.data ?? data.assets ?? data ?? [];
      const mappedAssets = items.map(mapAsset);
      setAssets(mappedAssets);
      const validIds = new Set(mappedAssets.map((asset: DiscoveredAsset) => asset.id));
      setSelectedAssetIds(prev => new Set([...prev].filter(id => validIds.has(id))));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, [approvalFilter, typeFilter]);

  const fetchDevices = useCallback(async () => {
    try {
      const response = await fetchWithAuth('/devices');
      if (!response.ok) {
        console.warn('[DiscoveredAssetList] Failed to fetch devices:', response.status);
        return;
      }
      const data = await response.json();
      const raw: any[] = data.devices ?? data.data ?? data ?? [];
      setDevices(raw.map((d: any) => ({ id: d.id, name: d.displayName || d.hostname || d.id })));
    } catch (err) {
      console.warn('[DiscoveredAssetList] Failed to fetch devices:', err);
    }
  }, []);

  useEffect(() => {
    fetchAssets();
    fetchDevices();
  }, [fetchAssets, fetchDevices]);

  const handleApprove = async (asset: DiscoveredAsset) => {
    try {
      setError(undefined);
      const response = await fetchWithAuth(`/discovery/assets/${asset.id}/approve`, {
        method: 'PATCH'
      });
      if (!response.ok) {
        throw new Error('Failed to approve asset');
      }
      await fetchAssets();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    }
  };

  const handleDismiss = async (asset: DiscoveredAsset) => {
    try {
      setError(undefined);
      const response = await fetchWithAuth(`/discovery/assets/${asset.id}/dismiss`, {
        method: 'PATCH'
      });
      if (!response.ok) {
        throw new Error('Failed to dismiss asset');
      }
      await fetchAssets();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    }
  };

  const toggleAssetSelection = (assetId: string) => {
    setSelectedAssetIds(prev => {
      const next = new Set(prev);
      if (next.has(assetId)) {
        next.delete(assetId);
      } else {
        next.add(assetId);
      }
      return next;
    });
  };

  const allVisibleSelected = assets.length > 0 && assets.every(asset => selectedAssetIds.has(asset.id));
  const selectedCount = assets.filter(asset => selectedAssetIds.has(asset.id)).length;

  const toggleSelectAllVisible = () => {
    setSelectedAssetIds(prev => {
      const next = new Set(prev);
      if (allVisibleSelected) {
        for (const asset of assets) next.delete(asset.id);
      } else {
        for (const asset of assets) next.add(asset.id);
      }
      return next;
    });
  };

  const handleBulkApprove = async () => {
    const ids = [...selectedAssetIds];
    if (ids.length === 0) return;
    try {
      setBulkActing(true);
      setError(undefined);
      const response = await fetchWithAuth('/discovery/assets/bulk-approve', {
        method: 'POST',
        body: JSON.stringify({ assetIds: ids })
      });
      if (!response.ok) {
        throw new Error('Failed to approve selected assets');
      }
      setSelectedAssetIds(new Set());
      await fetchAssets();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setBulkActing(false);
    }
  };

  const handleBulkDismiss = async () => {
    const ids = [...selectedAssetIds];
    if (ids.length === 0) return;
    try {
      setBulkActing(true);
      setError(undefined);
      const response = await fetchWithAuth('/discovery/assets/bulk-dismiss', {
        method: 'POST',
        body: JSON.stringify({ assetIds: ids })
      });
      if (!response.ok) {
        throw new Error('Failed to dismiss selected assets');
      }
      setSelectedAssetIds(new Set());
      await fetchAssets();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setBulkActing(false);
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
          value={approvalFilter}
          onChange={e => setApprovalFilter(e.target.value)}
          className="h-9 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        >
          <option value="all">All statuses</option>
          <option value="pending">Pending</option>
          <option value="approved">Approved</option>
          <option value="dismissed">Dismissed</option>
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
        {(approvalFilter !== 'all' || typeFilter !== 'all') && (
          <button
            type="button"
            onClick={() => { setApprovalFilter('all'); setTypeFilter('all'); }}
            className="h-9 rounded-md border px-3 text-sm text-muted-foreground hover:text-foreground"
          >
            Clear filters
          </button>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={toggleSelectAllVisible}
          className="h-8 rounded-md border px-3 text-xs font-medium hover:bg-muted"
        >
          {allVisibleSelected ? 'Deselect all visible' : 'Select all visible'}
        </button>
        <button
          type="button"
          onClick={() => setSelectedAssetIds(new Set())}
          disabled={selectedCount === 0}
          className="h-8 rounded-md border px-3 text-xs font-medium text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
        >
          Clear selection
        </button>
        <button
          type="button"
          onClick={handleBulkApprove}
          disabled={selectedCount === 0 || bulkActing}
          className="h-8 rounded-md border border-green-500/40 px-3 text-xs font-medium text-green-700 hover:bg-green-500/10 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {bulkActing ? 'Approving...' : `Approve selected (${selectedCount})`}
        </button>
        <button
          type="button"
          onClick={handleBulkDismiss}
          disabled={selectedCount === 0 || bulkActing}
          className="h-8 rounded-md border px-3 text-xs font-medium text-muted-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
        >
          {bulkActing ? 'Dismissing...' : `Dismiss selected (${selectedCount})`}
        </button>
      </div>

      <div className="mt-4 overflow-hidden rounded-md border">
        <table className="min-w-full divide-y">
          <thead className="bg-muted/40">
            <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-3 w-10">
                <input
                  type="checkbox"
                  aria-label="Select all visible assets"
                  checked={allVisibleSelected}
                  onChange={toggleSelectAllVisible}
                  className="h-4 w-4 rounded border-muted-foreground/40"
                />
              </th>
              <th className="px-4 py-3">Host</th>
              <th className="px-4 py-3">Type</th>
              <th className="px-4 py-3">Approval</th>
              <th className="px-4 py-3">Last Seen</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {assets.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-sm text-muted-foreground">
                  No assets discovered yet.
                </td>
              </tr>
            ) : (
              assets.map(asset => (
                <tr
                  key={asset.id}
                  onClick={() => setSelectedAsset(toDetail(asset))}
                  className={`cursor-pointer transition hover:bg-muted/40 ${asset.approvalStatus === 'pending' ? 'border-l-2 border-l-amber-400' : ''}`}
                >
                  <td className="px-4 py-3 align-top">
                    <input
                      type="checkbox"
                      aria-label={`Select asset ${asset.hostname || asset.ip}`}
                      checked={selectedAssetIds.has(asset.id)}
                      onClick={event => event.stopPropagation()}
                      onChange={() => toggleAssetSelection(asset.id)}
                      className="mt-0.5 h-4 w-4 rounded border-muted-foreground/40"
                    />
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${asset.isOnline ? 'bg-green-500' : 'bg-muted-foreground/40'}`} title={asset.isOnline ? 'Online' : 'Offline'} />
                      <div className="min-w-0">
                        {asset.label && (
                          <div className="text-sm font-semibold truncate">{asset.label}</div>
                        )}
                        <div className="flex items-baseline gap-2">
                          <span className={`text-sm ${asset.label ? 'text-muted-foreground' : 'font-medium'} truncate`}>{asset.hostname || asset.ip}</span>
                          {asset.hostname && <span className="text-xs text-muted-foreground font-mono">{asset.ip}</span>}
                        </div>
                        <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                          {asset.mac !== '—' && <span className="font-mono">{asset.mac}</span>}
                          {asset.manufacturer !== '—' && <span>{asset.manufacturer}</span>}
                          {asset.responseTimeMs != null && (
                            <span className={`font-mono ${pingColor(asset.responseTimeMs)}`}>{formatPing(asset.responseTimeMs)}</span>
                          )}
                          {asset.monitoringEnabled && (
                            <span className="inline-flex items-center gap-0.5 text-green-600">
                              <Signal className="h-3 w-3" />
                              Monitored
                            </span>
                          )}
                          {asset.linkedDeviceName && (
                            <span className="inline-flex items-center gap-0.5 text-green-700">
                              <CheckCircle2 className="h-3 w-3" />
                              {asset.linkedDeviceName}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3 align-top">
                    <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${typeConfig[asset.type].color}`}>
                      {typeConfig[asset.type].label}
                    </span>
                  </td>
                  <td className="px-4 py-3 align-top">
                    <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${approvalStatusConfig[asset.approvalStatus].color}`}>
                      {approvalStatusConfig[asset.approvalStatus].label}
                    </span>
                  </td>
                  <td className="px-4 py-3 align-top text-xs text-muted-foreground whitespace-nowrap">{formatLastSeen(asset.lastSeen, timezone)}</td>
                  <td className="px-4 py-3 align-top">
                    <div className="flex items-center justify-end gap-2">
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
                      {asset.approvalStatus !== 'approved' && (
                        <button
                          type="button"
                          onClick={event => {
                            event.stopPropagation();
                            void handleApprove(asset);
                          }}
                          className="flex h-8 w-8 items-center justify-center rounded-md border border-green-500/40 text-green-700 hover:bg-green-500/10"
                          title="Approve"
                        >
                          <CheckCircle2 className="h-4 w-4" />
                        </button>
                      )}
                      {asset.approvalStatus !== 'dismissed' && (
                        <button
                          type="button"
                          onClick={event => {
                            event.stopPropagation();
                            void handleDismiss(asset);
                          }}
                          className="flex h-8 w-8 items-center justify-center rounded-md border hover:bg-muted"
                          title="Dismiss"
                        >
                          <XCircle className="h-4 w-4" />
                        </button>
                      )}
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
        onDeleted={async () => {
          setSelectedAsset(null);
          await fetchAssets();
        }}
        onUpdated={async () => {
          await fetchAssets();
        }}
      />
    </div>
  );
}
