/**
 * PAM ownership epochs W1 (#8203) — device ownership lineage.
 *
 * Created in SQL migration 2026-12-17-130000-device-ownership-epochs.sql;
 * declared here for typed reads and the static contract tests. Spec:
 * docs/superpowers/specs/pam/2026-10-06-pam-ownership-epoch-design.md §4.
 *
 * All three tables are append-only and written ONLY by the SECURITY DEFINER
 * devices triggers (`breeze_device_ownership_epoch_init` on INSERT,
 * `breeze_device_ownership_epoch_advance` on an org_id change). breeze_app
 * holds SELECT and DELETE only — never insert into these from app code.
 */
import { foreignKey, index, integer, pgTable, primaryKey, text, timestamp, unique, uuid, varchar } from 'drizzle-orm/pg-core';
import { organizations } from './orgs';
import { devices } from './devices';

export const DEVICE_OWNERSHIP_EPOCH_CAUSES = [
  'enrollment',
  'backfill',
  'device_move',
  'org_merge',
  'unspecified',
] as const;
export type DeviceOwnershipEpochCause = (typeof DEVICE_OWNERSHIP_EPOCH_CAUSES)[number];

/**
 * One row per (device, epoch). Deliberately NO FK to devices: deleting a
 * device in its current org must never cascade into an earlier org's
 * evidence (spec §4.4). Shape 1 RLS on org_id.
 */
export const deviceOwnershipEpochs = pgTable(
  'device_ownership_epochs',
  {
    deviceId: uuid('device_id').notNull(),
    epoch: integer('epoch').notNull(),
    orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    siteId: uuid('site_id'),
    cause: text('cause').notNull().$type<DeviceOwnershipEpochCause>(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ name: 'device_ownership_epochs_pkey', columns: [table.deviceId, table.epoch] }),
    deviceOrgEpochUq: unique('device_ownership_epochs_device_org_epoch_key').on(
      table.deviceId,
      table.orgId,
      table.epoch,
    ),
    orgIdx: index('device_ownership_epochs_org_idx').on(table.orgId),
  }),
);

/**
 * One row per closed epoch: the display snapshot for source-org history after
 * the device has left that org (spec §4.2). Shape 1 RLS on the CLOSED epoch's
 * org_id, never the live device's.
 */
export const deviceOwnershipEpochClosures = pgTable(
  'device_ownership_epoch_closures',
  {
    deviceId: uuid('device_id').notNull(),
    epoch: integer('epoch').notNull(),
    orgId: uuid('org_id').notNull(),
    closedAt: timestamp('closed_at', { withTimezone: true }).notNull().defaultNow(),
    hostnameSnapshot: varchar('hostname_snapshot', { length: 255 }),
    displayNameSnapshot: varchar('display_name_snapshot', { length: 255 }),
    siteIdSnapshot: uuid('site_id_snapshot'),
  },
  (table) => ({
    pk: primaryKey({ name: 'device_ownership_epoch_closures_pkey', columns: [table.deviceId, table.epoch] }),
    // DEFERRABLE INITIALLY IMMEDIATE in SQL (drizzle does not model deferrability).
    epochFk: foreignKey({
      columns: [table.deviceId, table.orgId, table.epoch],
      foreignColumns: [deviceOwnershipEpochs.deviceId, deviceOwnershipEpochs.orgId, deviceOwnershipEpochs.epoch],
      name: 'device_ownership_epoch_closures_epoch_fkey',
    }).onDelete('cascade'),
    orgIdx: index('device_ownership_epoch_closures_org_idx').on(table.orgId),
  }),
);

/**
 * Ledger retirement markers (spec §4.5): one row per actuation of a departing
 * epoch. Identifiers only — no org_id. System scope only (RLS), intentionally
 * system-scoped like device_commands. Lives exactly as long as the device.
 */
export const pamLedgerRetirements = pgTable(
  'pam_ledger_retirements',
  {
    deviceId: uuid('device_id').notNull().references(() => devices.id, { onDelete: 'cascade' }),
    actuationId: uuid('actuation_id').notNull(),
    retiredEpoch: integer('retired_epoch').notNull(),
    retiredAt: timestamp('retired_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ name: 'pam_ledger_retirements_pkey', columns: [table.deviceId, table.actuationId] }),
  }),
);

export type DeviceOwnershipEpoch = typeof deviceOwnershipEpochs.$inferSelect;
export type DeviceOwnershipEpochClosure = typeof deviceOwnershipEpochClosures.$inferSelect;
export type PamLedgerRetirement = typeof pamLedgerRetirements.$inferSelect;
