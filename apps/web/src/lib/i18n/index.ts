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

/** Idempotently load a locale's namespace chunks into i18next. */
export async function loadLocale(locale: LocalePreference): Promise<void> {
  if (loadedLocales.has(locale)) return;
  const entries = Object.entries(lazyLocales).filter(
    ([path]) => parseLocalePath(path)?.locale === locale
  );
  await Promise.all(
    entries.map(async ([path, loader]) => {
      const parsed = parseLocalePath(path);
      if (!parsed) return;
      const mod = (await loader()) as { default: Record<string, unknown> };
      i18next.addResourceBundle(locale, parsed.ns, mod.default, true, true);
    })
  );
  loadedLocales.add(locale);
}

function applyLocale(locale: LocalePreference): void {
  void loadLocale(locale).then(() => i18next.changeLanguage(locale));
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
    if (resolved !== 'en') applyLocale(resolved);
  }
  subscribeLocale(applyLocale);
}

export const i18n = i18next;

/** Persist the console language; the appearance subscriber switches i18next. */
export function setLocale(locale: LocalePreference): void {
  writeLocalePreference(locale);
}
