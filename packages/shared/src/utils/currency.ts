import type { StripeCurrencyWarning } from '../types/stripeAccount';

// Single source of truth for currency knowledge (multi-currency spec §4,
// docs/superpowers/specs/billing/2026-08-21-multi-currency-design.md).
// Moved from apps/web/src/lib/currencies.ts (issue #3204) + the zero-decimal
// core of apps/api/src/services/stripeMoney.ts — keep their original rationale
// docblocks when moving.

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

// Currency-aware conversion between Stripe's smallest-currency-unit integers and
// our decimal major-unit strings. Stripe expects amounts in the currency's
// minor unit (cents for USD), EXCEPT for zero-decimal currencies (JPY, KRW, …)
// where the "smallest unit" IS the major unit — there a 1000 JPY charge is
// `unit_amount: 1000`, not 100000. Blindly multiplying by 100 over-charges those
// customers 100x, so every Stripe amount conversion must route through here.
//
// Source: https://docs.stripe.com/currencies#zero-decimal

// Stripe's zero-decimal set (https://docs.stripe.com/currencies#zero-decimal).
// ISO 4217 agrees for every code Breeze supports. 3-decimal currencies
// (BHD/KWD/OMR/JOD/TND) are deliberately NOT supported (spec §12) — the
// exponent is therefore exactly 0 or 2.
const ZERO_DECIMAL = new Set([
  'BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG',
  'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
]);

export function isZeroDecimal(currency: string): boolean {
  return ZERO_DECIMAL.has(String(currency).trim().toUpperCase());
}

export function minorUnitExponent(currency: string): 0 | 2 {
  return isZeroDecimal(currency) ? 0 : 2;
}

/** Major-unit amount → minor units (Stripe contract). Throws on non-finite. */
export function toMinorUnits(amountMajor: string | number, currency: string): number {
  const n = Number(amountMajor);
  if (!Number.isFinite(n)) throw new Error('currency: non-finite amount');
  return isZeroDecimal(currency) ? Math.round(n) : Math.round(n * 100);
}

/** Minor units → fixed-2 major-unit string (storage stays numeric(_,2)). */
export function fromMinorUnits(minor: string | number, currency: string): string {
  const n = Number(minor);
  if (!Number.isFinite(n)) throw new Error('currency: non-finite amount');
  return isZeroDecimal(currency) ? n.toFixed(2) : (n / 100).toFixed(2);
}

/**
 * Round a major-unit amount half-up at the currency's minor-unit boundary,
 * returning the fixed-2 string our numeric(_,2) columns store. For 2-decimal
 * currencies this is the classic cent round; for zero-decimal currencies the
 * result is a whole number of major units ('1001.00' for JPY).
 * Half-up = ties away from zero toward +∞ on the scaled value, matching the
 * existing quoteMath/invoiceMath discipline.
 */
export function roundToCurrency(value: string | number, currency: string): string {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error('currency: non-finite amount');
  if (isZeroDecimal(currency)) return Math.floor(n + 0.5).toFixed(2);
  return (Math.floor(n * 100 + 0.5) / 100).toFixed(2);
}

/** True when `value` is already exact at the currency's minor unit. */
export function isRepresentableInCurrency(value: string | number, currency: string): boolean {
  const n = Number(value);
  if (!Number.isFinite(n)) return false;
  return roundToCurrency(n, currency) === n.toFixed(2);
}

/**
 * THE money formatter (spec §9 — one formatter everywhere). Intl currency
 * style with a graceful fallback: an invalid/unknown code renders as
 * "12.00 XYZ" instead of throwing. `locale` undefined → the runtime default
 * (the web passes its resolved preference, which may be undefined).
 */
export function formatMoney(value: string | number | null | undefined, currency: string, locale?: string): string {
  const n = Number(value ?? 0);
  const safe = Number.isFinite(n) ? n : 0;
  const code = String(currency ?? '').trim().toUpperCase();
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency: code }).format(safe);
  } catch {
    return `${safe.toFixed(2)} ${code}`;
  }
}

/**
 * Warn-don't-block (multi-currency spec §10). `null` when the account currency
 * is unknown (nothing cached yet) or matches the document currency
 * (case-insensitive); otherwise the single warning shape shared by the pay-link
 * response, `getInvoice`, and the web. Never blocks and never converts.
 */
export function buildStripeCurrencyWarning(
  documentCurrency: string, accountCurrency: string | null | undefined,
): StripeCurrencyWarning | null {
  const doc = String(documentCurrency ?? '').trim().toUpperCase();
  const acc = String(accountCurrency ?? '').trim().toUpperCase();
  if (!acc || !doc || acc === doc) return null;
  return {
    code: 'CURRENCY_DIFFERS_FROM_STRIPE_ACCOUNT',
    documentCurrency: doc,
    accountCurrency: acc,
    message: `This document is in ${doc} but your Stripe account settles in ${acc}. Stripe will present ${doc} to the customer and convert it on settlement — you bear the FX spread and any conversion fee.`,
  };
}

/** @deprecated use formatMoney — kept so no caller breaks mid-rename. */
export const formatCurrencyAmount = formatMoney;

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
