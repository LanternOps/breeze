/**
 * The eight locales every device prompt string ships in (spec §3.1).
 * Order is the catalog's canonical order; keep it in sync with
 * agent/internal/promptcatalog (Locales).
 *
 * This file has no imports on purpose: Breeze Assist imports it through a path
 * alias (it has no @breeze/shared dependency), so it must stay self-contained.
 */
export const PROMPT_LOCALES = ['en', 'de-DE', 'es-419', 'fr-FR', 'fr-CA', 'it-IT', 'pt-BR', 'tr-TR'] as const;

export type PromptLocale = (typeof PROMPT_LOCALES)[number];

export const DEFAULT_PROMPT_LOCALE: PromptLocale = 'en';

const EXACT = new Map<string, PromptLocale>(PROMPT_LOCALES.map((l) => [l.toLowerCase(), l]));

/** Primary language subtag → locale. `fr-CA` is reached only by its own tag. */
const BY_LANGUAGE: Readonly<Record<string, PromptLocale>> = {
  en: 'en',
  de: 'de-DE',
  es: 'es-419',
  fr: 'fr-FR',
  it: 'it-IT',
  pt: 'pt-BR',
  tr: 'tr-TR',
};

export function isPromptLocale(value: unknown): value is PromptLocale {
  return typeof value === 'string' && (PROMPT_LOCALES as readonly string[]).includes(value);
}

/**
 * Map any OS / BCP 47 / POSIX locale tag onto one of the eight prompt locales.
 * Deterministic and total; mirrored by promptcatalog.Negotiate and pinned by
 * fixtures/prompt-catalog/locale-negotiation.json.
 *
 * 1. Trim ASCII whitespace. A tag holding anything but ASCII letters, digits
 *    and `_ - . @` → en (so Unicode case-folding or trim rules can never make
 *    the TS and Go answers differ). Lower-case, `_` → `-`, drop a POSIX
 *    `.codeset` and `@modifier`.
 * 2. An exact match among the eight wins.
 * 3. `fr-ca` followed by end or another subtag → fr-CA (an extension such as
 *    `-u-ca-gregory` does not change the region; a script subtag does).
 * 4. Otherwise the primary subtag (exactly; `fry` is not `fr`) picks the locale.
 * 5. Anything else → en.
 */
export function negotiatePromptLocale(tag: string): PromptLocale {
  if (typeof tag !== 'string') return DEFAULT_PROMPT_LOCALE;
  let t = tag.replace(/^[ \t\n\v\f\r]+|[ \t\n\v\f\r]+$/g, '');
  if (!/^[A-Za-z0-9_.@-]*$/.test(t)) return DEFAULT_PROMPT_LOCALE;
  t = t.toLowerCase().replace(/_/g, '-');
  const at = t.indexOf('@');
  if (at >= 0) t = t.slice(0, at);
  const dot = t.indexOf('.');
  if (dot >= 0) t = t.slice(0, dot);

  const exact = EXACT.get(t);
  if (exact) return exact;
  if (t.startsWith('fr-ca-')) return 'fr-CA';

  const dash = t.indexOf('-');
  const primary = dash >= 0 ? t.slice(0, dash) : t;
  return BY_LANGUAGE[primary] ?? DEFAULT_PROMPT_LOCALE;
}
