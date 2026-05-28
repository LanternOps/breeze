import { useState, useEffect, useCallback, useMemo } from 'react';
import { useEventStream } from '../../hooks/useEventStream';
import { List, Grid, Plus, AlertCircle, Globe, Building2 } from 'lucide-react';
import { showToast } from '../shared/Toast';
import type { FilterConditionGroup } from '@breeze/shared';
import { useOrgStore } from '../../stores/orgStore';
import DeviceList, { type Device, type DeviceStatus, type OSType } from './DeviceList';
import type { DeviceRole } from '@/lib/deviceRoles';
import DeviceCard from './DeviceCard';
import ScriptPickerModal, { type Script, type ScriptRunAsSelection } from './ScriptPickerModal';
import DeviceSettingsModal from './DeviceSettingsModal';
import AddDeviceModal from './AddDeviceModal';
import CreateGroupModal from './CreateGroupModal';
import { DeviceFilterBar } from '../filters/DeviceFilterBar';
import { FilterChipBar } from './FilterChipBar';
import { QuickAddChips } from './QuickAddChips';
import { SavedFiltersPanel } from './SavedFiltersPanel';
import { decodeFilterFromHash, writeFilterToHash, isFiltersV2Enabled } from './filterUrl';
import { fetchWithAuth } from '../../stores/auth';
import { sendDeviceCommand, sendBulkCommand, executeScript, toggleMaintenanceMode, decommissionDevice, bulkDecommissionDevices, restoreDevice, permanentDeleteDevice, sendWakeCommand, sendBulkWakeCommand, summarizeBulkWakeFailures, watchWakeOutcome, WakeCommandError, wakeFriendlyErrorMessage } from '../../services/deviceActions';
import { navigateTo } from '@/lib/navigation';
import { getErrorMessage, getErrorTitle } from '@/lib/errorMessages';
import { asRecord, toPercent } from '@/lib/deviceUtils';
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

type DeviceGroup = {
  id: string;
  name: string;
  type: 'static' | 'dynamic';
  deviceCount: number;
  deviceIds?: string[];
};

export default function DevicesPage() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [deviceGroups, setDeviceGroups] = useState<DeviceGroup[]>([]);
  const [groupMembershipMap, setGroupMembershipMap] = useState<Map<string, Set<string>>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('list');
  const [actionInProgress, setActionInProgress] = useState(false);
  const [bulkProgress, setBulkProgress] = useState<{ current: number; total: number; label: string } | null>(null);
  const [showAddDevice, setShowAddDevice] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.location.hash === '#add-device';
  });
  const [scriptPickerOpen, setScriptPickerOpen] = useState(false);
  const [scriptTargetDevices, setScriptTargetDevices] = useState<Device[]>([]);
  const [settingsDevice, setSettingsDevice] = useState<Device | null>(null);
  // Initial filter is read from #filtersV2=… hash so a shared link round-trips.
  const [advancedFilter, setAdvancedFilter] = useState<FilterConditionGroup | null>(() => {
    if (typeof window === 'undefined') return null;
    return decodeFilterFromHash(window.location.hash);
  });
  const [showCreateGroup, setShowCreateGroup] = useState(false);
  const [autoSelectGroupId, setAutoSelectGroupId] = useState<string | null>(null);

  const { currentOrgId, organizations } = useOrgStore();

  // Org scope toggle: 'current' narrows the list to currentOrgId, 'all' shows
  // every device the caller's auth scope grants access to. URL-hash synced so
  // the choice survives reload and is shareable. Default is 'current' so the
  // org switcher's selection visibly narrows the list (it didn't before this
  // toggle existed — the page silently showed every accessible org).
  const [orgScope, setOrgScope] = useState<'current' | 'all'>(() => {
    if (typeof window === 'undefined') return 'current';
    const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    return params.get('scope') === 'all' ? 'all' : 'current';
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    if (orgScope === 'all') {
      params.set('scope', 'all');
    } else {
      params.delete('scope');
    }
    const next = params.toString();
    const desired = next ? `#${next}` : '';
    if (window.location.hash !== desired) {
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${desired}`);
    }
  }, [orgScope]);

  // When 'current' scope is active and we have a currentOrgId, lock the
  // DeviceList's internal org filter to it. When 'all', leave the filter
  // unlocked so the user sees every accessible org. null = unlocked.
  const lockedOrgFilter: string | null = orgScope === 'current' ? currentOrgId : null;

  const currentOrgName = useMemo(
    () => organizations.find((o) => o.id === currentOrgId)?.name ?? 'Current org',
    [organizations, currentOrgId]
  );

  // Grid view doesn't pass through DeviceList's filter logic, so apply the
  // same scope filter here for parity.
  const scopedDevices = useMemo(
    () => (lockedOrgFilter ? devices.filter((d) => d.orgId === lockedOrgFilter) : devices),
    [devices, lockedOrgFilter]
  );

  // v2 chip-filter UI feature flag. Evaluated once per mount — toggling
  // mid-session would require a reload to re-paint state.
  const filtersV2 = typeof window !== 'undefined' ? isFiltersV2Enabled() : false;

  // Distinct software-name list for the multi-select picker (spec 4.2).
  // Cheap one-shot fetch; the dropdown is hidden behind a search box so 500
  // names is fine. We tolerate failure (multi-select falls back to CSV).
  const [softwareOptions, setSoftwareOptions] = useState<string[] | undefined>(undefined);
  // Per-name fleet device counts to render next to each picker option.
  const [softwareOptionCounts, setSoftwareOptionCounts] = useState<Record<string, number> | undefined>(undefined);
  // Bumped by FilterChipBar's Ctrl+S handler to trigger SavedFiltersPanel's
  // save prompt. Keeping the panel as the source-of-truth for the save flow
  // (incl. error handling) and passing only a counter avoids prop drilling.
  const [saveTrigger, setSaveTrigger] = useState(0);

  useEffect(() => {
    if (!filtersV2) return;
    const ctrl = new AbortController();
    (async () => {
      try {
        // Fleet-wide distinct list. When the user is in All-orgs scope we
        // opt out of fetchWithAuth's auto-injected orgId so partner/system
        // callers see every accessible org's software inventory, not just
        // the currently-selected org's. Without the opt-out, the dropdown
        // would silently shrink to current-org software when the toggle
        // says "All orgs" — defeating the whole point.
        const res = await fetchWithAuth(
          '/devices/software/distinct?limit=500',
          { signal: ctrl.signal },
          { skipOrgIdInjection: orgScope === 'all' }
        );
        if (!res.ok) return;
        const body = await res.json();
        const rows = (body?.data ?? []) as Array<{ name?: string; deviceCount?: number }>;
        const names: string[] = [];
        const counts: Record<string, number> = {};
        for (const r of rows) {
          if (!r.name) continue;
          names.push(r.name);
          if (typeof r.deviceCount === 'number') counts[r.name] = r.deviceCount;
        }
        setSoftwareOptions(names);
        setSoftwareOptionCounts(counts);
      } catch (e) {
        if ((e as Error).name !== 'AbortError') {
          // Quiet: editor falls back to comma-separated text input.
        }
      }
    })();
    return () => ctrl.abort();
  }, [filtersV2, orgScope]);

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

      // /devices opts out of fetchWithAuth's auto-injected orgId so the
      // server returns every device in the caller's accessible scope,
      // not just the current-org subset. The Current/All-orgs toggle
      // then narrows client-side via DeviceList's lockedOrgFilter.
      // Without the opt-out, "All orgs" looks identical to "Current org"
      // because the server already pre-filtered.
      const [devicesResponse, orgsResponse, sitesResponse, groupsResponse] = await Promise.all([
        // limit=500 matches the API-side cap for /devices; the list is
        // paginated client-side after this fetch. Larger fleets need
        // server-side sort/filter/page — tracked separately.
        // skipOrgIdInjection: true so the All Orgs toggle can show every
        // device in the caller's scope, not just current-org subset.
        fetchWithAuth('/devices?includeDecommissioned=true&limit=500', {}, { skipOrgIdInjection: true }),
        fetchWithAuth('/orgs'),
        fetchWithAuth('/orgs/sites'),
        fetchWithAuth('/device-groups?includeMemberships=true').catch((err) => {
          console.warn('Failed to fetch device groups:', err);
          return null;
        })
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
          deviceRoleSource: d.deviceRoleSource as string | undefined,
          lastUser: d.lastUser as string | undefined,
          uptimeSeconds: typeof d.uptimeSeconds === 'number' ? d.uptimeSeconds : undefined,
          osBuild: d.osBuild as string | undefined,
          architecture: d.architecture as string | undefined,
          isHeadless: typeof d.isHeadless === 'boolean' ? d.isHeadless : undefined,
          enrolledAt: d.enrolledAt as string | undefined,
          desktopAccess: (d.desktopAccess as Device['desktopAccess']) ?? null,
          hardware: hardware ? {
            cpuModel: hardware.cpuModel as string | undefined,
            cpuCores: typeof hardware.cpuCores === 'number' ? hardware.cpuCores : undefined,
            ramTotalMb: typeof hardware.ramTotalMb === 'number' ? hardware.ramTotalMb : undefined,
            diskTotalGb: typeof hardware.diskTotalGb === 'number' ? hardware.diskTotalGb : undefined,
          } : undefined,
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

      // Fetch groups for group filter
      let groupsList: DeviceGroup[] = [];
      if (groupsResponse && groupsResponse.ok) {
        const groupsData = await groupsResponse.json();
        groupsList = groupsData.data ?? groupsData.groups ?? [];
      } else if (groupsResponse && !groupsResponse.ok) {
        console.warn('Failed to fetch device groups:', groupsResponse.status);
      }

      // Build group membership map: groupId -> Set<deviceId>
      const memberMap = new Map<string, Set<string>>();
      for (const group of groupsList) {
        if (group.deviceIds) {
          memberMap.set(group.id, new Set(group.deviceIds));
        }
      }

      setDeviceGroups(groupsList);
      setGroupMembershipMap(memberMap);
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

  const handleGroupCreated = useCallback(async (newGroupId: string) => {
    setShowCreateGroup(false);
    setAutoSelectGroupId(newGroupId);
    await fetchDevices();
  }, [fetchDevices]);

  const handleAutoSelectConsumed = useCallback(() => {
    setAutoSelectGroupId(null);
  }, []);

  // Real-time device status updates
  const handleDeviceEvent = useCallback((event: { type: string; payload: Record<string, unknown> }) => {
    const { type, payload } = event;
    const deviceId = payload.deviceId as string;
    if (!deviceId) return;

    if (type === 'device.online' || type === 'device.offline') {
      setDevices(prev => prev.map(d =>
        d.id === deviceId
          ? { ...d, status: (payload.status as string ?? (type === 'device.online' ? 'online' : 'offline')) as DeviceStatus, lastSeen: new Date().toISOString() }
          : d
      ));
    } else if (type === 'device.updated') {
      const fields = payload.fields as string[] | undefined;
      if (fields?.includes('agentVersion')) {
        setDevices(prev => prev.map(d =>
          d.id === deviceId
            ? { ...d, agentVersion: (payload.agentVersion as string) ?? d.agentVersion }
            : d
        ));
      }
    } else if (type === 'device.enrolled' || type === 'device.decommissioned') {
      fetchDevices();
    }
  }, [fetchDevices]);

  const { subscribe } = useEventStream({ onEvent: handleDeviceEvent });

  useEffect(() => {
    subscribe(['device.online', 'device.offline', 'device.updated', 'device.enrolled', 'device.decommissioned']);
  }, [subscribe]);

  // Sync the chip-bar filter state into the URL hash so the view is
  // shareable. Only active when v2 UI is on; legacy DeviceFilterBar owns
  // its own state and doesn't expect hash interop.
  useEffect(() => {
    if (!filtersV2) return;
    writeFilterToHash(advancedFilter);
  }, [advancedFilter, filtersV2]);

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

  const handleScriptSelect = async (script: Script, runAs: ScriptRunAsSelection, parameters?: Record<string, unknown>) => {
    if (actionInProgress) return;

    try {
      setActionInProgress(true);
      const deviceIds = scriptTargetDevices.map(d => d.id);
      const result = await executeScript(script.id, deviceIds, parameters, runAs);

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

        case 'wake': {
          try {
            const wake = await sendWakeCommand(device.id);
            const hostname = device.hostname;
            showToast({
              type: 'success',
              message: `Wake packet sent to ${hostname} via ${wake.relay.hostname} (${wake.broadcast}). Watching for it to come online…`,
            });
            void watchWakeOutcome(device.id).then(async (outcome) => {
              if (outcome === 'online') {
                showToast({ type: 'success', message: `${hostname} is now online.` });
                await fetchDevices();
              } else if (outcome === 'timeout') {
                showToast({
                  type: 'error',
                  message: `${hostname} did not come online within 4 minutes. Check ethernet + BIOS WoL.`,
                });
              }
            });
          } catch (err) {
            if (err instanceof WakeCommandError) {
              const friendly = wakeFriendlyErrorMessage(err.code) ?? err.message;
              showToast({ type: 'error', message: `${device.hostname}: ${friendly}` });
            } else {
              throw err;
            }
          }
          break;
        }

        case 'refresh': {
          await sendDeviceCommand(device.id, 'refresh_inventory');
          showToast({
            type: 'success',
            message: `Inventory refresh requested for ${device.hostname}. Fresh data in 1–2 minutes.`,
          });
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

        case 'wake': {
          // One round-trip; server iterates per-device with relay-pick per LAN
          // and returns per-device outcome. We render one summary toast
          // grouped by failure code so a 50-device bulk doesn't spam 50
          // toasts.
          const summary = await sendBulkWakeCommand(deviceIds);
          const failureSummary = summarizeBulkWakeFailures(summary.failed);
          if (summary.failed.length === 0) {
            showToast({
              type: 'success',
              message: `Wake packets sent to ${summary.succeeded.length} device${summary.succeeded.length === 1 ? '' : 's'}. Allow up to 5 minutes to come online.`,
            });
          } else if (summary.succeeded.length === 0) {
            showToast({
              type: 'error',
              message: `Could not wake any of ${summary.failed.length} device${summary.failed.length === 1 ? '' : 's'}: ${failureSummary}.`,
            });
          } else {
            showToast({
              type: 'error',
              message: `Wake sent to ${summary.succeeded.length} of ${summary.succeeded.length + summary.failed.length} devices. ${summary.failed.length} could not be woken: ${failureSummary}.`,
            });
          }
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
        <div className="flex flex-wrap items-center gap-3">
          <div
            className="inline-flex rounded-md border"
            role="group"
            aria-label="Organization scope"
            data-testid="org-scope-toggle"
          >
            <button
              type="button"
              onClick={() => setOrgScope('current')}
              disabled={!currentOrgId}
              title={currentOrgId ? `Show only ${currentOrgName}` : 'No current organization selected'}
              aria-pressed={orgScope === 'current'}
              data-testid="org-scope-current"
              className={`flex h-10 items-center gap-1.5 rounded-l-md px-3 text-xs font-medium transition ${
                orgScope === 'current' ? 'bg-muted' : 'hover:bg-muted/50'
              } disabled:cursor-not-allowed disabled:opacity-50`}
            >
              <Building2 className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Current org</span>
              <span className="sm:hidden">Org</span>
            </button>
            <button
              type="button"
              onClick={() => setOrgScope('all')}
              title="Show every endpoint across all accessible organizations"
              aria-pressed={orgScope === 'all'}
              data-testid="org-scope-all"
              className={`flex h-10 items-center gap-1.5 rounded-r-md border-l px-3 text-xs font-medium transition ${
                orgScope === 'all' ? 'bg-muted' : 'hover:bg-muted/50'
              }`}
            >
              <Globe className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">All orgs</span>
              <span className="sm:hidden">All</span>
            </button>
          </div>
          <div className="flex rounded-md border">
            <button
              type="button"
              onClick={() => setViewMode('list')}
              className={`flex h-10 w-10 items-center justify-center rounded-l-md transition ${
                viewMode === 'list' ? 'bg-muted' : 'hover:bg-muted/50'
              }`}
              title="List view"
              aria-label="List view"
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
              aria-label="Grid view"
            >
              <Grid className="h-4 w-4" />
            </button>
          </div>
          <button
            type="button"
            onClick={() => setShowAddDevice(true)}
            className="flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90"
          >
            <Plus className="h-4 w-4" />
            Add Device
          </button>
        </div>
      </div>

      {filtersV2 ? (
        <div className="flex flex-col gap-2">
          <FilterChipBar
            value={advancedFilter}
            onChange={setAdvancedFilter}
            orgs={orgs}
            sites={sites}
            softwareOptions={softwareOptions}
            softwareOptionCounts={softwareOptionCounts}
            onSaveRequested={() => setSaveTrigger(t => t + 1)}
            rightSlot={
              <SavedFiltersPanel
                currentFilter={advancedFilter}
                onApply={setAdvancedFilter}
                saveTrigger={saveTrigger}
              />
            }
          />
          <QuickAddChips value={advancedFilter} onChange={setAdvancedFilter} />
        </div>
      ) : (
        <DeviceFilterBar
          value={advancedFilter}
          onChange={setAdvancedFilter}
          showSavedFilters={true}
          collapsible={true}
        />
      )}

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
        <div className="rounded-lg border bg-card p-8">
          <div className="max-w-lg">
            <h2 className="text-lg font-semibold text-foreground mb-2">Your fleet is empty</h2>
            <p className="text-sm text-muted-foreground mb-6">
              Get started by adding your first device. The installer and enrollment key are generated automatically.
            </p>
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => setShowAddDevice(true)}
                className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
              >
                <Plus className="h-4 w-4" />
                Add Device
              </button>
              <a href="https://docs.breezermm.com/agents/installation/" target="_blank" rel="noopener" className="inline-flex items-center gap-1.5 rounded-md border px-4 py-2 text-sm font-medium text-foreground hover:bg-muted transition-colors">
                View installation guide
              </a>
            </div>
          </div>
        </div>
      ) : viewMode === 'list' ? (
        <DeviceList
          devices={devices}
          orgs={orgs}
          sites={sites}
          groups={deviceGroups}
          groupMembershipMap={groupMembershipMap}
          onSelect={handleSelectDevice}
          onAction={handleDeviceAction}
          onBulkAction={handleBulkAction}
          serverFilter={advancedFilter}
          onCreateGroup={() => setShowCreateGroup(true)}
          autoSelectGroupId={autoSelectGroupId}
          onAutoSelectConsumed={handleAutoSelectConsumed}
          lockedOrgFilter={lockedOrgFilter}
          orgScope={orgScope}
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {scopedDevices.map(device => (
            <DeviceCard
              key={device.id}
              device={device}
              onClick={handleSelectDevice}
              onAction={handleDeviceAction}
            />
          ))}
        </div>
      )}

      <AddDeviceModal isOpen={showAddDevice} onClose={() => setShowAddDevice(false)} />

      <CreateGroupModal
        isOpen={showCreateGroup}
        onClose={() => setShowCreateGroup(false)}
        onCreated={handleGroupCreated}
      />

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
