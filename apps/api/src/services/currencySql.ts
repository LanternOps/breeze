import { sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { CURRENCY_CODES, isZeroDecimal } from '@breeze/shared';

/**
 * Money-rounding SQL shared by the ticket billing summary
 * (`timeEntryService.getTicketBillingSummary`) and the #3198 R2 report
 * (`businessReports/technicianTimeReport.ts`), so the two cannot disagree on
 * how a row is rounded. Kept free of `db` so a generator can import it without
 * pulling in the time-entry service graph.
 */

/** Supported zero-decimal codes (JPY, KRW, …) — every other supported currency has 2 minor-unit digits (spec §12). */
const ZERO_DECIMAL_CODES: string[] = CURRENCY_CODES.filter((code) => isZeroDecimal(code));

/**
 * SQL scale for a per-row ROUND at the row's own currency minor unit — the
 * SQL twin of `roundToCurrency` (PG `ROUND(numeric, int)` is half away from
 * zero, which is half-up for the non-negative amounts these rows carry).
 *
 * Takes a Drizzle column or a raw SQL fragment (e.g. `sql\`e.currency_code\``
 * for a column of a CTE alias).
 */
export function minorUnitScaleSql(currencyColumn: AnyColumn | SQL): SQL<number> {
  return ZERO_DECIMAL_CODES.length > 0
    ? sql<number>`CASE WHEN ${currencyColumn} IN (${sql.join(ZERO_DECIMAL_CODES.map((code) => sql`${code}`), sql`, `)}) THEN 0 ELSE 2 END`
    : sql<number>`2`;
}
