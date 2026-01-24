import { useState, useEffect, useCallback } from 'react';
import { ArrowLeft, CheckCircle, XCircle } from 'lucide-react';
import DeviceDetails from './DeviceDetails';
import type { Device, DeviceStatus, OSType } from './DeviceList';
import { fetchWithAuth } from '../../stores/auth';
import { sendDeviceCommand, toggleMaintenanceMode } from '../../services/deviceActions';

type DeviceDetailPageProps = {
  deviceId: string;
};

type Toast = {
  id: string;
  type: 'success' | 'error';
  message: string;
};

export default function DeviceDetailPage({ deviceId }: DeviceDetailPageProps) {
  const [device, setDevice] = useState<Device | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [actionInProgress, setActionInProgress] = useState(false);

  const showToast = useCallback((type: 'success' | 'error', message: string) => {
    const id = Date.now().toString();
    setToasts(prev => [...prev, { id, type, message }]);
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 5000);
  }, []);

  const fetchDevice = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);

      const response = await fetchWithAuth(`/devices/${deviceId}`);
      if (!response.ok) {
        if (response.status === 404) {
          throw new Error('Device not found');
        }
        throw new Error('Failed to fetch device');
      }

      const data = await response.json();

      // Transform API response to match Device type
      const transformedDevice: Device = {
        id: data.id,
        hostname: data.hostname ?? data.displayName ?? 'Unknown',
        os: (data.osType ?? data.os ?? 'windows') as OSType,
        osVersion: data.osVersion ?? '',
        status: (data.status ?? 'offline') as DeviceStatus,
        cpuPercent: data.hardware?.cpuPercent ?? 0,
        ramPercent: data.hardware?.ramPercent ?? 0,
        lastSeen: data.lastSeenAt ?? data.lastSeen ?? '',
        siteId: data.siteId ?? '',
        siteName: data.siteName ?? 'Unknown Site',
        agentVersion: data.agentVersion ?? '',
        tags: data.tags ?? []
      };

      setDevice(transformedDevice);
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
    if (actionInProgress) return;

    try {
      setActionInProgress(true);

      switch (action) {
        case 'reboot':
        case 'shutdown':
        case 'lock':
          await sendDeviceCommand(device.id, action);
          showToast('success', `${action.charAt(0).toUpperCase() + action.slice(1)} command sent to ${device.hostname}`);
          break;

        case 'maintenance': {
          const isCurrentlyMaintenance = device.status === 'maintenance';
          await toggleMaintenanceMode(device.id, !isCurrentlyMaintenance);
          showToast('success', `${device.hostname} ${isCurrentlyMaintenance ? 'taken out of' : 'put into'} maintenance mode`);
          await fetchDevice();
          break;
        }

        case 'terminal':
          window.location.href = `/remote/terminal/${device.id}`;
          return;

        case 'files':
          window.location.href = `/remote/files/${device.id}`;
          return;

        case 'run-script':
          showToast('error', 'Script picker not yet implemented');
          break;

        default:
          showToast('error', `Unknown action: ${action}`);
      }
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : `Failed to ${action} ${device.hostname}`);
    } finally {
      setActionInProgress(false);
    }
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
      {toasts.length > 0 && (
        <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2">
          {toasts.map(toast => (
            <div
              key={toast.id}
              className={`flex items-center gap-2 rounded-lg px-4 py-3 shadow-lg ${
                toast.type === 'success'
                  ? 'bg-green-600 text-white'
                  : 'bg-destructive text-destructive-foreground'
              }`}
            >
              {toast.type === 'success' ? (
                <CheckCircle className="h-5 w-5" />
              ) : (
                <XCircle className="h-5 w-5" />
              )}
              <span className="text-sm font-medium">{toast.message}</span>
            </div>
          ))}
        </div>
      )}
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
