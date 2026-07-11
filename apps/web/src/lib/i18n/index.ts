// Shared i18next instance for all React islands.
//
// Namespaces are auto-registered from apps/web/src/locales/<locale>/<ns>.json:
// English is bundled eagerly (synchronous first render + fallback language);
// every other locale is code-split and loaded on demand, so adding thousands
// of keys does not grow the common island bundle for English users.
//
// SSR intentionally renders English; the resolved client locale applies during
// hydration. Cookie-based SSR locale selection is deferred beyond Phase 2.
import i18next, { type Resource } from 'i18next';
import { initReactI18next } from 'react-i18next';
import {
  readResolvedLocalePreference,
  subscribeLocale,
  writeLocalePreference,
  type LocalePreference,
} from '../appearance';

const eagerEnglish = import.meta.glob('../../locales/en/*.json', { eager: true });
const lazyLocales = import.meta.glob([
  '../../locales/*/*.json',
  '!../../locales/en/*.json',
]);

function parseLocalePath(path: string): { locale: string; ns: string } | null {
  const match = path.match(/locales\/([^/]+)\/([^/]+)\.json$/);
  return match ? { locale: match[1], ns: match[2] } : null;
}

const resources: Resource = { en: {} };
for (const [path, mod] of Object.entries(eagerEnglish)) {
  const parsed = parseLocalePath(path);
  if (!parsed) continue;
  (resources.en as Record<string, unknown>)[parsed.ns] = (mod as { default: unknown }).default;
}

const loadedLocales = new Set<string>(['en']);
const localeLoadPromises = new Map<LocalePreference, Promise<void>>();

/** Idempotently load a locale's namespace chunks into i18next. */
export function loadLocale(locale: LocalePreference): Promise<void> {
  if (loadedLocales.has(locale)) return Promise.resolve();

  const inFlight = localeLoadPromises.get(locale);
  if (inFlight) return inFlight;

  const entries = Object.entries(lazyLocales).filter(
    ([path]) => parseLocalePath(path)?.locale === locale
  );
  const loadPromise = Promise.all(
    entries.map(async ([path, loader]) => {
      const parsed = parseLocalePath(path);
      if (!parsed) return;
      const mod = (await loader()) as { default: Record<string, unknown> };
      i18next.addResourceBundle(locale, parsed.ns, mod.default, true, true);
    })
  )
    .then(() => {
      loadedLocales.add(locale);
    })
    .finally(() => {
      if (localeLoadPromises.get(locale) === loadPromise) {
        localeLoadPromises.delete(locale);
      }
    });

  localeLoadPromises.set(locale, loadPromise);
  return loadPromise;
}

type LocaleRuntimeDependencies = {
  loadLocale: (locale: LocalePreference) => Promise<void>;
  changeLanguage: (locale: LocalePreference) => Promise<unknown>;
  reportError?: (error: unknown) => void;
};

const defaultLocaleRuntimeDependencies: LocaleRuntimeDependencies = {
  loadLocale,
  changeLanguage: locale => i18next.changeLanguage(locale),
  reportError: error => console.error('Failed to apply locale; falling back to English.', error),
};

let latestLocaleRequest = 0;
let localeChangeQueue: Promise<void> = Promise.resolve();
// A failed lazy-locale request can leave the persisted preference pointing at
// a locale whose resources are unavailable. In that case formatters must
// follow the language actually rendered by i18next, not the stored preference.
// This override is cleared synchronously when a new request begins so an
// explicit preference still affects number/date formatting immediately while
// its locale chunk is loading.
let fallbackFormattingLocale: LocalePreference | undefined;

/** @internal Formatting bridge for the lazy-locale fallback state. */
export function getFallbackFormattingLocale(): LocalePreference | undefined {
  return fallbackFormattingLocale;
}

async function changeLanguageIfLatest(
  requestId: number,
  locale: LocalePreference,
  dependencies: LocaleRuntimeDependencies
): Promise<void> {
  const change = localeChangeQueue.then(async () => {
    if (requestId !== latestLocaleRequest) return;
    await dependencies.changeLanguage(locale);
  });
  // Keep later requests moving even if an injected/runtime change rejects.
  localeChangeQueue = change.catch(() => undefined);
  await change;
}

/** @internal Exported so the asynchronous request coordinator can be tested. */
export async function applyLocale(
  locale: LocalePreference,
  dependencies: LocaleRuntimeDependencies = defaultLocaleRuntimeDependencies
): Promise<void> {
  const requestId = ++latestLocaleRequest;
  fallbackFormattingLocale = undefined;

  try {
    await dependencies.loadLocale(locale);
    await changeLanguageIfLatest(requestId, locale, dependencies);
  } catch (error) {
    // A stale failure must never undo a newer locale request. If the latest
    // locale cannot load, deterministically retain/switch to eager English.
    if (requestId !== latestLocaleRequest) return;
    dependencies.reportError?.(error);
    try {
      await dependencies.loadLocale('en');
      await changeLanguageIfLatest(requestId, 'en', dependencies);
      if (requestId === latestLocaleRequest) fallbackFormattingLocale = 'en';
    } catch {
      // Locale changes are best-effort UI state and must not create an
      // unhandled rejection in appearance-store subscribers.
    }
  }
}

if (!i18next.isInitialized) {
  void i18next.use(initReactI18next).init({
    resources,
    lng: 'en',
    fallbackLng: 'en',
    defaultNS: 'common',
    interpolation: { escapeValue: false },
    initAsync: false,
    returnNull: false,
  });

  if (typeof window !== 'undefined') {
    const resolved = readResolvedLocalePreference();
    if (resolved !== 'en') void applyLocale(resolved);
  }
  subscribeLocale(locale => {
    void applyLocale(locale);
  });
}

export const i18n = i18next;

/** Persist the console language; the appearance subscriber switches i18next. */
export function setLocale(locale: LocalePreference): void {
  writeLocalePreference(locale);
}
