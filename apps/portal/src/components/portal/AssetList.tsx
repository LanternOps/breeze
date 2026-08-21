import React from 'react';
import { Package, AlertCircle } from 'lucide-react';
import { type Asset } from '@/lib/api';
import { formatRelativeTime } from '@/lib/utils';
import { cn } from '@/lib/utils';

interface AssetListProps {
  assets: Asset[];
  error?: string | null;
}

// Below `sm` the row reflows from a table row into a stacked card; the old
// `overflow-hidden` wrapper clipped the rightmost columns on a phone with no
// scrollbar to reach them. At `sm` and up the real table semantics come back.
// One DOM tree either way, so data-testids and header scopes stay unique.
const ROW = 'flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-3 hover:bg-muted/50 sm:table-row sm:p-0';
const CELL = 'block sm:table-cell sm:px-4 sm:py-3';
const TH = 'px-4 py-3 text-left text-sm font-medium text-muted-foreground';

export function AssetList({ assets, error }: AssetListProps) {

  if (error) {
    return (
      <div role="alert" className="rounded-md bg-destructive/10 p-4 text-center text-destructive-on-tint">
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
        <div className="overflow-x-auto">
          <table className="block w-full sm:table sm:min-w-[40rem]">
            <thead className="hidden bg-muted/50 sm:table-header-group">
              <tr>
                <th scope="col" className={TH}>
                  Device
                </th>
                <th scope="col" className={TH}>
                  Hostname
                </th>
                <th scope="col" className={TH}>
                  Platform
                </th>
                <th scope="col" className={TH}>
                  Status
                </th>
                <th scope="col" className={TH}>
                  Last Seen
                </th>
              </tr>
            </thead>
            <tbody className="block divide-y sm:table-row-group">
              {assets.map((asset) => (
                <tr key={asset.id} className={ROW}>
                  {/* order-* reorders the card: the device name and its status
                      share the first line, the technical detail trails muted. */}
                  <td className={cn(CELL, 'order-1 grow')}>
                    <div className="flex items-center gap-3">
                      <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-muted">
                        <Package className="h-4 w-4 text-muted-foreground" />
                      </div>
                      <span className="font-medium">{asset.displayName || asset.hostname}</span>
                    </div>
                  </td>
                  <td className={cn(CELL, 'order-3 text-xs text-muted-foreground sm:text-sm')}>
                    <span className="sm:hidden">Hostname </span>
                    {asset.hostname}
                  </td>
                  <td className={cn(CELL, 'order-4 text-xs text-muted-foreground sm:text-sm')}>
                    <span className="sm:hidden">Platform </span>
                    {asset.osType || '-'}
                  </td>
                  <td className={cn(CELL, 'order-2 shrink-0 text-sm capitalize')}>
                    {asset.status}
                  </td>
                  <td className={cn(CELL, 'order-5 text-xs text-muted-foreground sm:text-sm')}>
                    <span className="sm:hidden">Last seen </span>
                    {asset.lastSeenAt ? formatRelativeTime(asset.lastSeenAt) : '-'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

export default AssetList;
