import { useState, useEffect, useCallback } from 'react';
import { useEventStream } from '../../hooks/useEventStream';
import { ArrowLeft } from 'lucide-react';
import { showToast } from '../shared/Toast';
import DeviceDetails from './DeviceDetails';
import DeviceSettingsModal from './DeviceSettingsModal';
import ChangeSiteModal from './ChangeSiteModal';
import ScriptPickerModal, { type Script, type ScriptRunAsSelection } from './ScriptPickerModal';
import type { Device, DeviceStatus, OSType } from './DeviceList';
import { fetchWithAuth } from '../../stores/auth';
import { sendDeviceCommand, executeScript, toggleMaintenanceMode, decommissionDevice, clearDeviceSessions, restoreDevice, permanentDeleteDevice } from '../../services/deviceActions';
import { useAiStore } from '@/stores/aiStore';
import { navigateTo } from '@/lib/navigation';
import Breadcrumbs from '../layout/Breadcrumbs';

type DeviceDetailPageProps = {
  deviceId: string;
};

export default function DeviceDetailPage({ deviceId }: DeviceDetailPageProps) {
  const [device, setDevice] = useState<Device | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [actionInProgress, setActionInProgress] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [changeSiteOpen, setChangeSiteOpen] = useState(false);
  const [scriptPickerOpen, setScriptPickerOpen] = useState(false);

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

      // Get latest metrics from recentMetrics array
      const latestMetrics = data.recentMetrics?.[0];

      // Transform API response to match Device type
      const transformedDevice: Device = {
        id: data.id,
        hostname: data.hostname ?? data.displayName ?? 'Unknown',
        os: (data.osType ?? data.os ?? 'windows') as OSType,
        osVersion: data.osVersion ?? '',
        status: (data.status ?? 'offline') as DeviceStatus,
        cpuPercent: latestMetrics?.cpuPercent ?? 0,
        ramPercent: latestMetrics?.ramPercent ?? 0,
        lastSeen: data.lastSeenAt ?? data.lastSeen ?? '',
        orgId: data.orgId ?? '',
        orgName: data.orgName ?? 'Unknown Org',
        siteId: data.siteId ?? '',
        siteName: data.siteName ?? 'Unknown Site',
        agentVersion: data.agentVersion ?? '',
        tags: data.tags ?? [],
        lastUser: data.lastUser ?? undefined,
        uptimeSeconds: typeof data.uptimeSeconds === 'number' ? data.uptimeSeconds : (latestMetrics?.uptimeSeconds ?? undefined),
        deviceRole: data.deviceRole ?? undefined,
        displayName: data.displayName ?? undefined,
        isHeadless: data.isHeadless ?? undefined,
        desktopAccess: data.desktopAccess ?? undefined,
        remoteAccessPolicy: data.remoteAccessPolicy ?? undefined,
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

  // Real-time device updates
  const handleDeviceEvent = useCallback((event: { type: string; payload: Record<string, unknown> }) => {
    const { type, payload } = event;
    const eventDeviceId = payload.deviceId as string;
    if (eventDeviceId !== deviceId) return;

    if (type === 'device.online' || type === 'device.offline') {
      setDevice(prev => prev ? {
        ...prev,
        status: (payload.status as string ?? (type === 'device.online' ? 'online' : 'offline')) as DeviceStatus,
        lastSeen: new Date().toISOString(),
        agentVersion: (payload.agentVersion as string) ?? prev.agentVersion,
      } : prev);
    } else if (type === 'device.updated') {
      const fields = payload.fields as string[] | undefined;
      if (fields?.includes('agentVersion')) {
        setDevice(prev => prev ? {
          ...prev,
          agentVersion: (payload.agentVersion as string) ?? prev.agentVersion,
        } : prev);
      }
    } else if (type === 'device.decommissioned') {
      fetchDevice();
    }
  }, [deviceId, fetchDevice]);

  const { subscribe } = useEventStream({ onEvent: handleDeviceEvent });

  useEffect(() => {
    subscribe(['device.online', 'device.offline', 'device.updated', 'device.decommissioned']);
  }, [subscribe]);

  // Inject AI context when device data is available
  const setPageContext = useAiStore((s) => s.setPageContext);
  useEffect(() => {
    if (device) {
      setPageContext({
        type: 'device',
        id: device.id,
        hostname: device.hostname,
        os: device.os,
        status: device.status,
        ip: undefined
      });
    }
    return () => setPageContext(null);
  }, [device, setPageContext]);

  const handleBack = () => {
    void navigateTo('/devices');
  };

  const handleAction = async (action: string, device: Device) => {
    if (actionInProgress) return;

    try {
      setActionInProgress(true);

      switch (action) {
        case 'reboot':
        case 'reboot_safe_mode':
        case 'shutdown':
        case 'lock': {
          await sendDeviceCommand(device.id, action);
          const label = action === 'reboot_safe_mode' ? 'Reboot to Safe Mode' : action.charAt(0).toUpperCase() + action.slice(1);
          showToast({ type: 'success', message: `${label} command sent to ${device.hostname}` });
          break;
        }

        case 'maintenance': {
          const isCurrentlyMaintenance = device.status === 'maintenance';
          await toggleMaintenanceMode(device.id, !isCurrentlyMaintenance);
          showToast({ type: 'success', message: `${device.hostname} ${isCurrentlyMaintenance ? 'taken out of' : 'put into'} maintenance mode` });
          await fetchDevice();
          break;
        }

        case 'files':
          void navigateTo(`/remote/files/${device.id}`);
          return;

        case 'remote-tools':
          void navigateTo(`/remote/tools?deviceId=${device.id}&deviceName=${encodeURIComponent(device.hostname)}&os=${device.os}`);
          return;

        case 'deploy-software':
          void navigateTo('/software');
          return;

        case 'run-script':
          setScriptPickerOpen(true);
          break;

        case 'settings':
          setSettingsOpen(true);
          break;

        case 'change-site':
          setChangeSiteOpen(true);
          return;

        case 'clear-sessions': {
          const result = await clearDeviceSessions(device.id);
          showToast({ type: 'success', message: `Cleared ${result.cleaned} session${result.cleaned !== 1 ? 's' : ''} for ${device.hostname}` });
          break;
        }

        case 'decommission': {
          // Deferred execution with undo — gives the user 5 seconds to cancel
          let cancelled = false;
          showToast({
            type: 'undo',
            message: `Decommissioning "${device.hostname}"...`,
            duration: 5000,
            onUndo: () => {
              cancelled = true;
              showToast({ type: 'success', message: 'Decommission cancelled', duration: 2000 });
            }
          });
          setTimeout(async () => {
            if (cancelled) return;
            try {
              await decommissionDevice(device.id);
              showToast({ type: 'success', message: `${device.hostname} has been decommissioned` });
              void navigateTo('/devices');
            } catch (err) {
              showToast({ type: 'error', message: err instanceof Error ? err.message : `Failed to decommission ${device.hostname}` });
            }
          }, 5000);
          return;
        }

        case 'restore':
          await restoreDevice(device.id);
          showToast({ type: 'success', message: `${device.hostname} has been restored` });
          await fetchDevice();
          break;

        case 'permanent-delete': {
          // Deferred execution with undo — gives the user 5 seconds to cancel
          let pdCancelled = false;
          showToast({
            type: 'undo',
            message: `Permanently deleting "${device.hostname}"...`,
            duration: 5000,
            onUndo: () => {
              pdCancelled = true;
              showToast({ type: 'success', message: 'Permanent delete cancelled', duration: 2000 });
            }
          });
          setTimeout(async () => {
            if (pdCancelled) return;
            try {
              await permanentDeleteDevice(device.id);
              showToast({ type: 'success', message: `${device.hostname} has been permanently deleted` });
              void navigateTo('/devices');
            } catch (err) {
              showToast({ type: 'error', message: err instanceof Error ? err.message : `Failed to delete ${device.hostname}` });
            }
          }, 5000);
          return;
        }

        default:
          showToast({ type: 'error', message: `Unknown action: ${action}` });
      }
    } catch (err) {
      showToast({ type: 'error', message: err instanceof Error ? err.message : `Failed to ${action} ${device.hostname}` });
    } finally {
      setActionInProgress(false);
    }
  };

  const handleScriptSelect = async (script: Script, runAs: ScriptRunAsSelection, parameters?: Record<string, unknown>) => {
    if (actionInProgress || !device) return;

    try {
      setActionInProgress(true);
      await executeScript(script.id, [device.id], parameters, runAs);
      showToast({ type: 'success', message: `Script "${script.name}" queued for ${device.hostname}` });
    } catch (err) {
      showToast({ type: 'error', message: err instanceof Error ? err.message : 'Failed to queue script' });
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
      <Breadcrumbs items={[
        { label: 'Devices', href: '/devices' },
        { label: device.hostname || 'Device' }
      ]} />
      <DeviceDetails device={device} onBack={handleBack} onAction={handleAction} />
      <DeviceSettingsModal
        device={device}
        isOpen={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onSaved={fetchDevice}
        onAction={handleAction}
      />
      <ChangeSiteModal
        device={device}
        isOpen={changeSiteOpen}
        onClose={() => setChangeSiteOpen(false)}
        onSaved={() => {
          showToast({ type: 'success', message: `${device.hostname} moved to new site` });
          void fetchDevice();
        }}
      />
      <ScriptPickerModal
        isOpen={scriptPickerOpen}
        onClose={() => setScriptPickerOpen(false)}
        onSelect={handleScriptSelect}
        deviceHostname={device.hostname}
        deviceOs={device.os}
      />
    </div>
  );
}
