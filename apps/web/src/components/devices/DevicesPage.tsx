import { useState, useEffect, useCallback } from 'react';
import { List, Grid, Plus } from 'lucide-react';
import DeviceList, { type Device, type DeviceStatus, type OSType } from './DeviceList';
import DeviceCard from './DeviceCard';

type ViewMode = 'list' | 'grid';

type Site = {
  id: string;
  name: string;
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

export default function DevicesPage() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [viewMode, setViewMode] = useState<ViewMode>('list');

  const fetchDevices = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);

      // Fetch devices and sites in parallel
      const [devicesRes, sitesRes] = await Promise.all([
        fetch('/api/devices'),
        fetch('/api/sites'),
      ]);

      if (!devicesRes.ok) {
        throw new Error(`Failed to fetch devices: ${devicesRes.status}`);
      }

      const devicesData = await devicesRes.json();
      const devicesList = Array.isArray(devicesData)
        ? devicesData
        : (devicesData.devices ?? devicesData.data ?? []);

      setDevices(devicesList.map(mapApiDevice));

      if (sitesRes.ok) {
        const sitesData = await sitesRes.json();
        const sitesList = Array.isArray(sitesData)
          ? sitesData
          : (sitesData.sites ?? sitesData.data ?? []);
        setSites(sitesList.map((s: Record<string, unknown>) => ({
          id: String(s.id ?? ''),
          name: String(s.name ?? ''),
        })));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch devices');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchDevices();
  }, [fetchDevices]);

  const handleSelectDevice = (device: Device) => {
    window.location.href = `/devices/${device.id}`;
  };

  const handleDeviceAction = async (action: string, device: Device) => {
    console.log('Device action:', action, device.hostname);
    // Implement actual action handling
  };

  const handleBulkAction = async (action: string, selectedDevices: Device[]) => {
    console.log('Bulk action:', action, selectedDevices.map(d => d.hostname));
    // Implement actual bulk action handling
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <p className="mt-4 text-sm text-muted-foreground">Loading devices...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <button
          type="button"
          onClick={fetchDevices}
          className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          Try again
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold">Devices</h1>
          <p className="text-muted-foreground">
            Manage and monitor your fleet of {devices.length} devices.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex rounded-md border">
            <button
              type="button"
              onClick={() => setViewMode('list')}
              className={`flex h-10 w-10 items-center justify-center rounded-l-md transition ${
                viewMode === 'list' ? 'bg-muted' : 'hover:bg-muted/50'
              }`}
              title="List view"
            >
              <List className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => setViewMode('grid')}
              className={`flex h-10 w-10 items-center justify-center rounded-r-md transition ${
                viewMode === 'grid' ? 'bg-muted' : 'hover:bg-muted/50'
              }`}
              title="Grid view"
            >
              <Grid className="h-4 w-4" />
            </button>
          </div>
          <button
            type="button"
            className="flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90"
          >
            <Plus className="h-4 w-4" />
            Add Device
          </button>
        </div>
      </div>

      {viewMode === 'list' ? (
        <DeviceList
          devices={devices}
          sites={sites}
          onSelect={handleSelectDevice}
          onBulkAction={handleBulkAction}
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {devices.map(device => (
            <DeviceCard
              key={device.id}
              device={device}
              onClick={handleSelectDevice}
              onAction={handleDeviceAction}
            />
          ))}
        </div>
      )}
    </div>
  );
}
