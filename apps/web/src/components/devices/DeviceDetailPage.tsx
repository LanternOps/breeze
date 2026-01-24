import { useState, useEffect, useCallback } from 'react';
import { ArrowLeft } from 'lucide-react';
import DeviceDetails from './DeviceDetails';
import type { Device } from './DeviceList';

type DeviceDetailPageProps = {
  deviceId: string;
};

// Mock data for development - in production this would come from API
const mockDevices: Record<string, Device> = {
  '1': {
    id: '1',
    hostname: 'WORKSTATION-001',
    os: 'windows',
    osVersion: '11 Pro 23H2',
    status: 'online',
    cpuPercent: 45,
    ramPercent: 62,
    lastSeen: '2024-01-15T12:00:00.000Z',
    siteId: 'site-1',
    siteName: 'Headquarters',
    agentVersion: '2.5.1',
    tags: ['production', 'engineering']
  },
  '2': {
    id: '2',
    hostname: 'SERVER-DB-01',
    os: 'linux',
    osVersion: 'Ubuntu 22.04 LTS',
    status: 'online',
    cpuPercent: 78,
    ramPercent: 85,
    lastSeen: '2024-01-15T11:58:00.000Z',
    siteId: 'site-1',
    siteName: 'Headquarters',
    agentVersion: '2.5.1',
    tags: ['production', 'database']
  },
  '3': {
    id: '3',
    hostname: 'MACBOOK-DESIGN-01',
    os: 'macos',
    osVersion: 'Sonoma 14.2',
    status: 'online',
    cpuPercent: 32,
    ramPercent: 48,
    lastSeen: '2024-01-15T11:55:00.000Z',
    siteId: 'site-2',
    siteName: 'Remote Office',
    agentVersion: '2.5.0',
    tags: ['design']
  },
  '4': {
    id: '4',
    hostname: 'LAPTOP-SALES-02',
    os: 'windows',
    osVersion: '11 Pro 23H2',
    status: 'offline',
    cpuPercent: 0,
    ramPercent: 0,
    lastSeen: '2024-01-15T10:00:00.000Z',
    siteId: 'site-2',
    siteName: 'Remote Office',
    agentVersion: '2.4.3',
    tags: ['sales']
  },
  '5': {
    id: '5',
    hostname: 'SERVER-WEB-01',
    os: 'linux',
    osVersion: 'Ubuntu 22.04 LTS',
    status: 'maintenance',
    cpuPercent: 12,
    ramPercent: 35,
    lastSeen: '2024-01-15T11:59:00.000Z',
    siteId: 'site-1',
    siteName: 'Headquarters',
    agentVersion: '2.5.1',
    tags: ['production', 'web']
  }
};

export default function DeviceDetailPage({ deviceId }: DeviceDetailPageProps) {
  const [device, setDevice] = useState<Device | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const fetchDevice = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);

      // In production, replace with actual API call
      // const response = await fetch(`/api/devices/${deviceId}`);
      // if (!response.ok) throw new Error('Device not found');
      // const data = await response.json();
      // setDevice(data);

      // Using mock data for now
      await new Promise(resolve => setTimeout(resolve, 300));
      const mockDevice = mockDevices[deviceId];
      if (!mockDevice) {
        throw new Error('Device not found');
      }
      setDevice(mockDevice);
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
