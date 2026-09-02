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

// ---------------------------------------------------------------------------
// Exact decimal arithmetic (review #2). Money rounding MUST NOT go through a
// binary double between steps: 0.02 × 7.25 is 0.14499999999999999 as a double,
// so `Math.floor(n * 100 + 0.5)` gave 0.14 while Postgres' ROUND() on the same
// numeric columns gave 0.15. Every helper below parses its operands into an
// unscaled BigInt + decimal scale, multiplies/rounds in integer space, and only
// then formats — so ties are exact and the JS and SQL paths agree.
// ---------------------------------------------------------------------------

interface Decimal { neg: boolean; unscaled: bigint; scale: number }

const DECIMAL_RE = /^([+-])?(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/i;

/** Shortest round-trip repr for numbers (what `String(n)` gives) — the decimal a
 *  user/JSON most plausibly meant (1.005, not 1.00499999999999989...). */
function parseDecimal(value: string | number): Decimal {
  let text: string;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('currency: non-finite amount');
    text = String(value);
  } else {
    text = value.trim();
    if (text === '') return { neg: false, unscaled: 0n, scale: 0 };
    if (!DECIMAL_RE.test(text)) {
      // Anything else Number() accepts (e.g. '0x10') is normalized through it;
      // non-finite throws exactly like the historical implementation.
      const n = Number(text);
      if (!Number.isFinite(n)) throw new Error('currency: non-finite amount');
      text = String(n);
    }
  }
  const m = DECIMAL_RE.exec(text);
  if (!m || (m[2] === '' && (m[3] ?? '') === '')) throw new Error('currency: non-finite amount');
  const neg = m[1] === '-';
  const intPart = m[2] ?? '';
  const fracPart = m[3] ?? '';
  const exp = m[4] ? Number(m[4]) : 0;
  let digits = `${intPart}${fracPart}`.replace(/^0+(?=\d)/, '');
  let scale = fracPart.length - exp;
  if (scale < 0) { digits = digits + '0'.repeat(-scale); scale = 0; }
  return { neg, unscaled: BigInt(digits || '0'), scale };
}

/** Round a (magnitude, scale) to `exp` decimals, half-up toward +∞ on the signed
 *  value — the same tie direction as the historical `Math.floor(n*100 + 0.5)`
 *  (so -1.005 → -1.00, not -1.01). Returns the signed minor-unit integer. */
function roundScaled(d: Decimal, exp: number): bigint {
  let q: bigint;
  if (d.scale <= exp) {
    q = d.unscaled * 10n ** BigInt(exp - d.scale);
  } else {
    const div = 10n ** BigInt(d.scale - exp);
    q = d.unscaled / div;
    const twiceRem = (d.unscaled % div) * 2n;
    if (d.neg ? twiceRem > div : twiceRem >= div) q += 1n;
  }
  return d.neg ? -q : q;
}

/** Signed minor-unit integer → the fixed-2 major-unit string our numeric(_,2)
 *  columns store ('1001.00' for JPY, '-1.01' for USD; never '-0.00'). */
function formatMinor(minor: bigint, exp: number): string {
  if (minor === 0n) return '0.00';
  const neg = minor < 0n;
  const mag = neg ? -minor : minor;
  const div = 10n ** BigInt(exp);
  const whole = mag / div;
  const frac = (mag % div).toString().padStart(exp, '0').padEnd(2, '0');
  return `${neg ? '-' : ''}${whole}.${frac}`;
}

/**
 * Round a major-unit amount half-up at the currency's minor-unit boundary,
 * returning the fixed-2 string our numeric(_,2) columns store. For 2-decimal
 * currencies this is the classic cent round; for zero-decimal currencies the
 * result is a whole number of major units ('1001.00' for JPY).
 * Half-up = ties toward +∞ on the scaled value, matching the existing
 * quoteMath/invoiceMath discipline — evaluated on the EXACT decimal, never on
 * a binary double ('1.005' → '1.01'; 0.02 × 7.25 → '0.15').
 */
export function roundToCurrency(value: string | number, currency: string): string {
  const exp = minorUnitExponent(currency);
  return formatMinor(roundScaled(parseDecimal(value), exp), exp);
}

/**
 * quantity × unitPrice with ONE half-up round at the currency's minor unit,
 * computed entirely in scaled-integer space. This is THE line-total primitive
 * (invoiceMath/quoteMath `computeLineTotal`, the timesheet labor rule) and is
 * what keeps the JS figures identical to `ROUND(quantity * rate, scale)` in SQL.
 */
export function multiplyToCurrency(a: string | number, b: string | number, currency: string): string {
  const x = parseDecimal(a);
  const y = parseDecimal(b);
  const exp = minorUnitExponent(currency);
  const product: Decimal = { neg: x.neg !== y.neg, unscaled: x.unscaled * y.unscaled, scale: x.scale + y.scale };
  return formatMinor(roundScaled(product, exp), exp);
}

/** True when `value` is already exact at the currency's minor unit (no non-zero
 *  digit beyond the exponent in the exact decimal — '1.0151' is NOT representable
 *  in USD even though it happens to round to its own 2-dp float). */
export function isRepresentableInCurrency(value: string | number, currency: string): boolean {
  let d: Decimal;
  try { d = parseDecimal(value); } catch { return false; }
  const exp = minorUnitExponent(currency);
  if (d.scale <= exp) return true;
  return d.unscaled % 10n ** BigInt(d.scale - exp) === 0n;
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
 * Warn-don't-block (multi-currency spec §10). The single warning shape shared by
 * the pay-link response, `getInvoice`, and the web. Never blocks, never converts.
 *
 * - account currency known and equal (case-insensitive) → `null` (nothing to say)
 * - known and different → `CURRENCY_DIFFERS_FROM_STRIPE_ACCOUNT`
 * - UNKNOWN (never cached) → `STRIPE_ACCOUNT_CURRENCY_UNKNOWN`. An unknown
 *   account currency must not be read as "matches" — existing connections
 *   predate the cache, so silence here would hide every mismatch for them
 *   until someone happened to open the settings page (#3777 review F6).
 * - `null` only when the DOCUMENT currency is missing (nothing to compare).
 */
export function buildStripeCurrencyWarning(
  documentCurrency: string, accountCurrency: string | null | undefined,
): StripeCurrencyWarning | null {
  const doc = String(documentCurrency ?? '').trim().toUpperCase();
  const acc = String(accountCurrency ?? '').trim().toUpperCase();
  if (!doc) return null;
  if (!acc) {
    return {
      code: 'STRIPE_ACCOUNT_CURRENCY_UNKNOWN',
      documentCurrency: doc,
      accountCurrency: null,
      message: `Your Stripe account's settlement currency is not cached, so it could not be checked against this ${doc} document. Refresh your Stripe account details under Settings → Integrations to enable the mismatch check.`,
    };
  }
  if (acc === doc) return null;
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
