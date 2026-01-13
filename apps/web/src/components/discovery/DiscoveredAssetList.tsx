import { Link2, EyeOff } from 'lucide-react';

export type DiscoveredAssetStatus = 'new' | 'linked' | 'ignored';
export type DiscoveredAssetType = 'server' | 'workstation' | 'network' | 'printer' | 'unknown';

export type DiscoveredAsset = {
  id: string;
  ip: string;
  mac: string;
  hostname: string;
  type: DiscoveredAssetType;
  status: DiscoveredAssetStatus;
  manufacturer: string;
  lastSeen?: string;
};

type DiscoveredAssetListProps = {
  assets: DiscoveredAsset[];
  onLink?: (asset: DiscoveredAsset) => void;
  onIgnore?: (asset: DiscoveredAsset) => void;
  onSelect?: (asset: DiscoveredAsset) => void;
};

const typeConfig: Record<DiscoveredAssetType, { label: string; color: string }> = {
  server: { label: 'Server', color: 'bg-blue-500/20 text-blue-700 border-blue-500/40' },
  workstation: { label: 'Workstation', color: 'bg-indigo-500/20 text-indigo-700 border-indigo-500/40' },
  network: { label: 'Network', color: 'bg-teal-500/20 text-teal-700 border-teal-500/40' },
  printer: { label: 'Printer', color: 'bg-orange-500/20 text-orange-700 border-orange-500/40' },
  unknown: { label: 'Unknown', color: 'bg-muted text-muted-foreground border-muted' }
};

const statusConfig: Record<DiscoveredAssetStatus, { label: string; color: string }> = {
  new: { label: 'New', color: 'bg-green-500/20 text-green-700 border-green-500/40' },
  linked: { label: 'Linked', color: 'bg-blue-500/20 text-blue-700 border-blue-500/40' },
  ignored: { label: 'Ignored', color: 'bg-yellow-500/20 text-yellow-700 border-yellow-500/40' }
};

function formatLastSeen(value?: string) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

export default function DiscoveredAssetList({
  assets,
  onLink,
  onIgnore,
  onSelect
}: DiscoveredAssetListProps) {
  return (
    <div className="rounded-lg border bg-card p-6 shadow-sm">
      <div>
        <h2 className="text-lg font-semibold">Discovered Assets</h2>
        <p className="text-sm text-muted-foreground">Review assets detected in your environment.</p>
      </div>

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
                  onClick={() => onSelect?.(asset)}
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
                          onLink?.(asset);
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
                          onIgnore?.(asset);
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
    </div>
  );
}
