import { Monitor } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { CustomerDevice, CustomerDeviceStatus } from './DeviceStatusCard';

type CustomerDeviceListProps = {
  devices: CustomerDevice[];
  onSelect?: (device: CustomerDevice) => void;
};

const statusBadge: Record<CustomerDeviceStatus, string> = {
  online: 'bg-emerald-500/15 text-emerald-700 border-emerald-500/30',
  offline: 'bg-rose-500/15 text-rose-700 border-rose-500/30',
  maintenance: 'bg-amber-500/15 text-amber-700 border-amber-500/30'
};

export default function CustomerDeviceList({ devices, onSelect }: CustomerDeviceListProps) {
  return (
    <div className="overflow-hidden rounded-lg border bg-card shadow-sm">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground">My Devices</h2>
          <p className="text-xs text-muted-foreground">
            {devices.length} devices linked to your account
          </p>
        </div>
      </div>
      <div className="divide-y">
        {devices.map(device => (
          <button
            key={device.id}
            type="button"
            onClick={() => onSelect?.(device)}
            className="flex w-full items-center justify-between px-4 py-3 text-left transition hover:bg-muted"
          >
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-md bg-muted text-muted-foreground">
                <Monitor className="h-4 w-4" />
              </div>
              <div>
                <div className="text-sm font-medium text-foreground">{device.hostname}</div>
                <div className="text-xs text-muted-foreground">{device.type}</div>
              </div>
            </div>
            <span
              className={cn(
                'rounded-full border px-2.5 py-1 text-xs font-medium',
                statusBadge[device.status]
              )}
            >
              {device.status}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
