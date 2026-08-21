import { pgTable, char } from 'drizzle-orm/pg-core';

// Global currency allowlist — see 2026-08-27-a-supported-currencies.sql for the
// tenancy rationale (INTENTIONAL_UNSCOPED: public read, system-only write).
export const supportedCurrencies = pgTable('supported_currencies', {
  code: char('code', { length: 3 }).primaryKey(),
});
