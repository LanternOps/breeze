import { useState, useEffect, useCallback } from 'react';
import { List, Grid, Plus } from 'lucide-react';
import DeviceList, { type Device, type DeviceStatus, type OSType } from './DeviceList';
import DeviceCard from './DeviceCard';

type ViewMode = 'list' | 'grid';

type Site = {
  id: string;
  name: string;
};

// Mock data for development
const mockDevices: Device[] = [
  {
    id: '1',
    hostname: 'WORKSTATION-001',
    os: 'windows',
    osVersion: '11 Pro 23H2',
    status: 'online',
    cpuPercent: 45,
    ramPercent: 62,
    lastSeen: new Date().toISOString(),
    siteId: 'site-1',
    siteName: 'Headquarters',
    agentVersion: '2.5.1',
    tags: ['production', 'engineering']
  },
  {
    id: '2',
    hostname: 'SERVER-DB-01',
    os: 'linux',
    osVersion: 'Ubuntu 22.04 LTS',
    status: 'online',
    cpuPercent: 78,
    ramPercent: 85,
    lastSeen: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
    siteId: 'site-1',
    siteName: 'Headquarters',
    agentVersion: '2.5.1',
    tags: ['production', 'database']
  },
  {
    id: '3',
    hostname: 'MACBOOK-DESIGN-01',
    os: 'macos',
    osVersion: 'Sonoma 14.2',
    status: 'online',
    cpuPercent: 32,
    ramPercent: 48,
    lastSeen: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    siteId: 'site-2',
    siteName: 'Remote Office',
    agentVersion: '2.5.0',
    tags: ['design']
  },
  {
    id: '4',
    hostname: 'LAPTOP-SALES-02',
    os: 'windows',
    osVersion: '11 Pro 23H2',
    status: 'offline',
    cpuPercent: 0,
    ramPercent: 0,
    lastSeen: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    siteId: 'site-2',
    siteName: 'Remote Office',
    agentVersion: '2.4.3',
    tags: ['sales']
  },
  {
    id: '5',
    hostname: 'SERVER-WEB-01',
    os: 'linux',
    osVersion: 'Ubuntu 22.04 LTS',
    status: 'maintenance',
    cpuPercent: 12,
    ramPercent: 35,
    lastSeen: new Date(Date.now() - 1 * 60 * 1000).toISOString(),
    siteId: 'site-1',
    siteName: 'Headquarters',
    agentVersion: '2.5.1',
    tags: ['production', 'web']
  },
  {
    id: '6',
    hostname: 'WORKSTATION-002',
    os: 'windows',
    osVersion: '10 Pro 22H2',
    status: 'online',
    cpuPercent: 55,
    ramPercent: 72,
    lastSeen: new Date(Date.now() - 30 * 1000).toISOString(),
    siteId: 'site-1',
    siteName: 'Headquarters',
    agentVersion: '2.5.1',
    tags: ['production', 'engineering']
  },
  {
    id: '7',
    hostname: 'MACBOOK-DEV-01',
    os: 'macos',
    osVersion: 'Ventura 13.6',
    status: 'online',
    cpuPercent: 67,
    ramPercent: 58,
    lastSeen: new Date(Date.now() - 45 * 1000).toISOString(),
    siteId: 'site-1',
    siteName: 'Headquarters',
    agentVersion: '2.5.1',
    tags: ['development']
  },
  {
    id: '8',
    hostname: 'SERVER-BACKUP-01',
    os: 'linux',
    osVersion: 'Debian 12',
    status: 'online',
    cpuPercent: 8,
    ramPercent: 22,
    lastSeen: new Date(Date.now() - 15 * 1000).toISOString(),
    siteId: 'site-1',
    siteName: 'Headquarters',
    agentVersion: '2.5.1',
    tags: ['infrastructure', 'backup']
  }
];

const mockSites: Site[] = [
  { id: 'site-1', name: 'Headquarters' },
  { id: 'site-2', name: 'Remote Office' }
];

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

      // In production, replace with actual API call
      // const response = await fetch('/api/devices');
      // const data = await response.json();
      // setDevices(data.devices ?? []);

      // Using mock data for now
      await new Promise(resolve => setTimeout(resolve, 500));
      setDevices(mockDevices);
      setSites(mockSites);
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
