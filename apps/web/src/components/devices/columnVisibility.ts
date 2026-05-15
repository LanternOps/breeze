// Per-user column visibility and order for the Devices list. Persisted in
// localStorage so the choices survive navigation and reloads on the same
// browser. Two pieces stored under separate keys: visible-set (which
// columns to show) and ordered-list (in what position). Splitting them
// keeps visibility prefs portable when the column catalog grows over time
// — a user who hid CPU stays with CPU hidden even when newer columns
// arrive at the end of the canonical order.
//
// The row-select checkbox and the row-actions menu are non-togglable and
// always render. They are not represented in this module — they live
// unconditionally in DeviceList.tsx.

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

// DEFAULT_VISIBLE_COLUMNS preserves the pre-feature behavior: the same nine
// columns are shown by default. Every newly-exposed field starts OFF so
// existing users see no surprise on first render. Discussion #56.
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

export const COLUMN_VISIBILITY_STORAGE_KEY = 'breeze.devices.visibleColumns';
export const COLUMN_ORDER_STORAGE_KEY = 'breeze.devices.columnOrder';

export function isValidColumnId(value: string): value is ColumnId {
  return (COLUMN_IDS as readonly string[]).includes(value);
}

// readColumnVisibility returns the stored set of visible column IDs if the
// localStorage value parses cleanly and at least one entry is a known
// ColumnId. Falls back to DEFAULT_VISIBLE_COLUMNS during SSR, when the
// entry is missing, when JSON is malformed, or when no entry validates.
// Throw-safe (Safari private mode raises SecurityError on getItem).
export function readColumnVisibility(): ReadonlySet<ColumnId> {
  if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') {
    return new Set(DEFAULT_VISIBLE_COLUMNS);
  }
  try {
    const raw = window.localStorage.getItem(COLUMN_VISIBILITY_STORAGE_KEY);
    if (raw === null) return new Set(DEFAULT_VISIBLE_COLUMNS);
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set(DEFAULT_VISIBLE_COLUMNS);
    const valid: ColumnId[] = [];
    for (const v of parsed) {
      if (typeof v === 'string' && isValidColumnId(v)) {
        valid.push(v);
      }
    }
    if (valid.length === 0) return new Set(DEFAULT_VISIBLE_COLUMNS);
    return new Set(valid);
  } catch {
    return new Set(DEFAULT_VISIBLE_COLUMNS);
  }
}

// writeColumnVisibility persists the chosen set. Silently swallows errors
// (quota exceeded, Safari private mode) — the chosen set is still applied
// in component state; only persistence across reload is lost. Filters to
// known ColumnIds + dedupes before writing.
export function writeColumnVisibility(visible: Iterable<ColumnId>): void {
  if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') return;
  const clean = Array.from(new Set(Array.from(visible).filter(isValidColumnId)));
  try {
    window.localStorage.setItem(COLUMN_VISIBILITY_STORAGE_KEY, JSON.stringify(clean));
  } catch {
    // Quota / SecurityError — ignore.
  }
}

// readColumnOrder returns the canonical column order in the user's chosen
// arrangement. Always returns every ColumnId exactly once. Missing IDs in
// the stored order (e.g. new columns added to the catalog since the user
// last saved) are appended at the end so they remain reachable.
// Falls back to COLUMN_IDS order during SSR or on parse failure.
export function readColumnOrder(): ColumnId[] {
  if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') {
    return [...COLUMN_IDS];
  }
  try {
    const raw = window.localStorage.getItem(COLUMN_ORDER_STORAGE_KEY);
    if (raw === null) return [...COLUMN_IDS];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [...COLUMN_IDS];
    const seen = new Set<ColumnId>();
    const result: ColumnId[] = [];
    for (const v of parsed) {
      if (typeof v === 'string' && isValidColumnId(v) && !seen.has(v)) {
        seen.add(v);
        result.push(v);
      }
    }
    // Append any catalog ids the stored order is missing.
    for (const id of COLUMN_IDS) {
      if (!seen.has(id)) result.push(id);
    }
    return result;
  } catch {
    return [...COLUMN_IDS];
  }
}

// writeColumnOrder persists the user's column arrangement. Filters to
// known ColumnIds + dedupes + appends missing IDs so the stored value is
// always a complete permutation of COLUMN_IDS.
export function writeColumnOrder(order: Iterable<ColumnId>): void {
  if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') return;
  const seen = new Set<ColumnId>();
  const clean: ColumnId[] = [];
  for (const id of order) {
    if (isValidColumnId(id) && !seen.has(id)) {
      seen.add(id);
      clean.push(id);
    }
  }
  for (const id of COLUMN_IDS) {
    if (!seen.has(id)) clean.push(id);
  }
  try {
    window.localStorage.setItem(COLUMN_ORDER_STORAGE_KEY, JSON.stringify(clean));
  } catch {
    // Quota / SecurityError — ignore.
  }
}
