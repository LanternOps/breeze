// Locale-aware number formatting for the web console.
//
// Uses the user's explicit language preference when set; otherwise passes
// `undefined` to Intl so the browser locale applies (same behavior as the
// bare `toLocaleString()` calls these helpers replace). Phase 2 migrates
// scattered `.toFixed()` / hardcoded '$' call sites onto these helpers.
import { readLocalePreference } from '../appearance';

export function formatNumber(value: number, options: Intl.NumberFormatOptions = {}): string {
  return new Intl.NumberFormat(readLocalePreference(), options).format(value);
}

export function formatCurrency(
  value: number,
  currency = 'USD',
  options: Intl.NumberFormatOptions = {}
): string {
  return new Intl.NumberFormat(readLocalePreference(), {
    style: 'currency',
    currency,
    ...options,
  }).format(value);
}

/** value is a fraction: 0.42 → "42%" */
export function formatPercent(value: number, options: Intl.NumberFormatOptions = {}): string {
  return new Intl.NumberFormat(readLocalePreference(), { style: 'percent', ...options }).format(value);
}
