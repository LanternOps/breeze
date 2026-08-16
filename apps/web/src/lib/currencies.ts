// Curated ISO 4217 currency list for the partner-level billing currency picker
// (issue #3204). Before this, the only way to set `partners.currency_code` was a
// free-text `maxLength={3}` input on the billing settings page — which happily
// accepted "XXX", "eur " or a typo'd "GPB" and only surfaced the mistake once an
// invoice rendered in a currency nobody uses.
//
// Deliberately curated rather than derived from Intl: there is no standard
// runtime enumeration of ISO 4217 codes (`Intl.supportedValuesOf('currency')`
// returns ~300 entries including historical and fund codes like XAU/XDR), and a
// 300-entry picker is worse than a 34-entry one for the MSP markets Breeze
// actually serves. `isKnownCurrency` exists so callers can render an unknown
// stored value instead of silently dropping it (same principle as
// TimezoneSelect keeping a legacy zone visible).

export const CURRENCY_CODES = [
  'AED', 'ARS', 'AUD', 'BRL', 'CAD', 'CHF', 'CLP', 'COP', 'CZK', 'DKK',
  'EUR', 'GBP', 'HKD', 'HUF', 'IDR', 'ILS', 'INR', 'JPY', 'KES', 'MXN',
  'MYR', 'NGN', 'NOK', 'NZD', 'PHP', 'PLN', 'RON', 'SAR', 'SEK', 'SGD',
  'THB', 'TRY', 'USD', 'ZAR',
] as const;

export type CurrencyCode = (typeof CURRENCY_CODES)[number];

const KNOWN = new Set<string>(CURRENCY_CODES);

export function isKnownCurrency(code: string): boolean {
  return KNOWN.has(code.trim().toUpperCase());
}

// Display names come from Intl rather than the locale catalogs on purpose: 34
// codes x 8 locales would be 272 hand-translated strings that the platform
// already knows, and every one of them would be a parity/duplicate-baseline
// liability. Cached per (locale, code) because the picker renders the whole
// list and constructing Intl.DisplayNames is not free.
const labelCache = new Map<string, string>();

/**
 * Localized currency name for `code`, e.g. "US Dollar" / "Dollar des
 * États-Unis". Falls back to the bare code on runtimes without
 * `Intl.DisplayNames` (or for a code it does not recognize), so the option is
 * always selectable.
 */
export function currencyLabel(code: string, locale: string): string {
  const normalized = code.trim().toUpperCase();
  // Separator is '|', which appears in neither a BCP-47 tag nor an ISO 4217
  // code, so the two halves cannot run together into a colliding key.
  const cacheKey = `${locale}|${normalized}`;
  const cached = labelCache.get(cacheKey);
  if (cached !== undefined) return cached;

  let label = normalized;
  try {
    const name = new Intl.DisplayNames([locale], { type: 'currency' }).of(normalized);
    // DisplayNames echoes the input back when it has no name for the code.
    if (name && name !== normalized) label = `${normalized} — ${name}`;
  } catch {
    // Old runtime or unsupported locale: the bare code is still meaningful.
  }
  labelCache.set(cacheKey, label);
  return label;
}

/** Currency options for a select, with `current` appended when it is off-list. */
export function currencyOptions(current: string): string[] {
  const normalized = current.trim().toUpperCase();
  return normalized && !KNOWN.has(normalized)
    ? [normalized, ...CURRENCY_CODES]
    : [...CURRENCY_CODES];
}
