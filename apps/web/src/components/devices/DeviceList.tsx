import { Fragment, useMemo, useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import {
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ChevronDown,
  ArrowUpDown,
  CornerDownRight,
  MoreHorizontal,
  MoreVertical,
  Filter,
  Terminal,
  FileCode,
  RotateCcw,
  Settings,
  Trash2,
  Zap,
  Columns3,
  Network,
  Cpu,
  Battery,
  BatteryCharging,
  BatteryWarning,
  Plug,
  Link2,
} from "lucide-react";
import type {
  BatteryStatus,
  DesktopAccessState,
  RemoteAccessPolicy,
  VpnPresence,
} from "@breeze/shared";
import ConnectDesktopButton from "../remote/ConnectDesktopButton";
// Single source of truth for "can this device still accept a queued command?".
// Hoisted out of this file (#2465): the bulk bar in DevicesPage needs the SAME
// rule, and re-deriving it per surface is exactly how the false "must be online"
// premise got copied three times (DeviceActions -> row menu -> bulk bar). The
// verified API contract lives next to it — read that before changing this.
import {
  isCommandQueueable,
  notOnlineTitle,
  notQueueableTitle,
} from "./bulkActionGating";
import { widthPercentClass, formatUptime } from "@/lib/utils";
import { formatLastSeen } from "@/lib/formatTime";
import { formatNumber } from "@/lib/i18n/format";
import {
  getDeviceRoleLabel,
  getDeviceRoleIcon,
  type DeviceRole,
} from "@/lib/deviceRoles";
import {
  activeVpnList,
  getVpnProviderIcon,
  getVpnProviderLabel,
  getVpnProviderBadgeClass,
  formatVpnTooltip,
} from "@/lib/vpnProviders";
import {
  PAGE_SIZE_OPTIONS,
  readPageSizePreference,
  writePageSizePreference,
} from "./pageSizePreference";
import {
  COLUMN_IDS,
  COLUMN_LABELS,
  readColumnOrder,
  readColumnVisibility,
  resetColumns,
  writeColumnOrder,
  writeColumnVisibility,
  type ColumnId,
} from "./columnVisibility";
import {
  densityTableClasses,
  readDensity,
  subscribeDensity,
  type Density,
} from "@/lib/density";
import {
  readLinkedProfileCollapsePreference,
  subscribeLinkedProfileCollapse,
  writeLinkedProfileCollapsePreference,
  type LinkedProfileCollapsePreference,
} from "@/lib/appearance";
import { groupLinkedDevices } from "./linkedDevices";
import { useOrgStore } from "@/stores/orgStore";
import DecommissionedHiddenHint from "./DecommissionedHiddenHint";
import { OSIcon } from "./osIcons";
import { formatDeviceOsVersion } from "./osDisplay";
import { type ListFilters, DEFAULT_LIST_FILTERS } from "./deviceListFilters";
import { useTranslation } from "react-i18next";
import "../../lib/i18n";

export type DeviceStatus =
  | "online"
  | "offline"
  | "maintenance"
  | "decommissioned"
  | "quarantined"
  | "updating"
  | "pending";
export type OSType = "windows" | "macos" | "linux";

/**
 * Presentation-level discriminator for the unified Devices list (#1322).
 * `agent` = an enrolled endpoint running the Go agent (devices table).
 * `network` = a discovered network device (printer/router/switch/…) from
 * discovered_assets that is approved and not linked to an agent. Agent-only
 * columns (CPU/RAM, agent version, OS build) render blank for `network` rows.
 */
export type DeviceClass = "agent" | "network";

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
  watchdogVersion?: string | null;
  /**
   * Control-plane URL the agent last heartbeated to (devices.agent_server_url,
   * #2288). The opt-in Server column renders only its hostname. Any current
   * agent reports it on every heartbeat (failover or not); absent only on
   * responses from older API versions or agents too old to send it.
   */
  agentServerUrl?: string | null;
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
  watchdogStatus?: "connected" | "failover" | "offline" | null;
  hardware?: {
    cpuModel?: string;
    cpuCores?: number;
    ramTotalMb?: number;
    diskTotalGb?: number;
  };
  /**
   * Headline device reliability score (0-100) from the existing
   * device_reliability subsystem (#1720). Null/undefined when no score has
   * been computed yet (newly enrolled, or before the reliability worker runs)
   * — the Reliability column renders a dash and sorts those rows last.
   */
  reliabilityScore?: number | null;
  /** Reliability trend from the same subsystem; drives the small arrow indicator. */
  reliabilityTrend?: "improving" | "stable" | "degrading" | null;
  /**
   * Current-state power/battery snapshot (#2142). null/undefined = no data
   * reported yet (old agent or network device) → the Power column renders a
   * dash. { present: false } = a real no-battery desktop → also a dash.
   */
  batteryStatus?: BatteryStatus | null;
  /**
   * Active-VPN-client presence snapshot (#2139). null/undefined = no data
   * reported yet (old agent or network device) → the VPN column renders a
   * dash. [] = reported with no active VPN → also a dash. Rendered purely
   * from cached inventory — the list never fans out live commands.
   */
  activeVpns?: VpnPresence[] | null;
  /**
   * Linked multi-boot profiles (#2138). `linkGroupId` comes straight from the
   * devices list API (null/undefined = unlinked). The grouping presentation
   * (inactive strips / left-edge group bar) is computed client-side per page by
   * groupLinkedDevices in linkedDevices.ts.
   */
  linkGroupId?: string | null;
  /**
   * vm_host link groups (#2308). 'host' = this record is the host server of a
   * vm_host group; 'guest' = a guest VM nested under that host. null/undefined
   * for unlinked devices and multiboot members (peers). A non-null role
   * implies the group's kind is 'vm_host' — no group fetch needed.
   */
  linkGroupRole?: 'host' | 'guest' | null;
};

// Columns that only make sense for the network arm (#1322); hidden unless
// networkDevicesEnabled. Module-level so it isn't reallocated each render.
const NETWORK_ONLY_COLUMNS: ReadonlySet<ColumnId> = new Set<ColumnId>([
  "class",
  "type",
]);

type DeviceListProps = {
  devices: Device[];
  orgs?: { id: string; name: string }[];
  sites?: { id: string; name: string }[];
  groups?: {
    id: string;
    name: string;
    type: "static" | "dynamic";
    deviceCount: number;
  }[];
  // Still accepted by callers, but the device-group filter now lives in the
  // chip bar (server-resolved), so DeviceList no longer filters by membership.
  groupMembershipMap?: Map<string, Set<string>>;
  onCreateGroup?: () => void;
  autoSelectGroupId?: string | null;
  onAutoSelectConsumed?: () => void;
  timezone?: string;
  onSelect?: (device: Device) => void;
  onAction?: (action: string, device: Device) => void;
  onBulkAction?: (action: string, devices: Device[]) => void;
  // Controlled inline filter state — now just the device search box, owned by
  // DevicesPage and shared with DeviceFilterToolbar. Every other structured
  // filter lives in the server-resolved group (serverFilterIds). Defaults keep
  // DeviceList usable on its own (tests render it standalone).
  // `onListFiltersChange` is accepted for API symmetry; DeviceList itself no
  // longer mutates the search filter (the toolbar owns the input).
  listFilters?: ListFilters;
  onListFiltersChange?: (next: ListFilters) => void;
  // Initial page size if the user has no stored preference for this browser.
  // Once the component mounts, the live page size comes from localStorage
  // (see pageSizePreference.ts); subsequent changes to this prop are ignored.
  pageSize?: number;
  // Pre-resolved advanced-filter id set (null = no advanced filter active).
  // Resolution lives in DevicesPage via useAdvancedFilterIds so the list and
  // grid views filter against the same complete, uncapped id set.
  serverFilterIds?: Set<string> | null;
  serverFilterLoading?: boolean;
  // When false (default), decommissioned devices are hidden — matching the old
  // default view (status='all' implicitly excluded them). DevicesPage sets this
  // true only when the active filter group explicitly targets the
  // 'decommissioned' status, so filtering FOR decommissioned still shows them.
  includeDecommissioned?: boolean;
  // Applies the Decommissioned status filter upstream (#2251) — the existing
  // unhide mechanism. Wired by DevicesPage; when absent (standalone renders /
  // tests) the "N decommissioned hidden — show" hint is not rendered.
  onShowDecommissioned?: () => void;
  // Unified-list network arm (#1322). Off by default behind a build-time flag
  // (PUBLIC_ENABLE_NETWORK_DEVICES_IN_LIST); when false the Class/Type columns
  // and the All/Agent/Network facet are hidden entirely so the list is the
  // agent-only view. DevicesPage passes ENABLE_NETWORK_DEVICES_IN_LIST.
  networkDevicesEnabled?: boolean;
};

const statusColors: Record<DeviceStatus, string> = {
  online: "bg-success/15 text-success border-success/30",
  offline: "bg-destructive/15 text-destructive border-destructive/30",
  maintenance: "bg-warning/15 text-warning border-warning/30",
  decommissioned: "bg-muted text-muted-foreground border-border",
  quarantined: "bg-warning/15 text-warning border-warning/30",
  updating: "bg-info/15 text-info border-info/30",
  pending: "bg-muted text-muted-foreground border-border",
};

// Canonical status values stay untouched; only their presentation keys vary.
const statusLabelKeys: Record<DeviceStatus, string> = {
  online: "deviceList.statuses.compact.online",
  offline: "deviceList.statuses.compact.offline",
  maintenance: "deviceList.statuses.compact.maintenance",
  decommissioned: "deviceList.statuses.compact.decommissioned",
  quarantined: "deviceList.statuses.compact.quarantined",
  updating: "deviceList.statuses.compact.updating",
  pending: "deviceList.statuses.compact.pending",
};
const statusFullLabelKeys: Record<DeviceStatus, string> = {
  online: "deviceList.statuses.full.online",
  offline: "deviceList.statuses.full.offline",
  maintenance: "deviceList.statuses.full.maintenance",
  decommissioned: "deviceList.statuses.full.decommissioned",
  quarantined: "deviceList.statuses.full.quarantined",
  updating: "deviceList.statuses.full.updating",
  pending: "deviceList.statuses.full.pending",
};

// Row-menu action gating (#2426). Two categories, and conflating them is the
// bug this fixes. In THIS menu the members are:
//
//   LIVE SESSION — Remote Terminal. Hands off a socket, so it needs an
//   actively-connected agent. `terminalWs` (and its desktop/tunnel siblings)
//   reject anything but `online` with "Device is not online".
//   → gate on `status !== 'online'`.
//
//   QUEUED COMMAND — Run Script, Reboot. Inserted as a `device_commands` row
//   with `status:'pending'` (no TTL) and claimed on the agent's NEXT
//   poll/heartbeat. The only status the API refuses is `decommissioned`:
//   `routes/devices/commands.ts` (:89, :157, :268, :437) and the shared
//   `executeScriptOnDevices` service (`services/scriptExecution.ts:118`, which
//   drops `status === 'decommissioned'` devices from the target set and returns
//   `status:'queued'` for the rest). Running a script against an OFFLINE device
//   is a working, intentional feature: it executes on reconnect. Gating a
//   queued command on `!== 'online'` does not prevent a doomed request, it
//   REMOVES that capability.
//   → gate on `status === 'decommissioned'` (an agent-less machine that can
//     never claim the command).
//
// Reboot carried the stricter `!== 'online'` gate until #2630. It is a queued
// command like Run Script, so it now uses `isCommandQueueable` too: rebooting an
// offline box on reconnect is a working feature, and the grid card (DeviceCard)
// had already been gated that way — leaving the two disagreeing meant the same
// device flipped enabled/disabled just by switching grid/list view. See #2486.
//
// The tooltip helpers live in bulkActionGating.ts beside `isCommandQueueable`,
// so the row menu and the grid card render the same reason for the same status.

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
function shouldShowAgentSilentBadge(
  device: Pick<Device, "mainAgentSilentSince" | "watchdogStatus">,
): boolean {
  return (
    Boolean(device.mainAgentSilentSince) && device.watchdogStatus !== "offline"
  );
}

function formatSilentDuration(silentSince: string): string {
  const minutes = Math.max(
    1,
    Math.floor((Date.now() - new Date(silentSince).getTime()) / 60_000),
  );
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

const osLabels: Record<OSType, string> = {
  windows: "Windows",
  macos: "macOS",
  linux: "Linux",
};

type SortField = ColumnId | null;
type SortDirection = "asc" | "desc";

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

// Single shared collator for every string sort in this list. `numeric` keeps
// host-2 < host-10 and agent 0.9.x < 0.10.x; `base` sensitivity folds case and
// accents so they don't fragment the order. Hoisted to module scope on purpose:
// constructing an Intl.Collator per comparison is measurably costly on the
// default landing view at the ~40k-row cap, where the sort runs over the whole
// union on every render.
const nameCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

// Hostname of the agent's active control-plane URL (#2288); null on
// missing/malformed values so the cell falls back to the dash.
function serverHost(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    return new URL(raw).hostname;
  } catch {
    return null;
  }
}

// One comparable value per column, mirroring what the cell displays.
// `null` means "renders as a dash" — those rows sort last in BOTH
// directions so blanks never bury the real data. Strings compare with
// numeric collation (host-2 < host-10, agent 0.9.x < 0.10.x).
const sortValue: Record<ColumnId, (d: Device) => string | number | null> = {
  hostname: (d) => d.displayName || d.hostname,
  // Unified-list columns (#1322): sort by the same value the cell renders so
  // header sort stays consistent with every other column (#1284 invariant).
  class: (d) =>
    (d.deviceClass ?? "agent") === "network" ? "Network" : "Agent",
  // Type renders only for network rows now (#1386); agent rows show a dash, so
  // they sort as blanks-last (null) to match the cell — the #1284 invariant.
  type: (d) =>
    (d.deviceClass ?? "agent") === "network"
      ? getDeviceRoleLabel(d.assetType ?? "unknown")
      : null,
  organization: (d) => d.orgName || null,
  site: (d) => d.siteName || null,
  os: (d) => osLabels[d.os],
  osVersion: (d) => formatDeviceOsVersion(d.os, d.osVersion) || null,
  osBuild: (d) => d.osBuild || null,
  architecture: (d) => d.architecture || null,
  // Role renders only for agent rows now (#1386); network rows show a dash and
  // sort blanks-last (null) to match the cell — the #1284 invariant.
  role: (d) =>
    (d.deviceClass ?? "agent") === "network"
      ? null
      : getDeviceRoleLabel(d.deviceRole ?? "unknown"),
  isHeadless: (d) =>
    typeof d.isHeadless === "boolean" ? (d.isHeadless ? 1 : 0) : null,
  status: (d) => statusSortRank[d.status],
  // false/absent renders as a dash (see the cell), so it maps to null like
  // isHeadless — keeping the blanks-last invariant consistent for booleans.
  pendingReboot: (d) => (d.pendingReboot ? 1 : null),
  cpu: (d) => (d.status === "online" ? d.cpuPercent : null),
  ram: (d) => (d.status === "online" ? d.ramPercent : null),
  // Sort by charge for devices with a battery; no-battery/unknown rows sort as
  // blanks-last null to match the dash the cell renders (#1284 invariant).
  power: (d) =>
    d.batteryStatus?.present && typeof d.batteryStatus.percent === "number"
      ? d.batteryStatus.percent
      : null,
  cpuModel: (d) => d.hardware?.cpuModel || null,
  cores: (d) =>
    typeof d.hardware?.cpuCores === "number" ? d.hardware.cpuCores : null,
  ramTotal: (d) =>
    typeof d.hardware?.ramTotalMb === "number" ? d.hardware.ramTotalMb : null,
  diskTotal: (d) =>
    typeof d.hardware?.diskTotalGb === "number" ? d.hardware.diskTotalGb : null,
  lastSeen: (d) => new Date(d.lastSeen).getTime() || null,
  agentVersion: (d) => d.agentVersion || null,
  watchdogVersion: (d) => d.watchdogVersion?.trim() || null,
  serverUrl: (d) => serverHost(d.agentServerUrl),
  tags: (d) => (d.tags && d.tags.length > 0 ? d.tags.join(", ") : null),
  lastUser: (d) => d.lastUser || null,
  uptime: (d) =>
    d.status === "online" && d.uptimeSeconds != null ? d.uptimeSeconds : null,
  enrolled: (d) =>
    d.enrolledAt ? new Date(d.enrolledAt).getTime() || null : null,
  desktopAccess: (d) => d.desktopAccess?.mode || null,
  // No computed score yet (newly enrolled / pre-worker, or a network device)
  // sorts as a blank-last null to match the dash the cell renders (#1284).
  reliability: (d) =>
    typeof d.reliabilityScore === "number" ? d.reliabilityScore : null,
  // Sort by the first active VPN's provider label; devices with no active VPN
  // sort blanks-last (null) to match the dash the cell renders (#1284).
  vpn: (d) => {
    const active = activeVpnList(d.activeVpns);
    return active.length > 0 ? getVpnProviderLabel(active[0].provider) : null;
  },
};

export default function DeviceList({
  devices,
  groups = [],
  autoSelectGroupId,
  onAutoSelectConsumed,
  timezone,
  onSelect,
  onAction,
  onBulkAction,
  pageSize = 10,
  includeDecommissioned = false,
  onShowDecommissioned,
  serverFilterIds = null,
  serverFilterLoading = false,
  networkDevicesEnabled = false,
  listFilters,
}: DeviceListProps) {
  const { t } = useTranslation("devices");
  // Use provided timezone or browser default
  const effectiveTimezone =
    timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

  // The only inline (instant, client-side) filter is device search,
  // owned by DevicesPage and shared with DeviceFilterToolbar. Every other
  // structured filter (status/os/role/org/site/group/…) now lives in the
  // server-resolved group and arrives pre-resolved as `serverFilterIds`. When
  // rendered standalone (tests), fall back to the default so search is a no-op.
  const filters = listFilters ?? DEFAULT_LIST_FILTERS;
  const { search: query } = filters;
  // Unified-list class facet (#1322): All / Agent-managed / Network. Kept
  // local to DeviceList (it lives next to the count, not in the toolbar).
  const [classFilter, setClassFilter] = useState<"all" | "agent" | "network">(
    "all",
  );
  // Client-side VPN facet (#2139): 'all' | 'any' (any active VPN) | a provider
  // id. Operates on already-loaded cached inventory, mirroring the class facet
  // — no server round-trip, no live command fan-out.
  const [vpnFilter, setVpnFilter] = useState<"all" | "any" | string>("all");
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
  const [columnOrder, setColumnOrder] = useState<ColumnId[]>(() =>
    readColumnOrder(),
  );
  const [columnsMenuOpen, setColumnsMenuOpen] = useState(false);
  const columnsMenuRef = useRef<HTMLDivElement>(null);
  // Table density reflects the account-wide preference (breeze.density),
  // which is now set from the top-bar theme/display menu. Subscribe so the
  // table re-renders when it changes, without a reload.
  const [density, setDensity] = useState<Density>(() => readDensity());
  useEffect(() => subscribeDensity(setDensity), []);
  // Linked multi-boot profiles (#2138): per-user "Collapse linked inactive
  // profiles" presentation toggle, persisted via the appearance module
  // (localStorage — NOT a query param / URL hash). Default on.
  const [linkedCollapse, setLinkedCollapse] =
    useState<LinkedProfileCollapsePreference>(() =>
      readLinkedProfileCollapsePreference(),
    );
  useEffect(() => subscribeLinkedProfileCollapse(setLinkedCollapse), []);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // vm_host nesting (#2308): link-group ids whose guest rows are collapsed
  // beneath their host. Transient per-visit presentation state (default:
  // expanded, guests visible) — deliberately NOT persisted/hash-encoded.
  const [collapsedVmGroups, setCollapsedVmGroups] = useState<Set<string>>(new Set());
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
  const [rowMenuAnchor, setRowMenuAnchor] = useState<{
    top: number;
    bottom: number;
    right: number;
  } | null>(null);
  const rowMenuRef = useRef<HTMLDivElement>(null);
  const rowMenuButtonRef = useRef<HTMLButtonElement | null>(null);
  const [sortField, setSortField] = useState<SortField>(null);
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");

  // Close row action menu on outside click
  useEffect(() => {
    if (!rowMenuOpenId) return;
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      // The menu is portaled outside the trigger, so check both the menu and the button.
      if (
        rowMenuRef.current?.contains(target) ||
        rowMenuButtonRef.current?.contains(target)
      )
        return;
      setRowMenuOpenId(null);
    };
    // The menu is fixed-positioned from a captured anchor; scrolling would detach it, so close instead.
    const handleScroll = () => setRowMenuOpenId(null);
    document.addEventListener("mousedown", handleClickOutside);
    window.addEventListener("scroll", handleScroll, true);
    window.addEventListener("resize", handleScroll);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      window.removeEventListener("scroll", handleScroll, true);
      window.removeEventListener("resize", handleScroll);
    };
  }, [rowMenuOpenId]);

  // Close columns visibility menu on outside click
  useEffect(() => {
    if (!columnsMenuOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (
        columnsMenuRef.current &&
        !columnsMenuRef.current.contains(e.target as Node)
      ) {
        setColumnsMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [columnsMenuOpen]);

  // Hiding does not change columnOrder, so re-showing restores the slot.
  const toggleColumn = (id: ColumnId) => {
    setVisibleColumns((prev) => {
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
    setColumnOrder((prev) => {
      const visibleIds = prev.filter((c) => visibleColumns.has(c));
      const visibleIdx = visibleIds.indexOf(id);
      if (visibleIdx === -1) return prev;
      const targetVisibleIdx = visibleIdx + direction;
      if (targetVisibleIdx < 0 || targetVisibleIdx >= visibleIds.length)
        return prev;
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

  // Restores both visibility and order to the catalog defaults.
  const resetColumnsToDefault = () => {
    const cols = resetColumns();
    setColumnOrder(cols.map((c) => c.id));
    setVisibleColumns(new Set(cols.filter((c) => c.visible).map((c) => c.id)));
  };

  // Notify the parent that a freshly-created group has been handled. The group
  // filter itself now lives in the chip bar (server-resolved), so there is no
  // local group selection to toggle here — just consume the one-shot signal.
  useEffect(() => {
    if (autoSelectGroupId && groups.some((g) => g.id === autoSelectGroupId)) {
      onAutoSelectConsumed?.();
    }
  }, [autoSelectGroupId, groups, onAutoSelectConsumed]);

  // Reset to page 1 whenever the active filters change (device search, the
  // class facet, and the server-resolved id set are the only things that narrow
  // the list now). This replaces the per-control setCurrentPage(1) calls that
  // lived on each filter input before the toolbar was extracted.
  useEffect(() => {
    setCurrentPage(1);
  }, [query, classFilter, vpnFilter, serverFilterIds]);

  const filteredDevices = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    return devices.filter((device) => {
      // Hide decommissioned by default — preserves the old list's hygiene
      // (status='all' implicitly excluded them). Filtering FOR decommissioned
      // via a status chip flips includeDecommissioned true upstream.
      if (!includeDecommissioned && device.status === "decommissioned") {
        return false;
      }

      // Apply server-side advanced filter (status/os/role/org/site/group/… all
      // resolve through this id set now — they are no longer client-side).
      if (serverFilterIds !== null && !serverFilterIds.has(device.id)) {
        return false;
      }

      const deviceClass = device.deviceClass ?? "agent";
      const matchesClass =
        classFilter === "all" ? true : deviceClass === classFilter;

      // VPN facet (#2139): 'all' passes everything; 'any' requires ≥1 active
      // VPN; a provider id requires that provider to be active on the device.
      let matchesVpn = true;
      if (vpnFilter !== "all") {
        const active = activeVpnList(device.activeVpns);
        matchesVpn =
          vpnFilter === "any"
            ? active.length > 0
            : active.some((v) => v.provider === vpnFilter);
      }

      const matchesQuery =
        normalizedQuery.length === 0
          ? true
          : device.hostname.toLowerCase().includes(normalizedQuery) ||
            (device.displayName?.toLowerCase().includes(normalizedQuery) ??
              false);

      return matchesClass && matchesVpn && matchesQuery;
    });
  }, [
    devices,
    query,
    classFilter,
    vpnFilter,
    serverFilterIds,
    includeDecommissioned,
  ]);

  // How many decommissioned devices the default view is hiding (#2251). Zero
  // when they're already visible (includeDecommissioned) so the hint and the
  // count math below stay consistent with what the table actually shows.
  const hiddenDecommissionedCount = useMemo(
    () =>
      includeDecommissioned
        ? 0
        : devices.filter(d => d.status === 'decommissioned').length,
    [devices, includeDecommissioned]
  );

  // Providers present across the loaded set — drives the VPN facet options so
  // techs only see providers that actually exist in their fleet.
  const availableVpnProviders = useMemo(() => {
    const set = new Set<string>();
    for (const device of devices) {
      for (const vpn of activeVpnList(device.activeVpns)) set.add(vpn.provider);
    }
    return Array.from(set).sort((a, b) =>
      getVpnProviderLabel(a).localeCompare(getVpnProviderLabel(b)),
    );
  }, [devices]);

  // Reset a by-provider VPN filter back to 'all' if that provider drops out of
  // the loaded set (e.g. the device went offline) so the facet never gets stuck
  // on an option that matches nothing.
  useEffect(() => {
    if (
      vpnFilter !== "all" &&
      vpnFilter !== "any" &&
      !availableVpnProviders.includes(vpnFilter)
    ) {
      setVpnFilter("all");
    }
  }, [vpnFilter, availableVpnProviders]);

  const handleSort = (field: ColumnId) => {
    if (sortField === field) {
      setSortDirection((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDirection("asc");
    }
  };

  // Show the class facet only when the network arm is enabled AND a network
  // device is actually present, so agent-only fleets aren't cluttered with an
  // inert control. With the feature flag off this is always false.
  const hasNetworkDevices = useMemo(
    () =>
      networkDevicesEnabled &&
      devices.some((d) => (d.deviceClass ?? "agent") === "network"),
    [networkDevicesEnabled, devices],
  );

  const sortedDevices = useMemo(() => {
    // Default ordering for the merged list (#1424, deferred item 1). With no
    // column actively selected, agent rows arrive hostname-sorted from the
    // cursor API while network rows arrive last-seen-sorted from the offset
    // API, and DevicesPage concatenates them as `[...agents, ...network]`. The
    // raw concatenation therefore renders as two differently-ordered blocks —
    // the "merged list visibly alternates sort order" defect. Apply one unified
    // key across the whole union: the same `displayName || hostname` the Device
    // column sorts on, with `id` as a stable tiebreaker so client-side
    // pagination is deterministic (a row can't hop pages between renders).
    if (!sortField) {
      const byName = sortValue.hostname;
      // sortValue is typed `string | number | null`; a null/blank name must sort
      // blanks-last (like the column-sort branch below) rather than become the
      // string "null"/"" buried among real names. Two blanks tie and fall
      // through to the id tiebreaker so client-side pagination stays stable.
      const isBlank = (v: string | number | null) =>
        v == null || String(v).trim() === "";
      return [...filteredDevices].sort((a, b) => {
        const av = byName(a);
        const bv = byName(b);
        const aBlank = isBlank(av);
        const bBlank = isBlank(bv);
        const cmp =
          aBlank || bBlank
            ? aBlank === bBlank
              ? 0
              : aBlank
                ? 1
                : -1
            : nameCollator.compare(String(av), String(bv));
        return cmp !== 0 ? cmp : a.id.localeCompare(b.id);
      });
    }
    const value = sortValue[sortField];
    const dir = sortDirection === "desc" ? -1 : 1;

    return [...filteredDevices].sort((a, b) => {
      const av = value(a);
      const bv = value(b);
      // Dash cells sort last regardless of direction.
      if (av === null || bv === null)
        return av === bv ? 0 : av === null ? 1 : -1;
      const cmp =
        typeof av === "number" && typeof bv === "number"
          ? av - bv
          : nameCollator.compare(String(av), String(bv));
      return dir * cmp;
    });
  }, [filteredDevices, sortField, sortDirection]);

  const totalPages = Math.ceil(sortedDevices.length / effectivePageSize);

  // Adjust currentPage during render when filters/search shrink the result
  // set below it. Setting state during render is React's documented way to
  // correct derived state without a flash of stale UI — React discards the
  // in-progress render and re-runs with the corrected value.
  if (totalPages > 0 && currentPage > totalPages) {
    setCurrentPage(1);
  }

  const startIndex = (currentPage - 1) * effectivePageSize;
  const paginatedDevices = sortedDevices.slice(
    startIndex,
    startIndex + effectivePageSize,
  );

  // Linked-device presentation, computed client-side WITHIN the current page.
  // Multiboot (#2138): exactly one online member → offline siblings render as
  // thin strips beneath it; all offline → full rows with a left-edge group
  // bar; 2+ online → all normal rows. The collapse toggle gates ONLY these
  // multiboot heuristics (off → flat multiboot rows). vm_host nesting (#2308)
  // is hierarchical organization, not offline-noise suppression, so guests
  // nest under their host regardless of the toggle.
  const displayRows = useMemo(
    () => groupLinkedDevices(paginatedDevices, linkedCollapse === "on"),
    [paginatedDevices, linkedCollapse],
  );
  // vm_host nesting (#2308): drop guest rows whose group is collapsed. The
  // host row renders a "N guests hidden" strip in their place.
  const visibleRows = useMemo(
    () => displayRows.filter(r => !(r.vmRole === 'guest' && r.vmGroupId && collapsedVmGroups.has(r.vmGroupId))),
    [displayRows, collapsedVmGroups]
  );
  // Strips are NOT selectable rows — bulk selection only sees real full rows.
  // Collapsed (hidden) vm_host guests are likewise excluded: select-all must
  // never silently pick up rows the user cannot see.
  const selectablePageDevices = useMemo(
    () => visibleRows.map((r) => r.device),
    [visibleRows],
  );
  // Only offer the collapse toggle when the fleet actually has MULTIBOOT
  // linked profiles — it doesn't govern vm_host nesting (#2308), so a fleet
  // with only vm_host groups gets no dead toggle.
  const hasLinkedDevices = useMemo(
    () => devices.some((d) => d.linkGroupId && !d.linkGroupRole),
    [devices],
  );

  const handlePageSizeChange = (newSize: number) => {
    setEffectivePageSize(newSize);
    writePageSizePreference(newSize);
    // Reset to page 1 so the user doesn't land out-of-range when shrinking
    // the page (and gets a coherent first-page view when growing it).
    setCurrentPage(1);
  };

  const handleSelectAll = (checked: boolean) => {
    if (checked) {
      setSelectedIds(new Set(selectablePageDevices.map((d) => d.id)));
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
    const selectedDevices = devices.filter((d) => selectedIds.has(d.id));
    onBulkAction?.(action, selectedDevices);
    setBulkMenuOpen(false);
    setSelectedIds(new Set());
  };

  const allSelected =
    selectablePageDevices.length > 0 &&
    selectablePageDevices.every((d) => selectedIds.has(d.id));
  const someSelected = selectablePageDevices.some((d) => selectedIds.has(d.id));

  // Fleet (All-organizations) view: only then does the Organization column
  // carry information — in single-org scope it would repeat the header's org
  // on every row, so it disappears from the table and the column picker.
  const isFleetView = useOrgStore((s) => !s.currentOrgId && s.allOrgs);

  // The Class/Type columns belong to the network arm (#1322); hide them
  // entirely when the feature flag is off so the list is the agent-only view.
  const isColumnAvailable = (id: ColumnId) =>
    (networkDevicesEnabled || !NETWORK_ONLY_COLUMNS.has(id)) &&
    (id !== "organization" || isFleetView);

  // Effective render sequence: user-chosen order, filtered to visible.
  // Checkbox and Actions are rendered separately as the first/last cells.
  const renderedColumns = columnOrder.filter(
    (id) => visibleColumns.has(id) && isColumnAvailable(id),
  );

  // sortHeader factors out the repeated header pattern for sortable
  // columns to keep the column-defs table below readable. The column id
  // doubles as the sort key.
  const sortHeader = (
    id: ColumnId,
    label: string,
    hint: string,
    alignRight = false,
  ) => (
    <th
      key={id}
      className={`px-3 py-3 cursor-pointer select-none hover:text-foreground${alignRight ? " text-right" : ""}`}
      title={hint}
      aria-sort={
        sortField === id
          ? sortDirection === "asc"
            ? "ascending"
            : "descending"
          : "none"
      }
      onClick={() => handleSort(id)}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {sortField === id ? (
          sortDirection === "asc" ? (
            <ChevronUp className="h-3 w-3" />
          ) : (
            <ChevronDown className="h-3 w-3" />
          )
        ) : (
          <ArrowUpDown className="h-3 w-3 opacity-30" />
        )}
      </span>
    </th>
  );

  // metricBar renders the CPU/RAM percent bar with em-dash fallback for
  // non-online devices. Extracted so the cpu and ram column cells stay small.
  //
  // Color intent: green/red are reserved for *device status* (the Up/Down
  // pills), so a calm brand fill carries normal utilization here — a 45%-RAM
  // bar shouldn't read as "healthy green" and visually rhyme with an Up pill.
  // We still escalate amber → red at genuine pressure (≥75% / ≥90%) because a
  // pegged box is exactly what a tech must catch at a glance; the bar width
  // and the trailing number carry the exact value at every level.
  const metricBar = (percent: number, online: boolean) =>
    online ? (
      <div className="flex items-center gap-2">
        <div className="h-2 w-16 overflow-hidden rounded-full bg-muted">
          <div
            className={`h-full rounded-full ${percent >= 90 ? "bg-destructive" : percent >= 75 ? "bg-warning" : "bg-primary/70"} ${widthPercentClass(percent)}`}
          />
        </div>
        <span className="w-10 text-right tabular-nums">{percent}%</span>
      </div>
    ) : (
      <span className="text-muted-foreground">{t("deviceList.text")}</span>
    );

  // Format helpers for hardware columns. RAM is reported in MB; convert
  // to GB rounded to one decimal. Disk is already reported in GB.
  const fmtRamGb = (mb: number | undefined) =>
    typeof mb === "number"
      ? `${formatNumber(mb / 1024, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} GB`
      : null;
  const fmtDiskGb = (gb: number | undefined) =>
    typeof gb === "number" ? `${gb} GB` : null;
  const fmtDate = (iso: string | undefined) => {
    if (!iso) return null;
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
  };
  const fmtWatchdogVersion = (raw: string | null | undefined) => {
    const version = raw?.trim();
    return version ? version : t("deviceList.nA");
  };

  // Reliability score band → badge classes. Thresholds mirror
  // DeviceReliabilityPanel.tsx (scoreClass): ≤50 critical, ≤70 warning,
  // ≤85 info, else healthy — keep the two in sync so the list badge and the
  // drill-down panel tell the same story (#1720).
  const reliabilityBandClass = (score: number): string => {
    if (score <= 50)
      return "bg-destructive/15 text-destructive border-destructive/30";
    if (score <= 70) return "bg-warning/15 text-warning border-warning/30";
    if (score <= 85) return "bg-info/15 text-info border-info/30";
    return "bg-success/15 text-success border-success/30";
  };
  const reliabilityTrendGlyph: Record<
    NonNullable<Device["reliabilityTrend"]>,
    { glyph: string; label: string }
  > = {
    improving: { glyph: "↑", label: t("deviceList.improving") },
    stable: { glyph: "→", label: t("deviceList.stable") },
    degrading: { glyph: "↓", label: t("deviceList.degrading") },
  };

  // Power/battery cell helpers (#2142).
  const fmtBatteryDuration = (minutes: number): string => {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
    return `${m}m`;
  };
  const batteryStateLabel: Record<
    NonNullable<BatteryStatus["chargingState"]>,
    string
  > = {
    charging: "Charging",
    discharging: "On battery",
    full: "Full",
    not_charging: "Not charging",
    unknown: "Unknown",
  };
  const formatBatteryTooltip = (b: BatteryStatus): string => {
    const parts: string[] = [];
    if (typeof b.percent === "number") parts.push(`${Math.round(b.percent)}%`);
    if (b.chargingState)
      parts.push(batteryStateLabel[b.chargingState] ?? b.chargingState);
    if (b.pluggedIn !== undefined)
      parts.push(
        b.pluggedIn
          ? t("deviceList.pluggedInAc")
          : t("deviceList.onBatteryPower"),
      );
    if (typeof b.timeRemainingMinutes === "number")
      parts.push(`~${fmtBatteryDuration(b.timeRemainingMinutes)} remaining`);
    if (typeof b.timeToFullMinutes === "number")
      parts.push(`~${fmtBatteryDuration(b.timeToFullMinutes)} to full`);
    if (b.reportedAt)
      parts.push(`reported ${formatLastSeen(b.reportedAt, effectiveTimezone)}`);
    return parts.join(" • ");
  };

  // columnDefs is the single source of truth for each toggleable column's
  // header and per-row cell. The thead and tbody iterate `renderedColumns`
  // and pick from this table, so adding a new column means adding one
  // entry here plus the corresponding id to COLUMN_IDS / COLUMN_LABELS.
  const dash = (
    <span className="text-muted-foreground">{t("deviceList.text")}</span>
  );
  // Agent-only columns render "—" for network devices (#1322): the
  // attribute doesn't exist for a printer/router, so don't imply 0/blank.
  const agentCell = (device: Device, node: React.ReactNode): React.ReactNode =>
    (device.deviceClass ?? "agent") === "network" ? dash : node;
  const columnDefs: Record<
    ColumnId,
    { header: () => React.ReactNode; cell: (device: Device) => React.ReactNode }
  > = {
    hostname: {
      header: () => sortHeader("hostname", t("deviceList.tableColumns.device"), t("deviceList.sortBy.device")),
      cell: (device) => {
        const hasDisplayName =
          !!device.displayName && device.displayName !== device.hostname;
        const primaryName = device.displayName || device.hostname;
        return (
          <td key="hostname" className="max-w-[220px] px-3 py-3 text-sm">
            <div className="min-w-0">
              <span className="block truncate font-medium" title={primaryName}>
                {primaryName}
              </span>
              {hasDisplayName && (
                <span
                  className="block truncate text-xs text-muted-foreground"
                  title={device.hostname}
                >
                  {device.hostname}
                </span>
              )}
            </div>
          </td>
        );
      },
    },
    class: {
      header: () => sortHeader("class", "Class", "Sort by class"),
      cell: (device) => {
        const deviceClass = device.deviceClass ?? "agent";
        const isNetwork = deviceClass === "network";
        return (
          <td key="class" className="px-3 py-3 text-sm">
            <span
              data-testid={`device-${device.id}-class-badge`}
              title={
                isNetwork
                  ? t("deviceList.networkDiscoveredDevice")
                  : t("deviceList.agentManagedEndpoint")
              }
              className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium ${
                isNetwork
                  ? "bg-info/15 text-info border-info/30"
                  : "bg-primary/10 text-primary border-primary/30"
              }`}
            >
              {isNetwork ? (
                <Network className="h-3 w-3" />
              ) : (
                <Cpu className="h-3 w-3" />
              )}
              {isNetwork ? t("deviceList.network") : t("deviceList.agent")}
            </span>
          </td>
        );
      },
    },
    type: {
      header: () => sortHeader("type", "Type", "Sort by type"),
      cell: (device) => {
        // Type is the asset_type of a *network-discovered* device (printer,
        // switch, NAS…). For agent rows the equivalent question — what kind of
        // endpoint is this — is answered by the Role column, so Type renders a
        // dash rather than echoing deviceRole and duplicating Role side by
        // side (#1386). Role and Type are complementary axes, one per class.
        if ((device.deviceClass ?? "agent") !== "network") {
          return (
            <td key="type" className="px-3 py-3 text-sm whitespace-nowrap">
              {dash}
            </td>
          );
        }
        const typeValue = device.assetType ?? "unknown";
        const TypeIcon = getDeviceRoleIcon(typeValue);
        const typeLabel = getDeviceRoleLabel(typeValue);
        return (
          <td
            key="type"
            className="px-3 py-3 text-sm whitespace-nowrap"
            data-testid={`device-${device.id}-type`}
          >
            <span
              className="inline-flex items-center gap-1.5 text-muted-foreground"
              title={typeLabel}
            >
              <TypeIcon className="h-3.5 w-3.5" />
              <span className="truncate">{typeLabel}</span>
            </span>
          </td>
        );
      },
    },
    organization: {
      header: () =>
        sortHeader("organization", t("deviceList.tableColumns.organization"), t("deviceList.sortBy.organization")),
      cell: (device) => (
        <td
          key="organization"
          className="max-w-[160px] px-3 py-3 text-sm text-muted-foreground"
        >
          <span className="block truncate" title={device.orgName}>
            {device.orgName}
          </span>
        </td>
      ),
    },
    site: {
      header: () => sortHeader("site", t("deviceList.tableColumns.site"), t("deviceList.sortBy.site")),
      cell: (device) => (
        <td
          key="site"
          className="max-w-[160px] px-3 py-3 text-sm text-muted-foreground"
        >
          <span className="block truncate" title={device.siteName}>
            {device.siteName}
          </span>
        </td>
      ),
    },
    os: {
      header: () => sortHeader("os", t("deviceList.tableColumns.os"), t("deviceList.sortBy.os")),
      cell: (device) => (
        <td key="os" className="px-3 py-3 text-sm">
          {agentCell(
            device,
            <OSIcon os={device.os} className="h-4 w-4 text-muted-foreground" />,
          )}
        </td>
      ),
    },
    osVersion: {
      header: () => sortHeader("osVersion", "OS Version", "Sort by OS version"),
      cell: (device) => (
        <td
          key="osVersion"
          className="px-3 py-3 text-sm text-muted-foreground whitespace-nowrap"
        >
          {formatDeviceOsVersion(device.os, device.osVersion) || dash}
        </td>
      ),
    },
    osBuild: {
      header: () => sortHeader("osBuild", "OS Build", "Sort by OS build"),
      cell: (device) => (
        <td
          key="osBuild"
          className="px-3 py-3 text-sm text-muted-foreground whitespace-nowrap"
        >
          {device.osBuild || dash}
        </td>
      ),
    },
    architecture: {
      header: () => sortHeader("architecture", "Arch", "Sort by architecture"),
      cell: (device) => (
        <td
          key="architecture"
          className="px-3 py-3 text-sm text-muted-foreground"
        >
          {device.architecture || dash}
        </td>
      ),
    },
    role: {
      header: () => sortHeader("role", t("deviceList.tableColumns.role"), t("deviceList.sortBy.role")),
      cell: (device) => {
        // Role is the function of an *agent-managed* endpoint and drives
        // config-policy targeting; it's meaningless for a network-discovered
        // asset (a printer has no agent role), so network rows render a dash —
        // the inverse of the Type column above (#1386, #1322 dash convention).
        const role = device.deviceRole ?? "unknown";
        const RoleIcon = getDeviceRoleIcon(role);
        const roleLabel = t(/* i18n-dynamic */ `deviceList.roles.${role}`, {
          defaultValue: getDeviceRoleLabel(role),
        });
        return (
          <td
            key="role"
            className="px-3 py-3 text-sm"
            data-testid={`device-${device.id}-role`}
          >
            {agentCell(
              device,
              <span
                className="inline-flex items-center justify-center rounded-full border bg-muted/50 p-1.5"
                title={roleLabel}
                aria-label={roleLabel}
              >
                <RoleIcon className="h-3.5 w-3.5" />
              </span>,
            )}
          </td>
        );
      },
    },
    isHeadless: {
      header: () =>
        sortHeader("isHeadless", "Headless", "Sort by headless flag"),
      cell: (device) => (
        <td
          key="isHeadless"
          className="px-3 py-3 text-sm text-muted-foreground"
        >
          {typeof device.isHeadless === "boolean"
            ? device.isHeadless
              ? t("deviceList.yes")
              : t("deviceList.no")
            : dash}
        </td>
      ),
    },
    status: {
      header: () => sortHeader("status", t("deviceList.tableColumns.status"), t("deviceList.sortBy.status")),
      cell: (device) => (
        <td key="status" className="px-3 py-3 text-sm">
          <div className="flex items-center gap-1">
            <span
              className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${statusColors[device.status]}`}
              title={t(/* i18n-dynamic */ statusFullLabelKeys[device.status])}
            >
              {t(/* i18n-dynamic */ statusLabelKeys[device.status])}
            </span>
            {shouldShowAgentSilentBadge(device) && (
              <span
                data-testid={`device-${device.id}-agent-silent-badge`}
                title={`Main agent has been silent for ${formatSilentDuration(device.mainAgentSilentSince!)}. Watchdog is still reporting in, so the box is alive but the agent has wedged.`}
                className="inline-flex items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-[10px] font-medium bg-warning/15 text-warning border-warning/30"
              >
                {t("deviceList.agentSilent")}{" "}
                {formatSilentDuration(device.mainAgentSilentSince!)}
              </span>
            )}
            {/* Pending-reboot is only actionable while the box is reachable. On an
                offline device the flag is stale and unactionable, so suppress the
                dot rather than wrap it under the wider "Down" pill. */}
            {device.pendingReboot && device.status !== "offline" && (
              <span
                data-testid={`device-${device.id}-pending-reboot-badge`}
                title={t("deviceList.theOsReportsAPendingReboot")}
                aria-label={t("deviceList.rebootPending")}
                role="img"
                className="inline-block h-2 w-2 shrink-0 rounded-full bg-warning"
              />
            )}
          </div>
        </td>
      ),
    },
    pendingReboot: {
      header: () =>
        sortHeader("pendingReboot", "Pending Reboot", "Sort by pending reboot"),
      cell: (device) => (
        <td key="pendingReboot" className="px-3 py-3 text-sm whitespace-nowrap">
          {device.pendingReboot ? (
            <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium bg-warning/15 text-warning border-warning/30">
              {t("deviceList.rebootPending")}{" "}
            </span>
          ) : (
            dash
          )}
        </td>
      ),
    },
    cpu: {
      header: () => sortHeader("cpu", t("deviceList.tableColumns.cpu"), t("deviceList.sortBy.cpu")),
      cell: (device) => (
        <td key="cpu" className="px-3 py-3 text-sm">
          {agentCell(
            device,
            metricBar(device.cpuPercent, device.status === "online"),
          )}
        </td>
      ),
    },
    ram: {
      header: () => sortHeader("ram", t("deviceList.tableColumns.ram"), t("deviceList.sortBy.ram")),
      cell: (device) => (
        <td key="ram" className="px-3 py-3 text-sm">
          {agentCell(
            device,
            metricBar(device.ramPercent, device.status === "online"),
          )}
        </td>
      ),
    },
    power: {
      header: () => sortHeader("power", "Power", "Sort by battery charge"),
      cell: (device) => {
        const b = device.batteryStatus;
        // No battery data, or a real no-battery desktop → dash.
        if (!b || !b.present) {
          return (
            <td
              key="power"
              className="px-3 py-3 text-sm"
              data-testid={`device-${device.id}-power`}
            >
              {agentCell(device, dash)}
            </td>
          );
        }
        const pct =
          typeof b.percent === "number" ? Math.round(b.percent) : null;
        const charging = b.chargingState === "charging";
        // "Low" only when actually running the battery down — plugged-in or
        // charging at a low charge isn't an alert state.
        const low =
          pct !== null &&
          pct <= 20 &&
          b.pluggedIn !== true &&
          !charging &&
          b.chargingState !== "full";
        const Icon = charging
          ? BatteryCharging
          : b.pluggedIn
            ? Plug
            : low
              ? BatteryWarning
              : Battery;
        const colorClass = low
          ? "text-destructive"
          : charging
            ? "text-success"
            : "text-muted-foreground";
        return (
          <td
            key="power"
            className="px-3 py-3 text-sm whitespace-nowrap"
            title={formatBatteryTooltip(b)}
            data-testid={`device-${device.id}-power`}
          >
            <span className="inline-flex items-center gap-1.5">
              <Icon
                className={`h-4 w-4 shrink-0 ${colorClass}`}
                aria-hidden="true"
              />
              <span
                className={
                  low
                    ? "font-medium text-destructive tabular-nums"
                    : "tabular-nums"
                }
              >
                {pct !== null
                  ? `${pct}%`
                  : batteryStateLabel[b.chargingState ?? "unknown"]}
              </span>
            </span>
          </td>
        );
      },
    },
    cpuModel: {
      header: () => sortHeader("cpuModel", "CPU Model", "Sort by CPU model"),
      cell: (device) => (
        <td
          key="cpuModel"
          className="max-w-[220px] px-3 py-3 text-sm text-muted-foreground"
        >
          <span
            className="block truncate"
            title={device.hardware?.cpuModel ?? ""}
          >
            {device.hardware?.cpuModel || dash}
          </span>
        </td>
      ),
    },
    cores: {
      header: () => sortHeader("cores", "Cores", "Sort by core count", true),
      cell: (device) => (
        <td key="cores" className="px-3 py-3 text-right text-sm tabular-nums">
          {typeof device.hardware?.cpuCores === "number"
            ? device.hardware.cpuCores
            : dash}
        </td>
      ),
    },
    ramTotal: {
      header: () => sortHeader("ramTotal", "RAM", "Sort by total RAM", true),
      cell: (device) => (
        <td
          key="ramTotal"
          className="px-3 py-3 text-right text-sm tabular-nums"
        >
          {fmtRamGb(device.hardware?.ramTotalMb) ?? dash}
        </td>
      ),
    },
    diskTotal: {
      header: () => sortHeader("diskTotal", "Disk", "Sort by total disk", true),
      cell: (device) => (
        <td
          key="diskTotal"
          className="px-3 py-3 text-right text-sm tabular-nums"
        >
          {fmtDiskGb(device.hardware?.diskTotalGb) ?? dash}
        </td>
      ),
    },
    lastSeen: {
      header: () =>
        sortHeader("lastSeen", t("deviceList.tableColumns.lastSeen"), t("deviceList.sortBy.lastSeen")),
      cell: (device) => (
        <td
          key="lastSeen"
          className="px-3 py-3 text-sm text-muted-foreground whitespace-nowrap"
        >
          {formatLastSeen(device.lastSeen, effectiveTimezone)}
        </td>
      ),
    },
    agentVersion: {
      header: () =>
        sortHeader("agentVersion", "Agent Version", "Sort by agent version"),
      cell: (device) => (
        <td
          key="agentVersion"
          className="px-3 py-3 text-sm text-muted-foreground whitespace-nowrap"
        >
          {device.agentVersion || dash}
        </td>
      ),
    },
    watchdogVersion: {
      header: () =>
        sortHeader(
          "watchdogVersion",
          "Watchdog Version",
          "Sort by watchdog version",
        ),
      cell: (device) => (
        <td
          key="watchdogVersion"
          className="px-3 py-3 text-sm text-muted-foreground whitespace-nowrap"
        >
          {agentCell(device, fmtWatchdogVersion(device.watchdogVersion))}
        </td>
      ),
    },
    serverUrl: {
      header: () =>
        sortHeader(
          "serverUrl",
          t("deviceList.roles.server"),
          t("deviceList.sortBy.device"),
        ),
      cell: (device) => (
        <td
          key="serverUrl"
          className="px-3 py-3 text-sm text-muted-foreground whitespace-nowrap"
          title={device.agentServerUrl ?? undefined}
          data-testid={`device-${device.id}-server-url`}
        >
          {serverHost(device.agentServerUrl) || dash}
        </td>
      ),
    },
    tags: {
      header: () => sortHeader("tags", "Tags", "Sort by tags"),
      cell: (device) => (
        <td
          key="tags"
          className="max-w-[220px] px-3 py-3 text-sm text-muted-foreground"
        >
          {device.tags && device.tags.length > 0 ? (
            <div
              className="flex flex-wrap items-center gap-1"
              title={device.tags.join(", ")}
            >
              {device.tags.slice(0, TAG_CHIP_CAP).map((tag) => (
                <span
                  key={tag}
                  className="inline-flex items-center rounded-full border border-border bg-muted/50 px-2 py-0.5 text-xs font-medium text-foreground"
                >
                  {tag}
                </span>
              ))}
              {device.tags.length > TAG_CHIP_CAP && (
                <span className="inline-flex items-center rounded-full border border-border px-2 py-0.5 text-xs font-medium text-muted-foreground">
                  {t("deviceList.text2")}
                  {device.tags.length - TAG_CHIP_CAP}
                </span>
              )}
            </div>
          ) : (
            dash
          )}
        </td>
      ),
    },
    lastUser: {
      header: () => sortHeader("lastUser", "Last User", "Sort by last user"),
      cell: (device) => (
        <td
          key="lastUser"
          className="max-w-[160px] px-3 py-3 text-sm text-muted-foreground"
        >
          <span className="block truncate" title={device.lastUser ?? ""}>
            {device.lastUser || dash}
          </span>
        </td>
      ),
    },
    uptime: {
      header: () => sortHeader("uptime", "Uptime", "Sort by uptime"),
      cell: (device) => (
        <td
          key="uptime"
          className="px-3 py-3 text-sm text-muted-foreground whitespace-nowrap"
        >
          {device.status === "online" && device.uptimeSeconds != null
            ? formatUptime(device.uptimeSeconds)
            : dash}
        </td>
      ),
    },
    enrolled: {
      header: () =>
        sortHeader("enrolled", "Enrolled", "Sort by enrollment date"),
      cell: (device) => (
        <td
          key="enrolled"
          className="px-3 py-3 text-sm text-muted-foreground whitespace-nowrap"
        >
          {fmtDate(device.enrolledAt) ?? dash}
        </td>
      ),
    },
    desktopAccess: {
      header: () =>
        sortHeader("desktopAccess", "Desktop Access", "Sort by desktop access"),
      cell: (device) => {
        const da = device.desktopAccess;
        if (!da)
          return (
            <td
              key="desktopAccess"
              className="px-3 py-3 text-sm text-muted-foreground"
            >
              {dash}
            </td>
          );
        return (
          <td
            key="desktopAccess"
            className="px-3 py-3 text-sm text-muted-foreground"
          >
            <span
              className="inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium"
              title={`mode=${da.mode}; loginUi=${da.loginUiReachable}; virtualDisplay=${da.virtualDisplayReady}`}
            >
              {da.mode}
            </span>
          </td>
        );
      },
    },
    reliability: {
      header: () =>
        sortHeader(
          "reliability",
          "Reliability",
          "Sort by reliability score",
          true,
        ),
      cell: (device) => {
        const score = device.reliabilityScore;
        if (typeof score !== "number") {
          // No score computed yet (newly enrolled, pre-worker) or a network
          // device — render a dash; sortValue maps these to null so they sort
          // last in both directions (#1284 dash convention).
          return (
            <td
              key="reliability"
              className="px-3 py-3 text-right text-sm tabular-nums"
              data-testid={`device-${device.id}-reliability`}
            >
              {dash}
            </td>
          );
        }
        const trend = device.reliabilityTrend
          ? reliabilityTrendGlyph[device.reliabilityTrend]
          : null;
        return (
          <td
            key="reliability"
            className="px-3 py-3 text-right text-sm"
            data-testid={`device-${device.id}-reliability`}
          >
            <span
              className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium tabular-nums ${reliabilityBandClass(score)}`}
              title={
                trend
                  ? `Reliability ${score}/100 · ${trend.label}`
                  : `Reliability ${score}/100`
              }
            >
              {score}
              {trend && (
                <span aria-label={trend.label} className="opacity-80">
                  {trend.glyph}
                </span>
              )}
            </span>
          </td>
        );
      },
    },
    vpn: {
      header: () => sortHeader("vpn", "VPN", "Sort by VPN provider"),
      cell: (device) => {
        // Rendered ONLY from cached inventory (device.activeVpns) — never a
        // live command fan-out from the table (#2139).
        const active = activeVpnList(device.activeVpns);
        if (active.length === 0) {
          return (
            <td
              key="vpn"
              className="px-3 py-3 text-sm text-muted-foreground"
              data-testid={`device-${device.id}-vpn`}
            >
              {dash}
            </td>
          );
        }
        const VPN_CHIP_CAP = 2;
        const shown = active.slice(0, VPN_CHIP_CAP);
        const overflow = active.length - shown.length;
        // Full list on the cell title so hover reveals every provider/IP/DNS.
        const fullTitle = active.map(formatVpnTooltip).join("\n");
        return (
          <td
            key="vpn"
            className="px-3 py-3 text-sm whitespace-nowrap"
            data-testid={`device-${device.id}-vpn`}
          >
            <span className="inline-flex items-center gap-1" title={fullTitle}>
              {shown.map((vpn) => {
                const Icon = getVpnProviderIcon(vpn.provider);
                return (
                  <span
                    key={`${vpn.provider}:${vpn.interfaceName}`}
                    className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${getVpnProviderBadgeClass(vpn.provider)}`}
                    title={formatVpnTooltip(vpn)}
                    data-testid={`device-${device.id}-vpn-badge-${vpn.provider}`}
                  >
                    <Icon className="h-3 w-3 shrink-0" aria-hidden="true" />
                    {getVpnProviderLabel(vpn.provider)}
                  </span>
                );
              })}
              {overflow > 0 && (
                <span
                  className="inline-flex items-center rounded-full border border-muted px-1.5 py-0.5 text-xs font-medium text-muted-foreground"
                  data-testid={`device-${device.id}-vpn-overflow`}
                >
                  {t("deviceList.text2")}
                  {overflow}
                </span>
              )}
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
            {filteredDevices.length} {t("deviceList.of")}{" "}
            {devices.length - hiddenDecommissionedCount}{" "}
            {t("deviceList.devices")}{" "}
            {serverFilterIds !== null && (
              <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                <Filter className="h-3 w-3" />
                {t("deviceList.advancedFilterActive")}{" "}
                {serverFilterLoading && (
                  <span className="ml-1 animate-pulse">...</span>
                )}
              </span>
            )}
            {onShowDecommissioned && hiddenDecommissionedCount > 0 && (
              <span className="ml-2">
                <DecommissionedHiddenHint
                  count={hiddenDecommissionedCount}
                  onShow={onShowDecommissioned}
                />
              </span>
            )}
          </p>
          {/* Search / Status / OS / quick chips / More / Advanced now live in
              DeviceFilterToolbar (rendered by DevicesPage). DeviceList keeps
              only the class facet and the Columns menu next to the count. */}
          <div className="flex flex-wrap items-center gap-2">
            {hasNetworkDevices && (
              <div
                role="group"
                aria-label={t("deviceList.filterByDeviceClass")}
                className="inline-flex h-10 items-center rounded-md border bg-background p-0.5 text-sm"
              >
                {(
                  [
                    ["all", "All"],
                    ["agent", "Agent"],
                    ["network", "Network"],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    data-testid={`device-class-filter-${value}`}
                    aria-pressed={classFilter === value}
                    onClick={() => setClassFilter(value)}
                    className={`h-full rounded px-3 font-medium transition ${
                      classFilter === value
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:bg-muted"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
            {visibleColumns.has("vpn") && (
              <select
                aria-label={t("deviceList.filterByVpn")}
                data-testid="device-vpn-filter"
                value={vpnFilter}
                onChange={(e) => setVpnFilter(e.target.value)}
                className="h-10 rounded-md border bg-background px-2 text-sm text-muted-foreground"
              >
                <option value="all">{t("deviceList.allVpn")}</option>
                <option value="any">{t("deviceList.anyActiveVpn")}</option>
                {availableVpnProviders.map((provider) => (
                  <option key={provider} value={provider}>
                    {getVpnProviderLabel(provider)}
                  </option>
                ))}
              </select>
            )}
            {hasLinkedDevices && (
              <button
                type="button"
                data-testid="collapse-linked-toggle"
                aria-pressed={linkedCollapse === "on"}
                onClick={() =>
                  writeLinkedProfileCollapsePreference(
                    linkedCollapse === "on" ? "off" : "on",
                  )
                }
                title={t("deviceList.multiBootMachinesTuckExpectedOffline")}
                className={`flex h-10 items-center gap-1.5 whitespace-nowrap rounded-md border px-3 text-sm font-medium ${
                  linkedCollapse === "on"
                    ? "border-primary/40 bg-primary/10 text-primary"
                    : "text-muted-foreground hover:bg-muted"
                }`}
              >
                <Link2 className="h-3.5 w-3.5" />
                {t("deviceList.collapseLinkedInactiveProfiles")}{" "}
              </button>
            )}
            {/* Interface density is now an account-wide control in the
                top-bar theme/display menu (Header.tsx). The table still
                reflects the saved preference via densityTableClasses +
                subscribeDensity below. */}
            <div className="relative" ref={columnsMenuRef}>
              <button
                type="button"
                onClick={() => setColumnsMenuOpen((o) => !o)}
                aria-haspopup="true"
                aria-expanded={columnsMenuOpen}
                className="h-10 whitespace-nowrap rounded-md border px-3 text-sm font-medium hover:bg-muted flex items-center gap-1.5"
              >
                <Columns3 className="h-3.5 w-3.5" />
                {t("deviceList.columns")}{" "}
              </button>
              {columnsMenuOpen && (
                <div
                  role="menu"
                  className="absolute right-0 z-20 mt-1 max-h-96 w-72 overflow-y-auto rounded-md border bg-card p-1 shadow-md"
                >
                  <p className="px-2 pt-1 pb-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    {t("deviceList.visibleInOrder")}{" "}
                  </p>
                  {columnOrder
                    .filter(
                      (id) => visibleColumns.has(id) && isColumnAvailable(id),
                    )
                    .map((id, idx, arr) => (
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
                        <span className="flex-1 cursor-default">
                          {COLUMN_LABELS[id]}
                        </span>
                        <button
                          type="button"
                          disabled={idx === 0}
                          onClick={() => moveColumn(id, -1)}
                          className="rounded p-0.5 hover:bg-background disabled:cursor-not-allowed disabled:opacity-30"
                          aria-label={`Move ${COLUMN_LABELS[id]} up`}
                          title={t("deviceList.moveUp")}
                        >
                          <ChevronUp className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          disabled={idx === arr.length - 1}
                          onClick={() => moveColumn(id, 1)}
                          className="rounded p-0.5 hover:bg-background disabled:cursor-not-allowed disabled:opacity-30"
                          aria-label={`Move ${COLUMN_LABELS[id]} down`}
                          title={t("deviceList.moveDown")}
                        >
                          <ChevronDown className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ))}
                  <hr className="my-1" />
                  <p className="px-2 pt-0.5 pb-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    {t("deviceList.hidden")}{" "}
                  </p>
                  {columnOrder
                    .filter(
                      (id) => !visibleColumns.has(id) && isColumnAvailable(id),
                    )
                    .map((id) => (
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
                  <hr className="my-1" />
                  <button
                    type="button"
                    onClick={resetColumnsToDefault}
                    className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    {t("deviceList.resetToDefaults")}{" "}
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {selectedIds.size > 0 && (
        <div className="mt-4 flex items-center gap-3 rounded-md border bg-muted/40 px-4 py-2">
          <span className="text-sm font-medium">
            {selectedIds.size} {t("deviceList.selected")}
          </span>
          <div className="relative">
            <button
              type="button"
              onClick={() => setBulkMenuOpen(!bulkMenuOpen)}
              className="flex items-center gap-1 rounded-md border bg-background px-3 py-1.5 text-sm font-medium hover:bg-muted"
            >
              {t("deviceList.bulkActions")}{" "}
              <MoreHorizontal className="h-4 w-4" />
            </button>
            {bulkMenuOpen && (
              <div
                data-testid="bulk-actions-menu"
                className="absolute left-0 top-full z-10 mt-1 w-48 rounded-md border bg-card shadow-lg"
              >
                <button
                  type="button"
                  onClick={() => handleBulkAction("reboot")}
                  className="w-full px-4 py-2 text-left text-sm hover:bg-muted"
                >
                  {t("deviceList.rebootSelected")}{" "}
                </button>
                <button
                  type="button"
                  onClick={() => handleBulkAction("run-script")}
                  className="w-full px-4 py-2 text-left text-sm hover:bg-muted"
                >
                  {t("deviceList.runScript")}{" "}
                </button>
                <button
                  type="button"
                  onClick={() => handleBulkAction("deploy-software")}
                  className="w-full px-4 py-2 text-left text-sm hover:bg-muted"
                >
                  {t("deviceList.deploySoftware")}{" "}
                </button>
                <button
                  type="button"
                  onClick={() => handleBulkAction("maintenance-on")}
                  className="w-full px-4 py-2 text-left text-sm hover:bg-muted"
                >
                  {t("deviceList.enableMaintenance")}{" "}
                </button>
                <button
                  type="button"
                  onClick={() => handleBulkAction("maintenance-off")}
                  className="w-full px-4 py-2 text-left text-sm hover:bg-muted"
                >
                  {t("deviceList.disableMaintenance")}{" "}
                </button>
                <hr className="my-1" />
                <button
                  type="button"
                  onClick={() => handleBulkAction("wake")}
                  className="w-full px-4 py-2 text-left text-sm hover:bg-muted"
                >
                  {t("deviceList.wakeSelected")}{" "}
                </button>
                {selectedIds.size >= 2 && (
                  <button
                    type="button"
                    data-testid="bulk-link-multiboot"
                    onClick={() => handleBulkAction("link-multiboot")}
                    className="w-full px-4 py-2 text-left text-sm hover:bg-muted"
                  >
                    {t("deviceList.linkAsMultiBoot")}{" "}
                  </button>
                )}
                {selectedIds.size >= 2 && (
                  <button
                    type="button"
                    data-testid="bulk-link-vm-host"
                    onClick={() => handleBulkAction('link-vm-host')}
                    className="w-full px-4 py-2 text-left text-sm hover:bg-muted"
                  >
                    Link as VM host + guests
                  </button>
                )}
                <hr className="my-1" />
                <button
                  type="button"
                  onClick={() => handleBulkAction("decommission")}
                  className="w-full px-4 py-2 text-left text-sm text-destructive hover:bg-destructive/10"
                >
                  {t("deviceList.decommissionSelected")}{" "}
                </button>
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={() => setSelectedIds(new Set())}
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            {t("deviceList.clearSelection")}{" "}
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
                  aria-label={t("deviceList.selectAllDevicesOnThisPage")}
                  ref={(el) => {
                    if (el) el.indeterminate = someSelected && !allSelected;
                  }}
                  onChange={(e) => handleSelectAll(e.target.checked)}
                  className="h-4 w-4 rounded border-border"
                />
              </th>
              {renderedColumns.map((id) => columnDefs[id].header())}
              <th className="px-3 py-3 text-right">
                {t("deviceList.actions")}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {paginatedDevices.length === 0 ? (
              <tr>
                <td
                  colSpan={
                    renderedColumns.length +
                    2 /* checkbox + Actions; renderedColumns already drops flag-gated columns */
                  }
                  className="px-3 py-6 text-center text-sm text-muted-foreground"
                >
                  {t("deviceList.noDevicesFoundTryAdjustingYour")}{" "}
                </td>
              </tr>
            ) : (
              visibleRows.map(({ device, inactiveSiblings, offlineGroup, vmRole, vmGroupId, vmGuestCount }) => (
                <Fragment key={device.id}>
                  <tr
                    onClick={() => onSelect?.(device)}
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onSelect?.(device);
                      }
                    }}
                    className="cursor-pointer transition hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-hidden"
                  >
                    <td
                      className={`px-3 py-3 ${offlineGroup || vmRole ? "border-l-2 border-l-primary/40" : ""}`}
                      {...(offlineGroup
                        ? {
                            "data-testid": `device-${device.id}-group-bar`,
                            title: t(
                              "deviceList.linkedMultiBootProfileAllBoot",
                            ),
                          }
                        : {})}
                    >
                      <div className="flex items-center gap-1">
                        {/* vm_host (#2308): expand/collapse toggle on the host row. */}
                        {vmRole === "host" && vmGroupId && (
                          <button
                            type="button"
                            data-testid={`device-${device.id}-vm-toggle`}
                            aria-label={
                              collapsedVmGroups.has(vmGroupId)
                                ? `Show ${vmGuestCount ?? 0} guest VMs of ${device.hostname}`
                                : `Hide guest VMs of ${device.hostname}`
                            }
                            aria-expanded={!collapsedVmGroups.has(vmGroupId)}
                            title={`VM host — ${vmGuestCount ?? 0} guest VM${vmGuestCount === 1 ? "" : "s"} on this page`}
                            onClick={(e) => {
                              e.stopPropagation();
                              const collapsing =
                                !collapsedVmGroups.has(vmGroupId);
                              if (collapsing) {
                                // Deselect the guests being hidden — a checked
                                // row must never stay a bulk-action target while
                                // invisible.
                                const hiddenIds = displayRows
                                  .filter(
                                    (r) =>
                                      r.vmRole === "guest" &&
                                      r.vmGroupId === vmGroupId,
                                  )
                                  .map((r) => r.device.id);
                                if (hiddenIds.some((id) => selectedIds.has(id))) {
                                  setSelectedIds((prev) => {
                                    const next = new Set(prev);
                                    for (const id of hiddenIds) next.delete(id);
                                    return next;
                                  });
                                }
                              }
                              setCollapsedVmGroups((prev) => {
                                const next = new Set(prev);
                                if (next.has(vmGroupId)) next.delete(vmGroupId);
                                else next.add(vmGroupId);
                                return next;
                              });
                            }}
                            className="-ml-1 flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                          >
                            {collapsedVmGroups.has(vmGroupId) ? (
                              <ChevronRight className="h-3.5 w-3.5" />
                            ) : (
                              <ChevronDown className="h-3.5 w-3.5" />
                            )}
                          </button>
                        )}
                        {/* vm_host (#2308): nesting glyph on guest rows. */}
                        {vmRole === "guest" && (
                          <CornerDownRight
                            data-testid={`device-${device.id}-vm-guest-glyph`}
                            aria-hidden
                            className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                          />
                        )}
                        <input
                          type="checkbox"
                          checked={selectedIds.has(device.id)}
                          aria-label={t("deviceList.selectDevice", { hostname: device.hostname })}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) =>
                            handleSelectOne(device.id, e.target.checked)
                          }
                          className="h-4 w-4 rounded border-border"
                        />
                      </div>
                    </td>
                    {renderedColumns.map((id) => columnDefs[id].cell(device))}
                    <td
                      className="px-3 py-3 text-sm"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {(device.deviceClass ?? "agent") === "network" ? (
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
                            {t("deviceList.view")}{" "}
                          </button>
                        </div>
                      ) : (
                        <div className="flex items-center justify-end gap-1">
                          <ConnectDesktopButton
                            deviceId={device.id}
                            iconOnly
                            disabled={device.status !== "online"}
                            isHeadless={device.isHeadless}
                            desktopAccess={device.desktopAccess}
                            remoteAccessPolicy={device.remoteAccessPolicy}
                          />
                          <div className="relative">
                            <button
                              type="button"
                              aria-label={t("deviceList.deviceActions")}
                              ref={
                                rowMenuOpenId === device.id
                                  ? rowMenuButtonRef
                                  : undefined
                              }
                              onClick={(e) => {
                                if (rowMenuOpenId !== device.id) {
                                  const rect =
                                    e.currentTarget.getBoundingClientRect();
                                  // ~280px dropdown height (7 items × ~36px + padding/divider).
                                  // Flip up when the space below the button is less than that.
                                  setRowMenuFlipUp(
                                    window.innerHeight - rect.bottom < 300,
                                  );
                                  setRowMenuAnchor({
                                    top: rect.top,
                                    bottom: rect.bottom,
                                    right: rect.right,
                                  });
                                }
                                setRowMenuOpenId(
                                  rowMenuOpenId === device.id
                                    ? null
                                    : device.id,
                                );
                              }}
                              className="flex h-8 w-8 items-center justify-center rounded-md transition hover:bg-muted"
                            >
                              <MoreVertical className="h-4 w-4" />
                            </button>
                            {rowMenuOpenId === device.id &&
                              rowMenuAnchor &&
                              createPortal(
                                <div
                                  ref={rowMenuRef}
                                  style={{
                                    position: "fixed",
                                    right:
                                      window.innerWidth - rowMenuAnchor.right,
                                    ...(rowMenuFlipUp
                                      ? {
                                          bottom:
                                            window.innerHeight -
                                            rowMenuAnchor.top +
                                            4,
                                        }
                                      : { top: rowMenuAnchor.bottom + 4 }),
                                  }}
                                  className="z-50 w-48 rounded-md border bg-card shadow-lg"
                                >
                                  {/* Live session — needs a connected agent. */}
                                  <button
                                    type="button"
                                    disabled={device.status !== "online"}
                                    title={notOnlineTitle(
                                      device.status,
                                      t,
                                    )}
                                    onClick={() => {
                                      onAction?.("terminal", device);
                                      setRowMenuOpenId(null);
                                    }}
                                    className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                                  >
                                    <Terminal className="h-4 w-4" />
                                    {t("deviceList.remoteTerminal")}{" "}
                                  </button>
                                  {/* Queued command — an offline device runs it
                                      on reconnect, so only a decommissioned
                                      (agent-less) device is refused. */}
                                  <button
                                    type="button"
                                    disabled={!isCommandQueueable(device.status)}
                                    title={notQueueableTitle(
                                      device.status,
                                      t,
                                    )}
                                    onClick={() => {
                                      onAction?.("run-script", device);
                                      setRowMenuOpenId(null);
                                    }}
                                    className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                                  >
                                    <FileCode className="h-4 w-4" />
                                    {t("deviceList.runScript")}{" "}
                                  </button>
                                  {/* Reboot is ALSO a queued command, so it is
                                      gated like Run Script: the API refuses only
                                      decommissioned, and an offline box reboots
                                      on reconnect. Loosened in #2630 to match
                                      the grid card (see #2486). */}
                                  <button
                                    type="button"
                                    disabled={!isCommandQueueable(device.status)}
                                    title={notQueueableTitle(
                                      device.status,
                                      t,
                                    )}
                                    onClick={() => {
                                      onAction?.("reboot", device);
                                      setRowMenuOpenId(null);
                                    }}
                                    className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                                  >
                                    <RotateCcw className="h-4 w-4" />
                                    {t("deviceList.reboot")}{" "}
                                  </button>
                                  {device.status === "offline" && (
                                    <button
                                      type="button"
                                      onClick={() => {
                                        onAction?.("wake", device);
                                        setRowMenuOpenId(null);
                                      }}
                                      className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-muted"
                                      title={t(
                                        "deviceList.sendAWakeOnLanPacket",
                                      )}
                                    >
                                      <Zap className="h-4 w-4" />
                                      {t("deviceList.wake")}{" "}
                                    </button>
                                  )}
                                  <button
                                    type="button"
                                    onClick={() => {
                                      onAction?.("settings", device);
                                      setRowMenuOpenId(null);
                                    }}
                                    className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-muted"
                                  >
                                    <Settings className="h-4 w-4" />
                                    {t("deviceList.settings")}{" "}
                                  </button>
                                  <hr className="my-1" />
                                  {device.status === "decommissioned" ? (
                                    <button
                                      type="button"
                                      onClick={() => {
                                        onAction?.("restore", device);
                                        setRowMenuOpenId(null);
                                      }}
                                      className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-success hover:bg-success/10"
                                    >
                                      <RotateCcw className="h-4 w-4" />
                                      {t("deviceList.restore")}{" "}
                                    </button>
                                  ) : (
                                    <button
                                      type="button"
                                      onClick={() => {
                                        onAction?.("decommission", device);
                                        setRowMenuOpenId(null);
                                      }}
                                      className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-destructive hover:bg-destructive/10"
                                    >
                                      <Trash2 className="h-4 w-4" />
                                      {t("deviceList.decommission")}{" "}
                                    </button>
                                  )}
                                </div>,
                                document.body,
                              )}
                          </div>
                        </div>
                      )}
                    </td>
                  </tr>
                  {/* vm_host (#2308): when a host's guests are collapsed, a thin
                      strip stands in for them — click to expand. */}
                  {vmRole === "host" &&
                    vmGroupId &&
                    collapsedVmGroups.has(vmGroupId) && (
                      <tr
                        data-testid={`device-${device.id}-vm-collapsed-strip`}
                        onClick={() =>
                          setCollapsedVmGroups((prev) => {
                            const next = new Set(prev);
                            next.delete(vmGroupId);
                            return next;
                          })
                        }
                        tabIndex={0}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            setCollapsedVmGroups((prev) => {
                              const next = new Set(prev);
                              next.delete(vmGroupId);
                              return next;
                            });
                          }
                        }}
                        className="cursor-pointer bg-muted/30 transition hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-hidden"
                      >
                        <td
                          colSpan={
                            renderedColumns.length + 2 /* checkbox + Actions */
                          }
                          className="border-l-2 border-l-primary/40 px-3 py-1.5"
                        >
                          <div className="flex items-center gap-1.5 pl-7 text-xs text-muted-foreground">
                            <CornerDownRight className="h-3.5 w-3.5" aria-hidden />
                            <span>
                              {vmGuestCount} guest VM{vmGuestCount === 1 ? "" : "s"} hidden — click to expand
                            </span>
                          </div>
                        </td>
                      </tr>
                    )}
                  {/* Linked multi-boot: expected-offline boot profiles tucked
                    beneath their online sibling as thin muted strips (#2138).
                    Clickable through to the device's own detail page; NOT
                    selectable for bulk actions. */}
                  {inactiveSiblings.map((sib) => (
                    <tr
                      key={sib.id}
                      data-testid={`device-${sib.id}-inactive-strip`}
                      onClick={() => onSelect?.(sib)}
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          onSelect?.(sib);
                        }
                      }}
                      className="cursor-pointer bg-muted/30 transition hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-hidden"
                    >
                      <td
                        colSpan={
                          renderedColumns.length + 2 /* checkbox + Actions */
                        }
                        className="px-3 py-1.5"
                      >
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 pl-7 text-xs text-muted-foreground">
                          <span className="inline-flex items-center gap-1.5">
                            <OSIcon os={sib.os} className="h-3.5 w-3.5" />
                            <span className="font-medium">
                              {formatDeviceOsVersion(sib.os, sib.osVersion) ||
                                sib.hostname}
                            </span>
                            <span>{t("deviceList.inactive")}</span>
                          </span>
                          <span className="inline-flex items-center whitespace-nowrap rounded-full border px-1.5 py-px text-[10px] font-medium">
                            {t("deviceList.expectedOffline")}{" "}
                          </span>
                          <span>
                            {t("deviceList.lastSeen")}{" "}
                            {formatLastSeen(sib.lastSeen, effectiveTimezone)}
                          </span>
                          {sib.agentVersion && (
                            <span>
                              {t("deviceList.agentV")}
                              {sib.agentVersion}
                            </span>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </Fragment>
              ))
            )}
          </tbody>
        </table>
      </div>

      {sortedDevices.length > 0 && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-3">
            <p className="text-sm text-muted-foreground">
              {t("deviceList.showing")} {startIndex + 1} {t("deviceList.to")}{" "}
              {Math.min(startIndex + effectivePageSize, sortedDevices.length)}{" "}
              {t("deviceList.of")} {sortedDevices.length}
            </p>
            <div className="flex items-center gap-2">
              <label
                htmlFor="device-page-size"
                className="text-sm text-muted-foreground"
              >
                {t("deviceList.perPage")}{" "}
              </label>
              <select
                id="device-page-size"
                value={effectivePageSize}
                aria-label={t("deviceList.devicesPerPage")}
                onChange={(event) =>
                  handlePageSizeChange(Number(event.target.value))
                }
                className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring sm:w-32"
              >
                {PAGE_SIZE_OPTIONS.map((opt) => (
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
                onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                disabled={currentPage === 1}
                className="flex h-9 w-9 items-center justify-center rounded-md border hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <span className="text-sm">
                {t("deviceList.page")} {currentPage} {t("deviceList.of")}{" "}
                {totalPages}
              </span>
              <button
                type="button"
                onClick={() =>
                  setCurrentPage((p) => Math.min(totalPages, p + 1))
                }
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
