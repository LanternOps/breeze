// Per-user page-size preference for the Devices list. Persisted in
// localStorage under a single key so the choice survives navigation and
// reloads on the same browser. localStorage is the v1 storage decision;
// a future enhancement may lift it to users.settings.devicesPageSize so
// the preference follows the user across browsers (see Discussion #684).

export const PAGE_SIZE_OPTIONS = [10, 25, 50, 100, 200] as const;
export type PageSize = (typeof PAGE_SIZE_OPTIONS)[number];

export const DEFAULT_PAGE_SIZE: PageSize = 10;
export const PAGE_SIZE_STORAGE_KEY = 'breeze.devices.pageSize';

export function isValidPageSize(value: number): value is PageSize {
  return (PAGE_SIZE_OPTIONS as readonly number[]).includes(value);
}

// readPageSizePreference returns the stored preference if present and in
// PAGE_SIZE_OPTIONS, otherwise the supplied fallback (also validated, so
// an out-of-set caller default still resolves to a safe option). Returns
// DEFAULT_PAGE_SIZE during SSR or if localStorage access throws (Safari
// private mode raises SecurityError on getItem).
export function readPageSizePreference(fallback: number = DEFAULT_PAGE_SIZE): PageSize {
  const safeFallback: PageSize = isValidPageSize(fallback) ? fallback : DEFAULT_PAGE_SIZE;
  if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') {
    return safeFallback;
  }
  try {
    const raw = window.localStorage.getItem(PAGE_SIZE_STORAGE_KEY);
    if (raw === null) return safeFallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || !isValidPageSize(parsed)) return safeFallback;
    return parsed;
  } catch {
    return safeFallback;
  }
}

// writePageSizePreference persists the chosen size. Silently swallows
// errors (quota exceeded, Safari private mode) — the chosen size is still
// applied in component state, only persistence across reload is lost.
export function writePageSizePreference(size: number): void {
  if (!isValidPageSize(size)) return;
  if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') return;
  try {
    window.localStorage.setItem(PAGE_SIZE_STORAGE_KEY, String(size));
  } catch {
    // Quota / SecurityError — ignore.
  }
}
