import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useEventStream } from '../../hooks/useEventStream';
import { useAdvancedFilterIds } from '../../hooks/useAdvancedFilterIds';
import { List, Grid, Plus, AlertCircle } from 'lucide-react';
import { showToast } from '../shared/Toast';
import type { FilterCondition, FilterConditionGroup } from '@breeze/shared';
import DeviceList, { type Device, type DeviceClass, type DeviceStatus, type OSType } from './DeviceList';
import type { DeviceRole } from '@/lib/deviceRoles';
import DeviceCard from './DeviceCard';
import DecommissionedHiddenHint from './DecommissionedHiddenHint';
import ScriptPickerModal, { type Script, type ScriptRunAsSelection } from './ScriptPickerModal';
import DeviceSettingsModal from './DeviceSettingsModal';
import AddDeviceModal from './AddDeviceModal';
import CreateGroupModal from './CreateGroupModal';
import LinkVmHostModal from './LinkVmHostModal';
import { DeviceFilterBar } from '../filters/DeviceFilterBar';
import { DeviceFilterToolbar } from './DeviceFilterToolbar';
import { type ListFilters, DEFAULT_LIST_FILTERS } from './deviceListFilters';
import { decodeFilterFromHash, writeFilterToHash, isFiltersV2Enabled } from './filterUrl';
import { DeviceClassSegment } from './DeviceClassSegment';
import {
  filterDevicesByClass,
  countDevicesByClass,
  readDeviceClassFromHash,
  writeDeviceClassToHash,
  type DeviceClassFilter,
} from './deviceClassFilter';
import { fetchWithAuth } from '../../stores/auth';
import { fetchAllDevices, fetchAllNetworkDevices } from '../../lib/devicesFetch';
import { useOrgStore } from '../../stores/orgStore';
import { sendDeviceCommand, sendBulkCommand, executeScript, toggleMaintenanceMode, decommissionDevice, bulkDecommissionDevices, restoreDevice, permanentDeleteDevice, sendWakeCommand, sendBulkWakeCommand, summarizeBulkWakeFailures, summarizeBulkCommandFailures, watchWakeOutcome, WakeCommandError, wakeFriendlyErrorMessage, linkDevicesMultiboot, linkDevicesVmHost } from '../../services/deviceActions';
import { navigateTo } from '@/lib/navigation';
import { useHashState } from '@/lib/useHashState';
import { getErrorMessage, getErrorTitle, isAccessDenied } from '@/lib/errorMessages';
import AccessDenied from '../shared/AccessDenied';
import { asRecord, toPercent } from '@/lib/deviceUtils';
import { ENABLE_NETWORK_DEVICES_IN_LIST } from '@/lib/featureFlags';
import ProgressBar from '../shared/ProgressBar';
import { ConfirmDialog } from '../shared/ConfirmDialog';
import { scopeConfirmMessage } from '@/lib/scopeConfirmMessage';
import { DECOMMISSION_BLOCKED_BULK_ACTIONS, isCommandQueueable } from './bulkActionGating';
// Initializes the shared i18next singleton. Islands hydrate independently, so
// an island that hydrates before whichever other island happens to pull i18n in
// would otherwise render raw keys (and mismatch the SSR markup).
import '../../lib/i18n';

// vm_host member role (#2308): unknown values degrade to "ungrouped" (null) by
// design — a wrong nesting would be worse than none — but the degradation must
// be observable, or a future third role silently flattens every affected fleet
// until someone files "VM nesting stopped working". Warn once per value, not
// per row/refetch.
const warnedUnknownLinkGroupRoles = new Set<string>();
function normalizeLinkGroupRole(value: unknown): 'host' | 'guest' | null {
  if (value === 'host' || value === 'guest') return value;
  if (value != null && !warnedUnknownLinkGroupRoles.has(String(value))) {
    warnedUnknownLinkGroupRoles.add(String(value));
    console.warn(`[devices] unknown linkGroupRole ${JSON.stringify(value)} — treating the device as ungrouped`);
  }
  return null;
}

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
  const { t } = useTranslation('devices');
  // Org scope is shown by the always-visible top-bar switcher (scope pill +
  // org picker); the page header no longer repeats it. orgStoreOrgs is still
  // used to name orgs in the run-script confirm dialog.
  const { organizations: orgStoreOrgs } = useOrgStore();

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
  // The three hash-seeded states below adopt the hash post-mount via
  // useHashState so the first client render matches the SSR markup (#2421).
  const [showAddDevice, setShowAddDevice] = useHashState<boolean>(false, (h) => (h === 'add-device' ? true : undefined));
  const [scriptPickerOpen, setScriptPickerOpen] = useState(false);
  // vm_host link creation (#2308): the bulk action opens a host-picker modal
  // over the selected devices; null = closed.
  const [vmHostPickerDevices, setVmHostPickerDevices] = useState<Device[] | null>(null);
  const [scriptTargetDevices, setScriptTargetDevices] = useState<Device[]>([]);
  type PendingScriptRun = { script: Script; runAs: ScriptRunAsSelection; parameters?: Record<string, unknown>; devices: Device[] };
  const [pendingScriptRun, setPendingScriptRun] = useState<PendingScriptRun | null>(null);
  // #2465: a bulk agent command whose selection included decommissioned devices
  // (the one status the API refuses). `devices` is the eligible subset the action
  // will actually run on — offline devices stay IN, since their command queues
  // and runs on reconnect. The dialog reports what is being dropped so the user
  // confirms the reduced target set rather than having part of their selection
  // silently discarded.
  type PendingDecommissionedSkip = { action: string; devices: Device[]; skippedCount: number; totalCount: number };
  const [pendingDecommissionedSkip, setPendingDecommissionedSkip] = useState<PendingDecommissionedSkip | null>(null);
  const [settingsDevice, setSettingsDevice] = useState<Device | null>(null);
  // v2 chip bar seeds its filter from the URL hash so a filtered view is
  // shareable; the legacy DeviceFilterBar owns its own state and ignores it.
  const [advancedFilter, setAdvancedFilter] = useHashState<FilterConditionGroup | null>(null, (h) => decodeFilterFromHash(h) ?? undefined);
  // [ All | Agent | Network ] class segment (#1424). Seeded from the hash so a
  // chosen class is shareable; a pure client-side narrowing of the merged list.
  // Only meaningful when the network arm is enabled (otherwise the list is
  // agent-only and the segment is hidden).
  const [deviceClassFilter, setDeviceClassFilter] = useHashState<DeviceClassFilter>('all', (h) => readDeviceClassFromHash(h));
  const handleDeviceClassChange = useCallback((next: DeviceClassFilter) => {
    setDeviceClassFilter(next);
    writeDeviceClassToHash(next);
  }, []);
  // Inline ("instant") client-side filters — shared between DeviceFilterToolbar
  // (the controls) and DeviceList (the filtering) so each dimension has a single
  // source of truth. This is the hybrid model's client half; the group above is
  // its server half.
  const [listFilters, setListFilters] = useState<ListFilters>(DEFAULT_LIST_FILTERS);
  const filtersV2 = typeof window !== 'undefined' ? isFiltersV2Enabled() : false;
  // Resolve the advanced filter to the complete (uncapped) matching id set
  // once, here, so the list AND grid views render the same filtered fleet.
  // The grid previously mapped the raw devices array and ignored the filter.
  const { ids: advancedFilterIds, loading: advancedFilterLoading } = useAdvancedFilterIds(advancedFilter);
  const [showCreateGroup, setShowCreateGroup] = useState(false);
  const [autoSelectGroupId, setAutoSelectGroupId] = useState<string | null>(null);

  // #1459 — distinct software names for the filter picker, fetched server-side
  // (debounced) as the user types so the picker searches the real inventory
  // instead of falling back to free-text. Passing a defined array also flips
  // SoftwareMultiSelect out of its `noBackend` CSV fallback.
  const [softwareOptions, setSoftwareOptions] = useState<string[]>([]);
  const softwareSearchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const softwareSearchAbortRef = useRef<AbortController | null>(null);
  useEffect(() => () => {
    if (softwareSearchTimerRef.current) clearTimeout(softwareSearchTimerRef.current);
    softwareSearchAbortRef.current?.abort();
  }, []);
  const handleSoftwareSearch = useCallback((q: string) => {
    if (softwareSearchTimerRef.current) clearTimeout(softwareSearchTimerRef.current);
    const term = q.trim();
    if (!term) {
      setSoftwareOptions([]);
      return;
    }
    softwareSearchTimerRef.current = setTimeout(async () => {
      softwareSearchAbortRef.current?.abort();
      const ctrl = new AbortController();
      softwareSearchAbortRef.current = ctrl;
      try {
        const res = await fetchWithAuth(
          `/software-inventory/names?q=${encodeURIComponent(term)}`,
          { signal: ctrl.signal }
        );
        if (!res.ok) return;
        const body = await res.json();
        setSoftwareOptions(Array.isArray(body.data) ? body.data : []);
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') return;
        console.warn('Failed to fetch software names:', err);
      }
    }, 250);
  }, []);

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
  //
  // Decommissioned devices are hidden by default (old list behavior). Show them
  // only when the active filter group explicitly targets the 'decommissioned'
  // status, so a user filtering FOR decommissioned still sees them.
  const includeDecommissioned = useMemo(() => {
    const conds = advancedFilter?.conditions ?? [];
    return conds.some(c => {
      if ('conditions' in c) return false; // nested groups: ignore (rare)
      if (c.field !== 'status') return false;
      return Array.isArray(c.value)
        ? (c.value as unknown[]).includes('decommissioned')
        : c.value === 'decommissioned';
    });
  }, [advancedFilter]);

  // "Show" action for the hidden-decommissioned hint (#2251): applies the
  // Decommissioned status filter — the same unhide mechanism the toolbar's
  // status picker uses — replacing any other status equals/in value. Same
  // single-select-per-field semantics as DeviceFilterToolbar's addCondition
  // (independent implementation; chip order may differ — the replacement is
  // appended rather than placed in the replaced condition's slot). Other
  // filter conditions are preserved. If the current group is an OR sentence
  // built in the Advanced drawer, nest it instead of rewriting it so its
  // meaning is kept and the status condition stays top-level (where the
  // includeDecommissioned memo looks); the AND intersection can be empty if
  // the OR sentence itself constrains status — the rows still unhide, but
  // zero of them may match.
  const handleShowDecommissioned = useCallback(() => {
    setAdvancedFilter(prev => {
      const statusCond: FilterCondition = { field: 'status', operator: 'equals', value: 'decommissioned' };
      if (!prev) return { operator: 'AND', conditions: [statusCond] };
      if (prev.operator === 'OR') return { operator: 'AND', conditions: [prev, statusCond] };
      const rest = prev.conditions.filter(
        c => 'conditions' in c || c.field !== 'status' || (c.operator !== 'equals' && c.operator !== 'in')
      );
      return { operator: 'AND', conditions: [...rest, statusCond] };
    });
  }, []);

  // Per-segment counts come from the full merged fleet so each segment shows its
  // true total regardless of which one is active. Gated to the network arm; with
  // the flag off the segment isn't rendered and these go unused.
  const deviceClassCounts = useMemo(() => countDevicesByClass(devices), [devices]);
  // Narrow the merged list by the chosen class before either view consumes it,
  // so the list and grid stay in lockstep.
  const classFilteredDevices = useMemo(
    () => filterDevicesByClass(devices, deviceClassFilter),
    [devices, deviceClassFilter]
  );
  const gridDevices = useMemo(
    () => {
      const base = includeDecommissioned
        ? classFilteredDevices
        : classFilteredDevices.filter(d => d.status !== 'decommissioned');
      return advancedFilterIds === null ? base : base.filter(d => advancedFilterIds.has(d.id));
    },
    [classFilteredDevices, advancedFilterIds, includeDecommissioned]
  );
  // How many decommissioned devices the default view is hiding (#2251) — drives
  // the grid view's hint line (the list view computes its own from the same
  // classFilteredDevices set, so the two stay in lockstep). The page fetches
  // with includeDecommissioned: true, so this is a cheap client-side count.
  const hiddenDecommissionedCount = useMemo(
    () =>
      includeDecommissioned
        ? 0
        : classFilteredDevices.filter(d => d.status === 'decommissioned').length,
    [classFilteredDevices, includeDecommissioned]
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
              message: t('devicesPage.toasts.listTruncated', { count: actualCount }),
              duration: 8000
            });
          }
        }),
        // Network arm of the unified list (#1322) — approved, unlinked
        // discovered_assets. Gated behind ENABLE_NETWORK_DEVICES_IN_LIST and
        // off by default; when disabled we skip the fetch entirely and the list
        // is the agent-only view. Best-effort otherwise: a transient/absent-
        // endpoint failure here must not blank the agent fleet, so we degrade to
        // an empty network set. A 401, however, is a real auth failure and must
        // NOT be masked — re-throw it so it propagates to the outer catch and
        // gets the same auth-redirect/logout handling as the agent arm
        // (fetchWithAuth already triggered logout). Swallowing it would leave the
        // user on a half-rendered, silently-broken page. (The endpoint-absent
        // case is a 404, already degraded to empty inside fetchAllNetworkDevices.)
        ENABLE_NETWORK_DEVICES_IN_LIST
          ? fetchAllNetworkDevices({ signal }).catch((err) => {
              if (err instanceof Error && err.name === 'AbortError') throw err;
              if (err instanceof Response && err.status === 401) throw err;
              console.warn('Failed to fetch network devices:', err);
              return { data: [], total: 0, pagesWalked: 0 };
            })
          : Promise.resolve({ data: [], total: 0, pagesWalked: 0 }),
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
          hostname: (d.hostname ?? t('devicesPage.unknownDevice')) as string,
          displayName: typeof d.displayName === 'string' ? d.displayName : undefined,
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
          watchdogVersion: (d.watchdogVersion ?? null) as string | null,
          agentServerUrl: (d.agentServerUrl ?? null) as string | null,
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
          batteryStatus: (d.batteryStatus as Device['batteryStatus']) ?? null,
          activeVpns: (d.activeVpns as Device['activeVpns']) ?? null,
          // Linked multi-boot profiles (#2138): grouping is computed
          // client-side per page in DeviceList from this id alone.
          linkGroupId: typeof d.linkGroupId === 'string' ? d.linkGroupId : null,
          // vm_host member role (#2308): validated against the known values so
          // an unexpected API value degrades to "ungrouped" instead of leaking
          // (warned once per value — see normalizeLinkGroupRole).
          linkGroupRole: normalizeLinkGroupRole(d.linkGroupRole),
          enrolledAt: d.enrolledAt as string | undefined,
          desktopAccess: (d.desktopAccess as Device['desktopAccess']) ?? null,
          hardware: hardware ? {
            cpuModel: hardware.cpuModel as string | undefined,
            cpuCores: typeof hardware.cpuCores === 'number' ? hardware.cpuCores : undefined,
            ramTotalMb: typeof hardware.ramTotalMb === 'number' ? hardware.ramTotalMb : undefined,
            diskTotalGb: typeof hardware.diskTotalGb === 'number' ? hardware.diskTotalGb : undefined,
          } : undefined,
          // Reliability column (#1720): score is null until the reliability
          // worker has computed one for the device; the column renders a dash
          // and sorts those rows last. Trend is validated against the known
          // enum rather than blind-cast, so an unexpected API value falls back
          // to null (no glyph) instead of leaking through the type.
          reliabilityScore: typeof d.reliabilityScore === 'number' ? d.reliabilityScore : null,
          reliabilityTrend:
            d.reliabilityTrend === 'improving' ||
            d.reliabilityTrend === 'stable' ||
            d.reliabilityTrend === 'degrading'
              ? d.reliabilityTrend
              : null,
        };
      });

      // Network arm (#1322): normalize discovered_assets rows into the same
      // Device shape so they render in one list. Agent-only fields stay blank.
      const transformedNetworkDevices: Device[] = networkResult.data.map((d: Record<string, unknown>) => ({
        id: d.id as string,
        deviceClass: (d.deviceClass as DeviceClass) ?? 'network',
        assetType: (d.assetType as DeviceRole | undefined) ?? 'unknown',
        hostname: (d.hostname ?? t('devicesPage.unknownDevice')) as string,
        displayName: typeof d.displayName === 'string' ? d.displayName : undefined,
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
        watchdogVersion: null,
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
        orgName: orgMap.get(device.orgId) ?? t('devicesPage.unknownOrg'),
        siteName: siteMap.get(device.siteId) ?? t('devicesPage.unknownSite')
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
  }, [t]);

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
      // NOTE: no live watchdogVersion handler — the heartbeat path only
      // publishes `device.updated` with fields:['agentVersion'], never
      // 'watchdogVersion'. The watchdog version refreshes on the next list
      // fetch / device-detail load. Wire a producer in the watchdog heartbeat
      // branch before adding a consumer here.
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
    // Network-discovered assets get a native, read-only detail/overview page in
    // the Devices section (#1424 slice 2) instead of bouncing out to Discovery.
    if ((device.deviceClass ?? 'agent') === 'network') {
      void navigateTo(`/devices/network/${device.id}`);
      return;
    }
    void navigateTo(`/devices/${device.id}`);
  };

  const openScriptPicker = (targetDevices: Device[]) => {
    if (targetDevices.length === 0) {
      showToast({ type: 'error', message: t('devicesPage.toasts.selectDeviceForScript') });
      return;
    }
    setScriptTargetDevices(targetDevices);
    setScriptPickerOpen(true);
  };

  const closeScriptPicker = () => {
    setScriptPickerOpen(false);
    setScriptTargetDevices([]);
  };

  const handleScriptSelect = (script: Script, runAs: ScriptRunAsSelection, parameters?: Record<string, unknown>) => {
    // Gate script execution behind a scope-naming confirm dialog. Capture the
    // target devices now: ScriptPickerModal calls onClose() right after
    // onSelect(), and closeScriptPicker() resets scriptTargetDevices to [] —
    // so doExecuteScript can't read that state later or it sends an empty
    // deviceIds array (API 400 "Array must contain at least one item").
    setPendingScriptRun({ script, runAs, parameters, devices: scriptTargetDevices });
  };

  const doExecuteScript = async (pending: PendingScriptRun) => {
    if (actionInProgress) return;
    try {
      setActionInProgress(true);
      const { script, runAs, parameters, devices } = pending;
      const deviceIds = devices.map(d => d.id);
      const result = await executeScript(script.id, deviceIds, parameters, runAs);

      if (devices.length === 1) {
        showToast({ type: 'success', message: t('devicesPage.toasts.scriptQueuedOne', { script: script.name, hostname: devices[0].hostname }) });
      } else {
        showToast({ type: 'success', message: t('devicesPage.toasts.scriptQueuedMany', { script: script.name, count: result.devicesTargeted }) });
      }

      closeScriptPicker();
    } catch (err) {
      showToast({ type: 'error', message: err instanceof Error ? err.message : t('devicesPage.toasts.scriptQueueFailed') });
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
          const label = action === 'reboot_safe_mode'
            ? t('devicesPage.actions.rebootSafeMode')
            : t(/* i18n-dynamic */ `devicesPage.actions.${action}`, { defaultValue: action.charAt(0).toUpperCase() + action.slice(1) });
          // These commands are QUEUED, and #2630 opened them to non-online
          // devices. A 201 means "a row was inserted", not "the machine acted":
          // there is no dispatch step, and for a disconnected device the agent
          // claims it on its next poll (or staleCommandReaper fails it later).
          // Saying "sent" for that is a false success — the user walks away
          // believing it happened. Name the queue explicitly instead.
          showToast({
            type: 'success',
            message: device.status === 'online'
              ? t('devicesPage.toasts.commandSent', { action: label, hostname: device.hostname })
              : t('devicesPage.toasts.commandQueued', { action: label, hostname: device.hostname }),
          });
          break;
        }

        case 'wake': {
          try {
            const wake = await sendWakeCommand(device.id);
            const hostname = device.hostname;
            showToast({
              type: 'success',
              message: t('devicesPage.toasts.wakeSentWatching', {
                hostname,
                relay: wake.relay.hostname,
                broadcast: wake.broadcast,
              }),
            });
            const wakeController = new AbortController();
            wakeWatchersRef.current.add(wakeController);
            void watchWakeOutcome(device.id, { signal: wakeController.signal })
              .then(async (outcome) => {
                if (outcome === 'online') {
                  showToast({ type: 'success', message: t('devicesPage.toasts.deviceOnline', { hostname }) });
                  await fetchDevices();
                } else if (outcome === 'timeout') {
                  showToast({
                    type: 'error',
                    message: t('devicesPage.toasts.wakeTimeout', { hostname }),
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
              showToast({ type: 'error', message: t('devicesPage.toasts.deviceError', { hostname: device.hostname, error: friendly }) });
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
            message: t('devicesPage.toasts.inventoryRefreshRequested', { hostname: device.hostname }),
          });
          break;
        }

        case 'maintenance':
          const isCurrentlyMaintenance = device.status === 'maintenance';
          await toggleMaintenanceMode(device.id, !isCurrentlyMaintenance);
          showToast({
            type: 'success',
            message: isCurrentlyMaintenance
              ? t('devicesPage.toasts.maintenanceOff', { hostname: device.hostname })
              : t('devicesPage.toasts.maintenanceOn', { hostname: device.hostname }),
          });
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
            message: t('devicesPage.toasts.decommissioning', { hostname: device.hostname }),
            duration: 5000,
            onUndo: () => {
              cancelled = true;
              showToast({ type: 'success', message: t('devicesPage.toasts.decommissionCancelled'), duration: 2000 });
            }
          });
          setTimeout(async () => {
            if (cancelled) return;
            try {
              await decommissionDevice(device.id);
              showToast({ type: 'success', message: t('devicesPage.toasts.decommissioned', { hostname: device.hostname }) });
              await fetchDevices();
            } catch (err) {
              showToast({ type: 'error', message: err instanceof Error ? err.message : t('devicesPage.toasts.decommissionFailed', { hostname: device.hostname }) });
            }
          }, 5000);
          break;
        }

        case 'restore':
          await restoreDevice(device.id);
          showToast({ type: 'success', message: t('devicesPage.toasts.restored', { hostname: device.hostname }) });
          await fetchDevices();
          break;

        case 'permanent-delete': {
          // Deferred execution with undo — gives the user 5 seconds to cancel
          let pdCancelled = false;
          showToast({
            type: 'undo',
            message: t('devicesPage.toasts.permanentDeleting', { hostname: device.hostname }),
            duration: 5000,
            onUndo: () => {
              pdCancelled = true;
              showToast({ type: 'success', message: t('devicesPage.toasts.permanentDeleteCancelled'), duration: 2000 });
            }
          });
          setTimeout(async () => {
            if (pdCancelled) return;
            try {
              await permanentDeleteDevice(device.id);
              showToast({ type: 'success', message: t('devicesPage.toasts.permanentlyDeleted', { hostname: device.hostname }) });
              await fetchDevices();
            } catch (err) {
              showToast({ type: 'error', message: err instanceof Error ? err.message : t('devicesPage.toasts.deleteFailed', { hostname: device.hostname }) });
            }
          }, 5000);
          break;
        }

        default:
          showToast({ type: 'error', message: t('devicesPage.toasts.unknownAction', { action }) });
      }
    } catch (err) {
      showToast({ type: 'error', message: err instanceof Error ? err.message : t('devicesPage.toasts.actionFailed', { action, hostname: device.hostname }) });
    } finally {
      setActionInProgress(false);
    }
  };

  // vm_host (#2308): the picker chose a host — create the group. Mirrors the
  // multiboot bulk path's toast/refetch handling.
  const handleVmHostConfirm = async (hostDeviceId: string) => {
    const targets = vmHostPickerDevices;
    if (!targets || actionInProgress) return;
    try {
      setActionInProgress(true);
      await linkDevicesVmHost(hostDeviceId, targets.map(d => d.id));
      const host = targets.find(d => d.id === hostDeviceId);
      showToast({
        type: 'success',
        message: `Linked ${targets.length - 1} guest VM${targets.length - 1 === 1 ? '' : 's'} under ${host?.displayName || host?.hostname || 'the host server'}.`,
      });
      setVmHostPickerDevices(null);
      await fetchDevices();
    } catch (err) {
      showToast({ type: 'error', message: err instanceof Error ? err.message : 'Failed to link devices' });
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
        message: t('devicesPage.toasts.agentOnlyAction'),
      });
      return;
    }
    if (skippedNetworkCount > 0) {
      showToast({
        type: 'warning',
        message: t('devicesPage.toasts.networkSkipped', { count: skippedNetworkCount }),
      });
    }

    // Decommissioned gate (#2465). Agent commands are QUEUED, not delivered
    // live: the API refuses exactly one status — `decommissioned` — and any
    // other device (offline included) has its command stored `pending` and run
    // on its next check-in. So gate on `decommissioned` ONLY. Filtering to
    // `status === 'online'` here would look like the obvious fix and would in
    // fact discard commands the backend would have honoured — see the verified
    // API contract in bulkActionGating.ts before "tightening" this.
    //
    // Decommissioned rows are hidden by default, but a status filter that
    // includes them (or the #2251 "show" hint) puts them back in reach of a
    // select-all, which is how they land in a mixed batch.
    if (DECOMMISSION_BLOCKED_BULK_ACTIONS.has(action)) {
      const eligibleDevices = selectedDevices.filter(d => isCommandQueueable(d.status));
      const skippedDecommissionedCount = selectedDevices.length - eligibleDevices.length;

      if (eligibleDevices.length === 0) {
        showToast({
          type: 'error',
          message: t('devicesPage.toasts.bulkAllDecommissioned', { total: selectedDevices.length }),
        });
        return;
      }
      if (skippedDecommissionedCount > 0) {
        setPendingDecommissionedSkip({
          action,
          devices: eligibleDevices,
          skippedCount: skippedDecommissionedCount,
          totalCount: selectedDevices.length,
        });
        return;
      }
    }

    await runBulkAction(action, selectedDevices);
  };

  // Executes a bulk action against an already-vetted device set (network rows
  // dropped, decommissioned targets filtered + confirmed). Offline devices are
  // deliberately still IN this set — their command queues and runs on reconnect.
  // Entered either directly from handleBulkAction (nothing to skip) or from the
  // decommissioned-skip confirm.
  const runBulkAction = async (action: string, selectedDevices: Device[]) => {
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

    // vm_host (#2308): needs a host decision first — open the picker modal;
    // the POST happens in handleVmHostConfirm once a host is chosen.
    if (action === 'link-vm-host') {
      if (deviceIds.length < 2) {
        showToast({ type: 'error', message: 'Select at least two devices — one host server and its guest VMs.' });
        return;
      }
      setVmHostPickerDevices(selectedDevices);
      return;
    }

    try {
      setActionInProgress(true);

      switch (action) {
        case 'link-multiboot': {
          if (deviceIds.length < 2) {
            showToast({ type: 'error', message: t('devicesPage.toasts.selectTwoForMultiboot') });
            break;
          }
          await linkDevicesMultiboot(deviceIds);
          showToast({
            type: 'success',
            message: t('devicesPage.toasts.multibootLinked', { count: deviceCount }),
          });
          await fetchDevices();
          break;
        }

        case 'reboot':
        case 'reboot_safe_mode':
        case 'shutdown':
        case 'lock': {
          const result = await sendBulkCommand(deviceIds, action);
          const successCount = result.commands?.length ?? 0;
          const failedCount = result.failed?.length ?? 0;
          const skippedCount = result.skipped?.length ?? 0;
          const bulkLabel = action === 'reboot_safe_mode'
            ? t('devicesPage.actions.rebootSafeMode')
            : t(/* i18n-dynamic */ `devicesPage.actions.${action}`, { defaultValue: action.charAt(0).toUpperCase() + action.slice(1) });
          const skippedTail = skippedCount > 0 ? t('devicesPage.toasts.alreadyPendingTail', { count: skippedCount }) : '';

          if (failedCount === 0) {
            showToast({
              type: 'success',
              message: t('devicesPage.toasts.bulkCommandSent', { action: bulkLabel, count: successCount, skippedTail }),
            });
          } else {
            const failureSummary = summarizeBulkCommandFailures(result.failed ?? []);
            showToast({
              type: 'error',
              message: t('devicesPage.toasts.bulkCommandPartialFailed', {
                action: bulkLabel,
                count: successCount,
                skippedTail,
                failed: failedCount,
                failureSummary,
              }),
            });
          }
          break;
        }

        case 'maintenance-on':
        case 'maintenance-off': {
          const enabling = action === 'maintenance-on';
          const mLabel = enabling
            ? t('devicesPage.progress.enablingMaintenance')
            : t('devicesPage.progress.disablingMaintenance');
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
          const mVerb = enabling ? t('devicesPage.maintenanceVerb.on') : t('devicesPage.maintenanceVerb.off');
          if (mFailed.length === 0) {
            showToast({ type: 'success', message: t('devicesPage.toasts.bulkMaintenanceSuccess', { count: mSucceeded, verb: mVerb }) });
          } else if (mSucceeded === 0) {
            showToast({ type: 'error', message: t('devicesPage.toasts.bulkMaintenanceAllFailed', { count: mFailed.length, devices: summarizeFailedDevices(mFailed) }) });
          } else {
            showToast({ type: 'error', message: t('devicesPage.toasts.bulkMaintenanceSomeFailed', { succeeded: mSucceeded, verb: mVerb, failed: mFailed.length, devices: summarizeFailedDevices(mFailed) }) });
          }
          await fetchDevices();
          break;
        }

        case 'decommission': {
          const result = await bulkDecommissionDevices(deviceIds);
          if (result.failed === 0) {
            showToast({ type: 'success', message: t('devicesPage.toasts.bulkDecommissioned', { count: result.succeeded }) });
          } else {
            showToast({ type: 'error', message: t('devicesPage.toasts.bulkDecommissionFailed', { succeeded: result.succeeded, failed: result.failed }) });
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
              message: t('devicesPage.toasts.bulkWakeSent', { count: summary.succeeded.length }),
            });
          } else if (summary.succeeded.length === 0) {
            showToast({
              type: 'error',
              message: t('devicesPage.toasts.bulkWakeAllFailed', { count: summary.failed.length, failureSummary }),
            });
          } else {
            showToast({
              type: 'error',
              message: t('devicesPage.toasts.bulkWakeSomeFailed', {
                succeeded: summary.succeeded.length,
                total: summary.succeeded.length + summary.failed.length,
                failed: summary.failed.length,
                failureSummary,
              }),
            });
          }
          break;
        }

        default:
          showToast({ type: 'error', message: t('devicesPage.toasts.unknownBulkAction', { action }) });
      }
    } catch (err) {
      showToast({ type: 'error', message: err instanceof Error ? err.message : t('devicesPage.toasts.bulkActionFailed', { action }) });
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
        <div className="rounded-lg border bg-card p-6 shadow-xs">
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

  // A 403 is a permission denial, not a transient load failure — render the
  // access-denied state (no misleading "session expired / try again" UI).
  if (error && isAccessDenied(error)) {
    return <AccessDenied message={t('devicesPage.accessDenied')} />;
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
            {t('devicesPage.tryAgain')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{t('devicesPage.title')}</h1>
          <p className="text-muted-foreground">
            {t('devicesPage.subtitle')}
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
              title={t('devicesPage.listView')}
              aria-label={t('devicesPage.listView')}
            >
              <List className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => setViewMode('grid')}
              className={`flex h-10 w-10 items-center justify-center rounded-r-md transition ${
                viewMode === 'grid' ? 'bg-muted' : 'hover:bg-muted/50'
              }`}
              title={t('devicesPage.gridView')}
              aria-label={t('devicesPage.gridView')}
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
            {t('devicesPage.addDevice')}
          </button>
        </div>
      </div>

      {filtersV2 ? (
        <DeviceFilterToolbar
          value={advancedFilter}
          onChange={setAdvancedFilter}
          listFilters={listFilters}
          onListFiltersChange={setListFilters}
          orgs={orgs}
          sites={sites}
          groups={deviceGroups}
          softwareOptions={softwareOptions}
          onSoftwareSearch={handleSoftwareSearch}
          onCreateGroup={() => setShowCreateGroup(true)}
        />
      ) : (
        <DeviceFilterBar
          value={advancedFilter}
          onChange={setAdvancedFilter}
          showSavedFilters={true}
          collapsible={true}
        />
      )}

      {/* Class segment (#1424) — only meaningful when the merged list carries
          both arms; hidden entirely in the agent-only (flag-off) view. Applies
          to both the list and grid (both consume classFilteredDevices). */}
      {ENABLE_NETWORK_DEVICES_IN_LIST && (
        <DeviceClassSegment
          value={deviceClassFilter}
          counts={deviceClassCounts}
          onChange={handleDeviceClassChange}
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
            <h2 className="text-lg font-semibold text-foreground mb-2">{t('devicesPage.emptyTitle')}</h2>
            <p className="text-sm text-muted-foreground mb-6">
              {t('devicesPage.emptyDescription')}
            </p>
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => setShowAddDevice(true)}
                className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
              >
                <Plus className="h-4 w-4" />
                {t('devicesPage.addDevice')}
              </button>
              <a href="https://docs.breezermm.com/agents/installation/" target="_blank" rel="noopener" className="inline-flex items-center gap-1.5 rounded-md border px-4 py-2 text-sm font-medium text-foreground hover:bg-muted transition-colors">
                {t('devicesPage.viewInstallationGuide')}
              </a>
            </div>
          </div>
        </div>
      ) : viewMode === 'list' ? (
        <DeviceList
          devices={classFilteredDevices}
          orgs={orgs}
          sites={sites}
          groups={deviceGroups}
          groupMembershipMap={groupMembershipMap}
          onSelect={handleSelectDevice}
          onAction={handleDeviceAction}
          onBulkAction={handleBulkAction}
          serverFilterIds={advancedFilterIds}
          serverFilterLoading={advancedFilterLoading}
          includeDecommissioned={includeDecommissioned}
          onShowDecommissioned={handleShowDecommissioned}
          listFilters={listFilters}
          onListFiltersChange={setListFilters}
          onCreateGroup={() => setShowCreateGroup(true)}
          autoSelectGroupId={autoSelectGroupId}
          onAutoSelectConsumed={handleAutoSelectConsumed}
          networkDevicesEnabled={ENABLE_NETWORK_DEVICES_IN_LIST}
        />
      ) : (
        <div className="space-y-3">
          {hiddenDecommissionedCount > 0 && (
            <p>
              <DecommissionedHiddenHint
                count={hiddenDecommissionedCount}
                onShow={handleShowDecommissioned}
              />
            </p>
          )}
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
        </div>
      )}

      <AddDeviceModal isOpen={showAddDevice} onClose={() => setShowAddDevice(false)} />

      <CreateGroupModal
        isOpen={showCreateGroup}
        onClose={() => setShowCreateGroup(false)}
        onCreated={handleGroupCreated}
      />

      {vmHostPickerDevices && (
        <LinkVmHostModal
          isOpen={true}
          devices={vmHostPickerDevices}
          busy={actionInProgress}
          onConfirm={hostId => void handleVmHostConfirm(hostId)}
          onClose={() => setVmHostPickerDevices(null)}
        />
      )}

      <ScriptPickerModal
        isOpen={scriptPickerOpen}
        onClose={closeScriptPicker}
        onSelect={handleScriptSelect}
        deviceHostname={scriptTargetLabel}
        deviceOs={scriptTargetOs}
      />

      {pendingScriptRun && (() => {
        const distinctOrgIds = [...new Set(pendingScriptRun.devices.map(d => d.orgId).filter(Boolean))];
        const scriptOrgNames = distinctOrgIds.length > 0
          ? distinctOrgIds.map(id => orgStoreOrgs.find(o => o.id === id)?.name ?? id)
          : [t('devicesPage.selectedOrganization')];
        return (
          <ConfirmDialog
            open={true}
            onClose={() => setPendingScriptRun(null)}
            onConfirm={() => {
              const p = pendingScriptRun;
              setPendingScriptRun(null);
              void doExecuteScript(p);
            }}
            title={t('devicesPage.confirmScriptRun')}
            variant="warning"
            confirmLabel={t('common:actions.run')}
            confirmTestId="confirm-fleet-action"
            message={scopeConfirmMessage({
              action: t('devicesPage.confirmRunAction', { script: pendingScriptRun.script.name }),
              deviceCount: pendingScriptRun.devices.length,
              orgNames: scriptOrgNames,
            })}
            isLoading={actionInProgress}
          />
        );
      })()}

      {/* Decommissioned-skip confirm (#2465): the selection contained retired,
          agent-less devices, which the API refuses. Name the count being dropped
          and make the user own the reduced batch. Offline devices are NOT
          dropped — their command queues and runs when they reconnect. */}
      {pendingDecommissionedSkip && (
        <ConfirmDialog
          open={true}
          onClose={() => setPendingDecommissionedSkip(null)}
          // Confirming UNMOUNTS this dialog, which is what makes a double-click
          // safe — a second click has no button to hit. No isLoading/spinner
          // here on purpose: that would mean keeping the dialog mounted, and
          // then neither guard holds — ConfirmDialog's `disabled` and
          // runBulkAction's `actionInProgress` both read a closure captured at
          // render, still `false` on the second click, so the fleet reboots
          // twice. (The set-state/dispatch ORDER below is not what saves us:
          // React batches both. The unmount is.) DevicesPage.test.tsx pins it.
          onConfirm={() => {
            const p = pendingDecommissionedSkip;
            setPendingDecommissionedSkip(null);
            void runBulkAction(p.action, p.devices);
          }}
          title={t('devicesPage.confirmDecommissionedSkip.title')}
          variant="warning"
          confirmLabel={t('common:actions.confirm')}
          confirmTestId="confirm-decommissioned-skip"
          message={t('devicesPage.confirmDecommissionedSkip.message', {
            skipped: pendingDecommissionedSkip.skippedCount,
            total: pendingDecommissionedSkip.totalCount,
            eligible: pendingDecommissionedSkip.devices.length,
          })}
        />
      )}

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
