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
import * as Sentry from '@sentry/astro';
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
// `${ns}:${key}` pairs already reported this session, so a repeatedly
// re-rendered component with a missing key doesn't spam console/Sentry.
const reportedMissingKeys = new Set<string>();

const localizedDocumentTitleKeys: Record<string, string> = {
  '/': 'documentTitles.dashboard',
  '/devices': 'nav.devices',
  '/alerts': 'nav.alerts',
  '/tickets': 'nav.tickets',
  '/remote': 'nav.remoteAccess',
  '/scripts': 'nav.scripts',
  '/patches': 'nav.patches',
  '/vulnerabilities': 'nav.vulnerabilities',
  '/reports': 'nav.reports',
  '/profile': 'documentTitles.profileSettings',
  '/settings/profile': 'documentTitles.profileSettings',
};

/** Keep browser-owned metadata aligned with the language rendered by React islands. */
export function syncDocumentLocaleMetadata(
  pathname: string,
  targetDocument: Document = document,
): void {
  const locale = i18next.resolvedLanguage ?? i18next.language ?? 'en';
  targetDocument.documentElement.lang = locale;

  const normalizedPath = pathname !== '/' ? pathname.replace(/\/$/, '') : pathname;
  const titleKey = localizedDocumentTitleKeys[normalizedPath];
  if (titleKey) {
    targetDocument.title = `${i18next.t(titleKey, { ns: 'common' })} | Breeze RMM`;
  }
}

/**
 * Astro clears an island's `ssr` marker as soon as hydration is *dispatched* —
 * not when React has committed it. React hydrates concurrently (inside
 * `startTransition`), so its commit lands in a later scheduler task. Switching
 * the shared i18next language on the marker alone therefore fires MID-hydration:
 * the SSR DOM still holds English while the reconciling tree renders the stored
 * locale, and React aborts hydration with "server rendered text didn't match"
 * and re-renders every island from scratch.
 *
 * React schedules hydration at normal priority, so a callback queued at IDLE
 * priority is guaranteed to run after that commit has flushed. `timeout` keeps
 * the switch bounded on a page that never goes idle; `setTimeout` is the
 * fallback where `requestIdleCallback` is unavailable (Safari < 17, jsdom).
 */
function afterHydrationCommit(task: () => void): void {
  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(() => task(), { timeout: HYDRATION_COMMIT_TIMEOUT_MS });
    return;
  }
  setTimeout(task, 0);
}

const HYDRATION_COMMIT_TIMEOUT_MS = 500;

function scheduleAfterAstroHydration(task: () => void): void {
  const pendingSelector = 'astro-island[ssr][client="load"], astro-island[ssr][client="idle"]';
  const hasPendingIslands = () => document.querySelector(pendingSelector) !== null;
  const runAfterCommit = () => afterHydrationCommit(task);

  if (!hasPendingIslands()) {
    runAfterCommit();
    return;
  }

  const observer = new MutationObserver(() => {
    if (hasPendingIslands()) return;
    observer.disconnect();
    runAfterCommit();
  });
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['ssr'],
    subtree: true,
  });

  // Close the query/observe race if the final island hydrated between them.
  if (!hasPendingIslands()) {
    observer.disconnect();
    runAfterCommit();
  }
}

/** Apply the persisted locale after Astro's SSR islands finish hydrating. */
export function scheduleStoredLocaleAfterHydration(
  schedule: (task: () => void) => unknown = scheduleAfterAstroHydration,
): void {
  schedule(() => {
    const resolved = readResolvedLocalePreference();
    if (resolved !== i18next.language) void applyLocale(resolved);
  });
}

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
  // `locale` names the locale whose load/apply attempt this report describes
  // (the fallback report below passes 'en', since that's what failed there).
  reportError?: (error: unknown, locale: LocalePreference) => void;
};

// Sentry's ignoreErrors filters chunk-load failures by message
// (/Failed to fetch dynamically imported module/), so a raw captureException
// of the original error would be silently dropped. Callers wrap the original
// error in a distinct `i18n: ...` message before it reaches here so it
// survives that filter and shows up as an actionable, taggable event.
const defaultLocaleRuntimeDependencies: LocaleRuntimeDependencies = {
  loadLocale,
  changeLanguage: locale => i18next.changeLanguage(locale),
  reportError: (error, locale) => {
    console.error(`Failed to apply locale "${locale}".`, error);
    Sentry.captureException(error, { tags: { source: 'i18n-locale-load', locale } });
  },
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

export type ApplyLocaleResult = {
  locale: LocalePreference;
  /** True when THIS call's own attempt to apply `locale` failed and it dispatched the English fallback. */
  usedFallback: boolean;
};

/**
 * @internal Exported so the asynchronous request coordinator can be tested.
 *
 * Race semantics: the resolved value always describes the outcome of THIS
 * call's own attempt to load/apply `locale` — not necessarily the language
 * i18next ends up rendering, since a newer `applyLocale` call can supersede
 * this one at any await point (see `changeLanguageIfLatest`).
 * - `usedFallback: false` means this call's own load+changeLanguage for
 *   `locale` ran to completion without throwing. That includes the case
 *   where a newer request had already taken over by the time this call's
 *   change would have applied: `changeLanguageIfLatest` no-ops rather than
 *   throwing, so nothing failed under this call's authority.
 * - `usedFallback: true` means this call itself hit a load/change failure
 *   for `locale` while it still owned the request, and it dispatched the
 *   English fallback (regardless of whether that fallback itself fully
 *   applied — see the inner catch below).
 * - If a newer request had already superseded this one *before* the failure
 *   occurred, this call defers entirely (no fallback dispatched, since the
 *   newer request owns that) and resolves with `usedFallback: false`.
 * Callers that need the currently-rendered language should read
 * `i18n.language` / `i18n.resolvedLanguage` after awaiting, not infer it
 * from this return value alone.
 */
export async function applyLocale(
  locale: LocalePreference,
  dependencies: LocaleRuntimeDependencies = defaultLocaleRuntimeDependencies
): Promise<ApplyLocaleResult> {
  const requestId = ++latestLocaleRequest;
  fallbackFormattingLocale = undefined;

  try {
    await dependencies.loadLocale(locale);
    await changeLanguageIfLatest(requestId, locale, dependencies);
    return { locale, usedFallback: false };
  } catch (error) {
    // A stale failure must never undo a newer locale request. If the latest
    // locale cannot load, deterministically retain/switch to eager English.
    if (requestId !== latestLocaleRequest) return { locale, usedFallback: false };
    dependencies.reportError?.(
      new Error(`i18n: failed to load locale "${locale}"`, { cause: error }),
      locale
    );
    try {
      await dependencies.loadLocale('en');
      await changeLanguageIfLatest(requestId, 'en', dependencies);
      if (requestId === latestLocaleRequest) fallbackFormattingLocale = 'en';
    } catch (fallbackError) {
      // Locale changes are best-effort UI state and must not create an
      // unhandled rejection in appearance-store subscribers — but the double
      // failure (requested locale AND English fallback both unavailable)
      // still needs to reach telemetry instead of vanishing into an empty
      // catch.
      dependencies.reportError?.(
        new Error('i18n: fallback to English failed', { cause: fallbackError }),
        'en'
      );
    }
    return { locale, usedFallback: true };
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
    saveMissing: true,
    missingKeyHandler: (lngs, ns, key) => {
      try {
        const dedupeKey = `${ns}:${key}`;
        if (reportedMissingKeys.has(dedupeKey)) return;
        reportedMissingKeys.add(dedupeKey);

        if (import.meta.env.PROD) {
          Sentry.captureMessage('[i18n] missing key', {
            level: 'warning',
            tags: { ns, key, lngs: lngs.join(',') },
          });
        } else {
          console.warn(`[i18n] missing key: ${ns}:${key}`);
        }
      } catch {
        // Telemetry must never break translation lookups.
      }
    },
  });

  if (typeof window !== 'undefined') {
    const syncMetadata = () => syncDocumentLocaleMetadata(window.location.pathname);
    i18next.on('languageChanged', syncMetadata);
    document.addEventListener('astro:page-load', syncMetadata);
    syncMetadata();

    // Astro renders islands on the server with eager English resources. Applying
    // a stored non-English locale during module evaluation lets the client race
    // ahead of React hydration and guarantees text/attribute mismatches. Astro
    // removes each island's `ssr` marker when hydration completes; wait for all
    // eager/idle islands before switching the shared runtime.
    scheduleStoredLocaleAfterHydration();
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
