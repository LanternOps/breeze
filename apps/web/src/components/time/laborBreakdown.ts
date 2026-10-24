import { billedLaborMinutes, laborAmount, laborHours } from '@breeze/shared';
import { formatMoney } from '../billing/shared/format';

/** The fields of a time entry the labour breakdown reads (ticket rail + timesheet rows). */
export interface LaborBreakdownEntry {
  endedAt: string | null;
  isBillable: boolean;
  durationMinutes: number | null;
  /** #4628 §3.5 billed quantity; null/absent on a pre-feature row. */
  billableMinutes?: number | null;
  hourlyRate?: string | null;
  currencyCode?: string | null;
}

/**
 * #9561 — the labour rule made visible: "0.42 h × $135.00 = $56.70" for one
 * finished, billable, rated entry. Computed by the SAME shared helper the API
 * bills with (`laborAmount`, packages/shared/src/utils/laborMath.ts), so the
 * line always equals the figure on the invoice. Mirrors the API's money filter
 * for the ticket summary and the timesheet total (billable + rate + currency);
 * null for any entry that adds no money there.
 */
export function laborBreakdown(
  t: (key: string, options?: Record<string, unknown>) => string,
  entry: LaborBreakdownEntry,
): string | null {
  if (entry.endedAt == null || !entry.isBillable || !entry.hourlyRate || !entry.currencyCode) return null;
  const minutes = billedLaborMinutes(entry);
  return t('tickets:ticketTimeBilling.laborBreakdown', {
    hours: laborHours(minutes),
    rate: formatMoney(entry.hourlyRate, entry.currencyCode),
    amount: formatMoney(laborAmount(minutes, entry.hourlyRate, entry.currencyCode), entry.currencyCode),
  });
}
