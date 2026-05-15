// Per-user column visibility for the Devices list. Persisted in
// localStorage so the choice survives navigation and reloads on the
// same browser. localStorage is the v1 storage decision; a future
// enhancement may lift it to users.settings.devicesVisibleColumns so
// the preference follows the user across browsers. Same pattern as
// pageSizePreference.ts.
//
// Two columns are non-togglable and always render: the row-select
// checkbox and the row-actions menu. Those are not represented in
// this module — they live unconditionally in DeviceList.tsx.

export const COLUMN_IDS = [
  'hostname',
  'organization',
  'site',
  'os',
  'osVersion',
  'role',
  'status',
  'cpu',
  'ram',
  'lastSeen',
  'agentVersion',
  'tags',
  'lastUser',
  'uptime',
] as const;

export type ColumnId = (typeof COLUMN_IDS)[number];

// Labels are exported so the toggle dropdown in DeviceList can render
// the same human-readable text the header uses.
export const COLUMN_LABELS: Record<ColumnId, string> = {
  hostname: 'Hostname',
  organization: 'Organization',
  site: 'Site',
  os: 'OS',
  osVersion: 'OS Version',
  role: 'Role',
  status: 'Status',
  cpu: 'CPU %',
  ram: 'RAM %',
  lastSeen: 'Last Seen',
  agentVersion: 'Agent Version',
  tags: 'Tags',
  lastUser: 'Last User',
  uptime: 'Uptime',
};

// DEFAULT_VISIBLE_COLUMNS preserves the pre-feature behavior: the same
// nine columns are shown by default. The five newly-exposed fields
// (osVersion, agentVersion, tags, lastUser, uptime) start OFF so
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

export function isValidColumnId(value: string): value is ColumnId {
  return (COLUMN_IDS as readonly string[]).includes(value);
}

// readColumnVisibility returns the stored set of visible column IDs if
// the localStorage value parses cleanly and every entry is a known
// ColumnId. Returns DEFAULT_VISIBLE_COLUMNS during SSR, when the
// storage entry is missing, or when the parse/validation fails.
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
    // If every entry was rejected, fall back to defaults rather than
    // returning an empty set that would render an unusable table.
    if (valid.length === 0) return new Set(DEFAULT_VISIBLE_COLUMNS);
    return new Set(valid);
  } catch {
    return new Set(DEFAULT_VISIBLE_COLUMNS);
  }
}

// writeColumnVisibility persists the chosen set. Silently swallows
// errors (quota exceeded, Safari private mode) — the chosen set is
// still applied in component state; only persistence across reload
// is lost. Filters to known ColumnIds before writing to keep the
// stored value clean even if a caller hands in something unexpected.
export function writeColumnVisibility(visible: Iterable<ColumnId>): void {
  if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') return;
  const clean = Array.from(new Set(Array.from(visible).filter(isValidColumnId)));
  try {
    window.localStorage.setItem(COLUMN_VISIBILITY_STORAGE_KEY, JSON.stringify(clean));
  } catch {
    // Quota / SecurityError — ignore.
  }
}
