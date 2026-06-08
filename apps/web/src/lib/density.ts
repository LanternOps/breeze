// Per-user table density preference. Persisted in localStorage under a
// single account-wide key (not per-table) so the choice applies anywhere
// a table opts in. Mirrors the pageSizePreference / columnVisibility
// pattern: SSR-safe getter, silent-fail setter, and a small subscribe
// helper so unrelated component instances can re-render when one of
// them changes the preference.

export const DENSITY_OPTIONS = ['comfortable', 'compact', 'dense'] as const;
export type Density = (typeof DENSITY_OPTIONS)[number];

export const DEFAULT_DENSITY: Density = 'comfortable';
export const DENSITY_STORAGE_KEY = 'breeze.density';

export function isValidDensity(value: unknown): value is Density {
  return typeof value === 'string' && (DENSITY_OPTIONS as readonly string[]).includes(value);
}

// readDensity returns the stored preference if present and recognized,
// otherwise DEFAULT_DENSITY. SSR-safe: localStorage access during server
// render or in Safari private mode (SecurityError on getItem) falls back
// to the default.
export function readDensity(): Density {
  if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') {
    return DEFAULT_DENSITY;
  }
  try {
    const raw = window.localStorage.getItem(DENSITY_STORAGE_KEY);
    if (raw === null) return DEFAULT_DENSITY;
    return isValidDensity(raw) ? raw : DEFAULT_DENSITY;
  } catch {
    return DEFAULT_DENSITY;
  }
}

// writeDensity persists the chosen density. Silently swallows quota /
// SecurityError errors — the choice still applies in component state,
// only persistence across reload is lost. Notifies subscribers so other
// table instances on the same page re-read and re-render. Also mirrors
// the value to a data-density attribute on <html> so the page-level CSS
// rules in globals.css can tighten outer padding, card padding, gaps,
// header height, sidebar nav rows, and modal padding.
export function writeDensity(value: Density): void {
  if (!isValidDensity(value)) return;
  if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') return;
  try {
    window.localStorage.setItem(DENSITY_STORAGE_KEY, value);
  } catch {
    // Quota / SecurityError — ignore.
  }
  applyDensityAttribute(value);
  for (const fn of subscribers) {
    try {
      fn(value);
    } catch {
      // Subscriber errors must not break setter.
    }
  }
}

// applyDensityAttribute sets data-density on <html> so descendant CSS
// rules can target it. theme-bootstrap.js also does this inline on
// first paint to avoid FOUC; this function exists so subsequent
// React-driven changes stay in sync.
export function applyDensityAttribute(value: Density): void {
  if (typeof document === 'undefined') return;
  try {
    document.documentElement.setAttribute('data-density', value);
  } catch {
    // Unusable DOM (jsdom edge cases) — ignore.
  }
}

const subscribers = new Set<(value: Density) => void>();

// subscribeDensity registers a listener invoked synchronously after a
// successful writeDensity call in the same tab. Returns an unsubscribe
// function. Does not cover cross-tab updates (would need a `storage`
// event listener); v1 scope is the one-tab case.
export function subscribeDensity(fn: (value: Density) => void): () => void {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}

// densityTableClasses returns the Tailwind utility string applied to the
// <table> element. Uses arbitrary-variant child selectors so every td/th
// inside the table picks up the override without touching individual
// cell className strings. Comfortable matches the pre-feature defaults
// (py-3, text-sm) so existing visual is unchanged.
//
// Padding scale (vertical):
//   comfortable: py-3  (12px)  — existing
//   compact:     py-2  (8px)   — ~33% less
//   dense:       py-1.5 (6px) — ~50% less
//
// Font size only shrinks at dense to keep compact readable.
export function densityTableClasses(density: Density): string {
  switch (density) {
    case 'compact':
      return '[&_td]:py-2 [&_th]:py-2';
    case 'dense':
      return '[&_td]:py-1.5 [&_th]:py-1.5 [&_td]:text-xs';
    case 'comfortable':
    default:
      return '';
  }
}
