import type { TimeFormat } from '@breeze/shared';

export const THEME_OPTIONS = ['light', 'dark', 'system'] as const;
export type ThemePreference = (typeof THEME_OPTIONS)[number];

export const DENSITY_OPTIONS = ['comfortable', 'compact', 'dense'] as const;
export type Density = (typeof DENSITY_OPTIONS)[number];

export const FONT_OPTIONS = ['breeze', 'system'] as const;
export type FontPreference = (typeof FONT_OPTIONS)[number];

export const TIME_FORMAT_OPTIONS = ['12h', '24h'] as const satisfies readonly TimeFormat[];
export type TimeFormatPreference = TimeFormat;

/**
 * Devices-list presentation of linked multi-boot profiles (#2138). 'on' =
 * when exactly one profile of a link group is online, its offline siblings
 * render as thin "expected offline" strips beneath it; 'off' = today's flat
 * list. Per-user, localStorage-persisted (NOT a query param / URL hash).
 */
export const LINKED_PROFILE_COLLAPSE_OPTIONS = ['on', 'off'] as const;
export type LinkedProfileCollapsePreference = (typeof LINKED_PROFILE_COLLAPSE_OPTIONS)[number];

export type AppearancePreferences = {
  theme?: ThemePreference;
  density?: Density;
  font?: FontPreference;
  timeFormat?: TimeFormatPreference;
};

export const DEFAULT_THEME: ThemePreference = 'system';
export const DEFAULT_DENSITY: Density = 'comfortable';
export const DEFAULT_FONT: FontPreference = 'breeze';
export const DEFAULT_LINKED_PROFILE_COLLAPSE: LinkedProfileCollapsePreference = 'on';

export const THEME_STORAGE_KEY = 'theme';
export const DENSITY_STORAGE_KEY = 'breeze.density';
export const FONT_STORAGE_KEY = 'breeze.font';
export const TIME_FORMAT_STORAGE_KEY = 'breeze.timeFormat';
export const LINKED_PROFILE_COLLAPSE_STORAGE_KEY = 'breeze.collapseLinkedProfiles';

export function isValidTheme(value: unknown): value is ThemePreference {
  return typeof value === 'string' && (THEME_OPTIONS as readonly string[]).includes(value);
}

export function isValidDensity(value: unknown): value is Density {
  return typeof value === 'string' && (DENSITY_OPTIONS as readonly string[]).includes(value);
}

export function isValidFont(value: unknown): value is FontPreference {
  return typeof value === 'string' && (FONT_OPTIONS as readonly string[]).includes(value);
}

export function isValidTimeFormat(value: unknown): value is TimeFormatPreference {
  return typeof value === 'string' && (TIME_FORMAT_OPTIONS as readonly string[]).includes(value);
}

export function isValidLinkedProfileCollapse(value: unknown): value is LinkedProfileCollapsePreference {
  return typeof value === 'string' && (LINKED_PROFILE_COLLAPSE_OPTIONS as readonly string[]).includes(value);
}

export function normalizeTheme(value: unknown): ThemePreference | undefined {
  return isValidTheme(value) ? value : undefined;
}

export function normalizeDensity(value: unknown): Density | undefined {
  return isValidDensity(value) ? value : undefined;
}

export function normalizeFont(value: unknown): FontPreference | undefined {
  return isValidFont(value) ? value : undefined;
}

export function normalizeTimeFormat(value: unknown): TimeFormatPreference | undefined {
  return isValidTimeFormat(value) ? value : undefined;
}

export function normalizeLinkedProfileCollapse(value: unknown): LinkedProfileCollapsePreference | undefined {
  return isValidLinkedProfileCollapse(value) ? value : undefined;
}

function readStorageValue(key: string): string | null {
  if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') {
    return null;
  }
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorageValue(key: string, value: string): void {
  if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') {
    return;
  }
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Quota / SecurityError: ignore. The DOM-applied value still takes effect.
  }
}

export function readThemePreference(): ThemePreference {
  return normalizeTheme(readStorageValue(THEME_STORAGE_KEY)) ?? DEFAULT_THEME;
}

export function readDensity(): Density {
  return normalizeDensity(readStorageValue(DENSITY_STORAGE_KEY)) ?? DEFAULT_DENSITY;
}

export function readFontPreference(): FontPreference {
  return normalizeFont(readStorageValue(FONT_STORAGE_KEY)) ?? DEFAULT_FONT;
}

export function readTimeFormatPreference(): TimeFormatPreference | undefined {
  return normalizeTimeFormat(readStorageValue(TIME_FORMAT_STORAGE_KEY));
}

export function readLinkedProfileCollapsePreference(): LinkedProfileCollapsePreference {
  return normalizeLinkedProfileCollapse(readStorageValue(LINKED_PROFILE_COLLAPSE_STORAGE_KEY))
    ?? DEFAULT_LINKED_PROFILE_COLLAPSE;
}

export function detectBrowserTimeFormat(): TimeFormatPreference {
  if (typeof Intl === 'undefined' || typeof Intl.DateTimeFormat !== 'function') {
    return '12h';
  }

  try {
    const hourCycle = new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions().hourCycle;
    return hourCycle === 'h23' || hourCycle === 'h24' ? '24h' : '12h';
  } catch {
    return '12h';
  }
}

export function readResolvedTimeFormatPreference(): TimeFormatPreference {
  return readTimeFormatPreference() ?? detectBrowserTimeFormat();
}

export function applyThemePreference(value: ThemePreference): void {
  if (typeof document === 'undefined') return;
  const resolved = value === 'system'
    ? (typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : value;

  document.documentElement.classList.toggle('dark', resolved === 'dark');
}

export function applyDensityAttribute(value: Density): void {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute('data-density', value);
}

export function applyFontAttribute(value: FontPreference): void {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute('data-font', value);
}

export function writeThemePreference(value: ThemePreference): void {
  if (!isValidTheme(value)) return;
  writeStorageValue(THEME_STORAGE_KEY, value);
  applyThemePreference(value);
  notifyTheme(value);
}

export function writeDensity(value: Density): void {
  if (!isValidDensity(value)) return;
  writeStorageValue(DENSITY_STORAGE_KEY, value);
  applyDensityAttribute(value);
  notifyDensity(value);
}

export function writeFontPreference(value: FontPreference): void {
  if (!isValidFont(value)) return;
  writeStorageValue(FONT_STORAGE_KEY, value);
  applyFontAttribute(value);
  notifyFont(value);
}

export function writeTimeFormatPreference(value: TimeFormatPreference): void {
  if (!isValidTimeFormat(value)) return;
  writeStorageValue(TIME_FORMAT_STORAGE_KEY, value);
  notifyTimeFormat(value);
}

export function writeLinkedProfileCollapsePreference(value: LinkedProfileCollapsePreference): void {
  if (!isValidLinkedProfileCollapse(value)) return;
  writeStorageValue(LINKED_PROFILE_COLLAPSE_STORAGE_KEY, value);
  notifyLinkedProfileCollapse(value);
}

export function applyAppearancePreferences(preferences: AppearancePreferences): void {
  if (preferences.theme) {
    writeThemePreference(preferences.theme);
  }
  if (preferences.density) {
    writeDensity(preferences.density);
  }
  if (preferences.font) {
    writeFontPreference(preferences.font);
  }
  if (preferences.timeFormat) {
    writeTimeFormatPreference(preferences.timeFormat);
  }
}

const themeSubscribers = new Set<(value: ThemePreference) => void>();
const densitySubscribers = new Set<(value: Density) => void>();
const fontSubscribers = new Set<(value: FontPreference) => void>();
const timeFormatSubscribers = new Set<(value: TimeFormatPreference) => void>();
const linkedProfileCollapseSubscribers = new Set<(value: LinkedProfileCollapsePreference) => void>();

function notifyTheme(value: ThemePreference): void {
  for (const fn of themeSubscribers) {
    try {
      fn(value);
    } catch {
      // Subscriber errors must not break setter.
    }
  }
}

function notifyDensity(value: Density): void {
  for (const fn of densitySubscribers) {
    try {
      fn(value);
    } catch {
      // Subscriber errors must not break setter.
    }
  }
}

function notifyFont(value: FontPreference): void {
  for (const fn of fontSubscribers) {
    try {
      fn(value);
    } catch {
      // Subscriber errors must not break setter.
    }
  }
}

function notifyTimeFormat(value: TimeFormatPreference): void {
  for (const fn of timeFormatSubscribers) {
    try {
      fn(value);
    } catch {
      // Subscriber errors must not break setter.
    }
  }
}

function notifyLinkedProfileCollapse(value: LinkedProfileCollapsePreference): void {
  for (const fn of linkedProfileCollapseSubscribers) {
    try {
      fn(value);
    } catch {
      // Subscriber errors must not break setter.
    }
  }
}

export function subscribeTheme(fn: (value: ThemePreference) => void): () => void {
  themeSubscribers.add(fn);
  return () => {
    themeSubscribers.delete(fn);
  };
}

export function subscribeDensity(fn: (value: Density) => void): () => void {
  densitySubscribers.add(fn);
  return () => {
    densitySubscribers.delete(fn);
  };
}

export function subscribeFont(fn: (value: FontPreference) => void): () => void {
  fontSubscribers.add(fn);
  return () => {
    fontSubscribers.delete(fn);
  };
}

export function subscribeTimeFormat(fn: (value: TimeFormatPreference) => void): () => void {
  timeFormatSubscribers.add(fn);
  return () => {
    timeFormatSubscribers.delete(fn);
  };
}

export function subscribeLinkedProfileCollapse(fn: (value: LinkedProfileCollapsePreference) => void): () => void {
  linkedProfileCollapseSubscribers.add(fn);
  return () => {
    linkedProfileCollapseSubscribers.delete(fn);
  };
}

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
