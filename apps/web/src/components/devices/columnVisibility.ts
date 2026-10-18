// Per-user column visibility + order for the Devices list, persisted to
// localStorage under a single versioned key. Order and visibility are two
// hats on one ordered list: array order is the column order, and each entry
// carries its own `visible` flag. One object means one atomic setItem (no
// partial-write window where order persists but visibility throws), and a
// single source of truth. Merge-on-read keeps the stored list in sync with
// COLUMN_IDS as the catalog gains/loses columns across releases.

export const COLUMN_IDS = [
  'hostname',
  'class',
  'type',
  'organization',
  'site',
  'os',
  'osVersion',
  'osBuild',
  'architecture',
  'role',
  'isHeadless',
  'status',
  // #9038 — open alerts by severity + open tickets, fetched per page of rows
  // (GET /devices/attention-counts). Default-on: it is the triage signal.
  'attention',
  'pendingReboot',
  'cpu',
  'ram',
  'power',
  'cpuModel',
  'cores',
  'ramTotal',
  'diskTotal',
  'lastSeen',
  'agentVersion',
  'watchdogVersion',
  'helperVersion',
  'serverUrl',
  'wanIp',
  'lanIp',
  'tags',
  'lastUser',
  'uptime',
  'enrolled',
  'desktopAccess',
  'reliability',
  'hardwareHealth',
  'vpn',
  // Manual-asset inventory fields (#4622 W04). `serial` is opt-in for agent
  // rows too (via device_hardware); `assetTag`/`location` are manual-only.
  'serial',
  'assetTag',
  'location',
  // #5213 — provenance of a network row (scan | unifi | manual). Opt-in: agent
  // rows have no source, so default-on would show a column of dashes for the
  // common agent-only fleet (same reasoning as 'type' above).
  'source',
] as const;

export type ColumnId = (typeof COLUMN_IDS)[number];

export const COLUMN_LABELS: Record<ColumnId, string> = {
  hostname: 'Device',
  class: 'Class',
  type: 'Type',
  organization: 'Organization',
  site: 'Site',
  os: 'OS',
  osVersion: 'OS Version',
  osBuild: 'OS Build',
  architecture: 'Architecture',
  role: 'Role',
  isHeadless: 'Headless',
  status: 'Status',
  attention: 'Attention',
  pendingReboot: 'Pending Reboot',
  cpu: 'CPU %',
  ram: 'RAM %',
  power: 'Power',
  cpuModel: 'CPU Model',
  cores: 'Cores',
  ramTotal: 'RAM',
  diskTotal: 'Disk',
  lastSeen: 'Last Seen',
  agentVersion: 'Agent Version',
  watchdogVersion: 'Watchdog Version',
  helperVersion: 'Helper Version',
  serverUrl: 'Server',
  wanIp: 'WAN IP',
  lanIp: 'LAN IP',
  tags: 'Tags',
  lastUser: 'Last User',
  uptime: 'Uptime',
  enrolled: 'Enrolled',
  desktopAccess: 'Desktop Access',
  reliability: 'Reliability',
  hardwareHealth: 'Hardware',
  vpn: 'VPN',
  serial: 'Serial',
  assetTag: 'Asset Tag',
  location: 'Location',
  source: 'Source',
};

/**
 * Column-chooser sections (#9034). Every catalog column belongs to exactly one;
 * custom-field columns are not ColumnIds and get their own section.
 */
export const COLUMN_GROUP_ORDER = [
  'identity',
  'platform',
  'health',
  'versions',
  'network',
  'inventory',
] as const;

export type ColumnGroup = (typeof COLUMN_GROUP_ORDER)[number];

export const COLUMN_GROUPS: Record<ColumnId, ColumnGroup> = {
  hostname: 'identity',
  class: 'identity',
  type: 'identity',
  source: 'identity',
  organization: 'identity',
  site: 'identity',
  role: 'identity',
  tags: 'identity',
  lastUser: 'identity',
  enrolled: 'identity',
  os: 'platform',
  osVersion: 'platform',
  osBuild: 'platform',
  architecture: 'platform',
  isHeadless: 'platform',
  desktopAccess: 'platform',
  status: 'health',
  attention: 'health',
  pendingReboot: 'health',
  cpu: 'health',
  ram: 'health',
  power: 'health',
  lastSeen: 'health',
  uptime: 'health',
  reliability: 'health',
  hardwareHealth: 'health',
  agentVersion: 'versions',
  watchdogVersion: 'versions',
  helperVersion: 'versions',
  serverUrl: 'network',
  wanIp: 'network',
  lanIp: 'network',
  vpn: 'network',
  cpuModel: 'inventory',
  cores: 'inventory',
  ramTotal: 'inventory',
  diskTotal: 'inventory',
  serial: 'inventory',
  assetTag: 'inventory',
  location: 'inventory',
};

// The Device column names the row; a table without it is unreadable, so it is
// shown on every read and forced visible on every visibility write (#9034).
const LOCKED_COLUMNS: ReadonlySet<ColumnId> = new Set<ColumnId>(['hostname']);

export function isColumnLocked(id: ColumnId): boolean {
  return LOCKED_COLUMNS.has(id);
}

export const DEFAULT_VISIBLE_COLUMNS: ReadonlyArray<ColumnId> = [
  'hostname',
  'class',
  // 'type' is opt-in (#1386): it carries the asset_type of network-discovered
  // devices and renders a dash for agent rows, so default-on it would show a
  // column of dashes for the common agent-only fleet. The Class column already
  // distinguishes Agent/Network; enable Type from the column picker when you
  // have network inventory to inspect.
  'organization',
  'site',
  'os',
  'role',
  'status',
  'attention',
  'cpu',
  'ram',
  'lastSeen',
];

export const COLUMN_STORAGE_KEY = 'breeze.devices.columns';

/**
 * Where a column list is persisted and what it starts as. The fleet Devices
 * page and the organization record's embedded Devices tab each own a preset,
 * so a customisation on one never leaks into the other.
 */
export interface ColumnPreset {
  storageKey: string;
  defaultVisible: ReadonlyArray<ColumnId>;
}

export const DEVICES_PAGE_COLUMN_PRESET: ColumnPreset = {
  storageKey: COLUMN_STORAGE_KEY,
  defaultVisible: DEFAULT_VISIBLE_COLUMNS,
};

export const ORG_TAB_COLUMN_STORAGE_KEY = 'breeze.devices.columns.orgTab';

// The record's tab is already scoped to one org, so no Organization/Class/Role.
export const ORG_TAB_COLUMN_PRESET: ColumnPreset = {
  storageKey: ORG_TAB_COLUMN_STORAGE_KEY,
  defaultVisible: ['hostname', 'site', 'os', 'status', 'attention', 'cpu', 'ram', 'lastSeen'],
};
const STORAGE_VERSION = 1;

export interface StoredColumn {
  id: ColumnId;
  visible: boolean;
}

interface StoredShape {
  v: number;
  columns: StoredColumn[];
}

export function isValidColumnId(value: string): value is ColumnId {
  return (COLUMN_IDS as readonly string[]).includes(value);
}

// The catalog's default-visible flag for a column — the floor a new column
// ships with when it first appears in storage via merge-on-read.
function defaultVisible(id: ColumnId, preset: ColumnPreset): boolean {
  return preset.defaultVisible.includes(id);
}

// Canonical fallback: every catalog column in catalog order, each at its
// default visibility. Used for empty/malformed/SSR reads.
function defaultColumns(preset: ColumnPreset): StoredColumn[] {
  return COLUMN_IDS.map((id) => ({ id, visible: defaultVisible(id, preset) }));
}

// Returns every ColumnId exactly once: stored entries first (in stored order,
// with stored visibility), then any catalog ids missing from storage appended
// in catalog order inheriting their default-visible flag. Unknown/duplicate
// stored ids are dropped. Empty/malformed/SSR falls back to defaults — an
// empty or stale list is worse UX than the pre-feature view. Safari private
// mode raises SecurityError on getItem, so the try/catch is load-bearing.
function readColumns(preset: ColumnPreset): StoredColumn[] {
  if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') {
    return defaultColumns(preset);
  }
  try {
    const raw = window.localStorage.getItem(preset.storageKey);
    if (raw === null) return defaultColumns(preset);
    const parsed = JSON.parse(raw) as Partial<StoredShape> | null;
    if (!parsed || !Array.isArray(parsed.columns)) return defaultColumns(preset);
    const seen = new Set<ColumnId>();
    const result: StoredColumn[] = [];
    for (const entry of parsed.columns) {
      if (
        entry &&
        typeof entry.id === 'string' &&
        isValidColumnId(entry.id) &&
        !seen.has(entry.id)
      ) {
        seen.add(entry.id);
        result.push({
          id: entry.id,
          visible: typeof entry.visible === 'boolean' ? entry.visible : defaultVisible(entry.id, preset),
        });
      }
    }
    if (result.length === 0) return defaultColumns(preset);
    // Append catalog ids the stored list is missing, inheriting default visibility.
    for (const id of COLUMN_IDS) {
      if (!seen.has(id)) result.push({ id, visible: defaultVisible(id, preset) });
    }
    return result;
  } catch {
    return defaultColumns(preset);
  }
}

// Writes the complete ordered list in one atomic setItem. Normalizes first:
// dedupe, drop unknown ids, append any missing catalog ids at default
// visibility — so the stored value is always a complete permutation of
// COLUMN_IDS. Quota / SecurityError are swallowed; only persistence is lost.
function writeColumns(columns: Iterable<StoredColumn>, preset: ColumnPreset): void {
  if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') return;
  const seen = new Set<ColumnId>();
  const clean: StoredColumn[] = [];
  for (const c of columns) {
    if (c && isValidColumnId(c.id) && !seen.has(c.id)) {
      seen.add(c.id);
      clean.push({ id: c.id, visible: !!c.visible });
    }
  }
  for (const id of COLUMN_IDS) {
    if (!seen.has(id)) clean.push({ id, visible: defaultVisible(id, preset) });
  }
  const shape: StoredShape = { v: STORAGE_VERSION, columns: clean };
  try {
    window.localStorage.setItem(preset.storageKey, JSON.stringify(shape));
  } catch {
    // Quota / SecurityError — ignore.
  }
}

// Visible-set view of the stored list. An all-hidden list falls back to the
// default set — an empty table is worse UX than the pre-feature view.
export function readColumnVisibility(preset: ColumnPreset = DEVICES_PAGE_COLUMN_PRESET): ReadonlySet<ColumnId> {
  const visible = readColumns(preset).filter((c) => c.visible).map((c) => c.id);
  if (visible.length === 0) return new Set(preset.defaultVisible);
  return new Set([...visible, ...LOCKED_COLUMNS]);
}

// Updates only the visibility flags, preserving the current stored order.
export function writeColumnVisibility(
  visible: Iterable<ColumnId>,
  preset: ColumnPreset = DEVICES_PAGE_COLUMN_PRESET,
): void {
  const visibleSet = new Set([...Array.from(visible).filter(isValidColumnId), ...LOCKED_COLUMNS]);
  writeColumns(readColumns(preset).map((c) => ({ id: c.id, visible: visibleSet.has(c.id) })), preset);
}

// Ordered view of the stored list — every ColumnId exactly once.
export function readColumnOrder(preset: ColumnPreset = DEVICES_PAGE_COLUMN_PRESET): ColumnId[] {
  return readColumns(preset).map((c) => c.id);
}

// Overwrites any saved preference with the catalog defaults: every column in
// catalog order at its default visibility. Returns the fresh ordered list so
// callers can sync React state without a second read.
export function resetColumns(preset: ColumnPreset = DEVICES_PAGE_COLUMN_PRESET): StoredColumn[] {
  const cols = defaultColumns(preset);
  writeColumns(cols, preset);
  return cols;
}

// Updates only the order, preserving each column's current visibility flag.
export function writeColumnOrder(
  order: Iterable<ColumnId>,
  preset: ColumnPreset = DEVICES_PAGE_COLUMN_PRESET,
): void {
  const visById = new Map(readColumns(preset).map((c) => [c.id, c.visible] as const));
  const seen = new Set<ColumnId>();
  const next: StoredColumn[] = [];
  for (const id of order) {
    if (isValidColumnId(id) && !seen.has(id)) {
      seen.add(id);
      next.push({ id, visible: visById.get(id) ?? defaultVisible(id, preset) });
    }
  }
  for (const id of COLUMN_IDS) {
    if (!seen.has(id)) next.push({ id, visible: visById.get(id) ?? defaultVisible(id, preset) });
  }
  writeColumns(next, preset);
}
