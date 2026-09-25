// Per-user visibility for custom-field columns on the Devices list (#6594).
//
// Deliberately NOT folded into columnVisibility.ts's COLUMN_IDS: that union
// is a closed, per-release catalog consumed by several exhaustive
// `Record<ColumnId, ...>` maps in DeviceList.tsx (sortValue, columnDefs,
// NON_AGENT_COLUMNS, …), each requiring one entry per id at compile time.
// Custom field keys are per-org/partner runtime data, not a fixed catalog, so
// they're rendered as an ADDITIVE set of columns appended after the static
// ones (see DeviceList.tsx), with their own small, independent storage key —
// same shape as columnVisibility.ts (an ordered list + visible flag) but
// keyed by fieldKey instead of a closed ColumnId union.
const STORAGE_KEY = 'breeze.devices.customColumns';
const STORAGE_VERSION = 1;

interface StoredShape {
  v: number;
  fieldKeys: string[];
}

// No custom field column is visible by default — a fresh install has none
// defined, and an existing user shouldn't have their table widen out from
// under them the first time an admin defines one.
export function readVisibleCustomFieldKeys(): ReadonlySet<string> {
  if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') {
    return new Set();
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return new Set();
    const parsed = JSON.parse(raw) as Partial<StoredShape> | null;
    if (!parsed || !Array.isArray(parsed.fieldKeys)) return new Set();
    return new Set(parsed.fieldKeys.filter((k): k is string => typeof k === 'string'));
  } catch {
    return new Set();
  }
}

export function writeVisibleCustomFieldKeys(fieldKeys: Iterable<string>): void {
  if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') return;
  const shape: StoredShape = { v: STORAGE_VERSION, fieldKeys: Array.from(new Set(fieldKeys)) };
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(shape));
  } catch {
    // Quota / SecurityError — ignore, same as columnVisibility.ts.
  }
}
