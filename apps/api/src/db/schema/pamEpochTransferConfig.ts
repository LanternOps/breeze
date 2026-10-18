/**
 * PAM ownership epochs W6 (#8208): the one-row switch that lets the device
 * org-move guard apply its closed-actuation predicate instead of refusing
 * every PAM-touched move.
 *
 * Created in SQL migration 2026-12-30-210000-pam-epoch-transfer-flag.sql;
 * declared here for the drift check only. breeze_app holds NO privilege on it
 * (migration + ensureAppRole.ts); it is read through the SECURITY DEFINER
 * function `breeze_pam_epoch_transfer_enabled()` and written only by the
 * table owner. Never read or write it from app code.
 */
import { boolean, check, pgTable, timestamp } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const pamEpochTransferConfig = pgTable(
  'pam_epoch_transfer_config',
  {
    singleton: boolean('singleton').primaryKey().notNull().default(true),
    enabled: boolean('enabled').notNull().default(false),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    singletonChk: check('pam_epoch_transfer_config_singleton_chk', sql`${table.singleton}`),
  }),
);
