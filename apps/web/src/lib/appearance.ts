import type { SupportedLocale, TimeFormat } from '@breeze/shared';

export const THEME_OPTIONS = ['light', 'dark', 'system'] as const;
export type ThemePreference = (typeof THEME_OPTIONS)[number];

export const DENSITY_OPTIONS = ['comfortable', 'compact', 'dense'] as const;
export type Density = (typeof DENSITY_OPTIONS)[number];

export const FONT_OPTIONS = ['breeze', 'system'] as const;
export type FontPreference = (typeof FONT_OPTIONS)[number];

export const TIME_FORMAT_OPTIONS = ['12h', '24h'] as const satisfies readonly TimeFormat[];
export type TimeFormatPreference = TimeFormat;

export const LOCALE_OPTIONS = ['en', 'pt-BR', 'es-419', 'fr-FR', 'fr-CA', 'de-DE'] as const;
export type LocalePreference = SupportedLocale;

/**
 * Devices-list presentation of linked multi-boot profiles (#2138). 'on' =
 * when exactly one profile of a link group is online, its offline siblings
 * render as thin "expected offline" strips beneath it (and all-offline groups
 * get a left-edge bar); 'off' = a plain flat list with no grouping markers.
 * Per-user, localStorage-persisted (NOT a query param / URL hash).
 */
export const LINKED_PROFILE_COLLAPSE_OPTIONS = ['on', 'off'] as const;
export type LinkedProfileCollapsePreference = (typeof LINKED_PROFILE_COLLAPSE_OPTIONS)[number];

export type AppearancePreferences = {
  theme?: ThemePreference;
  density?: Density;
  font?: FontPreference;
  timeFormat?: TimeFormatPreference;
  locale?: LocalePreference;
};

export const DEFAULT_THEME: ThemePreference = 'system';
export const DEFAULT_DENSITY: Density = 'comfortable';
export const DEFAULT_FONT: FontPreference = 'breeze';
export const DEFAULT_LINKED_PROFILE_COLLAPSE: LinkedProfileCollapsePreference = 'on';

export const THEME_STORAGE_KEY = 'theme';
export const DENSITY_STORAGE_KEY = 'breeze.density';
export const FONT_STORAGE_KEY = 'breeze.font';
export const TIME_FORMAT_STORAGE_KEY = 'breeze.timeFormat';
export const LOCALE_STORAGE_KEY = 'breeze.locale';
export const PARTNER_LOCALE_STORAGE_KEY = 'breeze.partnerLocale';
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

export function isValidLocale(value: unknown): value is LocalePreference {
  return typeof value === 'string' && (LOCALE_OPTIONS as readonly string[]).includes(value);
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

export function normalizeLocale(value: unknown): LocalePreference | undefined {
  return isValidLocale(value) ? value : undefined;
}

export function normalizeLinkedProfileCollapse(value: unknown): LinkedProfileCollapsePreference | undefined {
  return isValidLinkedProfileCollapse(value) ? value : undefined;
}

function readStorageValue(key: string): string | null {
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    return window.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeStorageValue(key: string, value: string): void {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    window.localStorage?.setItem(key, value);
  } catch {
    // Quota / SecurityError: ignore. The DOM-applied value still takes effect.
  }
}

function removeStorageValue(key: string): void {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    window.localStorage?.removeItem(key);
  } catch {
    // Storage unavailable: the runtime resolution still uses browser defaults.
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

// Warn at most once per storage key per session so a persistently corrupt
// value (rather than a transient one-off) doesn't spam the console on every
// read (readResolvedLocalePreference is called on most navigations).
const warnedCorruptLocaleKeys = new Set<string>();

function readLocaleStorageValue(key: string): LocalePreference | undefined {
  const raw = readStorageValue(key);
  if (raw === null || raw === '') return undefined;

  const normalized = normalizeLocale(raw);
  if (normalized === undefined && !warnedCorruptLocaleKeys.has(key)) {
    warnedCorruptLocaleKeys.add(key);
    console.warn(
      `[appearance] Discarding unsupported locale value stored in localStorage["${key}"]: ${JSON.stringify(raw)}`
    );
  }
  return normalized;
}

export function readLocalePreference(): LocalePreference | undefined {
  return readLocaleStorageValue(LOCALE_STORAGE_KEY);
}

export function readPartnerLocalePreference(): LocalePreference | undefined {
  return readLocaleStorageValue(PARTNER_LOCALE_STORAGE_KEY);
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

export function detectBrowserLocale(): LocalePreference {
  if (typeof navigator === 'undefined') {
    return 'en';
  }
  const candidates = [...(navigator.languages ?? []), navigator.language].filter(
    (v): v is string => typeof v === 'string' && v.length > 0
  );
  for (const candidate of candidates) {
    const exactMatch = LOCALE_OPTIONS.find(
      (option) => option.toLowerCase() === candidate.toLowerCase()
    );
    if (exactMatch) return exactMatch;

    const languageMatch = LOCALE_OPTIONS.find(
      (option) => option.split('-')[0].toLowerCase() === candidate.split('-')[0].toLowerCase()
    );
    if (languageMatch) return languageMatch;
  }
  return 'en';
}

export function readResolvedLocalePreference(): LocalePreference {
  return readLocalePreference() ?? readPartnerLocalePreference() ?? detectBrowserLocale();
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

export function writeLocalePreference(value: LocalePreference): void {
  if (!isValidLocale(value)) return;
  writeStorageValue(LOCALE_STORAGE_KEY, value);
  notifyLocale(value);
}

/** Cache the current partner default without turning it into a user choice. */
export function writePartnerLocalePreference(value: LocalePreference | undefined): void {
  if (value === undefined) {
    removeStorageValue(PARTNER_LOCALE_STORAGE_KEY);
  } else if (isValidLocale(value)) {
    writeStorageValue(PARTNER_LOCALE_STORAGE_KEY, value);
  } else {
    return;
  }
  notifyLocale(readResolvedLocalePreference());
}

/**
 * Synchronize server-owned locale state after authentication.
 *
 * An absent user locale deliberately clears a previous account's cached user
 * choice before resolving the partner default, preventing cross-account locale
 * leakage on shared browsers.
 */
export function applyResolvedLocalePreferences(
  userLocale: unknown,
  partnerLocale: unknown,
): LocalePreference {
  const normalizedUser = normalizeLocale(userLocale);
  const normalizedPartner = normalizeLocale(partnerLocale);

  if (normalizedUser) writeStorageValue(LOCALE_STORAGE_KEY, normalizedUser);
  else removeStorageValue(LOCALE_STORAGE_KEY);

  if (normalizedPartner) writeStorageValue(PARTNER_LOCALE_STORAGE_KEY, normalizedPartner);
  else removeStorageValue(PARTNER_LOCALE_STORAGE_KEY);

  const resolved = normalizedUser ?? normalizedPartner ?? detectBrowserLocale();
  notifyLocale(resolved);
  return resolved;
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
  if (preferences.locale) {
    writeLocalePreference(preferences.locale);
  }
}

const themeSubscribers = new Set<(value: ThemePreference) => void>();
const densitySubscribers = new Set<(value: Density) => void>();
const fontSubscribers = new Set<(value: FontPreference) => void>();
const timeFormatSubscribers = new Set<(value: TimeFormatPreference) => void>();
const localeSubscribers = new Set<(value: LocalePreference) => void>();
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

function notifyLocale(value: LocalePreference): void {
  for (const fn of localeSubscribers) {
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

export function subscribeLocale(fn: (value: LocalePreference) => void): () => void {
  localeSubscribers.add(fn);
  return () => {
    localeSubscribers.delete(fn);
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
