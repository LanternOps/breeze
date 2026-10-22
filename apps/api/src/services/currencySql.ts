import { sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { CURRENCY_CODES, isZeroDecimal } from '@breeze/shared';

/**
 * Money-rounding SQL shared by the ticket billing summary
 * (`timeEntryService.getTicketBillingSummary`), the #3198 R2 report
 * (`businessReports/technicianTimeReport.ts`) and the org-currency preflight
 * (`orgCurrencyService.laborSumSql`), so they cannot disagree on how a row is
 * rounded. Kept free of `db` so a generator can import it without
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

/**
 * The labour rule (#9561) in SQL — the twin of `laborHours` / `laborAmount` in
 * `@breeze/shared` (packages/shared/src/utils/laborMath.ts): billed minutes →
 * hours rounded to 2 dp → × rate → ONE round at the currency's minor unit.
 * Used per row, inside the caller's SUM, so totals are sums of rounded rows
 * (the invoice-line figure), never a rounded sum.
 *
 * `minutes` must be a single SQL term — a column, a function call such as
 * `COALESCE(...)`, or a parenthesised expression — because the `::numeric`
 * cast binds to it directly. `scale` is a minor-unit exponent: a literal
 * (0 | 2) or a per-row `minorUnitScaleSql(...)`.
 */
export function laborHoursSql(minutes: AnyColumn | SQL): SQL<string> {
  return sql<string>`ROUND(${minutes}::numeric / 60, 2)`;
}

export function laborAmountSql(minutes: AnyColumn | SQL, hourlyRate: AnyColumn | SQL, scale: SQL<number> | 0 | 2): SQL<string> {
  const s = scale === 0 ? sql.raw('0') : scale === 2 ? sql.raw('2') : scale;
  return sql<string>`ROUND(${laborHoursSql(minutes)} * ${hourlyRate}, ${s})`;
}
