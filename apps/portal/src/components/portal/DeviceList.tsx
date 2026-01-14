import React, { useEffect, useState } from 'react';
import { Monitor, Wifi, WifiOff, AlertTriangle, Loader2 } from 'lucide-react';
import { portalApi, type Device } from '@/lib/api';
import { formatRelativeTime } from '@/lib/utils';
import { cn } from '@/lib/utils';

export function DeviceList() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchDevices() {
      const result = await portalApi.getDevices();
      if (result.data) {
        setDevices(result.data);
      } else {
        setError(result.error || 'Failed to load devices');
      }
      setIsLoading(false);
    }

    fetchDevices();
  }, []);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-md bg-destructive/10 p-4 text-center text-destructive">
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

  const getStatusIcon = (status: Device['status']) => {
    switch (status) {
      case 'online':
        return <Wifi className="h-4 w-4 text-success" />;
      case 'offline':
        return <WifiOff className="h-4 w-4 text-muted-foreground" />;
      case 'warning':
        return <AlertTriangle className="h-4 w-4 text-warning" />;
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
            className="rounded-lg border bg-card p-4 shadow-sm transition-shadow hover:shadow-md"
          >
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted">
                  <Monitor className="h-5 w-5 text-muted-foreground" />
                </div>
                <div>
                  <h3 className="font-medium">{device.name}</h3>
                  <p className="text-sm text-muted-foreground">
                    {device.hostname}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-1">
                {getStatusIcon(device.status)}
                <span
                  className={cn(
                    'text-xs font-medium',
                    device.status === 'online' && 'text-success',
                    device.status === 'offline' && 'text-muted-foreground',
                    device.status === 'warning' && 'text-warning'
                  )}
                >
                  {getStatusLabel(device.status)}
                </span>
              </div>
            </div>

            <div className="mt-4 grid grid-cols-2 gap-2 text-xs">
              <div>
                <span className="text-muted-foreground">OS:</span>{' '}
                <span>{device.osType} {device.osVersion}</span>
              </div>
              <div>
                <span className="text-muted-foreground">Last seen:</span>{' '}
                <span>{formatRelativeTime(device.lastSeen)}</span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default DeviceList;
