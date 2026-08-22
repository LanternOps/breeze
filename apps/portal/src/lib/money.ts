import { formatMoney } from '@breeze/shared';

/**
 * The portal's one money formatter (multi-currency spec §9): delegates to the
 * shared `formatMoney` and formats in the browser's locale. Portal i18n beyond
 * `navigator.language` is a listed follow-up (§15).
 */

/** The customer's browser locale; `'en'` when there is no `navigator` (Astro
 *  renders these views on the server first, so this must be SSR-safe). */
export function portalLocale(): string {
  if (typeof navigator !== 'undefined' && navigator?.language) return navigator.language;
  return 'en';
}

/** Formats the glyphs only — never converts. Unknown codes render as `12.00 XYZ`. */
export function money(value: string | number | null | undefined, currencyCode: string | null | undefined): string {
  return formatMoney(value, currencyCode || 'USD', portalLocale());
}
