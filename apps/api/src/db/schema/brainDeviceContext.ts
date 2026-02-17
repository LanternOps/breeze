import {
  pgEnum,
  pgTable,
  uuid,
  varchar,
  timestamp,
  jsonb,
  index
} from 'drizzle-orm/pg-core';
import { organizations } from './orgs';
import { devices } from './devices';

export const brainContextTypeEnum = pgEnum('brain_context_type', [
  'issue',
  'quirk',
  'followup',
  'preference'
]);

export const brainDeviceContext = pgTable('brain_device_context', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  deviceId: uuid('device_id').notNull().references(() => devices.id),
  contextType: brainContextTypeEnum('context_type').notNull(),
  summary: varchar('summary', { length: 255 }).notNull(),
  details: jsonb('details'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  expiresAt: timestamp('expires_at'),
  resolvedAt: timestamp('resolved_at'),
}, (table) => ({
  deviceIdIdx: index('brain_device_context_device_id_idx').on(table.deviceId),
  orgIdIdx: index('brain_device_context_org_id_idx').on(table.orgId),
  deviceTypeIdx: index('brain_device_context_device_type_idx').on(table.deviceId, table.contextType),
  deviceActiveIdx: index('brain_device_context_device_active_idx').on(table.deviceId, table.resolvedAt),
}));
