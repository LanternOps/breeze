import { DEFAULT_PROMPT_LOCALE, negotiatePromptLocale } from '@prompt-catalog/negotiate';

import en from '../locales/en.json';
import ptBR from '../locales/pt-BR.json';

/*
 * Helper UI localization (BRZ-7567, Phase 2, Wave 3).
 *
 * Deliberately not i18next: the Helper ships no runtime dependencies beyond
 * React/Zustand/Tauri, and `prompt/chrome.ts` already resolves the shared
 * prompt catalog with a tiny deterministic lookup. This layer is the same
 * shape (flat JSON catalogs, `{name}` parameters, `en` fallback) and reuses
 * the shared locale negotiation, so the Helper, the Agent and the API agree on
 * which of the eight locales a tag means. `en` is canonical; a locale without
 * a catalog, or a key missing from one, falls back to `en` (never throws).
 */

export type MessageKey = keyof typeof en;

type Catalog = Readonly<Partial<Record<MessageKey, string>>>;

/** Locales with a Helper catalog. Add a locale by adding its file here. */
const CATALOGS: Readonly<Record<string, Catalog>> = {
  en,
  'pt-BR': ptBR,
};

export const CATALOG_LOCALES: readonly string[] = Object.keys(CATALOGS);

/** `{name}` only; a value is never re-read as a placeholder. */
const PARAM = /\{([A-Za-z][A-Za-z0-9_]*)\}/g;

/** Any OS / BCP 47 / POSIX tag, onto one of the eight shared locales. */
export function resolveLocale(tag: string | null | undefined): string {
  return negotiatePromptLocale(tag ?? '');
}

/** The locale whose catalog is actually used for `tag` (`en` when none). */
export function catalogLocaleFor(tag: string | null | undefined): string {
  const locale = resolveLocale(tag);
  return locale in CATALOGS ? locale : DEFAULT_PROMPT_LOCALE;
}

export function translate(
  key: MessageKey,
  tag: string | null | undefined,
  params: Readonly<Record<string, string | number>> = {},
): string {
  const text = CATALOGS[catalogLocaleFor(tag)]?.[key] ?? en[key] ?? key;
  return text.replace(PARAM, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
  );
}

export { en as englishCatalog };
