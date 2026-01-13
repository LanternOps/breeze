import { Monitor } from 'lucide-react';
import { cn, formatRelativeTime } from '@/lib/utils';

export type CustomerDeviceStatus = 'online' | 'offline' | 'maintenance';

export type CustomerDevice = {
  id: string;
  hostname: string;
  status: CustomerDeviceStatus;
  type: string;
  lastSeen?: string;
  siteName?: string;
};

type DeviceStatusCardProps = {
  device: CustomerDevice;
  onSelect?: (device: CustomerDevice) => void;
};

const statusStyles: Record<CustomerDeviceStatus, string> = {
  online: 'bg-emerald-500',
  offline: 'bg-rose-500',
  maintenance: 'bg-amber-500'
};

export default function DeviceStatusCard({ device, onSelect }: DeviceStatusCardProps) {
  const lastSeenLabel = device.lastSeen
    ? formatRelativeTime(new Date(device.lastSeen))
    : 'Unknown';

  return (
    <button
      type="button"
      onClick={() => onSelect?.(device)}
      className="flex w-full items-center justify-between rounded-lg border bg-card p-4 text-left shadow-sm transition hover:border-primary/40 hover:shadow"
    >
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-md bg-muted text-muted-foreground">
          <Monitor className="h-5 w-5" />
        </div>
        <div>
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-foreground">{device.hostname}</span>
            <span
              className={cn('h-2.5 w-2.5 rounded-full', statusStyles[device.status])}
            />
          </div>
          <div className="text-xs text-muted-foreground">
            {device.type}
            {device.siteName ? ` • ${device.siteName}` : ''}
          </div>
        </div>
      </div>

      <div className="text-xs text-muted-foreground">Last seen {lastSeenLabel}</div>
    </button>
  );
}
