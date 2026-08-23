import { sql } from 'drizzle-orm';
import { pgTable, char, check, date, index, numeric, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';

// Global currency allowlist — see 2026-08-27-a-supported-currencies.sql for the
// tenancy rationale (INTENTIONAL_UNSCOPED: public read, system-only write).
export const supportedCurrencies = pgTable('supported_currencies', {
  code: char('code', { length: 3 }).primaryKey(),
});

/** Global reporting-only FX rates (multi-currency spec §8) — see
 *  2026-09-03-exchange-rates.sql for the tenancy rationale
 *  (INTENTIONAL_UNSCOPED: public read, system-only write). Consumed ONLY by
 *  dashboards/reports via exchangeRateService; never by document math, and
 *  never persisted onto a document. */
export const exchangeRates = pgTable('exchange_rates', {
  rateDate: date('rate_date').notNull(),
  baseCode: char('base_code', { length: 3 }).notNull().references(() => supportedCurrencies.code),
  quoteCode: char('quote_code', { length: 3 }).notNull().references(() => supportedCurrencies.code),
  rate: numeric('rate', { precision: 18, scale: 8 }).notNull(),
  /** 'ecb' (daily Frankfurter feed) | 'manual' (operator override, never overwritten by the feed). */
  source: text('source').notNull(),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ name: 'exchange_rates_pkey', columns: [t.rateDate, t.baseCode, t.quoteCode] }),
  index('exchange_rates_lookup_idx').on(t.baseCode, t.quoteCode, t.rateDate.desc()),
  check('exchange_rates_positive_rate_chk', sql`${t.rate} > 0`),
  check('exchange_rates_distinct_codes_chk', sql`${t.baseCode} <> ${t.quoteCode}`),
  check('exchange_rates_source_chk', sql`${t.source} in ('ecb','manual')`),
]);
