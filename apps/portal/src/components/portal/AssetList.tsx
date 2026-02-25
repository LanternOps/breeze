import React from 'react';
import { Package, AlertCircle } from 'lucide-react';
import { type Asset } from '@/lib/api';
import { formatRelativeTime } from '@/lib/utils';

interface AssetListProps {
  assets: Asset[];
  error?: string | null;
}

export function AssetList({ assets, error }: AssetListProps) {

  if (error) {
    return (
      <div className="rounded-md bg-destructive/10 p-4 text-center text-destructive">
        <AlertCircle className="mx-auto h-8 w-8" />
        <p className="mt-2">{error}</p>
      </div>
    );
  }

  if (assets.length === 0) {
    return (
      <div className="rounded-md border border-dashed p-8 text-center">
        <Package className="mx-auto h-12 w-12 text-muted-foreground" />
        <h3 className="mt-4 text-lg font-medium">No assets</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          No assets are currently associated with your account.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold">Your Assets</h2>

      <div className="overflow-hidden rounded-lg border">
        <table className="w-full">
          <thead className="bg-muted/50">
            <tr>
              <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">
                Device
              </th>
              <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">
                Hostname
              </th>
              <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">
                Platform
              </th>
              <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">
                Status
              </th>
              <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">
                Last Seen
              </th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {assets.map((asset) => (
              <tr key={asset.id} className="hover:bg-muted/50">
                <td className="px-4 py-3">
                  <div className="flex items-center gap-3">
                    <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-muted">
                      <Package className="h-4 w-4 text-muted-foreground" />
                    </div>
                    <span className="font-medium">{asset.displayName || asset.hostname}</span>
                  </div>
                </td>
                <td className="px-4 py-3 text-sm text-muted-foreground">{asset.hostname}</td>
                <td className="px-4 py-3 text-sm text-muted-foreground">
                  {asset.osType || '-'}
                </td>
                <td className="px-4 py-3 text-sm capitalize">
                  {asset.status}
                </td>
                <td className="px-4 py-3 text-sm text-muted-foreground">
                  {asset.lastSeenAt ? formatRelativeTime(asset.lastSeenAt) : '-'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default AssetList;
