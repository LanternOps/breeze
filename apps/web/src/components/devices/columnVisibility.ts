// Per-user column visibility + order for the Devices list, persisted to
// localStorage under a single versioned key. Order and visibility are two
// hats on one ordered list: array order is the column order, and each entry
// carries its own `visible` flag. One object means one atomic setItem (no
// partial-write window where order persists but visibility throws), and a
// single source of truth. Merge-on-read keeps the stored list in sync with
// COLUMN_IDS as the catalog gains/loses columns across releases.

export const COLUMN_IDS = [
  'hostname',
  'organization',
  'site',
  'os',
  'osVersion',
  'osBuild',
  'architecture',
  'role',
  'isHeadless',
  'status',
  'cpu',
  'ram',
  'cpuModel',
  'cores',
  'ramTotal',
  'diskTotal',
  'lastSeen',
  'agentVersion',
  'tags',
  'lastUser',
  'uptime',
  'enrolled',
  'desktopAccess',
] as const;

export type ColumnId = (typeof COLUMN_IDS)[number];

export const COLUMN_LABELS: Record<ColumnId, string> = {
  hostname: 'Hostname',
  organization: 'Organization',
  site: 'Site',
  os: 'OS',
  osVersion: 'OS Version',
  osBuild: 'OS Build',
  architecture: 'Architecture',
  role: 'Role',
  isHeadless: 'Headless',
  status: 'Status',
  cpu: 'CPU %',
  ram: 'RAM %',
  cpuModel: 'CPU Model',
  cores: 'Cores',
  ramTotal: 'RAM',
  diskTotal: 'Disk',
  lastSeen: 'Last Seen',
  agentVersion: 'Agent Version',
  tags: 'Tags',
  lastUser: 'Last User',
  uptime: 'Uptime',
  enrolled: 'Enrolled',
  desktopAccess: 'Desktop Access',
};

export const DEFAULT_VISIBLE_COLUMNS: ReadonlyArray<ColumnId> = [
  'hostname',
  'organization',
  'site',
  'os',
  'role',
  'status',
  'cpu',
  'ram',
  'lastSeen',
];

export const COLUMN_STORAGE_KEY = 'breeze.devices.columns';
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
function defaultVisible(id: ColumnId): boolean {
  return DEFAULT_VISIBLE_COLUMNS.includes(id);
}

// Canonical fallback: every catalog column in catalog order, each at its
// default visibility. Used for empty/malformed/SSR reads.
function defaultColumns(): StoredColumn[] {
  return COLUMN_IDS.map((id) => ({ id, visible: defaultVisible(id) }));
}

// Returns every ColumnId exactly once: stored entries first (in stored order,
// with stored visibility), then any catalog ids missing from storage appended
// in catalog order inheriting their default-visible flag. Unknown/duplicate
// stored ids are dropped. Empty/malformed/SSR falls back to defaults — an
// empty or stale list is worse UX than the pre-feature view. Safari private
// mode raises SecurityError on getItem, so the try/catch is load-bearing.
function readColumns(): StoredColumn[] {
  if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') {
    return defaultColumns();
  }
  try {
    const raw = window.localStorage.getItem(COLUMN_STORAGE_KEY);
    if (raw === null) return defaultColumns();
    const parsed = JSON.parse(raw) as Partial<StoredShape> | null;
    if (!parsed || !Array.isArray(parsed.columns)) return defaultColumns();
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
          visible: typeof entry.visible === 'boolean' ? entry.visible : defaultVisible(entry.id),
        });
      }
    }
    if (result.length === 0) return defaultColumns();
    // Append catalog ids the stored list is missing, inheriting default visibility.
    for (const id of COLUMN_IDS) {
      if (!seen.has(id)) result.push({ id, visible: defaultVisible(id) });
    }
    return result;
  } catch {
    return defaultColumns();
  }
}

// Writes the complete ordered list in one atomic setItem. Normalizes first:
// dedupe, drop unknown ids, append any missing catalog ids at default
// visibility — so the stored value is always a complete permutation of
// COLUMN_IDS. Quota / SecurityError are swallowed; only persistence is lost.
function writeColumns(columns: Iterable<StoredColumn>): void {
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
    if (!seen.has(id)) clean.push({ id, visible: defaultVisible(id) });
  }
  const shape: StoredShape = { v: STORAGE_VERSION, columns: clean };
  try {
    window.localStorage.setItem(COLUMN_STORAGE_KEY, JSON.stringify(shape));
  } catch {
    // Quota / SecurityError — ignore.
  }
}

// Visible-set view of the stored list. An all-hidden list falls back to the
// default set — an empty table is worse UX than the pre-feature view.
export function readColumnVisibility(): ReadonlySet<ColumnId> {
  const visible = readColumns().filter((c) => c.visible).map((c) => c.id);
  if (visible.length === 0) return new Set(DEFAULT_VISIBLE_COLUMNS);
  return new Set(visible);
}

// Updates only the visibility flags, preserving the current stored order.
export function writeColumnVisibility(visible: Iterable<ColumnId>): void {
  const visibleSet = new Set(Array.from(visible).filter(isValidColumnId));
  writeColumns(readColumns().map((c) => ({ id: c.id, visible: visibleSet.has(c.id) })));
}

// Ordered view of the stored list — every ColumnId exactly once.
export function readColumnOrder(): ColumnId[] {
  return readColumns().map((c) => c.id);
}

// Updates only the order, preserving each column's current visibility flag.
export function writeColumnOrder(order: Iterable<ColumnId>): void {
  const visById = new Map(readColumns().map((c) => [c.id, c.visible] as const));
  const seen = new Set<ColumnId>();
  const next: StoredColumn[] = [];
  for (const id of order) {
    if (isValidColumnId(id) && !seen.has(id)) {
      seen.add(id);
      next.push({ id, visible: visById.get(id) ?? defaultVisible(id) });
    }
  }
  for (const id of COLUMN_IDS) {
    if (!seen.has(id)) next.push({ id, visible: visById.get(id) ?? defaultVisible(id) });
  }
  writeColumns(next);
}
