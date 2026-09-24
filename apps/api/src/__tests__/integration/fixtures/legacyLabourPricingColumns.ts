/**
 * The six legacy labour-pricing columns, as they stood before
 * 2026-10-29-100300-drop-legacy-labour-pricing-columns.sql removed them
 * (#4628 W04b).
 *
 * A fresh `autoMigrate` runs the conversion (2026-10-24-200200) while these
 * columns still exist and drops them afterwards, so the conversion and the drop
 * still run for every self-hoster who skips versions. Suites that replay either
 * migration against the fully-migrated test database put the columns back
 * first. Only the columns and their defaults are restored: the CHECK and the
 * supported_currencies FKs from 2026-08-30 are irrelevant to both migrations,
 * and leaving them out lets a fixture model historical off-list rows.
 *
 * Use RESTORE inside a transaction that is rolled back, or pair
 * `restoreLegacyLabourPricingColumns()` in beforeAll with
 * `dropLegacyLabourPricingColumns()` in afterAll — integration files run one
 * at a time (`fileParallelism: false`), and a later file's tenant-export
 * contract fails on columns the registry no longer classifies.
 */
import { sql } from 'drizzle-orm';
import { getTestDb } from '../setup';

export const RESTORE_LEGACY_LABOUR_PRICING_COLUMNS_SQL = `
  ALTER TABLE ticket_categories ADD COLUMN IF NOT EXISTS default_billable boolean NOT NULL DEFAULT true;
  ALTER TABLE ticket_categories ADD COLUMN IF NOT EXISTS default_hourly_rate numeric(10,2);
  ALTER TABLE ticket_categories ADD COLUMN IF NOT EXISTS rate_currency char(3);
  ALTER TABLE org_ticket_settings ADD COLUMN IF NOT EXISTS default_hourly_rate numeric(10,2);
  ALTER TABLE org_ticket_settings ADD COLUMN IF NOT EXISTS rate_currency char(3) NOT NULL DEFAULT 'USD';
  ALTER TABLE org_ticket_settings ADD COLUMN IF NOT EXISTS default_billable boolean;
`;

export const DROP_LEGACY_LABOUR_PRICING_COLUMNS_SQL = `
  ALTER TABLE ticket_categories DROP COLUMN IF EXISTS default_billable;
  ALTER TABLE ticket_categories DROP COLUMN IF EXISTS default_hourly_rate;
  ALTER TABLE ticket_categories DROP COLUMN IF EXISTS rate_currency;
  ALTER TABLE org_ticket_settings DROP COLUMN IF EXISTS default_hourly_rate;
  ALTER TABLE org_ticket_settings DROP COLUMN IF EXISTS rate_currency;
  ALTER TABLE org_ticket_settings DROP COLUMN IF EXISTS default_billable;
`;

export async function restoreLegacyLabourPricingColumns(): Promise<void> {
  await getTestDb().execute(sql.raw(RESTORE_LEGACY_LABOUR_PRICING_COLUMNS_SQL));
}

export async function dropLegacyLabourPricingColumns(): Promise<void> {
  await getTestDb().execute(sql.raw(DROP_LEGACY_LABOUR_PRICING_COLUMNS_SQL));
}
