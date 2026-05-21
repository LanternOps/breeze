// Per-user column visibility + order for the Devices list, persisted to
// localStorage under two keys so adding a new column to COLUMN_IDS does
// not flip its visibility for users who had hidden it under the old set.

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

export const COLUMN_VISIBILITY_STORAGE_KEY = 'breeze.devices.visibleColumns';
export const COLUMN_ORDER_STORAGE_KEY = 'breeze.devices.columnOrder';

export function isValidColumnId(value: string): value is ColumnId {
  return (COLUMN_IDS as readonly string[]).includes(value);
}

// Empty stored set falls back to defaults — an empty table is worse UX
// than the pre-feature view. Safari private mode raises SecurityError on
// getItem, so the try/catch is load-bearing, not defensive coding.
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

// Quota / SecurityError are swallowed — only persistence is lost, the
// in-memory state still applies. Filtering to known ColumnIds keeps the
// stored value clean if a caller hands in something unexpected.
export function writeColumnVisibility(visible: Iterable<ColumnId>): void {
  if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') return;
  const clean = Array.from(new Set(Array.from(visible).filter(isValidColumnId)));
  try {
    window.localStorage.setItem(COLUMN_VISIBILITY_STORAGE_KEY, JSON.stringify(clean));
  } catch {
    // Quota / SecurityError — ignore.
  }
}

// Always returns every ColumnId exactly once. Missing IDs are appended at
// the end so a newly-added column remains reachable in the dropdown.
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

// Stored value is always a complete permutation of COLUMN_IDS.
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
