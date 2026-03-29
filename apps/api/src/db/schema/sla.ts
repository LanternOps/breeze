import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { organizations } from './orgs';
import { devices } from './devices';

export const backupSlaConfigs = pgTable(
  'backup_sla_configs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id),
    name: varchar('name', { length: 200 }).notNull(),
    rpoTargetMinutes: integer('rpo_target_minutes').notNull(),
    rtoTargetMinutes: integer('rto_target_minutes').notNull(),
    targetDevices: jsonb('target_devices').$type<string[]>().default([]),
    targetGroups: jsonb('target_groups').$type<string[]>().default([]),
    alertOnBreach: boolean('alert_on_breach').notNull().default(true),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    orgIdx: index('sla_configs_org_idx').on(table.orgId),
  })
);

export const backupSlaEvents = pgTable(
  'backup_sla_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id),
    slaConfigId: uuid('sla_config_id')
      .notNull()
      .references(() => backupSlaConfigs.id),
    deviceId: uuid('device_id').references(() => devices.id),
    eventType: varchar('event_type', { length: 30 }).notNull(),
    details: jsonb('details'),
    detectedAt: timestamp('detected_at').defaultNow().notNull(),
    resolvedAt: timestamp('resolved_at'),
  },
  (table) => ({
    orgIdx: index('sla_events_org_idx').on(table.orgId),
    configIdx: index('sla_events_config_idx').on(table.slaConfigId),
    deviceIdx: index('sla_events_device_idx').on(table.deviceId),
  })
);
