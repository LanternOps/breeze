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
} from 'drizzle-orm/pg-core';
import { devices } from './devices';
import { organizations } from './orgs';

export const warrantyStatusEnum = pgEnum('warranty_status', ['active', 'expiring', 'expired', 'unknown']);

export const deviceWarranty = pgTable('device_warranty', {
  id: uuid('id').primaryKey().defaultRandom(),
  deviceId: uuid('device_id').notNull().references(() => devices.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  manufacturer: varchar('manufacturer', { length: 100 }),
  serialNumber: varchar('serial_number', { length: 100 }),
  status: warrantyStatusEnum('status').notNull().default('unknown'),
  warrantyStartDate: date('warranty_start_date'),
  warrantyEndDate: date('warranty_end_date'),
  entitlements: jsonb('entitlements').notNull().default([]),
  lastSyncAt: timestamp('last_sync_at'),
  lastSyncError: text('last_sync_error'),
  nextSyncAt: timestamp('next_sync_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  orgIdIdx: index('device_warranty_org_id_idx').on(table.orgId),
  deviceIdIdx: uniqueIndex('device_warranty_device_id_idx').on(table.deviceId),
  warrantyEndDateIdx: index('device_warranty_end_date_idx').on(table.warrantyEndDate),
  nextSyncAtIdx: index('device_warranty_next_sync_at_idx').on(table.nextSyncAt),
}));
