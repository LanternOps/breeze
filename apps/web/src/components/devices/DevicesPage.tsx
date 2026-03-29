import { useState, useEffect, useCallback, useMemo } from 'react';
import { List, Grid, Plus, Copy, Loader2, X, AlertCircle, Monitor, ArrowRight } from 'lucide-react';
import { showToast } from '../shared/Toast';
import type { FilterConditionGroup } from '@breeze/shared';
import DeviceList, { type Device, type DeviceStatus, type OSType } from './DeviceList';
import type { DeviceRole } from '@/lib/deviceRoles';
import DeviceCard from './DeviceCard';
import ScriptPickerModal, { type Script, type ScriptRunAsSelection } from './ScriptPickerModal';
import DeviceSettingsModal from './DeviceSettingsModal';
import { DeviceFilterBar } from '../filters/DeviceFilterBar';
import { fetchWithAuth } from '../../stores/auth';
import { sendDeviceCommand, sendBulkCommand, executeScript, toggleMaintenanceMode, decommissionDevice, bulkDecommissionDevices, restoreDevice, permanentDeleteDevice } from '../../services/deviceActions';
import { navigateTo } from '@/lib/navigation';
import { getErrorMessage, getErrorTitle } from '@/lib/errorMessages';
import ProgressBar from '../shared/ProgressBar';

type ViewMode = 'list' | 'grid';

type Org = {
  id: string;
  name: string;
};

type Site = {
  id: string;
  name: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function toPercent(value: unknown): number {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number(value)
      : NaN;

  if (!Number.isFinite(parsed)) return 0;
  return Math.min(100, Math.max(0, Number(parsed.toFixed(1))));
}

export default function DevicesPage() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('list');
  const [actionInProgress, setActionInProgress] = useState(false);
  const [bulkProgress, setBulkProgress] = useState<{ current: number; total: number; label: string } | null>(null);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [onboardingToken, setOnboardingToken] = useState<string>('');
  const [enrollmentSecret, setEnrollmentSecret] = useState<string>('');
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

  const fetchDevices = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      // Fetch devices, orgs, and sites in parallel
      const [devicesResponse, orgsResponse, sitesResponse] = await Promise.all([
        fetchWithAuth('/devices?includeDecommissioned=true'),
        fetchWithAuth('/orgs'),
        fetchWithAuth('/orgs/sites')
      ]);

      if (!devicesResponse.ok) {
        throw devicesResponse;
      }

      const devicesData = await devicesResponse.json();
      const deviceList = devicesData.data ?? devicesData.devices ?? devicesData ?? [];

      // Transform API response to match Device type
      const transformedDevices: Device[] = deviceList.map((d: Record<string, unknown>) => {
        const metrics = asRecord(d.metrics);
        const hardware = asRecord(d.hardware);

        return {
          id: d.id as string,
          hostname: (d.hostname ?? d.displayName ?? 'Unknown') as string,
          os: (d.osType ?? d.os ?? 'windows') as OSType,
          osVersion: (d.osVersion ?? '') as string,
          status: (d.status ?? 'offline') as DeviceStatus,
          cpuPercent: toPercent(metrics?.cpuPercent ?? d.cpuPercent ?? hardware?.cpuPercent),
          ramPercent: toPercent(metrics?.ramPercent ?? d.ramPercent ?? hardware?.ramPercent),
          lastSeen: (d.lastSeenAt ?? d.lastSeen ?? '') as string,
          orgId: (d.orgId ?? '') as string,
          orgName: '', // Will be resolved from orgs
          siteId: (d.siteId ?? '') as string,
          siteName: '', // Will be resolved from sites
          agentVersion: (d.agentVersion ?? '') as string,
          tags: (d.tags ?? []) as string[],
          deviceRole: d.deviceRole as DeviceRole | undefined,
          deviceRoleSource: d.deviceRoleSource as string | undefined
        };
      });

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
      setError(err);
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
    setEnrollmentSecret('');
    setTokenError(undefined);

    try {
      const response = await fetchWithAuth('/devices/onboarding-token', {
        method: 'POST'
      });

      if (!response.ok) {
        if (response.status === 401) {
          void navigateTo('/login', { replace: true });
          return;
        }
        let errorMessage = 'Failed to generate installation token';
        try {
          const errorData = await response.json();
          const rawMessage = errorData.message || errorData.error || '';
          if (response.status === 403 && rawMessage.toLowerCase().includes('mfa required')) {
            errorMessage = 'MFA_REQUIRED';
          } else {
            errorMessage = rawMessage || errorMessage;
          }
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
      if (data.enrollmentSecret) {
        setEnrollmentSecret(data.enrollmentSecret);
      }
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
      showToast({ type: 'error', message: 'Failed to copy token' });
    }
  };

  const handleCopyCommand = async (command: string) => {
    try {
      await navigator.clipboard.writeText(command);
      showToast({ type: 'success', message: 'Command copied to clipboard' });
    } catch {
      showToast({ type: 'error', message: 'Failed to copy command' });
    }
  };

  const handleSelectDevice = (device: Device) => {
    void navigateTo(`/devices/${device.id}`);
  };

  const openScriptPicker = (targetDevices: Device[]) => {
    if (targetDevices.length === 0) {
      showToast({ type: 'error', message: 'Select at least one device to run a script' });
      return;
    }
    setScriptTargetDevices(targetDevices);
    setScriptPickerOpen(true);
  };

  const closeScriptPicker = () => {
    setScriptPickerOpen(false);
    setScriptTargetDevices([]);
  };

  const handleScriptSelect = async (script: Script, runAs: ScriptRunAsSelection) => {
    if (actionInProgress) return;

    try {
      setActionInProgress(true);
      const deviceIds = scriptTargetDevices.map(d => d.id);
      const result = await executeScript(script.id, deviceIds, undefined, runAs);

      if (scriptTargetDevices.length === 1) {
        showToast({ type: 'success', message: `Script "${script.name}" queued for ${scriptTargetDevices[0].hostname}` });
      } else {
        showToast({ type: 'success', message: `Script "${script.name}" queued for ${result.devicesTargeted} devices` });
      }

      closeScriptPicker();
    } catch (err) {
      showToast({ type: 'error', message: err instanceof Error ? err.message : 'Failed to queue script' });
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
        case 'reboot_safe_mode':
        case 'shutdown':
        case 'lock': {
          await sendDeviceCommand(device.id, action);
          const label = action === 'reboot_safe_mode' ? 'Reboot to Safe Mode' : action.charAt(0).toUpperCase() + action.slice(1);
          showToast({ type: 'success', message: `${label} command sent to ${device.hostname}` });
          break;
        }

        case 'maintenance':
          const isCurrentlyMaintenance = device.status === 'maintenance';
          await toggleMaintenanceMode(device.id, !isCurrentlyMaintenance);
          showToast({ type: 'success', message: `${device.hostname} ${isCurrentlyMaintenance ? 'taken out of' : 'put into'} maintenance mode` });
          await fetchDevices();
          break;

        case 'deploy-software':
          void navigateTo('/software');
          return;

        case 'terminal':
          void navigateTo(`/remote/terminal/${device.id}`);
          return;

        case 'files':
          void navigateTo(`/remote/files/${device.id}`);
          return;

        case 'run-script':
          openScriptPicker([device]);
          break;

        case 'settings':
          setSettingsDevice(device);
          break;

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
              await fetchDevices();
            } catch (err) {
              showToast({ type: 'error', message: err instanceof Error ? err.message : `Failed to decommission ${device.hostname}` });
            }
          }, 5000);
          break;
        }

        case 'restore':
          await restoreDevice(device.id);
          showToast({ type: 'success', message: `${device.hostname} has been restored` });
          await fetchDevices();
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
              await fetchDevices();
            } catch (err) {
              showToast({ type: 'error', message: err instanceof Error ? err.message : `Failed to delete ${device.hostname}` });
            }
          }, 5000);
          break;
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

  const handleBulkAction = async (action: string, selectedDevices: Device[]) => {
    if (actionInProgress || selectedDevices.length === 0) return;

    const deviceIds = selectedDevices.map(d => d.id);
    const deviceCount = selectedDevices.length;

    if (action === 'run-script') {
      openScriptPicker(selectedDevices);
      return;
    }

    if (action === 'deploy-software') {
      void navigateTo('/software');
      return;
    }

    try {
      setActionInProgress(true);

      switch (action) {
        case 'reboot':
        case 'reboot_safe_mode':
        case 'shutdown':
        case 'lock': {
          const result = await sendBulkCommand(deviceIds, action);
          const successCount = result.commands?.length ?? 0;
          const failedCount = result.failed?.length ?? 0;
          const bulkLabel = action === 'reboot_safe_mode' ? 'Reboot to Safe Mode' : action.charAt(0).toUpperCase() + action.slice(1);

          if (failedCount === 0) {
            showToast({ type: 'success', message: `${bulkLabel} command sent to ${successCount} devices` });
          } else {
            showToast({ type: 'error', message: `${bulkLabel} sent to ${successCount} devices, ${failedCount} failed` });
          }
          break;
        }

        case 'maintenance-on': {
          const mOnLabel = 'Enabling maintenance mode';
          setBulkProgress({ current: 0, total: deviceCount, label: mOnLabel });
          let mOnDone = 0;
          for (const device of selectedDevices) {
            await toggleMaintenanceMode(device.id, true);
            mOnDone++;
            setBulkProgress({ current: mOnDone, total: deviceCount, label: mOnLabel });
          }
          setBulkProgress(null);
          showToast({ type: 'success', message: `${deviceCount} devices put into maintenance mode` });
          await fetchDevices();
          break;
        }

        case 'maintenance-off': {
          const mOffLabel = 'Disabling maintenance mode';
          setBulkProgress({ current: 0, total: deviceCount, label: mOffLabel });
          let mOffDone = 0;
          for (const device of selectedDevices) {
            await toggleMaintenanceMode(device.id, false);
            mOffDone++;
            setBulkProgress({ current: mOffDone, total: deviceCount, label: mOffLabel });
          }
          setBulkProgress(null);
          showToast({ type: 'success', message: `${deviceCount} devices taken out of maintenance mode` });
          await fetchDevices();
          break;
        }

        case 'decommission': {
          const result = await bulkDecommissionDevices(deviceIds);
          if (result.failed === 0) {
            showToast({ type: 'success', message: `${result.succeeded} devices decommissioned` });
          } else {
            showToast({ type: 'error', message: `${result.succeeded} decommissioned, ${result.failed} failed` });
          }
          await fetchDevices();
          break;
        }

        default:
          showToast({ type: 'error', message: `Unknown bulk action: ${action}` });
      }
    } catch (err) {
      showToast({ type: 'error', message: err instanceof Error ? err.message : `Failed bulk ${action}` });
    } finally {
      setActionInProgress(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="h-6 w-32 rounded bg-muted animate-pulse mb-2" />
            <div className="h-4 w-48 rounded bg-muted animate-pulse" />
          </div>
          <div className="flex items-center gap-3">
            <div className="h-10 w-20 rounded-md bg-muted animate-pulse" />
            <div className="h-10 w-28 rounded-md bg-muted animate-pulse" />
          </div>
        </div>
        <div className="rounded-lg border bg-card p-6 shadow-sm">
          <div className="flex items-center justify-between mb-6">
            <div className="h-5 w-20 rounded bg-muted animate-pulse" />
            <div className="h-10 w-56 rounded-md bg-muted animate-pulse" />
          </div>
          <div className="space-y-0 divide-y">
            {[1, 2, 3, 4, 5].map(i => (
              <div key={i} className="flex items-center gap-4 py-3">
                <div className="h-4 w-4 rounded bg-muted animate-pulse" />
                <div className="h-4 w-40 rounded bg-muted animate-pulse" />
                <div className="h-4 w-20 rounded bg-muted animate-pulse" />
                <div className="h-4 w-16 rounded bg-muted animate-pulse" />
                <div className="hidden md:block h-4 w-16 rounded bg-muted animate-pulse" />
                <div className="hidden md:block h-4 w-16 rounded bg-muted animate-pulse" />
                <div className="h-4 w-20 rounded bg-muted animate-pulse" />
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border bg-card p-6">
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <div className="rounded-full bg-destructive/10 p-3 mb-3">
            <AlertCircle className="h-5 w-5 text-destructive" />
          </div>
          <p className="text-sm font-medium text-foreground mb-1">{getErrorTitle(error)}</p>
          <p className="text-xs text-muted-foreground mb-3">{getErrorMessage(error)}</p>
          <button
            type="button"
            onClick={fetchDevices}
            className="text-xs font-medium text-primary hover:underline"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Devices</h1>
          <p className="text-muted-foreground">
            Manage and monitor your fleet.
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
        showSavedFilters={true}
        collapsible={true}
      />

      {bulkProgress && (
        <div className="rounded-md border bg-muted/20 px-4 py-3">
          <ProgressBar
            current={bulkProgress.current}
            total={bulkProgress.total}
            label={bulkProgress.label}
          />
        </div>
      )}

      {devices.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <div className="rounded-full bg-primary/10 p-4 mb-4">
            <Monitor className="h-8 w-8 text-primary" />
          </div>
          <h2 className="text-lg font-semibold text-foreground mb-1">No devices yet</h2>
          <p className="text-sm text-muted-foreground max-w-md mb-6">
            Enroll your first device to start monitoring. You'll need an enrollment key and the Breeze agent installer.
          </p>
          <div className="flex gap-3">
            <a href="/settings/enrollment-keys" className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors">
              Get enrollment key
              <ArrowRight className="h-4 w-4" />
            </a>
            <a href="https://docs.breezermm.com/getting-started" target="_blank" rel="noopener" className="inline-flex items-center gap-1.5 rounded-md border px-4 py-2 text-sm font-medium text-foreground hover:bg-muted transition-colors">
              View setup guide
            </a>
          </div>
        </div>
      ) : viewMode === 'list' ? (
        <DeviceList
          devices={devices}
          orgs={orgs}
          sites={sites}
          onSelect={handleSelectDevice}
          onAction={handleDeviceAction}
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
                ) : tokenError === 'MFA_REQUIRED' ? (
                  <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-700">
                    Multi-factor authentication is required to generate installation tokens.{' '}
                    <a
                      href="/settings/profile"
                      className="font-medium underline hover:no-underline"
                    >
                      Set up MFA in your profile settings
                    </a>{' '}
                    and sign in again, then retry.
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

              {(() => {
                const apiUrl = (import.meta.env.PUBLIC_API_URL || window.location.origin).replace(/\/$/, '');
                const ghBase = (import.meta.env.PUBLIC_AGENT_DOWNLOAD_URL || 'https://github.com/lanternops/breeze/releases/latest/download').replace(/\/$/, '');
                const token = onboardingToken || '<TOKEN>';

                const secretFlag = enrollmentSecret ? ` --enrollment-secret "${enrollmentSecret}"` : '';
                const winCmd = `Invoke-WebRequest -Uri "${ghBase}/breeze-agent-windows-amd64.exe" -OutFile breeze-agent.exe; .\\breeze-agent.exe service install; .\\breeze-agent.exe enroll "${token}" --server "${apiUrl}"${secretFlag}; .\\breeze-agent.exe service start`;
                const macCmd = `curl -fsSL -o /tmp/breeze-agent.pkg "${apiUrl}/api/v1/agents/download/darwin/$(uname -m | sed 's/x86_64/amd64/;s/arm64/arm64/')/pkg" && sudo installer -pkg /tmp/breeze-agent.pkg -target / && sudo breeze-agent enroll "${token}" --server "${apiUrl}"${secretFlag} && sudo launchctl kickstart -k system/com.breeze.agent`;
                const linuxCmd = `curl -fsSL -o breeze-agent "${ghBase}/breeze-agent-linux-$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')" && chmod +x breeze-agent && sudo mv breeze-agent /usr/local/bin/ && sudo breeze-agent service install && sudo breeze-agent enroll "${token}" --server "${apiUrl}"${secretFlag} && sudo breeze-agent service start`;

                return (
                  <>
                    <div>
                      <h3 className="text-sm font-semibold mb-3">Windows (PowerShell - Run as Administrator)</h3>
                      <div className="rounded-lg border bg-muted/30 p-4">
                        <div className="flex items-start justify-between gap-2">
                          <code className="text-xs font-mono text-muted-foreground break-all">
                            {winCmd}
                          </code>
                          <button
                            type="button"
                            onClick={() => handleCopyCommand(winCmd)}
                            className="flex-shrink-0 p-1 hover:bg-muted rounded"
                          >
                            <Copy className="h-4 w-4" />
                          </button>
                        </div>
                      </div>
                    </div>

                    <div>
                      <h3 className="text-sm font-semibold mb-3">macOS (Terminal)</h3>
                      <div className="rounded-lg border bg-muted/30 p-4">
                        <div className="flex items-start justify-between gap-2">
                          <code className="text-xs font-mono text-muted-foreground break-all">
                            {macCmd}
                          </code>
                          <button
                            type="button"
                            onClick={() => handleCopyCommand(macCmd)}
                            className="flex-shrink-0 p-1 hover:bg-muted rounded"
                          >
                            <Copy className="h-4 w-4" />
                          </button>
                        </div>
                      </div>
                    </div>

                    <div>
                      <h3 className="text-sm font-semibold mb-3">Linux (Terminal)</h3>
                      <div className="rounded-lg border bg-muted/30 p-4">
                        <div className="flex items-start justify-between gap-2">
                          <code className="text-xs font-mono text-muted-foreground break-all">
                            {linuxCmd}
                          </code>
                          <button
                            type="button"
                            onClick={() => handleCopyCommand(linuxCmd)}
                            className="flex-shrink-0 p-1 hover:bg-muted rounded"
                          >
                            <Copy className="h-4 w-4" />
                          </button>
                        </div>
                      </div>
                    </div>
                  </>
                );
              })()}

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
          onAction={handleDeviceAction}
        />
      )}
    </div>
  );
}
