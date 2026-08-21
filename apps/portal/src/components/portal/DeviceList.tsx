import React from 'react';
import { Monitor, Wifi, WifiOff, AlertTriangle } from 'lucide-react';
import { type Device } from '@/lib/api';
import { cn } from '@/lib/utils';

interface DeviceListProps {
  devices: Device[];
  error?: string | null;
}

// The portal's reader is the customer's office manager, not a technician, so the
// two formatters below are deliberately plainer than the shared helpers in
// `@/lib/utils` (which render "3d ago" and the raw platform id). Kept local to
// this component rather than changed in utils, which the rest of the app shares.
const OS_LABELS: Record<string, string> = {
  windows: 'Windows',
  macos: 'Mac',
  linux: 'Linux',
};

function osLabel(osType: string | null): string {
  if (!osType) return 'Unknown';
  return OS_LABELS[osType.toLowerCase()] ?? osType;
}

function lastSeenLabel(value: string | null): string {
  if (!value) return 'Not known';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return 'Not known';

  const diffMin = Math.floor((Date.now() - d.getTime()) / 60000);
  if (diffMin < 2) return 'Just now';
  if (diffMin < 60) return `${diffMin} minutes ago`;

  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return diffHour === 1 ? 'About an hour ago' : `About ${diffHour} hours ago`;

  const diffDay = Math.floor(diffHour / 24);
  if (diffDay === 1) return 'Yesterday';
  if (diffDay < 7) return `${diffDay} days ago`;

  return `On ${d.toLocaleDateString()}`;
}

export function DeviceList({ devices, error }: DeviceListProps) {

  if (error) {
    return (
      <div role="alert" className="rounded-md bg-destructive/10 p-4 text-center text-destructive-on-tint">
        {error}
      </div>
    );
  }

  if (devices.length === 0) {
    return (
      <div className="rounded-md border border-dashed p-8 text-center">
        <Monitor className="mx-auto h-12 w-12 text-muted-foreground" />
        <h3 className="mt-4 text-lg font-medium">No devices</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          No devices are currently associated with your account.
        </p>
      </div>
    );
  }

  // These sit on the card's plain background, not on a /10 tint, but the base
  // `success`/`warning` tokens are background-tuned and fail AA (and the 3:1
  // graphics threshold) there too; the `-on-tint` variants are darker.
  const getStatusIcon = (status: Device['status']) => {
    switch (status) {
      case 'online':
        return <Wifi className="h-4 w-4 text-success-on-tint" />;
      case 'offline':
        return <WifiOff className="h-4 w-4 text-muted-foreground" />;
      case 'warning':
        return <AlertTriangle className="h-4 w-4 text-warning-on-tint" />;
    }
  };

  const getStatusLabel = (status: Device['status']) => {
    switch (status) {
      case 'online':
        return 'Online';
      case 'offline':
        return 'Offline';
      case 'warning':
        return 'Warning';
    }
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {devices.map((device) => (
          <div
            key={device.id}
            className="rounded-lg border bg-card p-4 shadow-xs transition-shadow hover:shadow-md"
          >
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted">
                  <Monitor className="h-5 w-5 text-muted-foreground" />
                </div>
                {/* The friendly name only; the raw hostname used to sit under it
                    as a subtitle, which is a technician's handle for the machine
                    and means nothing to the reader. It stays as the fallback
                    heading for a device that was never given a display name. */}
                <h3 className="font-medium">{device.displayName || device.hostname}</h3>
              </div>
              <div className="flex items-center gap-1">
                {getStatusIcon(device.status)}
                <span
                  className={cn(
                    'text-xs font-medium',
                    device.status === 'online' && 'text-success-on-tint',
                    device.status === 'offline' && 'text-muted-foreground',
                    device.status === 'warning' && 'text-warning-on-tint'
                  )}
                >
                  {getStatusLabel(device.status)}
                </span>
              </div>
            </div>

            <div className="mt-4 grid grid-cols-2 gap-2 text-xs">
              <div>
                {/* Platform family only. The build number ("10.0.19045") means
                    nothing to the person reading this. */}
                <span className="text-muted-foreground">Type:</span>{' '}
                <span>{osLabel(device.osType)}</span>
              </div>
              <div>
                <span className="text-muted-foreground">Last seen:</span>{' '}
                <span>{lastSeenLabel(device.lastSeenAt)}</span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default DeviceList;
