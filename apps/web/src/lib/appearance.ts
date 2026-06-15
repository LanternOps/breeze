export const THEME_OPTIONS = ['light', 'dark', 'system'] as const;
export type ThemePreference = (typeof THEME_OPTIONS)[number];

export const DENSITY_OPTIONS = ['comfortable', 'compact', 'dense'] as const;
export type Density = (typeof DENSITY_OPTIONS)[number];

export const FONT_OPTIONS = ['breeze', 'system'] as const;
export type FontPreference = (typeof FONT_OPTIONS)[number];

export type AppearancePreferences = {
  theme?: ThemePreference;
  density?: Density;
  font?: FontPreference;
};

export const DEFAULT_THEME: ThemePreference = 'system';
export const DEFAULT_DENSITY: Density = 'comfortable';
export const DEFAULT_FONT: FontPreference = 'breeze';

export const THEME_STORAGE_KEY = 'theme';
export const DENSITY_STORAGE_KEY = 'breeze.density';
export const FONT_STORAGE_KEY = 'breeze.font';

export function isValidTheme(value: unknown): value is ThemePreference {
  return typeof value === 'string' && (THEME_OPTIONS as readonly string[]).includes(value);
}

export function isValidDensity(value: unknown): value is Density {
  return typeof value === 'string' && (DENSITY_OPTIONS as readonly string[]).includes(value);
}

export function isValidFont(value: unknown): value is FontPreference {
  return typeof value === 'string' && (FONT_OPTIONS as readonly string[]).includes(value);
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
}

const themeSubscribers = new Set<(value: ThemePreference) => void>();
const densitySubscribers = new Set<(value: Density) => void>();
const fontSubscribers = new Set<(value: FontPreference) => void>();

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
