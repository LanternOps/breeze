import React from 'react';
import { Package } from 'lucide-react';
import { type Asset } from '@/lib/api';
import { formatRelativeTime } from '@/lib/utils';
import { cn } from '@/lib/utils';
import { ROW, CELL, TH, PageHeader, StatusMark, EmptyState, ErrorNotice, type MarkTone } from './ui';

interface AssetListProps {
  assets: Asset[];
  error?: string | null;
}

// Same OS label as DeviceList: the platform family replaces the raw osType id,
// and the raw hostname only appears when a device was never given a display
// name. Duplicated locally rather than shared, per repo convention.
const OS_LABELS: Record<string, string> = {
  windows: 'Windows',
  macos: 'Mac',
  linux: 'Linux',
};

function osLabel(osType: string | null): string {
  if (!osType) return 'Unknown';
  return OS_LABELS[osType.toLowerCase()] ?? osType;
}

function statusMark(status: Asset['status']): { tone: MarkTone; label: string } {
  switch (status) {
    case 'online':
      return { tone: 'success', label: 'Online' };
    case 'offline':
      return { tone: 'neutral', label: 'Offline' };
    case 'warning':
      return { tone: 'warning', label: 'Warning' };
  }
}

export function AssetList({ assets, error }: AssetListProps) {
  if (error) {
    return <ErrorNotice>{error}</ErrorNotice>;
  }

  return (
    <div>
      <PageHeader title="Equipment" lede="Everything checked out to you." />

      {assets.length === 0 ? (
        <EmptyState icon={<Package className="h-10 w-10" strokeWidth={1.5} />} title="No equipment">
          <p className="mt-1 text-sm text-muted-foreground">
            Nothing checked out to you right now.
          </p>
        </EmptyState>
      ) : (
        <div className="overflow-x-auto">
          <table className="block w-full sm:table sm:min-w-[36rem]">
            <thead className="hidden border-b border-border sm:table-header-group">
              <tr>
                <th scope="col" className={cn(TH, 'text-left')}>
                  Device
                </th>
                <th scope="col" className={cn(TH, 'text-left')}>
                  Type
                </th>
                <th scope="col" className={cn(TH, 'text-left')}>
                  Status
                </th>
                <th scope="col" className={cn(TH, 'text-left')}>
                  Last seen
                </th>
              </tr>
            </thead>
            <tbody className="block divide-y divide-border/70 sm:table-row-group">
              {assets.map((asset) => {
                const mark = statusMark(asset.status);
                return (
                  <tr key={asset.id} className={ROW}>
                    {/* order-* reorders the card: the device name and its status
                        share the first line, the platform detail trails muted. */}
                    <td className={cn(CELL, 'order-1 grow')}>
                      <span className="font-semibold text-foreground">
                        {asset.displayName || asset.hostname}
                      </span>
                    </td>
                    <td className={cn(CELL, 'order-3 text-xs text-muted-foreground sm:text-sm')}>
                      <span className="sm:hidden">Type </span>
                      {osLabel(asset.osType)}
                    </td>
                    <td className={cn(CELL, 'order-2 shrink-0')}>
                      <StatusMark tone={mark.tone}>
                        {mark.label}
                      </StatusMark>
                    </td>
                    <td className={cn(CELL, 'order-4 text-xs text-muted-foreground sm:text-sm')}>
                      <span className="sm:hidden">Last seen </span>
                      {asset.lastSeenAt ? formatRelativeTime(asset.lastSeenAt) : 'Not known'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div
            className="border-t border-border px-4 pt-3.5 text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground"
            data-testid="asset-ledger-foot"
          >
            {assets.length === 1 ? '1 item on file' : `${assets.length} items on file`}
          </div>
        </div>
      )}
    </div>
  );
}

export default AssetList;
