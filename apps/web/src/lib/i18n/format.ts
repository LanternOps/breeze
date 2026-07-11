// Locale-aware number formatting for the web console.
//
// Uses the user's explicit language preference when set, otherwise the locale
// resolved from user → partner → browser by i18next. Phase 2 migrates scattered
// `.toFixed()` / hardcoded '$' / bare number `toLocaleString()` display paths
// onto these helpers.
import { readLocalePreference } from '../appearance';
import { getFallbackFormattingLocale, i18n } from './index';

export function resolvedFormattingLocale(): string | undefined {
  return getFallbackFormattingLocale()
    ?? readLocalePreference()
    ?? i18n.resolvedLanguage
    ?? i18n.language
    ?? undefined;
}

export function formatNumber(value: number, options: Intl.NumberFormatOptions = {}): string {
  return new Intl.NumberFormat(resolvedFormattingLocale(), options).format(value);
}

export function formatCurrency(
  value: number,
  currency = 'USD',
  options: Intl.NumberFormatOptions = {}
): string {
  return new Intl.NumberFormat(resolvedFormattingLocale(), {
    style: 'currency',
    currency,
    ...options,
  }).format(value);
}

/** value is a fraction: 0.42 → "42%" */
export function formatPercent(value: number, options: Intl.NumberFormatOptions = {}): string {
  return new Intl.NumberFormat(resolvedFormattingLocale(), { style: 'percent', ...options }).format(value);
}
