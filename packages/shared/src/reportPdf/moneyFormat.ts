/**
 * Money/percent/minute formatting for the PDF layer (#3198 spec §3.4), shared
 * by the three business PDF modules and (W03) `reportExport.ts`.
 *
 * `formatMoney` here is a THIN WRAPPER, not a second formatting core (ruling
 * P4). `utils/currency.ts` already ships THE money formatter (spec §9 — "one
 * formatter everywhere"), but its null/NaN handling coerces to `$0.00`, which
 * is correct for money math (an unset invoice field IS zero) and wrong for a
 * report cell (an unmeasured ratio or figure must never look like a measured
 * zero). This wrapper adds exactly that N/A guard in front and otherwise
 * delegates untouched — the numeric string is passed straight through so the
 * canonical formatter's own `Number()` conversion is the only one that runs.
 *
 * NO jsPDF import: W03's `reportExport.ts` uses `formatMoney` for XLSX display
 * cells too, and the web bundle must not pull jsPDF in for a number.
 */
import { formatMoney as canonicalFormatMoney } from '../utils/currency';

const NA = 'N/A';

export function formatMoney(
  value: string | number | null | undefined,
  currencyCode: string,
  locale?: string,
): string {
  if (value === null || value === undefined || value === '') return NA;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return NA;
  return canonicalFormatMoney(value, currencyCode, locale);
}

/** `ratio` is 0..1. NULL means NOT MEASURED and renders N/A — never 0%. */
export function formatPercent(
  ratio: number | null | undefined,
  digits = 1,
  locale = 'en-US',
): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return NA;
  return new Intl.NumberFormat(locale, {
    style: 'percent',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(ratio);
}

export function formatMinutes(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) return NA;
  const total = Math.round(minutes);
  const sign = total < 0 ? '-' : '';
  const abs = Math.abs(total);
  return `${sign}${Math.floor(abs / 60)}h ${String(abs % 60).padStart(2, '0')}m`;
}
