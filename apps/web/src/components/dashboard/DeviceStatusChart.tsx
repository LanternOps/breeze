import { useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, WifiOff } from 'lucide-react';
import { getErrorMessage, getErrorTitle } from '@/lib/errorMessages';
import { fetchWithAuth } from '../../stores/auth';
import { formatTimeAgo } from '@/lib/formatTime';
import { cn } from '@/lib/utils';

interface Device {
  id: string;
  name: string;
  hostname?: string;
  status: string;
  lastSeen?: string;
  lastHeartbeat?: string;
}

export default function DeviceStatusChart() {
  const [offlineDevices, setOfflineDevices] = useState<Device[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [onlineCount, setOnlineCount] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    const fetchDeviceStatus = async () => {
      try {
        setIsLoading(true);
        setError(null);

        const response = await fetchWithAuth('/devices');
        if (!response.ok) throw response;

        const devicesData = await response.json();
        const devices: Device[] = devicesData.devices ?? devicesData.data ?? (Array.isArray(devicesData) ? devicesData : []);

        const online = devices.filter(d => d.status === 'online');
        const offline = devices.filter(d => d.status !== 'online');

        setTotalCount(devices.length);
        setOnlineCount(online.length);
        setOfflineDevices(
          offline
            .sort((a, b) => {
              const aTime = a.lastSeen || a.lastHeartbeat || '';
              const bTime = b.lastSeen || b.lastHeartbeat || '';
              return bTime.localeCompare(aTime);
            })
            .slice(0, 5)
        );
      } catch (err) {
        setError(err);
      } finally {
        setIsLoading(false);
      }
    };

    fetchDeviceStatus();
  }, [retryCount]);

  // Auto-refresh every 60 seconds
  useEffect(() => {
    const interval = setInterval(() => setRetryCount(c => c + 1), 60_000);
    return () => clearInterval(interval);
  }, []);

  const retry = () => {
    setRetryCount(c => c + 1);
    setError(null);
  };

  if (isLoading && totalCount === 0) {
    return (
      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="h-4 w-24 rounded bg-muted animate-pulse mb-4" />
        <div className="space-y-3">
          {[1, 2, 3].map(i => (
            <div key={i} className="flex items-center gap-3">
              <div className="skeleton h-4 w-4 rounded-full" />
              <div className="skeleton h-4 flex-1" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (error && totalCount === 0) {
    return (
      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <a href="/devices" className="mb-4 inline-block text-sm font-semibold hover:text-primary transition-colors">Fleet Status</a>
        <div className="flex flex-col items-center justify-center py-8 text-center">
          <div className="rounded-full bg-destructive/10 p-3 mb-3">
            <AlertCircle className="h-5 w-5 text-destructive" />
          </div>
          <p className="text-sm font-medium text-foreground mb-1">{getErrorTitle(error)}</p>
          <p className="text-xs text-muted-foreground mb-3">{getErrorMessage(error)}</p>
          <button onClick={retry} className="text-xs font-medium text-primary hover:underline">
            Try again
          </button>
        </div>
      </div>
    );
  }

  if (totalCount === 0) {
    return (
      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <a href="/devices" className="mb-4 inline-block text-sm font-semibold hover:text-primary transition-colors">Fleet Status</a>
        <div className="flex flex-col items-center justify-center py-8 text-center">
          <p className="text-sm text-muted-foreground">No devices enrolled yet</p>
          <a href="/settings/enrollment-keys" className="mt-2 text-xs font-medium text-primary hover:underline">
            Enroll a device
          </a>
        </div>
      </div>
    );
  }

  const allOnline = offlineDevices.length === 0;
  const offlineTotal = totalCount - onlineCount;

  return (
    <div className="rounded-lg border bg-card p-6 shadow-sm">
      <div className="mb-4 flex items-center justify-between">
        <a href="/devices" className="text-sm font-semibold hover:text-primary transition-colors">Fleet Status</a>
        <span className={cn(
          'text-xs font-medium',
          allOnline ? 'text-success' : 'text-muted-foreground'
        )}>
          {onlineCount}/{totalCount} online
        </span>
      </div>

      {allOnline ? (
        <div className="flex flex-col items-center py-6 text-center">
          <div className="rounded-full bg-success/10 p-3 mb-3">
            <CheckCircle2 className="h-5 w-5 text-success" />
          </div>
          <p className="text-sm font-medium text-foreground">All devices online</p>
          <p className="text-xs text-muted-foreground mt-1">Your fleet is healthy</p>
        </div>
      ) : (
        <div className="space-y-1">
          {offlineDevices.map(device => {
            const lastTime = device.lastSeen || device.lastHeartbeat;
            return (
              <a
                key={device.id}
                href={`/devices/${device.id}`}
                className="flex items-center gap-3 rounded-md px-2 py-2 text-sm hover:bg-muted/50 transition-colors"
              >
                <WifiOff className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                <span className="truncate flex-1 font-medium">{device.name || device.hostname || 'Unknown'}</span>
                {lastTime && (
                  <span className="text-xs text-muted-foreground flex-shrink-0">
                    {formatTimeAgo(lastTime)}
                  </span>
                )}
              </a>
            );
          })}
          {offlineDevices.length < offlineTotal && (
            <a
              href="/devices?status=offline"
              className="block text-center text-xs font-medium text-primary hover:underline pt-2"
            >
              View all {offlineTotal} offline
            </a>
          )}
        </div>
      )}
    </div>
  );
}
