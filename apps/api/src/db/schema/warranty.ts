import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  jsonb,
  pgEnum,
  index,
  uniqueIndex,
  date,
  boolean,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { devices } from './devices';
import { organizations } from './orgs';

// 'subscription_active' = recurring AppleCare subscription with no fixed end date;
// warrantyEndDate reflects the next renewal/billing date, not a true expiry, so
// the warranty-expiry alert is suppressed for this status.
export const warrantyStatusEnum = pgEnum('warranty_status', [
  'active',
  'expiring',
  'expired',
  'unknown',
  'subscription_active',
]);

export const deviceWarranty = pgTable('device_warranty', {
  id: uuid('id').primaryKey().defaultRandom(),
  // #4622 — XOR subject with manualAssetId, enforced by
  // device_warranty_one_subject_chk. Nullable since W03.
  deviceId: uuid('device_id').references(() => devices.id, { onDelete: 'cascade' }),
  // #4622 — the composite same-org FK (manual_asset_id, org_id) ->
  // manual_assets(id, org_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE
  // is declared in SQL only: Drizzle cannot express a multi-column FK on a
  // table definition, and a single-column .references() here would also create
  // a circular import between warranty.ts and manualAssets.ts.
  manualAssetId: uuid('manual_asset_id'),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  manufacturer: varchar('manufacturer', { length: 100 }),
  serialNumber: varchar('serial_number', { length: 100 }),
  status: warrantyStatusEnum('status').notNull().default('unknown'),
  warrantyStartDate: date('warranty_start_date'),
  warrantyEndDate: date('warranty_end_date'),
  // True when coverage is an active recurring subscription (AppleCare), in which
  // case warrantyEndDate is the next renewal date rather than a real expiry.
  isSubscription: boolean('is_subscription').notNull().default(false),
  entitlements: jsonb('entitlements').notNull().default([]),
  dataSource: varchar('data_source', { length: 50 }).default('provider'),
  lastSyncAt: timestamp('last_sync_at'),
  lastSyncError: text('last_sync_error'),
  nextSyncAt: timestamp('next_sync_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  orgIdIdx: index('device_warranty_org_id_idx').on(table.orgId),
  // Two partial unique indexes, one per subject kind — both upsert conflict
  // targets must stay valid now that either column can be NULL.
  deviceIdIdx: uniqueIndex('device_warranty_device_id_idx')
    .on(table.deviceId)
    .where(sql`${table.deviceId} IS NOT NULL`),
  manualAssetIdIdx: uniqueIndex('device_warranty_manual_asset_id_idx')
    .on(table.manualAssetId)
    .where(sql`${table.manualAssetId} IS NOT NULL`),
  manualAssetFkIdx: index('device_warranty_manual_asset_fk_idx').on(table.manualAssetId, table.orgId),
  warrantyEndDateIdx: index('device_warranty_end_date_idx').on(table.warrantyEndDate),
  nextSyncAtIdx: index('device_warranty_next_sync_at_idx').on(table.nextSyncAt),
}));
