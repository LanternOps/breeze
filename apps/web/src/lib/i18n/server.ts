// Pure server-side translation for `.astro` shells (titles, meta descriptions,
// static headings, the 404/500 error pages).
//
// Deliberately NOT i18next: `.astro` rendering passes the locale explicitly as
// an argument, so a pure function avoids any shared-instance language state
// racing across concurrent SSR requests. React islands keep the client runtime
// and its hydration swap (Phase-3 Decision 1) — nothing here touches them.
//
// Scope is the `pages` namespace only. `.astro` files must never import
// ../i18n/index.ts, which would initialize the client singleton during SSR.
import type { SupportedLocale } from '@breeze/shared';

// Auto-discovered, exactly like the client runtime in ./index.ts: adding a
// locale directory is enough, there is no literal locale list to keep in sync.
const bundleModules = import.meta.glob('../../locales/*/pages.json', { eager: true });

const bundles: Record<string, Record<string, unknown>> = {};
for (const [path, module] of Object.entries(bundleModules)) {
  const locale = /locales\/([^/]+)\/pages\.json$/.exec(path)?.[1];
  if (!locale) continue;
  bundles[locale] = (module as { default: Record<string, unknown> }).default;
}

const FALLBACK_LOCALE = 'en';

function lookup(locale: string, key: string): string | undefined {
  let node: unknown = bundles[locale];
  for (const part of key.split('.')) {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === 'string' ? node : undefined;
}

/**
 * Resolves `key` (a dot-path inside `locales/<locale>/pages.json`) for the
 * request's locale, falling back to English and finally to the raw key so a
 * typo is visible rather than blank. `{{var}}` placeholders are filled from
 * `vars`; an unknown placeholder is left intact for the same reason.
 */
export function tServer(
  locale: SupportedLocale | undefined,
  key: string,
  vars: Record<string, string | number> = {},
): string {
  const raw = (locale && lookup(locale, key)) ?? lookup(FALLBACK_LOCALE, key) ?? key;
  return raw.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match,
  );
}

/** Locale catalogs discovered at build time. Exported for the co-located tests. */
export const serverBundleLocales = Object.keys(bundles).sort();

export { resolveServerLocale, resolveLocaleFromAcceptLanguage, resolveLocaleFromCookie } from './serverLocale';
