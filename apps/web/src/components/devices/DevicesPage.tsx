import { useState, useEffect, useCallback, useMemo } from 'react';
import { List, Grid, Plus, CheckCircle, XCircle, Copy, Loader2, X } from 'lucide-react';
import type { FilterConditionGroup } from '@breeze/shared';
import DeviceList, { type Device, type DeviceStatus, type OSType } from './DeviceList';
import DeviceCard from './DeviceCard';
import ScriptPickerModal, { type Script } from './ScriptPickerModal';
import DeviceSettingsModal from './DeviceSettingsModal';
import { DeviceFilterBar } from '../filters/DeviceFilterBar';
import { fetchWithAuth } from '../../stores/auth';
import { sendDeviceCommand, sendBulkCommand, executeScript, toggleMaintenanceMode } from '../../services/deviceActions';

type ViewMode = 'list' | 'grid';

type Org = {
  id: string;
  name: string;
};

type Site = {
  id: string;
  name: string;
};

type Toast = {
  id: string;
  type: 'success' | 'error';
  message: string;
};

export default function DevicesPage() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [viewMode, setViewMode] = useState<ViewMode>('list');
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [actionInProgress, setActionInProgress] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [onboardingToken, setOnboardingToken] = useState<string>('');
  const [tokenLoading, setTokenLoading] = useState(false);
  const [tokenCopied, setTokenCopied] = useState(false);
  const [tokenError, setTokenError] = useState<string>();
  const [scriptPickerOpen, setScriptPickerOpen] = useState(false);
  const [scriptTargetDevices, setScriptTargetDevices] = useState<Device[]>([]);
  const [settingsDevice, setSettingsDevice] = useState<Device | null>(null);
  const [advancedFilter, setAdvancedFilter] = useState<FilterConditionGroup | null>(null);

  const scriptTargetLabel =
    scriptTargetDevices.length === 1
      ? scriptTargetDevices[0].hostname
      : scriptTargetDevices.length > 1
        ? `${scriptTargetDevices.length} devices`
        : 'selected devices';

  const scriptTargetOs = useMemo(() => {
    const unique = [...new Set(scriptTargetDevices.map(d => d.os))];
    return unique.length > 0 ? unique : undefined;
  }, [scriptTargetDevices]);

  const showToast = useCallback((type: 'success' | 'error', message: string) => {
    const id = Date.now().toString();
    setToasts(prev => [...prev, { id, type, message }]);
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 5000);
  }, []);

  const fetchDevices = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);

      // Fetch devices, orgs, and sites in parallel
      const [devicesResponse, orgsResponse, sitesResponse] = await Promise.all([
        fetchWithAuth('/devices'),
        fetchWithAuth('/orgs'),
        fetchWithAuth('/orgs/sites')
      ]);

      if (!devicesResponse.ok) {
        throw new Error('Failed to fetch devices');
      }

      const devicesData = await devicesResponse.json();
      const deviceList = devicesData.data ?? devicesData.devices ?? devicesData ?? [];

      // Transform API response to match Device type
      const transformedDevices: Device[] = deviceList.map((d: Record<string, unknown>) => ({
        id: d.id as string,
        hostname: (d.hostname ?? d.displayName ?? 'Unknown') as string,
        os: (d.osType ?? d.os ?? 'windows') as OSType,
        osVersion: (d.osVersion ?? '') as string,
        status: (d.status ?? 'offline') as DeviceStatus,
        cpuPercent: typeof d.hardware === 'object' && d.hardware !== null
          ? ((d.hardware as Record<string, unknown>).cpuPercent as number ?? 0)
          : 0,
        ramPercent: typeof d.hardware === 'object' && d.hardware !== null
          ? ((d.hardware as Record<string, unknown>).ramPercent as number ?? 0)
          : 0,
        lastSeen: (d.lastSeenAt ?? d.lastSeen ?? '') as string,
        orgId: (d.orgId ?? '') as string,
        orgName: '', // Will be resolved from orgs
        siteId: (d.siteId ?? '') as string,
        siteName: '', // Will be resolved from sites
        agentVersion: (d.agentVersion ?? '') as string,
        tags: (d.tags ?? []) as string[]
      }));

      // Fetch orgs for org name lookup
      let orgsList: Org[] = [];
      if (orgsResponse.ok) {
        const orgsData = await orgsResponse.json();
        orgsList = orgsData.data ?? orgsData.orgs ?? orgsData ?? [];
      } else {
        console.warn('Failed to fetch orgs:', orgsResponse.status);
      }

      // Fetch sites for site name lookup
      let sitesList: Site[] = [];
      if (sitesResponse.ok) {
        const sitesData = await sitesResponse.json();
        sitesList = sitesData.data ?? sitesData.sites ?? sitesData ?? [];
      } else {
        console.warn('Failed to fetch sites:', sitesResponse.status);
      }

      // Create lookup maps
      const orgMap = new Map(orgsList.map((o: Org) => [o.id, o.name]));
      const siteMap = new Map(sitesList.map((s: Site) => [s.id, s.name]));

      // Assign org and site names to devices
      const devicesWithNames = transformedDevices.map(device => ({
        ...device,
        orgName: orgMap.get(device.orgId) ?? 'Unknown Org',
        siteName: siteMap.get(device.siteId) ?? 'Unknown Site'
      }));

      setDevices(devicesWithNames);
      setOrgs(orgsList);
      setSites(sitesList);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch devices');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchDevices();
  }, [fetchDevices]);

  const handleOpenOnboarding = async () => {
    setShowOnboarding(true);
    setTokenLoading(true);
    setOnboardingToken('');
    setTokenError(undefined);

    try {
      const response = await fetchWithAuth('/devices/onboarding-token', {
        method: 'POST'
      });

      if (!response.ok) {
        if (response.status === 401) {
          window.location.href = '/login';
          return;
        }
        let errorMessage = 'Failed to generate installation token';
        try {
          const errorData = await response.json();
          errorMessage = errorData.message || errorData.error || errorMessage;
        } catch {
          if (response.status === 404) {
            errorMessage = 'Token generation service not available. Please contact support.';
          } else if (response.status >= 500) {
            errorMessage = 'Server error. Please try again later.';
          }
        }
        setTokenError(errorMessage);
        return;
      }

      const data = await response.json();
      const token = data.token ?? data.onboardingToken ?? data.data?.token;
      if (!token) {
        setTokenError('Server returned empty token. Please try again.');
        return;
      }
      setOnboardingToken(token);
    } catch (err) {
      setTokenError(err instanceof Error ? err.message : 'Network error. Please check your connection.');
    } finally {
      setTokenLoading(false);
    }
  };

  const handleCopyToken = async () => {
    if (!onboardingToken) return;
    try {
      await navigator.clipboard.writeText(onboardingToken);
      setTokenCopied(true);
      setTimeout(() => setTokenCopied(false), 2000);
    } catch {
      showToast('error', 'Failed to copy token');
    }
  };

  const handleCopyCommand = async (command: string) => {
    try {
      await navigator.clipboard.writeText(command);
      showToast('success', 'Command copied to clipboard');
    } catch {
      showToast('error', 'Failed to copy command');
    }
  };

  const handleSelectDevice = (device: Device) => {
    window.location.href = `/devices/${device.id}`;
  };

  const openScriptPicker = (targetDevices: Device[]) => {
    if (targetDevices.length === 0) {
      showToast('error', 'Select at least one device to run a script');
      return;
    }
    setScriptTargetDevices(targetDevices);
    setScriptPickerOpen(true);
  };

  const closeScriptPicker = () => {
    setScriptPickerOpen(false);
    setScriptTargetDevices([]);
  };

  const handleScriptSelect = async (script: Script) => {
    if (actionInProgress) return;

    try {
      setActionInProgress(true);
      const deviceIds = scriptTargetDevices.map(d => d.id);
      const result = await executeScript(script.id, deviceIds);

      if (scriptTargetDevices.length === 1) {
        showToast('success', `Script "${script.name}" queued for ${scriptTargetDevices[0].hostname}`);
      } else {
        showToast('success', `Script "${script.name}" queued for ${result.devicesTargeted} devices`);
      }

      closeScriptPicker();
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Failed to queue script');
    } finally {
      setActionInProgress(false);
    }
  };

  const handleDeviceAction = async (action: string, device: Device) => {
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

        case 'maintenance':
          const isCurrentlyMaintenance = device.status === 'maintenance';
          await toggleMaintenanceMode(device.id, !isCurrentlyMaintenance);
          showToast('success', `${device.hostname} ${isCurrentlyMaintenance ? 'taken out of' : 'put into'} maintenance mode`);
          await fetchDevices();
          break;

        case 'terminal':
          window.location.href = `/remote/terminal/${device.id}`;
          return;

        case 'files':
          window.location.href = `/remote/files/${device.id}`;
          return;

        case 'run-script':
          openScriptPicker([device]);
          break;

        case 'settings':
          setSettingsDevice(device);
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

  const handleBulkAction = async (action: string, selectedDevices: Device[]) => {
    if (actionInProgress || selectedDevices.length === 0) return;

    const deviceIds = selectedDevices.map(d => d.id);
    const deviceCount = selectedDevices.length;

    if (action === 'run-script') {
      openScriptPicker(selectedDevices);
      return;
    }

    try {
      setActionInProgress(true);

      switch (action) {
        case 'reboot':
        case 'shutdown':
        case 'lock': {
          const result = await sendBulkCommand(deviceIds, action);
          const successCount = result.commands?.length ?? 0;
          const failedCount = result.failed?.length ?? 0;

          if (failedCount === 0) {
            showToast('success', `${action.charAt(0).toUpperCase() + action.slice(1)} command sent to ${successCount} devices`);
          } else {
            showToast('error', `${action} sent to ${successCount} devices, ${failedCount} failed`);
          }
          break;
        }

        case 'maintenance-on':
          for (const device of selectedDevices) {
            await toggleMaintenanceMode(device.id, true);
          }
          showToast('success', `${deviceCount} devices put into maintenance mode`);
          await fetchDevices();
          break;

        case 'maintenance-off':
          for (const device of selectedDevices) {
            await toggleMaintenanceMode(device.id, false);
          }
          showToast('success', `${deviceCount} devices taken out of maintenance mode`);
          await fetchDevices();
          break;

        default:
          showToast('error', `Unknown bulk action: ${action}`);
      }
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : `Failed bulk ${action}`);
    } finally {
      setActionInProgress(false);
    }
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
      {/* Toast notifications */}
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
            onClick={handleOpenOnboarding}
            className="flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90"
          >
            <Plus className="h-4 w-4" />
            Add Device
          </button>
        </div>
      </div>

      <DeviceFilterBar
        value={advancedFilter}
        onChange={setAdvancedFilter}
        showPreview={true}
        showSavedFilters={true}
        collapsible={true}
      />

      {viewMode === 'list' ? (
        <DeviceList
          devices={devices}
          orgs={orgs}
          sites={sites}
          onSelect={handleSelectDevice}
          onBulkAction={handleBulkAction}
          serverFilter={advancedFilter}
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

      {showOnboarding && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8 overflow-y-auto">
          <div className="w-full max-w-2xl rounded-lg border bg-card p-6 shadow-sm">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold">Add New Device</h2>
              <button
                type="button"
                onClick={() => setShowOnboarding(false)}
                className="h-8 w-8 rounded-md hover:bg-muted flex items-center justify-center"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <p className="text-sm text-muted-foreground mb-6">
              Install the Breeze agent on your device to add it to your fleet. Use the installation token and commands below.
            </p>

            <div className="space-y-6">
              <div className="rounded-lg border bg-muted/30 p-4">
                <div className="flex items-center justify-between mb-2">
                  <label className="text-sm font-medium">Installation Token</label>
                  <button
                    type="button"
                    onClick={handleCopyToken}
                    disabled={tokenLoading || !onboardingToken}
                    className="inline-flex items-center gap-1 text-xs text-primary hover:underline disabled:opacity-50"
                  >
                    <Copy className="h-3 w-3" />
                    {tokenCopied ? 'Copied!' : 'Copy'}
                  </button>
                </div>
                {tokenLoading ? (
                  <div className="flex items-center gap-2 py-2">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    <span className="text-sm text-muted-foreground">Generating token...</span>
                  </div>
                ) : tokenError ? (
                  <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                    {tokenError}
                    <button
                      type="button"
                      onClick={handleOpenOnboarding}
                      className="ml-2 underline hover:no-underline"
                    >
                      Retry
                    </button>
                  </div>
                ) : (
                  <code className="block rounded-md bg-background p-3 text-sm font-mono break-all">
                    {onboardingToken || 'No token available'}
                  </code>
                )}
              </div>

              <div>
                <h3 className="text-sm font-semibold mb-3">Windows (PowerShell - Run as Administrator)</h3>
                <div className="rounded-lg border bg-muted/30 p-4">
                  <div className="flex items-start justify-between gap-2">
                    <code className="text-xs font-mono text-muted-foreground break-all">
                      {`Invoke-WebRequest -Uri "https://get.breezeRMM.io/install.ps1" -OutFile install.ps1; .\\install.ps1 -Token "${onboardingToken || '<TOKEN>'}"`}
                    </code>
                    <button
                      type="button"
                      onClick={() => handleCopyCommand(`Invoke-WebRequest -Uri "https://get.breezeRMM.io/install.ps1" -OutFile install.ps1; .\\install.ps1 -Token "${onboardingToken || '<TOKEN>'}"`)}
                      className="flex-shrink-0 p-1 hover:bg-muted rounded"
                    >
                      <Copy className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              </div>

              <div>
                <h3 className="text-sm font-semibold mb-3">macOS / Linux (Terminal)</h3>
                <div className="rounded-lg border bg-muted/30 p-4">
                  <div className="flex items-start justify-between gap-2">
                    <code className="text-xs font-mono text-muted-foreground break-all">
                      {`curl -fsSL https://get.breezeRMM.io/install.sh | sudo bash -s -- --token "${onboardingToken || '<TOKEN>'}"`}
                    </code>
                    <button
                      type="button"
                      onClick={() => handleCopyCommand(`curl -fsSL https://get.breezeRMM.io/install.sh | sudo bash -s -- --token "${onboardingToken || '<TOKEN>'}"`)}
                      className="flex-shrink-0 p-1 hover:bg-muted rounded"
                    >
                      <Copy className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              </div>

              <div className="rounded-md border border-blue-500/40 bg-blue-500/10 p-4 text-sm">
                <p className="font-medium text-blue-700">Note</p>
                <p className="mt-1 text-blue-600 text-xs">
                  The installation token expires in 24 hours. The device will appear in your list once the agent is installed and connected.
                </p>
              </div>
            </div>

            <div className="mt-6 flex justify-end">
              <button
                type="button"
                onClick={() => setShowOnboarding(false)}
                className="h-10 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      <ScriptPickerModal
        isOpen={scriptPickerOpen}
        onClose={closeScriptPicker}
        onSelect={handleScriptSelect}
        deviceHostname={scriptTargetLabel}
        deviceOs={scriptTargetOs}
      />

      {settingsDevice && (
        <DeviceSettingsModal
          device={settingsDevice}
          isOpen={!!settingsDevice}
          onClose={() => setSettingsDevice(null)}
          onSaved={fetchDevices}
        />
      )}
    </div>
  );
}
