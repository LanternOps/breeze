import { useMemo, useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Search, ChevronLeft, ChevronRight, ChevronUp, ChevronDown, ArrowUpDown, MoreHorizontal, MoreVertical, Filter, Terminal, FileCode, RotateCcw, Settings, Trash2, Zap, Columns3, Network, Cpu } from 'lucide-react';
import type { DesktopAccessState, RemoteAccessPolicy } from '@breeze/shared';
import ConnectDesktopButton from '../remote/ConnectDesktopButton';
import { widthPercentClass, formatUptime } from '@/lib/utils';
import { formatLastSeen } from '@/lib/formatTime';
import { DEVICE_ROLES, getDeviceRoleLabel, getDeviceRoleIcon, type DeviceRole } from '@/lib/deviceRoles';
import {
  PAGE_SIZE_OPTIONS,
  readPageSizePreference,
  writePageSizePreference,
} from './pageSizePreference';
import {
  COLUMN_IDS,
  COLUMN_LABELS,
  readColumnOrder,
  readColumnVisibility,
  writeColumnOrder,
  writeColumnVisibility,
  type ColumnId,
} from './columnVisibility';
import {
  densityTableClasses,
  readDensity,
  subscribeDensity,
  type Density,
} from '@/lib/density';
import { OSIcon } from './osIcons';
import { formatDeviceOsVersion } from './osDisplay';

export type DeviceStatus = 'online' | 'offline' | 'maintenance' | 'decommissioned' | 'quarantined' | 'updating' | 'pending';
export type OSType = 'windows' | 'macos' | 'linux';

/**
 * Presentation-level discriminator for the unified Devices list (#1322).
 * `agent` = an enrolled endpoint running the Go agent (devices table).
 * `network` = a discovered network device (printer/router/switch/…) from
 * discovered_assets that is approved and not linked to an agent. Agent-only
 * columns (CPU/RAM, agent version, OS build) render blank for `network` rows.
 */
export type DeviceClass = 'agent' | 'network';

export type Device = {
  id: string;
  /** Defaults to 'agent' when absent (older API / agent-only rows). */
  deviceClass?: DeviceClass;
  /** discovered_asset_type for network devices; reuses the deviceRole value space. */
  assetType?: DeviceRole;
  /** Network-device fields — null/undefined for agent rows. */
  manufacturer?: string | null;
  model?: string | null;
  responseTimeMs?: number | null;
  /** Whether SNMP/network monitoring is configured for a network device. */
  monitoringEnabled?: boolean;
  hostname: string;
  os: OSType;
  osVersion: string;
  osBuild?: string;
  architecture?: string;
  status: DeviceStatus;
  cpuPercent: number;
  ramPercent: number;
  lastSeen: string;
  orgId: string;
  orgName: string;
  siteId: string;
  siteName: string;
  agentVersion: string;
  tags: string[];
  lastUser?: string;
  uptimeSeconds?: number;
  enrolledAt?: string;
  deviceRole?: DeviceRole;
  deviceRoleSource?: string;
  displayName?: string;
  isHeadless?: boolean;
  /**
   * OS-level pending-reboot flag persisted from the agent heartbeat
   * (devices.pending_reboot). True when Windows registry / Linux
   * reboot-required markers say a reboot is outstanding. Absent on
   * responses from older API versions.
   */
  pendingReboot?: boolean;
  desktopAccess?: DesktopAccessState | null;
  remoteAccessPolicy?: RemoteAccessPolicy | null;
  /**
   * Server-detected asymmetry: timestamp at which the API stopped
   * receiving main-agent heartbeats while the watchdog is still
   * reporting in. Set by the heartbeat handler (#851 / Layer C).
   * Null when the agent is heartbeating normally or has fully gone
   * silent (watchdog included).
   */
  mainAgentSilentSince?: string | null;
  /**
   * Watchdog reachability as last reported. 'connected' = normal,
   * 'failover' = watchdog took over because main-agent stopped,
   * 'offline' = we haven't heard from the watchdog either (in which
   * case `status === 'offline'` is the load-bearing signal).
   */
  watchdogStatus?: 'connected' | 'failover' | 'offline' | null;
  hardware?: {
    cpuModel?: string;
    cpuCores?: number;
    ramTotalMb?: number;
    diskTotalGb?: number;
  };
};

// Columns that only make sense for the network arm (#1322); hidden unless
// networkDevicesEnabled. Module-level so it isn't reallocated each render.
const NETWORK_ONLY_COLUMNS: ReadonlySet<ColumnId> = new Set<ColumnId>(['class', 'type']);

type DeviceListProps = {
  devices: Device[];
  orgs?: { id: string; name: string }[];
  sites?: { id: string; name: string }[];
  groups?: { id: string; name: string; type: 'static' | 'dynamic'; deviceCount: number }[];
  groupMembershipMap?: Map<string, Set<string>>;
  onCreateGroup?: () => void;
  autoSelectGroupId?: string | null;
  onAutoSelectConsumed?: () => void;
  timezone?: string;
  onSelect?: (device: Device) => void;
  onAction?: (action: string, device: Device) => void;
  onBulkAction?: (action: string, devices: Device[]) => void;
  // Initial page size if the user has no stored preference for this browser.
  // Once the component mounts, the live page size comes from localStorage
  // (see pageSizePreference.ts); subsequent changes to this prop are ignored.
  pageSize?: number;
  // Pre-resolved advanced-filter id set (null = no advanced filter active).
  // Resolution lives in DevicesPage via useAdvancedFilterIds so the list and
  // grid views filter against the same complete, uncapped id set.
  serverFilterIds?: Set<string> | null;
  serverFilterLoading?: boolean;
  // Unified-list network arm (#1322). Off by default behind a build-time flag
  // (PUBLIC_ENABLE_NETWORK_DEVICES_IN_LIST); when false the Class/Type columns
  // and the All/Agent/Network facet are hidden entirely so the list is the
  // agent-only view. DevicesPage passes ENABLE_NETWORK_DEVICES_IN_LIST.
  networkDevicesEnabled?: boolean;
};

const statusColors: Record<DeviceStatus, string> = {
  online: 'bg-success/15 text-success border-success/30',
  offline: 'bg-destructive/15 text-destructive border-destructive/30',
  maintenance: 'bg-warning/15 text-warning border-warning/30',
  decommissioned: 'bg-muted text-muted-foreground border-border',
  quarantined: 'bg-warning/15 text-warning border-warning/30',
  updating: 'bg-info/15 text-info border-info/30',
  pending: 'bg-muted text-muted-foreground border-border'
};

// Compact pill label; full name on the title attribute for hover.
const statusLabels: Record<DeviceStatus, string> = {
  online: 'Up',
  offline: 'Down',
  maintenance: 'Maint',
  decommissioned: 'Decom',
  quarantined: 'Quar',
  updating: 'Upd',
  pending: 'Pend'
};
const statusFullLabels: Record<DeviceStatus, string> = {
  online: 'Online',
  offline: 'Offline',
  maintenance: 'Maintenance',
  decommissioned: 'Decommissioned',
  quarantined: 'Quarantined',
  updating: 'Updating',
  pending: 'Pending'
};

// Cap visible tag chips per row; the rest collapse into a +N chip, with the
// full comma-joined list on the cell's title attribute (same overflow trick
// as the status pill). Keeps row height and column width bounded.
const TAG_CHIP_CAP = 3;

/**
 * "Agent silent (watchdog OK)" amber badge. Fires when the server-side
 * asymmetry detector (#851 / Layer C) has marked `mainAgentSilentSince`
 * AND the watchdog is still reporting in (`watchdogStatus !== 'offline'`).
 * That state means the main agent has wedged but the box is alive — a
 * different failure mode from a fully-offline device, and the distinction
 * is the whole point of #800.
 *
 * Returns null when no asymmetry is present so the cell stays clean.
 */
function shouldShowAgentSilentBadge(device: Pick<Device, 'mainAgentSilentSince' | 'watchdogStatus'>): boolean {
  return Boolean(device.mainAgentSilentSince) && device.watchdogStatus !== 'offline';
}

function formatSilentDuration(silentSince: string): string {
  const minutes = Math.max(1, Math.floor((Date.now() - new Date(silentSince).getTime()) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

const osLabels: Record<OSType, string> = {
  windows: 'Windows',
  macos: 'macOS',
  linux: 'Linux'
};

type SortField = ColumnId | null;
type SortDirection = 'asc' | 'desc';

// Meaningful ordering for the Status sort. Raw enum alphabetics would put
// "decommissioned" before "online"; rank by operational severity instead.
const statusSortRank: Record<DeviceStatus, number> = {
  online: 0,
  updating: 1,
  pending: 2,
  maintenance: 3,
  quarantined: 4,
  offline: 5,
  decommissioned: 6,
};

// One comparable value per column, mirroring what the cell displays.
// `null` means "renders as a dash" — those rows sort last in BOTH
// directions so blanks never bury the real data. Strings compare with
// numeric collation (host-2 < host-10, agent 0.9.x < 0.10.x).
const sortValue: Record<ColumnId, (d: Device) => string | number | null> = {
  hostname: d => d.displayName || d.hostname,
  // Unified-list columns (#1322): sort by the same value the cell renders so
  // header sort stays consistent with every other column (#1284 invariant).
  class: d => ((d.deviceClass ?? 'agent') === 'network' ? 'Network' : 'Agent'),
  // Type renders only for network rows now (#1386); agent rows show a dash, so
  // they sort as blanks-last (null) to match the cell — the #1284 invariant.
  type: d =>
    (d.deviceClass ?? 'agent') === 'network'
      ? getDeviceRoleLabel(d.assetType ?? 'unknown')
      : null,
  organization: d => d.orgName || null,
  site: d => d.siteName || null,
  os: d => osLabels[d.os],
  osVersion: d => formatDeviceOsVersion(d.os, d.osVersion) || null,
  osBuild: d => d.osBuild || null,
  architecture: d => d.architecture || null,
  // Role renders only for agent rows now (#1386); network rows show a dash and
  // sort blanks-last (null) to match the cell — the #1284 invariant.
  role: d => ((d.deviceClass ?? 'agent') === 'network' ? null : getDeviceRoleLabel(d.deviceRole ?? 'unknown')),
  isHeadless: d => (typeof d.isHeadless === 'boolean' ? (d.isHeadless ? 1 : 0) : null),
  status: d => statusSortRank[d.status],
  // false/absent renders as a dash (see the cell), so it maps to null like
  // isHeadless — keeping the blanks-last invariant consistent for booleans.
  pendingReboot: d => (d.pendingReboot ? 1 : null),
  cpu: d => (d.status === 'online' ? d.cpuPercent : null),
  ram: d => (d.status === 'online' ? d.ramPercent : null),
  cpuModel: d => d.hardware?.cpuModel || null,
  cores: d => (typeof d.hardware?.cpuCores === 'number' ? d.hardware.cpuCores : null),
  ramTotal: d => (typeof d.hardware?.ramTotalMb === 'number' ? d.hardware.ramTotalMb : null),
  diskTotal: d => (typeof d.hardware?.diskTotalGb === 'number' ? d.hardware.diskTotalGb : null),
  lastSeen: d => new Date(d.lastSeen).getTime() || null,
  agentVersion: d => d.agentVersion || null,
  tags: d => (d.tags && d.tags.length > 0 ? d.tags.join(', ') : null),
  lastUser: d => d.lastUser || null,
  uptime: d => (d.status === 'online' && d.uptimeSeconds != null ? d.uptimeSeconds : null),
  enrolled: d => (d.enrolledAt ? new Date(d.enrolledAt).getTime() || null : null),
  desktopAccess: d => d.desktopAccess?.mode || null,
};

export default function DeviceList({
  devices,
  orgs = [],
  sites = [],
  groups = [],
  groupMembershipMap = new Map(),
  onCreateGroup,
  autoSelectGroupId,
  onAutoSelectConsumed,
  timezone,
  onSelect,
  onAction,
  onBulkAction,
  pageSize = 10,
  serverFilterIds = null,
  serverFilterLoading = false,
  networkDevicesEnabled = false
}: DeviceListProps) {
  // Use provided timezone or browser default
  const effectiveTimezone = timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

  const [query, setQuery] = useState('');
  // Unified-list class facet (#1322): All / Agent-managed / Network.
  const [classFilter, setClassFilter] = useState<'all' | 'agent' | 'network'>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [osFilter, setOsFilter] = useState<string>('all');
  const [roleFilter, setRoleFilter] = useState<string>('all');
  const [orgFilter, setOrgFilter] = useState<string>('all');
  const [siteFilter, setSiteFilter] = useState<string>('all');
  const [groupFilter, setGroupFilter] = useState<string[]>([]);
  const [groupDropdownOpen, setGroupDropdownOpen] = useState(false);
  const groupDropdownRef = useRef<HTMLDivElement>(null);
  const [currentPage, setCurrentPage] = useState(1);
  // Live, user-controllable page size. Initialized from localStorage; the
  // pageSize prop is just the fallback when no preference is stored.
  const [effectivePageSize, setEffectivePageSize] = useState<number>(() =>
    readPageSizePreference(pageSize),
  );
  // Checkbox + Actions are always-on first/last; the rest live in
  // COLUMN_IDS and the order in columnOrder controls render sequence.
  const [visibleColumns, setVisibleColumns] = useState<Set<ColumnId>>(
    () => new Set(readColumnVisibility()),
  );
  const [columnOrder, setColumnOrder] = useState<ColumnId[]>(() => readColumnOrder());
  const [columnsMenuOpen, setColumnsMenuOpen] = useState(false);
  const columnsMenuRef = useRef<HTMLDivElement>(null);
  // Table density reflects the account-wide preference (breeze.density),
  // which is now set from the top-bar theme/display menu. Subscribe so the
  // table re-renders when it changes, without a reload.
  const [density, setDensity] = useState<Density>(() => readDensity());
  useEffect(() => subscribeDensity(setDensity), []);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkMenuOpen, setBulkMenuOpen] = useState(false);
  const [rowMenuOpenId, setRowMenuOpenId] = useState<string | null>(null);
  // Flip the row dropdown direction when the click happens close to the
  // viewport bottom — the menu has ~7 items × ~36px, so any row whose
  // kebab sits <300px from the viewport bottom would otherwise render
  // its dropdown into the area below the table and get clipped.
  const [rowMenuFlipUp, setRowMenuFlipUp] = useState(false);
  // Viewport-relative anchor for the portaled row menu. The menu is rendered into
  // document.body (not inside the overflow-x-auto table wrapper, which would clip it),
  // so it positions itself with `fixed` coordinates derived from the kebab button.
  const [rowMenuAnchor, setRowMenuAnchor] = useState<{ top: number; bottom: number; right: number } | null>(null);
  const rowMenuRef = useRef<HTMLDivElement>(null);
  const rowMenuButtonRef = useRef<HTMLButtonElement | null>(null);
  const [showMoreFilters, setShowMoreFilters] = useState(false);
  const [sortField, setSortField] = useState<SortField>(null);
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');

  // Close row action menu on outside click
  useEffect(() => {
    if (!rowMenuOpenId) return;
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      // The menu is portaled outside the trigger, so check both the menu and the button.
      if (rowMenuRef.current?.contains(target) || rowMenuButtonRef.current?.contains(target)) return;
      setRowMenuOpenId(null);
    };
    // The menu is fixed-positioned from a captured anchor; scrolling would detach it, so close instead.
    const handleScroll = () => setRowMenuOpenId(null);
    document.addEventListener('mousedown', handleClickOutside);
    window.addEventListener('scroll', handleScroll, true);
    window.addEventListener('resize', handleScroll);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      window.removeEventListener('scroll', handleScroll, true);
      window.removeEventListener('resize', handleScroll);
    };
  }, [rowMenuOpenId]);

  // Close group dropdown on outside click
  useEffect(() => {
    if (!groupDropdownOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (groupDropdownRef.current && !groupDropdownRef.current.contains(e.target as Node)) {
        setGroupDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [groupDropdownOpen]);

  // Close columns visibility menu on outside click
  useEffect(() => {
    if (!columnsMenuOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (columnsMenuRef.current && !columnsMenuRef.current.contains(e.target as Node)) {
        setColumnsMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [columnsMenuOpen]);

  // Hiding does not change columnOrder, so re-showing restores the slot.
  const toggleColumn = (id: ColumnId) => {
    setVisibleColumns(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      writeColumnVisibility(next);
      return next;
    });
  };

  // Neighbor is the visible column above/below; hidden columns in
  // columnOrder are skipped so the swap matches what the user sees.
  const moveColumn = (id: ColumnId, direction: -1 | 1) => {
    setColumnOrder(prev => {
      const visibleIds = prev.filter(c => visibleColumns.has(c));
      const visibleIdx = visibleIds.indexOf(id);
      if (visibleIdx === -1) return prev;
      const targetVisibleIdx = visibleIdx + direction;
      if (targetVisibleIdx < 0 || targetVisibleIdx >= visibleIds.length) return prev;
      const swapWith = visibleIds[targetVisibleIdx];
      const a = prev.indexOf(id);
      const b = prev.indexOf(swapWith);
      const next = [...prev];
      next[a] = swapWith;
      next[b] = id;
      writeColumnOrder(next);
      return next;
    });
  };

  // Auto-select a newly created group
  useEffect(() => {
    if (autoSelectGroupId && groups.some(g => g.id === autoSelectGroupId)) {
      setGroupFilter(prev =>
        prev.includes(autoSelectGroupId) ? prev : [...prev, autoSelectGroupId]
      );
      onAutoSelectConsumed?.();
    }
  }, [autoSelectGroupId, groups, onAutoSelectConsumed]);

  const filteredDevices = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    return devices.filter(device => {
      // Apply server-side advanced filter
      if (serverFilterIds !== null && !serverFilterIds.has(device.id)) {
        return false;
      }

      const deviceClass = device.deviceClass ?? 'agent';
      const matchesClass = classFilter === 'all' ? true : deviceClass === classFilter;

      const matchesQuery = normalizedQuery.length === 0
        ? true
        : device.hostname.toLowerCase().includes(normalizedQuery) ||
          (device.displayName?.toLowerCase().includes(normalizedQuery) ?? false);
      const matchesStatus = statusFilter === 'all'
        ? device.status !== 'decommissioned'
        : device.status === statusFilter;
      // OS is an agent-only attribute; an active OS facet narrows agent rows
      // but never filters out network devices (they have no OS).
      const matchesOs = osFilter === 'all'
        ? true
        : deviceClass === 'network' ? true : device.os === osFilter;
      const matchesRole = roleFilter === 'all' ? true : device.deviceRole === roleFilter;
      const matchesOrg = orgFilter === 'all' ? true : device.orgId === orgFilter;
      const matchesSite = siteFilter === 'all' ? true : device.siteId === siteFilter;
      const matchesGroup = groupFilter.length === 0
        ? true
        : groupFilter.some(gId => groupMembershipMap.get(gId)?.has(device.id));

      return matchesClass && matchesQuery && matchesStatus && matchesOs && matchesRole && matchesOrg && matchesSite && matchesGroup;
    });
  }, [devices, query, classFilter, statusFilter, osFilter, roleFilter, orgFilter, siteFilter, groupFilter, groupMembershipMap, serverFilterIds]);

  const handleSort = (field: ColumnId) => {
    if (sortField === field) {
      setSortDirection(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDirection('asc');
    }
  };

  // Show the class facet only when the network arm is enabled AND a network
  // device is actually present, so agent-only fleets aren't cluttered with an
  // inert control. With the feature flag off this is always false.
  const hasNetworkDevices = useMemo(
    () => networkDevicesEnabled && devices.some(d => (d.deviceClass ?? 'agent') === 'network'),
    [networkDevicesEnabled, devices],
  );

  const sortedDevices = useMemo(() => {
    if (!sortField) return filteredDevices;
    const value = sortValue[sortField];
    const dir = sortDirection === 'desc' ? -1 : 1;

    return [...filteredDevices].sort((a, b) => {
      const av = value(a);
      const bv = value(b);
      // Dash cells sort last regardless of direction.
      if (av === null || bv === null) return av === bv ? 0 : av === null ? 1 : -1;
      const cmp =
        typeof av === 'number' && typeof bv === 'number'
          ? av - bv
          : String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' });
      return dir * cmp;
    });
  }, [filteredDevices, sortField, sortDirection]);

  const moreFiltersCount = [roleFilter, orgFilter, siteFilter].filter(f => f !== 'all').length + (groupFilter.length > 0 ? 1 : 0);

  const totalPages = Math.ceil(sortedDevices.length / effectivePageSize);

  // Adjust currentPage during render when filters/search shrink the result
  // set below it. Setting state during render is React's documented way to
  // correct derived state without a flash of stale UI — React discards the
  // in-progress render and re-runs with the corrected value.
  if (totalPages > 0 && currentPage > totalPages) {
    setCurrentPage(1);
  }

  const startIndex = (currentPage - 1) * effectivePageSize;
  const paginatedDevices = sortedDevices.slice(startIndex, startIndex + effectivePageSize);

  const handlePageSizeChange = (newSize: number) => {
    setEffectivePageSize(newSize);
    writePageSizePreference(newSize);
    // Reset to page 1 so the user doesn't land out-of-range when shrinking
    // the page (and gets a coherent first-page view when growing it).
    setCurrentPage(1);
  };

  const handleSelectAll = (checked: boolean) => {
    if (checked) {
      setSelectedIds(new Set(paginatedDevices.map(d => d.id)));
    } else {
      setSelectedIds(new Set());
    }
  };

  const handleSelectOne = (id: string, checked: boolean) => {
    const newSet = new Set(selectedIds);
    if (checked) {
      newSet.add(id);
    } else {
      newSet.delete(id);
    }
    setSelectedIds(newSet);
  };

  const handleBulkAction = (action: string) => {
    const selectedDevices = devices.filter(d => selectedIds.has(d.id));
    onBulkAction?.(action, selectedDevices);
    setBulkMenuOpen(false);
    setSelectedIds(new Set());
  };

  const allSelected = paginatedDevices.length > 0 && paginatedDevices.every(d => selectedIds.has(d.id));
  const someSelected = paginatedDevices.some(d => selectedIds.has(d.id));

  // The Class/Type columns belong to the network arm (#1322); hide them
  // entirely when the feature flag is off so the list is the agent-only view.
  const isColumnAvailable = (id: ColumnId) => networkDevicesEnabled || !NETWORK_ONLY_COLUMNS.has(id);

  // Effective render sequence: user-chosen order, filtered to visible.
  // Checkbox and Actions are rendered separately as the first/last cells.
  const renderedColumns = columnOrder.filter(id => visibleColumns.has(id) && isColumnAvailable(id));

  // sortHeader factors out the repeated header pattern for sortable
  // columns to keep the column-defs table below readable. The column id
  // doubles as the sort key.
  const sortHeader = (id: ColumnId, label: string, hint: string, alignRight = false) => (
    <th
      key={id}
      className={`px-3 py-3 cursor-pointer select-none hover:text-foreground${alignRight ? ' text-right' : ''}`}
      title={hint}
      aria-sort={sortField === id ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'}
      onClick={() => handleSort(id)}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {sortField === id ? (
          sortDirection === 'asc' ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />
        ) : (
          <ArrowUpDown className="h-3 w-3 opacity-30" />
        )}
      </span>
    </th>
  );

  // metricBar renders the colored CPU/RAM percent bar with em-dash
  // fallback for non-online devices. Extracted so the cpu and ram column
  // cells stay small.
  const metricBar = (percent: number, online: boolean) =>
    online ? (
      <div className="flex items-center gap-2">
        <div className="h-2 w-16 overflow-hidden rounded-full bg-muted">
          <div
            className={`h-full rounded-full ${percent > 80 ? 'bg-destructive' : percent > 60 ? 'bg-warning' : 'bg-success'} ${widthPercentClass(percent)}`}
          />
        </div>
        <span className="w-10 text-right tabular-nums">{percent}%</span>
      </div>
    ) : (
      <span className="text-muted-foreground">&mdash;</span>
    );

  // Format helpers for hardware columns. RAM is reported in MB; convert
  // to GB rounded to one decimal. Disk is already reported in GB.
  const fmtRamGb = (mb: number | undefined) =>
    typeof mb === 'number' ? `${(mb / 1024).toFixed(1)} GB` : null;
  const fmtDiskGb = (gb: number | undefined) =>
    typeof gb === 'number' ? `${gb} GB` : null;
  const fmtDate = (iso: string | undefined) => {
    if (!iso) return null;
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
  };

  // columnDefs is the single source of truth for each toggleable column's
  // header and per-row cell. The thead and tbody iterate `renderedColumns`
  // and pick from this table, so adding a new column means adding one
  // entry here plus the corresponding id to COLUMN_IDS / COLUMN_LABELS.
  const dash = <span className="text-muted-foreground">&mdash;</span>;
  // Agent-only columns render "—" for network devices (#1322): the
  // attribute doesn't exist for a printer/router, so don't imply 0/blank.
  const agentCell = (device: Device, node: React.ReactNode): React.ReactNode =>
    (device.deviceClass ?? 'agent') === 'network' ? dash : node;
  const columnDefs: Record<ColumnId, { header: () => React.ReactNode; cell: (device: Device) => React.ReactNode }> = {
    hostname: {
      header: () => sortHeader('hostname', 'Hostname', 'Sort by hostname'),
      cell: (device) => (
        <td key="hostname" className="max-w-[200px] px-3 py-3 text-sm font-medium">
          <span className="block truncate" title={device.displayName || device.hostname}>{device.displayName || device.hostname}</span>
        </td>
      ),
    },
    class: {
      header: () => sortHeader('class', 'Class', 'Sort by class'),
      cell: (device) => {
        const deviceClass = device.deviceClass ?? 'agent';
        const isNetwork = deviceClass === 'network';
        return (
          <td key="class" className="px-3 py-3 text-sm">
            <span
              data-testid={`device-${device.id}-class-badge`}
              title={isNetwork ? 'Network-discovered device' : 'Agent-managed endpoint'}
              className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium ${
                isNetwork
                  ? 'bg-info/15 text-info border-info/30'
                  : 'bg-primary/10 text-primary border-primary/30'
              }`}
            >
              {isNetwork ? <Network className="h-3 w-3" /> : <Cpu className="h-3 w-3" />}
              {isNetwork ? 'Network' : 'Agent'}
            </span>
          </td>
        );
      },
    },
    type: {
      header: () => sortHeader('type', 'Type', 'Sort by type'),
      cell: (device) => {
        // Type is the asset_type of a *network-discovered* device (printer,
        // switch, NAS…). For agent rows the equivalent question — what kind of
        // endpoint is this — is answered by the Role column, so Type renders a
        // dash rather than echoing deviceRole and duplicating Role side by
        // side (#1386). Role and Type are complementary axes, one per class.
        if ((device.deviceClass ?? 'agent') !== 'network') {
          return <td key="type" className="px-3 py-3 text-sm whitespace-nowrap">{dash}</td>;
        }
        const typeValue = device.assetType ?? 'unknown';
        const TypeIcon = getDeviceRoleIcon(typeValue);
        const typeLabel = getDeviceRoleLabel(typeValue);
        return (
          <td key="type" className="px-3 py-3 text-sm whitespace-nowrap" data-testid={`device-${device.id}-type`}>
            <span className="inline-flex items-center gap-1.5 text-muted-foreground" title={typeLabel}>
              <TypeIcon className="h-3.5 w-3.5" />
              <span className="truncate">{typeLabel}</span>
            </span>
          </td>
        );
      },
    },
    organization: {
      header: () => sortHeader('organization', 'Organization', 'Sort by organization'),
      cell: (device) => (
        <td key="organization" className="max-w-[160px] px-3 py-3 text-sm text-muted-foreground">
          <span className="block truncate" title={device.orgName}>{device.orgName}</span>
        </td>
      ),
    },
    site: {
      header: () => sortHeader('site', 'Site', 'Sort by site'),
      cell: (device) => (
        <td key="site" className="max-w-[160px] px-3 py-3 text-sm text-muted-foreground">
          <span className="block truncate" title={device.siteName}>{device.siteName}</span>
        </td>
      ),
    },
    os: {
      header: () => sortHeader('os', 'OS', 'Sort by operating system'),
      cell: (device) => (
        <td key="os" className="px-3 py-3 text-sm">
          {agentCell(device, <OSIcon os={device.os} className="h-4 w-4 text-muted-foreground" />)}
        </td>
      ),
    },
    osVersion: {
      header: () => sortHeader('osVersion', 'OS Version', 'Sort by OS version'),
      cell: (device) => (
        <td key="osVersion" className="px-3 py-3 text-sm text-muted-foreground whitespace-nowrap">
          {formatDeviceOsVersion(device.os, device.osVersion) || dash}
        </td>
      ),
    },
    osBuild: {
      header: () => sortHeader('osBuild', 'OS Build', 'Sort by OS build'),
      cell: (device) => (
        <td key="osBuild" className="px-3 py-3 text-sm text-muted-foreground whitespace-nowrap">
          {device.osBuild || dash}
        </td>
      ),
    },
    architecture: {
      header: () => sortHeader('architecture', 'Arch', 'Sort by architecture'),
      cell: (device) => (
        <td key="architecture" className="px-3 py-3 text-sm text-muted-foreground">
          {device.architecture || dash}
        </td>
      ),
    },
    role: {
      header: () => sortHeader('role', 'Role', 'Sort by role'),
      cell: (device) => {
        // Role is the function of an *agent-managed* endpoint and drives
        // config-policy targeting; it's meaningless for a network-discovered
        // asset (a printer has no agent role), so network rows render a dash —
        // the inverse of the Type column above (#1386, #1322 dash convention).
        const role = device.deviceRole ?? 'unknown';
        const RoleIcon = getDeviceRoleIcon(role);
        const roleLabel = getDeviceRoleLabel(role);
        return (
          <td key="role" className="px-3 py-3 text-sm" data-testid={`device-${device.id}-role`}>
            {agentCell(device, (
              <span
                className="inline-flex items-center justify-center rounded-full border bg-muted/50 p-1.5"
                title={roleLabel}
                aria-label={roleLabel}
              >
                <RoleIcon className="h-3.5 w-3.5" />
              </span>
            ))}
          </td>
        );
      },
    },
    isHeadless: {
      header: () => sortHeader('isHeadless', 'Headless', 'Sort by headless flag'),
      cell: (device) => (
        <td key="isHeadless" className="px-3 py-3 text-sm text-muted-foreground">
          {typeof device.isHeadless === 'boolean' ? (device.isHeadless ? 'Yes' : 'No') : dash}
        </td>
      ),
    },
    status: {
      header: () => sortHeader('status', 'Status', 'Sort by status'),
      cell: (device) => (
        <td key="status" className="px-3 py-3 text-sm">
          <div className="flex flex-wrap items-center gap-1">
            <span
              className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${statusColors[device.status]}`}
              title={statusFullLabels[device.status]}
            >
              {statusLabels[device.status]}
            </span>
            {shouldShowAgentSilentBadge(device) && (
              <span
                data-testid={`device-${device.id}-agent-silent-badge`}
                title={`Main agent has been silent for ${formatSilentDuration(device.mainAgentSilentSince!)}. Watchdog is still reporting in, so the box is alive but the agent has wedged.`}
                className="inline-flex items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-[10px] font-medium bg-warning/15 text-warning border-warning/30"
              >
                Agent silent · {formatSilentDuration(device.mainAgentSilentSince!)}
              </span>
            )}
            {device.pendingReboot && (
              <span
                data-testid={`device-${device.id}-pending-reboot-badge`}
                title="The OS reports a pending reboot (Windows registry / Linux reboot-required markers)."
                className="inline-flex items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-[10px] font-medium bg-warning/15 text-warning border-warning/30"
              >
                Reboot pending
              </span>
            )}
          </div>
        </td>
      ),
    },
    pendingReboot: {
      header: () => sortHeader('pendingReboot', 'Pending Reboot', 'Sort by pending reboot'),
      cell: (device) => (
        <td key="pendingReboot" className="px-3 py-3 text-sm whitespace-nowrap">
          {device.pendingReboot ? (
            <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium bg-warning/15 text-warning border-warning/30">
              Reboot pending
            </span>
          ) : (
            dash
          )}
        </td>
      ),
    },
    cpu: {
      header: () => sortHeader('cpu', 'CPU %', 'Sort by CPU usage'),
      cell: (device) => (
        <td key="cpu" className="px-3 py-3 text-sm">{agentCell(device, metricBar(device.cpuPercent, device.status === 'online'))}</td>
      ),
    },
    ram: {
      header: () => sortHeader('ram', 'RAM %', 'Sort by RAM usage'),
      cell: (device) => (
        <td key="ram" className="px-3 py-3 text-sm">{agentCell(device, metricBar(device.ramPercent, device.status === 'online'))}</td>
      ),
    },
    cpuModel: {
      header: () => sortHeader('cpuModel', 'CPU Model', 'Sort by CPU model'),
      cell: (device) => (
        <td key="cpuModel" className="max-w-[220px] px-3 py-3 text-sm text-muted-foreground">
          <span className="block truncate" title={device.hardware?.cpuModel ?? ''}>
            {device.hardware?.cpuModel || dash}
          </span>
        </td>
      ),
    },
    cores: {
      header: () => sortHeader('cores', 'Cores', 'Sort by core count', true),
      cell: (device) => (
        <td key="cores" className="px-3 py-3 text-right text-sm tabular-nums">
          {typeof device.hardware?.cpuCores === 'number' ? device.hardware.cpuCores : dash}
        </td>
      ),
    },
    ramTotal: {
      header: () => sortHeader('ramTotal', 'RAM', 'Sort by total RAM', true),
      cell: (device) => (
        <td key="ramTotal" className="px-3 py-3 text-right text-sm tabular-nums">
          {fmtRamGb(device.hardware?.ramTotalMb) ?? dash}
        </td>
      ),
    },
    diskTotal: {
      header: () => sortHeader('diskTotal', 'Disk', 'Sort by total disk', true),
      cell: (device) => (
        <td key="diskTotal" className="px-3 py-3 text-right text-sm tabular-nums">
          {fmtDiskGb(device.hardware?.diskTotalGb) ?? dash}
        </td>
      ),
    },
    lastSeen: {
      header: () => sortHeader('lastSeen', 'Last Seen', 'Sort by last seen time'),
      cell: (device) => (
        <td key="lastSeen" className="px-3 py-3 text-sm text-muted-foreground whitespace-nowrap">
          {formatLastSeen(device.lastSeen, effectiveTimezone)}
        </td>
      ),
    },
    agentVersion: {
      header: () => sortHeader('agentVersion', 'Agent Version', 'Sort by agent version'),
      cell: (device) => (
        <td key="agentVersion" className="px-3 py-3 text-sm text-muted-foreground whitespace-nowrap">
          {device.agentVersion || dash}
        </td>
      ),
    },
    tags: {
      header: () => sortHeader('tags', 'Tags', 'Sort by tags'),
      cell: (device) => (
        <td key="tags" className="max-w-[220px] px-3 py-3 text-sm text-muted-foreground">
          {device.tags && device.tags.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1" title={device.tags.join(', ')}>
              {device.tags.slice(0, TAG_CHIP_CAP).map(tag => (
                <span
                  key={tag}
                  className="inline-flex items-center rounded-full border border-border bg-muted/50 px-2 py-0.5 text-xs font-medium text-foreground"
                >
                  {tag}
                </span>
              ))}
              {device.tags.length > TAG_CHIP_CAP && (
                <span className="inline-flex items-center rounded-full border border-border px-2 py-0.5 text-xs font-medium text-muted-foreground">
                  +{device.tags.length - TAG_CHIP_CAP}
                </span>
              )}
            </div>
          ) : dash}
        </td>
      ),
    },
    lastUser: {
      header: () => sortHeader('lastUser', 'Last User', 'Sort by last user'),
      cell: (device) => (
        <td key="lastUser" className="max-w-[160px] px-3 py-3 text-sm text-muted-foreground">
          <span className="block truncate" title={device.lastUser ?? ''}>{device.lastUser || dash}</span>
        </td>
      ),
    },
    uptime: {
      header: () => sortHeader('uptime', 'Uptime', 'Sort by uptime'),
      cell: (device) => (
        <td key="uptime" className="px-3 py-3 text-sm text-muted-foreground whitespace-nowrap">
          {device.status === 'online' && device.uptimeSeconds != null
            ? formatUptime(device.uptimeSeconds)
            : dash}
        </td>
      ),
    },
    enrolled: {
      header: () => sortHeader('enrolled', 'Enrolled', 'Sort by enrollment date'),
      cell: (device) => (
        <td key="enrolled" className="px-3 py-3 text-sm text-muted-foreground whitespace-nowrap">
          {fmtDate(device.enrolledAt) ?? dash}
        </td>
      ),
    },
    desktopAccess: {
      header: () => sortHeader('desktopAccess', 'Desktop Access', 'Sort by desktop access'),
      cell: (device) => {
        const da = device.desktopAccess;
        if (!da) return <td key="desktopAccess" className="px-3 py-3 text-sm text-muted-foreground">{dash}</td>;
        return (
          <td key="desktopAccess" className="px-3 py-3 text-sm text-muted-foreground">
            <span className="inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium" title={`mode=${da.mode}; loginUi=${da.loginUiReachable}; virtualDisplay=${da.virtualDisplayReady}`}>
              {da.mode}
            </span>
          </td>
        );
      },
    },
  };

  return (
    <div>
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-muted-foreground">
            {filteredDevices.length} of {statusFilter === 'all' ? devices.filter(d => d.status !== 'decommissioned').length : devices.length} devices
            {serverFilterIds !== null && (
              <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                <Filter className="h-3 w-3" />
                Advanced filter active
                {serverFilterLoading && <span className="ml-1 animate-pulse">...</span>}
              </span>
            )}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {hasNetworkDevices && (
              <div
                role="group"
                aria-label="Filter by device class"
                className="inline-flex h-10 items-center rounded-md border bg-background p-0.5 text-sm"
              >
                {([
                  ['all', 'All'],
                  ['agent', 'Agent'],
                  ['network', 'Network'],
                ] as const).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    data-testid={`device-class-filter-${value}`}
                    aria-pressed={classFilter === value}
                    onClick={() => {
                      setClassFilter(value);
                      setCurrentPage(1);
                    }}
                    className={`h-full rounded px-3 font-medium transition ${
                      classFilter === value
                        ? 'bg-primary text-primary-foreground'
                        : 'text-muted-foreground hover:bg-muted'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                type="search"
                placeholder="Search by hostname"
                value={query}
                onChange={event => {
                  setQuery(event.target.value);
                  setCurrentPage(1);
                }}
                className="h-10 w-full rounded-md border bg-background pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring sm:w-56"
              />
            </div>
            <select
              value={statusFilter}
              aria-label="Filter by status"
              onChange={event => {
                setStatusFilter(event.target.value);
                setCurrentPage(1);
              }}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring sm:w-32"
            >
              <option value="all">All Status</option>
              <option value="online">Online</option>
              <option value="offline">Offline</option>
              <option value="maintenance">Maintenance</option>
              <option value="decommissioned">Decommissioned</option>
            </select>
            <select
              value={osFilter}
              aria-label="Filter by operating system"
              onChange={event => {
                setOsFilter(event.target.value);
                setCurrentPage(1);
              }}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring sm:w-32"
            >
              <option value="all">All OS</option>
              <option value="windows">Windows</option>
              <option value="macos">macOS</option>
              <option value="linux">Linux</option>
            </select>
            <button
              type="button"
              onClick={() => setShowMoreFilters(!showMoreFilters)}
              className="h-10 whitespace-nowrap rounded-md border px-3 text-sm font-medium hover:bg-muted flex items-center gap-1.5"
            >
              <Filter className="h-3.5 w-3.5" />
              More
              {moreFiltersCount > 0 && (
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary text-[10px] font-semibold text-primary-foreground">
                  {moreFiltersCount}
                </span>
              )}
            </button>
            {/* Interface density is now an account-wide control in the
                top-bar theme/display menu (Header.tsx). The table still
                reflects the saved preference via densityTableClasses +
                subscribeDensity below. */}
            <div className="relative" ref={columnsMenuRef}>
              <button
                type="button"
                onClick={() => setColumnsMenuOpen(o => !o)}
                aria-haspopup="true"
                aria-expanded={columnsMenuOpen}
                className="h-10 whitespace-nowrap rounded-md border px-3 text-sm font-medium hover:bg-muted flex items-center gap-1.5"
              >
                <Columns3 className="h-3.5 w-3.5" />
                Columns
              </button>
              {columnsMenuOpen && (
                <div
                  role="menu"
                  className="absolute right-0 z-20 mt-1 max-h-96 w-72 overflow-y-auto rounded-md border bg-card p-1 shadow-md"
                >
                  <p className="px-2 pt-1 pb-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Visible (in order)
                  </p>
                  {columnOrder.filter(id => visibleColumns.has(id) && isColumnAvailable(id)).map((id, idx, arr) => (
                    <div
                      key={id}
                      className="flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted"
                    >
                      <input
                        type="checkbox"
                        checked
                        onChange={() => toggleColumn(id)}
                        className="h-4 w-4 rounded border-border"
                        aria-label={`Hide ${COLUMN_LABELS[id]}`}
                      />
                      <span className="flex-1 cursor-default">{COLUMN_LABELS[id]}</span>
                      <button
                        type="button"
                        disabled={idx === 0}
                        onClick={() => moveColumn(id, -1)}
                        className="rounded p-0.5 hover:bg-background disabled:cursor-not-allowed disabled:opacity-30"
                        aria-label={`Move ${COLUMN_LABELS[id]} up`}
                        title="Move up"
                      >
                        <ChevronUp className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        disabled={idx === arr.length - 1}
                        onClick={() => moveColumn(id, 1)}
                        className="rounded p-0.5 hover:bg-background disabled:cursor-not-allowed disabled:opacity-30"
                        aria-label={`Move ${COLUMN_LABELS[id]} down`}
                        title="Move down"
                      >
                        <ChevronDown className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                  <hr className="my-1" />
                  <p className="px-2 pt-0.5 pb-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Hidden
                  </p>
                  {columnOrder.filter(id => !visibleColumns.has(id) && isColumnAvailable(id)).map(id => (
                    <label
                      key={id}
                      className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
                    >
                      <input
                        type="checkbox"
                        checked={false}
                        onChange={() => toggleColumn(id)}
                        className="h-4 w-4 rounded border-border"
                      />
                      <span>{COLUMN_LABELS[id]}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
            {(query || statusFilter !== 'all' || osFilter !== 'all' || roleFilter !== 'all' || orgFilter !== 'all' || siteFilter !== 'all' || groupFilter.length > 0) && (
              <button
                type="button"
                onClick={() => {
                  setQuery('');
                  setStatusFilter('all');
                  setOsFilter('all');
                  setRoleFilter('all');
                  setOrgFilter('all');
                  setSiteFilter('all');
                  setGroupFilter([]);
                  setCurrentPage(1);
                }}
                className="h-10 whitespace-nowrap rounded-md px-3 text-sm font-medium text-muted-foreground hover:text-foreground"
              >
                Clear filters
              </button>
            )}
          </div>
        </div>
        <div className={`grid transition-[grid-template-rows] duration-200 ease-out ${showMoreFilters ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
          <div className="overflow-hidden">
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <select
                value={roleFilter}
                aria-label="Filter by device role"
                onChange={event => {
                  setRoleFilter(event.target.value);
                  setCurrentPage(1);
                }}
                className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring sm:w-36"
              >
                <option value="all">All Roles</option>
                {DEVICE_ROLES.map(role => (
                  <option key={role} value={role}>
                    {getDeviceRoleLabel(role)}
                  </option>
                ))}
              </select>
              {orgs.length > 0 && (
                <select
                  value={orgFilter}
                  aria-label="Filter by organization"
                  onChange={event => {
                    setOrgFilter(event.target.value);
                    setCurrentPage(1);
                  }}
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring sm:w-40"
                >
                  <option value="all">All Orgs</option>
                  {orgs.map(org => (
                    <option key={org.id} value={org.id}>
                      {org.name}
                    </option>
                  ))}
                </select>
              )}
              {sites.length > 0 && (
                <select
                  value={siteFilter}
                  aria-label="Filter by site"
                  onChange={event => {
                    setSiteFilter(event.target.value);
                    setCurrentPage(1);
                  }}
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring sm:w-40"
                >
                  <option value="all">All Sites</option>
                  {sites.map(site => (
                    <option key={site.id} value={site.id}>
                      {site.name}
                    </option>
                  ))}
                </select>
              )}
              {groups.length > 0 && (
                <div className="relative" ref={groupDropdownRef}>
                  <button
                    type="button"
                    onClick={() => setGroupDropdownOpen(!groupDropdownOpen)}
                    className="h-10 whitespace-nowrap rounded-md border bg-background px-3 text-sm font-medium hover:bg-muted flex items-center gap-1.5"
                  >
                    Groups
                    {groupFilter.length > 0 && (
                      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary text-[10px] font-semibold text-primary-foreground">
                        {groupFilter.length}
                      </span>
                    )}
                    <ChevronDown className="h-3.5 w-3.5" />
                  </button>
                  {groupDropdownOpen && (
                    <div className="absolute left-0 top-full z-20 mt-1 w-64 rounded-md border bg-card shadow-lg">
                      <div className="max-h-48 overflow-y-auto p-2">
                        {groups.map(group => (
                          <label key={group.id} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted">
                            <input
                              type="checkbox"
                              checked={groupFilter.includes(group.id)}
                              onChange={() => {
                                setGroupFilter(prev =>
                                  prev.includes(group.id)
                                    ? prev.filter(id => id !== group.id)
                                    : [...prev, group.id]
                                );
                                setCurrentPage(1);
                              }}
                              className="h-4 w-4 rounded border-border"
                            />
                            <span className="text-sm truncate">{group.name}</span>
                            <span className="ml-auto text-[10px] text-muted-foreground">{group.type}</span>
                          </label>
                        ))}
                      </div>
                      <div className="border-t px-2 py-2 flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            setGroupDropdownOpen(false);
                            onCreateGroup?.();
                          }}
                          className="text-xs font-medium text-primary hover:underline"
                        >
                          + New Group
                        </button>
                        <a
                          href="/devices/groups"
                          className="text-xs text-muted-foreground hover:text-foreground ml-auto"
                        >
                          Manage Groups
                        </a>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {selectedIds.size > 0 && (
        <div className="mt-4 flex items-center gap-3 rounded-md border bg-muted/40 px-4 py-2">
          <span className="text-sm font-medium">{selectedIds.size} selected</span>
          <div className="relative">
            <button
              type="button"
              onClick={() => setBulkMenuOpen(!bulkMenuOpen)}
              className="flex items-center gap-1 rounded-md border bg-background px-3 py-1.5 text-sm font-medium hover:bg-muted"
            >
              Bulk Actions
              <MoreHorizontal className="h-4 w-4" />
            </button>
            {bulkMenuOpen && (
              <div className="absolute left-0 top-full z-10 mt-1 w-48 rounded-md border bg-card shadow-lg">
                <button
                  type="button"
                  onClick={() => handleBulkAction('reboot')}
                  className="w-full px-4 py-2 text-left text-sm hover:bg-muted"
                >
                  Reboot Selected
                </button>
                <button
                  type="button"
                  onClick={() => handleBulkAction('run-script')}
                  className="w-full px-4 py-2 text-left text-sm hover:bg-muted"
                >
                  Run Script
                </button>
                <button
                  type="button"
                  onClick={() => handleBulkAction('deploy-software')}
                  className="w-full px-4 py-2 text-left text-sm hover:bg-muted"
                >
                  Deploy Software
                </button>
                <button
                  type="button"
                  onClick={() => handleBulkAction('maintenance-on')}
                  className="w-full px-4 py-2 text-left text-sm hover:bg-muted"
                >
                  Enable Maintenance
                </button>
                <button
                  type="button"
                  onClick={() => handleBulkAction('maintenance-off')}
                  className="w-full px-4 py-2 text-left text-sm hover:bg-muted"
                >
                  Disable Maintenance
                </button>
                <hr className="my-1" />
                <button
                  type="button"
                  onClick={() => handleBulkAction('wake')}
                  className="w-full px-4 py-2 text-left text-sm hover:bg-muted"
                >
                  Wake Selected
                </button>
                <hr className="my-1" />
                <button
                  type="button"
                  onClick={() => handleBulkAction('decommission')}
                  className="w-full px-4 py-2 text-left text-sm text-destructive hover:bg-destructive/10"
                >
                  Decommission Selected
                </button>
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={() => setSelectedIds(new Set())}
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            Clear selection
          </button>
        </div>
      )}

      <div className="mt-6 overflow-x-auto rounded-md border">
        <table className={`w-full divide-y ${densityTableClasses(density)}`}>
          <thead className="bg-muted/40">
            <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <th className="px-3 py-3">
                <input
                  type="checkbox"
                  checked={allSelected}
                  aria-label="Select all devices on this page"
                  ref={el => {
                    if (el) el.indeterminate = someSelected && !allSelected;
                  }}
                  onChange={e => handleSelectAll(e.target.checked)}
                  className="h-4 w-4 rounded border-border"
                />
              </th>
              {renderedColumns.map(id => columnDefs[id].header())}
              <th className="px-3 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {paginatedDevices.length === 0 ? (
              <tr>
                <td
                  colSpan={renderedColumns.length + 2 /* checkbox + Actions; renderedColumns already drops flag-gated columns */}
                  className="px-3 py-6 text-center text-sm text-muted-foreground"
                >
                  No devices found. Try adjusting your search or filters.
                </td>
              </tr>
            ) : (
              paginatedDevices.map(device => (
                <tr
                  key={device.id}
                  onClick={() => onSelect?.(device)}
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onSelect?.(device);
                    }
                  }}
                  className="cursor-pointer transition hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-none"
                >
                  <td className="px-3 py-3">
                    <input
                      type="checkbox"
                      checked={selectedIds.has(device.id)}
                      aria-label={`Select ${device.hostname}`}
                      onClick={e => e.stopPropagation()}
                      onChange={e => handleSelectOne(device.id, e.target.checked)}
                      className="h-4 w-4 rounded border-border"
                    />
                  </td>
                  {renderedColumns.map(id => columnDefs[id].cell(device))}
                  <td className="px-3 py-3 text-sm" onClick={e => e.stopPropagation()}>
                    {(device.deviceClass ?? 'agent') === 'network' ? (
                      // Network devices have no agent — none of the remote
                      // actions (desktop/terminal/scripts/reboot) apply.
                      // Phase 1 routes to the existing Discovery view.
                      <div className="flex items-center justify-end gap-1">
                        <button
                          type="button"
                          data-testid={`device-${device.id}-open-network`}
                          onClick={() => onSelect?.(device)}
                          className="rounded-md border px-2.5 py-1 text-xs font-medium text-muted-foreground hover:bg-muted"
                        >
                          View
                        </button>
                      </div>
                    ) : (
                    <div className="flex items-center justify-end gap-1">
                      <ConnectDesktopButton
                        deviceId={device.id}
                        iconOnly
                        disabled={device.status !== 'online'}
                        isHeadless={device.isHeadless}
                        desktopAccess={device.desktopAccess}
                        remoteAccessPolicy={device.remoteAccessPolicy}
                      />
                      <div className="relative">
                        <button
                          type="button"
                          aria-label="Device actions"
                          ref={rowMenuOpenId === device.id ? rowMenuButtonRef : undefined}
                          onClick={(e) => {
                            if (rowMenuOpenId !== device.id) {
                              const rect = e.currentTarget.getBoundingClientRect();
                              // ~280px dropdown height (7 items × ~36px + padding/divider).
                              // Flip up when the space below the button is less than that.
                              setRowMenuFlipUp(window.innerHeight - rect.bottom < 300);
                              setRowMenuAnchor({ top: rect.top, bottom: rect.bottom, right: rect.right });
                            }
                            setRowMenuOpenId(rowMenuOpenId === device.id ? null : device.id);
                          }}
                          className="flex h-8 w-8 items-center justify-center rounded-md transition hover:bg-muted"
                        >
                          <MoreVertical className="h-4 w-4" />
                        </button>
                        {rowMenuOpenId === device.id && rowMenuAnchor && createPortal(
                          <div
                            ref={rowMenuRef}
                            style={{
                              position: 'fixed',
                              right: window.innerWidth - rowMenuAnchor.right,
                              ...(rowMenuFlipUp
                                ? { bottom: window.innerHeight - rowMenuAnchor.top + 4 }
                                : { top: rowMenuAnchor.bottom + 4 }),
                            }}
                            className="z-50 w-48 rounded-md border bg-card shadow-lg"
                          >
                            <button
                              type="button"
                              disabled={device.status !== 'online'}
                              onClick={() => {
                                onAction?.('terminal', device);
                                setRowMenuOpenId(null);
                              }}
                              className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              <Terminal className="h-4 w-4" />
                              Remote Terminal
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                onAction?.('run-script', device);
                                setRowMenuOpenId(null);
                              }}
                              className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-muted"
                            >
                              <FileCode className="h-4 w-4" />
                              Run Script
                            </button>
                            <button
                              type="button"
                              disabled={device.status !== 'online'}
                              onClick={() => {
                                onAction?.('reboot', device);
                                setRowMenuOpenId(null);
                              }}
                              className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              <RotateCcw className="h-4 w-4" />
                              Reboot
                            </button>
                            {device.status === 'offline' && (
                              <button
                                type="button"
                                onClick={() => {
                                  onAction?.('wake', device);
                                  setRowMenuOpenId(null);
                                }}
                                className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-muted"
                                title="Send a Wake-on-LAN packet via an online peer agent on the device's LAN"
                              >
                                <Zap className="h-4 w-4" />
                                Wake
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => {
                                onAction?.('settings', device);
                                setRowMenuOpenId(null);
                              }}
                              className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-muted"
                            >
                              <Settings className="h-4 w-4" />
                              Settings
                            </button>
                            <hr className="my-1" />
                            {device.status === 'decommissioned' ? (
                              <button
                                type="button"
                                onClick={() => {
                                  onAction?.('restore', device);
                                  setRowMenuOpenId(null);
                                }}
                                className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-success hover:bg-success/10"
                              >
                                <RotateCcw className="h-4 w-4" />
                                Restore
                              </button>
                            ) : (
                              <button
                                type="button"
                                onClick={() => {
                                  onAction?.('decommission', device);
                                  setRowMenuOpenId(null);
                                }}
                                className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-destructive hover:bg-destructive/10"
                              >
                                <Trash2 className="h-4 w-4" />
                                Decommission
                              </button>
                            )}
                          </div>,
                          document.body
                        )}
                      </div>
                    </div>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {sortedDevices.length > 0 && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-3">
            <p className="text-sm text-muted-foreground">
              Showing {startIndex + 1} to {Math.min(startIndex + effectivePageSize, sortedDevices.length)} of {sortedDevices.length}
            </p>
            <div className="flex items-center gap-2">
              <label htmlFor="device-page-size" className="text-sm text-muted-foreground">
                Per page
              </label>
              <select
                id="device-page-size"
                value={effectivePageSize}
                aria-label="Devices per page"
                onChange={event => handlePageSizeChange(Number(event.target.value))}
                className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring sm:w-32"
              >
                {PAGE_SIZE_OPTIONS.map(opt => (
                  <option key={opt} value={opt}>
                    {opt}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {totalPages > 1 && (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                disabled={currentPage === 1}
                className="flex h-9 w-9 items-center justify-center rounded-md border hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <span className="text-sm">
                Page {currentPage} of {totalPages}
              </span>
              <button
                type="button"
                onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                disabled={currentPage === totalPages}
                className="flex h-9 w-9 items-center justify-center rounded-md border hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
