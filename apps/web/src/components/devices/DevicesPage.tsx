import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useEventStream } from '../../hooks/useEventStream';
import { useAdvancedFilterIds } from '../../hooks/useAdvancedFilterIds';
import { List, Grid, Plus, AlertCircle } from 'lucide-react';
import { showToast } from '../shared/Toast';
import type { FilterConditionGroup } from '@breeze/shared';
import DeviceList, { type Device, type DeviceClass, type DeviceStatus, type OSType } from './DeviceList';
import type { DeviceRole } from '@/lib/deviceRoles';
import DeviceCard from './DeviceCard';
import ScriptPickerModal, { type Script, type ScriptRunAsSelection } from './ScriptPickerModal';
import DeviceSettingsModal from './DeviceSettingsModal';
import AddDeviceModal from './AddDeviceModal';
import CreateGroupModal from './CreateGroupModal';
import { DeviceFilterBar } from '../filters/DeviceFilterBar';
import { FilterChipBar } from './FilterChipBar';
import { QuickAddChips } from './QuickAddChips';
import { decodeFilterFromHash, writeFilterToHash, isFiltersV2Enabled } from './filterUrl';
import { fetchWithAuth } from '../../stores/auth';
import { fetchAllDevices, fetchAllNetworkDevices } from '../../lib/devicesFetch';
import { sendDeviceCommand, sendBulkCommand, executeScript, toggleMaintenanceMode, decommissionDevice, bulkDecommissionDevices, restoreDevice, permanentDeleteDevice, sendWakeCommand, sendBulkWakeCommand, summarizeBulkWakeFailures, summarizeBulkCommandFailures, watchWakeOutcome, WakeCommandError, wakeFriendlyErrorMessage } from '../../services/deviceActions';
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

// Compact, bounded summary of which devices failed in a per-item bulk loop, so
// a 50-device batch with failures yields one readable toast (not 50 toasts or
// an opaque "some failed"). Caps the named list to avoid an unbounded string.
function summarizeFailedDevices(names: string[]): string {
  const shown = names.slice(0, 3);
  const rest = names.length - shown.length;
  return rest > 0 ? `${shown.join(', ')} and ${rest} more` : shown.join(', ');
}

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
  // v2 chip bar seeds its filter from the URL hash so a filtered view is
  // shareable; the legacy DeviceFilterBar owns its own state and ignores it.
  const [advancedFilter, setAdvancedFilter] = useState<FilterConditionGroup | null>(() => {
    if (typeof window === 'undefined') return null;
    return decodeFilterFromHash(window.location.hash);
  });
  const filtersV2 = typeof window !== 'undefined' ? isFiltersV2Enabled() : false;
  // Resolve the advanced filter to the complete (uncapped) matching id set
  // once, here, so the list AND grid views render the same filtered fleet.
  // The grid previously mapped the raw devices array and ignored the filter.
  const { ids: advancedFilterIds, loading: advancedFilterLoading } = useAdvancedFilterIds(advancedFilter);
  const [showCreateGroup, setShowCreateGroup] = useState(false);
  const [autoSelectGroupId, setAutoSelectGroupId] = useState<string | null>(null);

  // Track every in-flight wake watcher so navigating away aborts the
  // long-running poll loop. Without this, each wake fired on this page
  // keeps polling /devices/:id for up to 4 minutes after unmount and
  // attempts setState (via showToast + fetchDevices) on a dead component.
  // (Todd's #789 review.) A user can wake several rows in quick
  // succession, hence a Set rather than a single controller.
  const wakeWatchersRef = useRef<Set<AbortController>>(new Set());
  useEffect(() => {
    const watchers = wakeWatchersRef.current;
    return () => {
      for (const ctrl of watchers) ctrl.abort();
      watchers.clear();
    };
  }, []);

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

  // Grid view applies the advanced filter here; the list view passes the id
  // set into DeviceList, which combines it with its local quick-filters
  // (search/status/os/etc. stay list-only).
  const gridDevices = useMemo(
    () => (advancedFilterIds === null ? devices : devices.filter(d => advancedFilterIds.has(d.id))),
    [devices, advancedFilterIds]
  );

  const fetchDevices = useCallback(async (signal?: AbortSignal) => {
    try {
      setLoading(true);
      setError(null);

      // Devices walk the cursor (Discussion #742 PR 3); orgs/sites/groups
      // are bounded one-shot fetches. Run all four in parallel so the
      // first paint isn't gated on the slowest one. fetchAllDevices is
      // forward+backward compatible: against the cursor API it walks
      // pages, against the legacy offset API it returns the first
      // capped page and stops — same UX as before, no user-visible cap
      // once the server-side cursor migration lands.
      //
      // `signal` is wired by the mount useEffect's AbortController so a
      // navigate-away mid-walk stops the next page request and prevents
      // setState on an unmounted component (#778 review).
      const [devicesResult, networkResult, orgsResponse, sitesResponse, groupsResponse] = await Promise.all([
        fetchAllDevices({
          includeDecommissioned: true,
          signal,
          // Surface the silent-cap case (#778 review). Without this, hitting
          // the safety ceiling would render an incomplete device list and
          // get reported later as "devices are missing."
          onTruncated: ({ actualCount }) => {
            showToast({
              type: 'error',
              message:
                `Devices list truncated at ${actualCount} rows ` +
                `(safety cap hit). Some devices may not be shown — refresh or contact support.`,
              duration: 8000
            });
          }
        }),
        // Network arm of the unified list (#1322) — approved, unlinked
        // discovered_assets. Best-effort: a transient/absent-endpoint failure
        // here must not blank the agent fleet, so we degrade to an empty
        // network set. A 401, however, is a real auth failure and must NOT be
        // masked — re-throw it so it propagates to the outer catch and gets the
        // same auth-redirect/logout handling as the agent arm (fetchWithAuth
        // already triggered logout). Swallowing it would leave the user on a
        // half-rendered, silently-broken page. (The endpoint-absent case is
        // a 404, already degraded to empty inside fetchAllNetworkDevices.)
        fetchAllNetworkDevices({ signal }).catch((err) => {
          if (err instanceof Error && err.name === 'AbortError') throw err;
          if (err instanceof Response && err.status === 401) throw err;
          console.warn('Failed to fetch network devices:', err);
          return { data: [], total: 0, pagesWalked: 0 };
        }),
        fetchWithAuth('/orgs', { signal }),
        fetchWithAuth('/orgs/sites', { signal }),
        fetchWithAuth('/device-groups?includeMemberships=true', { signal }).catch((err) => {
          // AbortError on unmount is expected — bubble it up so the outer
          // catch can short-circuit cleanly; don't log it as a real failure.
          if (err instanceof Error && err.name === 'AbortError') throw err;
          console.warn('Failed to fetch device groups:', err);
          return null;
        })
      ]);

      const deviceList = devicesResult.data;

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
          mainAgentSilentSince: (d.mainAgentSilentSince ?? null) as string | null,
          watchdogStatus: (d.watchdogStatus ?? null) as Device['watchdogStatus'],
          lastUser: d.lastUser as string | undefined,
          uptimeSeconds: typeof d.uptimeSeconds === 'number' ? d.uptimeSeconds : undefined,
          osBuild: d.osBuild as string | undefined,
          architecture: d.architecture as string | undefined,
          isHeadless: typeof d.isHeadless === 'boolean' ? d.isHeadless : undefined,
          pendingReboot: d.pendingReboot === true,
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

      // Network arm (#1322): normalize discovered_assets rows into the same
      // Device shape so they render in one list. Agent-only fields stay blank.
      const transformedNetworkDevices: Device[] = networkResult.data.map((d: Record<string, unknown>) => ({
        id: d.id as string,
        deviceClass: (d.deviceClass as DeviceClass) ?? 'network',
        assetType: (d.assetType as DeviceRole | undefined) ?? 'unknown',
        hostname: (d.hostname ?? d.displayName ?? 'Unknown') as string,
        // No OS for a network device; the OS column renders "—" for network rows.
        os: '' as OSType,
        osVersion: '',
        status: (d.status ?? 'offline') as DeviceStatus,
        cpuPercent: 0,
        ramPercent: 0,
        lastSeen: (d.lastSeenAt ?? '') as string,
        orgId: (d.orgId ?? '') as string,
        orgName: '',
        siteId: (d.siteId ?? '') as string,
        siteName: '',
        agentVersion: '',
        tags: (d.tags ?? []) as string[],
        manufacturer: (d.manufacturer ?? null) as string | null,
        model: (d.model ?? null) as string | null,
        responseTimeMs: typeof d.responseTimeMs === 'number' ? d.responseTimeMs : null,
        monitoringEnabled: d.monitoringEnabled === true,
        enrolledAt: d.enrolledAt as string | undefined,
      }));

      const allTransformed = [...transformedDevices, ...transformedNetworkDevices];

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

      // Assign org and site names to devices (agent + network arms).
      const devicesWithNames = allTransformed.map(device => ({
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
      // Aborts are expected when the component unmounts mid-walk — drop
      // them silently rather than rendering a misleading error banner.
      if (err instanceof Error && err.name === 'AbortError') return;
      setError(err);
    } finally {
      // setLoading(false) is harmless after unmount (React 18 ignores
      // setState on unmounted components for hook-based components) but
      // we still skip it when we know the call aborted, to avoid a
      // brief flicker if the component remounts on the same key.
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetchDevices(controller.signal);
    return () => controller.abort();
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

  // Mirror the chip-bar filter into the URL hash so the view is shareable.
  // Only active under v2; the legacy bar doesn't expect hash interop.
  useEffect(() => {
    if (!filtersV2) return;
    writeFilterToHash(advancedFilter);
  }, [advancedFilter, filtersV2]);

  const handleSelectDevice = (device: Device) => {
    // Network-discovered devices have no agent device-detail page yet
    // (per-type overview pages are deferred to a #1322 follow-up). Route to
    // the existing Discovery asset view, deep-linked to this asset.
    if ((device.deviceClass ?? 'agent') === 'network') {
      void navigateTo(`/discovery?tab=assets&asset=${device.id}`);
      return;
    }
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
            const wakeController = new AbortController();
            wakeWatchersRef.current.add(wakeController);
            void watchWakeOutcome(device.id, { signal: wakeController.signal })
              .then(async (outcome) => {
                if (outcome === 'online') {
                  showToast({ type: 'success', message: `${hostname} is now online.` });
                  await fetchDevices();
                } else if (outcome === 'timeout') {
                  showToast({
                    type: 'error',
                    message: `${hostname} did not come online within 4 minutes. Check ethernet + BIOS WoL.`,
                  });
                }
                // 'aborted' is silent — user navigated away or page reloaded.
              })
              .finally(() => {
                wakeWatchersRef.current.delete(wakeController);
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

  const handleBulkAction = async (action: string, allSelectedDevices: Device[]) => {
    if (actionInProgress || allSelectedDevices.length === 0) return;

    // Every bulk action below talks to an enrolled agent (reboot/shutdown/lock,
    // maintenance, decommission, wake, run-script, deploy-software). A network
    // row's `id` is a `discovered_assets.id`, NOT a `devices.id` — feeding it
    // into an agent-only endpoint 404s (e.g. PATCH /devices/:id/maintenance),
    // and an unhandled throw mid-loop would silently skip every real device
    // after it. So drop network rows up front for these actions and tell the
    // user, rather than letting them flow into the per-device loops (#1322).
    const selectedDevices = allSelectedDevices.filter(d => (d.deviceClass ?? 'agent') === 'agent');
    const skippedNetworkCount = allSelectedDevices.length - selectedDevices.length;
    if (selectedDevices.length === 0) {
      showToast({
        type: 'error',
        message: 'This action applies to agent devices only. Network devices have no agent and were skipped.',
      });
      return;
    }
    if (skippedNetworkCount > 0) {
      showToast({
        type: 'warning',
        message: `${skippedNetworkCount} network device${skippedNetworkCount === 1 ? '' : 's'} skipped — this action applies to agent devices only.`,
      });
    }

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
          const skippedCount = result.skipped?.length ?? 0;
          const bulkLabel = action === 'reboot_safe_mode' ? 'Reboot to Safe Mode' : action.charAt(0).toUpperCase() + action.slice(1);
          const skippedTail = skippedCount > 0 ? `, ${skippedCount} already pending` : '';

          if (failedCount === 0) {
            showToast({
              type: 'success',
              message: `${bulkLabel} command sent to ${successCount} device${successCount === 1 ? '' : 's'}${skippedTail}`,
            });
          } else {
            const failureSummary = summarizeBulkCommandFailures(result.failed ?? []);
            showToast({
              type: 'error',
              message: `${bulkLabel} sent to ${successCount} device${successCount === 1 ? '' : 's'}${skippedTail}; ${failedCount} failed: ${failureSummary}.`,
            });
          }
          break;
        }

        case 'maintenance-on':
        case 'maintenance-off': {
          const enabling = action === 'maintenance-on';
          const mLabel = enabling ? 'Enabling maintenance mode' : 'Disabling maintenance mode';
          setBulkProgress({ current: 0, total: deviceCount, label: mLabel });
          let mDone = 0;
          const mFailed: string[] = [];
          // Per-device try/catch: one device 404'ing/erroring must NOT abort
          // the batch and silently skip every device after it. Collect the
          // failures and report them in a single summary toast (#1322).
          for (const device of selectedDevices) {
            try {
              await toggleMaintenanceMode(device.id, enabling);
            } catch {
              mFailed.push(device.hostname || device.id);
            }
            mDone++;
            setBulkProgress({ current: mDone, total: deviceCount, label: mLabel });
          }
          setBulkProgress(null);
          const mSucceeded = deviceCount - mFailed.length;
          const mVerb = enabling ? 'put into' : 'taken out of';
          if (mFailed.length === 0) {
            showToast({ type: 'success', message: `${mSucceeded} device${mSucceeded === 1 ? '' : 's'} ${mVerb} maintenance mode` });
          } else if (mSucceeded === 0) {
            showToast({ type: 'error', message: `Failed to update maintenance mode for all ${mFailed.length} device${mFailed.length === 1 ? '' : 's'}: ${summarizeFailedDevices(mFailed)}` });
          } else {
            showToast({ type: 'error', message: `${mSucceeded} device${mSucceeded === 1 ? '' : 's'} ${mVerb} maintenance mode; ${mFailed.length} failed: ${summarizeFailedDevices(mFailed)}` });
          }
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
            onClick={() => void fetchDevices()}
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
          serverFilterIds={advancedFilterIds}
          serverFilterLoading={advancedFilterLoading}
          onCreateGroup={() => setShowCreateGroup(true)}
          autoSelectGroupId={autoSelectGroupId}
          onAutoSelectConsumed={handleAutoSelectConsumed}
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {gridDevices.map(device => (
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
