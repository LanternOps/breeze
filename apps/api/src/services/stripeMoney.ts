// apps/api/src/services/stripeMoney.ts
//
// Currency-aware conversion between Stripe's smallest-currency-unit integers and
// our decimal major-unit strings. Stripe expects amounts in the currency's
// minor unit (cents for USD), EXCEPT for zero-decimal currencies (JPY, KRW, …)
// where the "smallest unit" IS the major unit — there a 1000 JPY charge is
// `unit_amount: 1000`, not 100000. Blindly multiplying by 100 over-charges those
// customers 100x, so every Stripe amount conversion must route through here.
//
// Source: https://docs.stripe.com/currencies#zero-decimal

const ZERO_DECIMAL = new Set([
  'BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG',
  'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
]);

/** Convert a major-unit amount (e.g. "10.50" / 10.5) into Stripe's minor units. */
export function toMinorUnits(amountMajor: string | number, currency: string): number {
  const c = String(currency).toUpperCase();
  const n = Number(amountMajor);
  return ZERO_DECIMAL.has(c) ? Math.round(n) : Math.round(n * 100);
}

/** Convert Stripe minor units back into a fixed-2 major-unit string. */
export function fromMinorUnits(minor: string | number, currency: string): string {
  const c = String(currency).toUpperCase();
  return ZERO_DECIMAL.has(c) ? Number(minor).toFixed(2) : (Number(minor) / 100).toFixed(2);
}

export function isZeroDecimal(currency: string): boolean {
  return ZERO_DECIMAL.has(String(currency).toUpperCase());
}
