import { useState, useEffect, useCallback } from 'react';
import { ArrowLeft } from 'lucide-react';
import DeviceDetails from './DeviceDetails';
import type { Device, DeviceStatus, OSType } from './DeviceList';

type DeviceDetailPageProps = {
  deviceId: string;
};

// Map API response to Device type
function mapApiDevice(apiDevice: Record<string, unknown>): Device {
  const osTypeMap: Record<string, OSType> = {
    windows: 'windows',
    linux: 'linux',
    macos: 'macos',
    darwin: 'macos',
  };

  return {
    id: String(apiDevice.id ?? ''),
    hostname: String(apiDevice.hostname ?? apiDevice.display_name ?? 'Unknown'),
    os: osTypeMap[String(apiDevice.os_type ?? '').toLowerCase()] ?? 'linux',
    osVersion: String(apiDevice.os_version ?? ''),
    status: (apiDevice.status as DeviceStatus) ?? 'offline',
    cpuPercent: Number(apiDevice.cpu_percent ?? 0),
    ramPercent: Number(apiDevice.ram_percent ?? 0),
    lastSeen: String(apiDevice.last_seen_at ?? ''),
    siteId: String(apiDevice.site_id ?? ''),
    siteName: String(apiDevice.site_name ?? ''),
    agentVersion: String(apiDevice.agent_version ?? ''),
    tags: Array.isArray(apiDevice.tags) ? apiDevice.tags.map(String) : [],
  };
}

export default function DeviceDetailPage({ deviceId }: DeviceDetailPageProps) {
  const [device, setDevice] = useState<Device | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const fetchDevice = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);

      const response = await fetch(`/api/devices/${deviceId}`);
      if (!response.ok) {
        throw new Error(response.status === 404 ? 'Device not found' : 'Failed to fetch device');
      }
      const data = await response.json();
      const deviceData = data.device ?? data.data ?? data;
      setDevice(mapApiDevice(deviceData));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch device');
    } finally {
      setLoading(false);
    }
  }, [deviceId]);

  useEffect(() => {
    fetchDevice();
  }, [fetchDevice]);

  const handleBack = () => {
    window.location.href = '/devices';
  };

  const handleAction = async (action: string, device: Device) => {
    console.log('Device action:', action, device.hostname);
    // Implement actual action handling
    // After action completes, refresh device data
    await fetchDevice();
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <p className="mt-4 text-sm text-muted-foreground">Loading device...</p>
        </div>
      </div>
    );
  }

  if (error || !device) {
    return (
      <div className="space-y-6">
        <button
          type="button"
          onClick={handleBack}
          className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to devices
        </button>
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
          <p className="text-sm text-destructive">{error || 'Device not found'}</p>
          <button
            type="button"
            onClick={handleBack}
            className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            Go back
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <button
        type="button"
        onClick={handleBack}
        className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to devices
      </button>
      <DeviceDetails device={device} onBack={handleBack} onAction={handleAction} />
    </div>
  );
}
