// THE labour rule (#9561) — one implementation for the API (invoice lines,
// timesheet totals, billables export, approval gate, hour blocks) and the web
// (ticket rail, timesheet), so a figure shown on screen can never settle to a
// different number on the invoice.
//
//   billed minutes → hours rounded to 2 decimals → × hourly rate
//                  → ONE half-up round at the currency's minor unit
//
// 25 min at 135.00/h is 0.42 h × 135.00 = 56.70, not 25/60 × 135 = 56.25.
// That is BY DESIGN, not a rounding bug: invoice lines store the quantity as
// numeric(_,2) hours and quantity × unit price must equal the line total (the
// Xero/QuickBooks pushes rely on it). See the invoice-engine spec (2026-06-14)
// and the block-hours "round-first" spec. No billing increment is implied —
// any whole-minute duration is accepted; only the hours are rounded.
//
// The SQL twin used by the database aggregates is `laborAmountSql` in
// apps/api/src/services/currencySql.ts; the two are pinned to each other by
// apps/api/src/__tests__/integration/laborAmountSql.integration.test.ts.

import { multiplyToCurrency } from './currency';

/**
 * Hundredths of an hour for a duration: `round(minutes / 60, 2) × 100`.
 * Integer arithmetic on the result, so sums of entries never drift
 * (300 × 20 min = 99.00 h, never 98.99999). Whole minutes never land on a
 * half-hundredth (100m/60 = 5m/3 has a fractional part of 0, ⅓ or ⅔), so the
 * tie direction never matters and this agrees with Postgres
 * `ROUND(minutes::numeric / 60, 2)` exactly.
 */
export function laborHundredths(minutes: number): number {
  if (!Number.isFinite(minutes)) throw new Error('labor: minutes must be a finite number');
  // `+ 0` folds a -0 result (e.g. a tiny negative input) to 0.
  return Math.round((minutes * 100) / 60) + 0;
}

/** Integer hundredths of an hour → the fixed-2 hours string ('0.42'). */
export function hundredthsToHours(hundredths: number): string {
  const neg = hundredths < 0;
  const abs = Math.abs(hundredths);
  return `${neg ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** Billed hours for a duration, rounded to 2 decimals: 25 → '0.42'. */
export function laborHours(minutes: number): string {
  return hundredthsToHours(laborHundredths(minutes));
}

/**
 * The billed quantity in minutes (#4628 §3.5): `billable_minutes` (after the
 * card's minimum/rounding) when stamped, else the worked duration, else 0.
 * The JS twin of `COALESCE(billable_minutes, duration_minutes, 0)`.
 */
export function billedLaborMinutes(entry: {
  billableMinutes?: number | null;
  durationMinutes?: number | null;
}): number {
  return (entry.billableMinutes ?? entry.durationMinutes) ?? 0;
}

/**
 * The labour amount for one entry: `laborHours(minutes) × hourlyRate`, rounded
 * once, half-up, at the currency's minor unit — exact decimal arithmetic, never
 * through a binary double. Returns the fixed-2 major-unit string
 * ('56.70'; '330.00' for 20 min × 1,000 JPY).
 */
export function laborAmount(minutes: number, hourlyRate: string | number, currencyCode: string): string {
  return multiplyToCurrency(laborHours(minutes), hourlyRate, currencyCode);
}
