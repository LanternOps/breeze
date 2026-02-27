/**
 * Peripheral Control schema — USB/Bluetooth/Thunderbolt policy enforcement.
 *
 * peripheralPolicies: defines rules for device classes (storage, bluetooth, etc.)
 *   scoped to org/site/group/device via targetType + targetIds JSONB.
 *   `all_usb` is a superset that covers all USB classes including `storage`.
 *   Exception rules in the exceptions JSONB allow vendor/product/serial overrides.
 *
 * peripheralEvents: agent-reported telemetry (connect, disconnect, block, etc.)
 *   linked to the triggering policy when applicable. Deduplicated via
 *   sourceEventId unique partial index (only deduplicates events that carry an ID).
 */
import {
  boolean,
  index,
  jsonb,
  pgEnum,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { devices } from './devices';
import { organizations } from './orgs';
import { users } from './users';

export const peripheralDeviceClassEnum = pgEnum('peripheral_device_class', [
  'storage',
  'all_usb',
  'bluetooth',
  'thunderbolt'
]);

export const peripheralPolicyActionEnum = pgEnum('peripheral_policy_action', [
  'allow',
  'block',
  'read_only',
  'alert'
]);

export const peripheralPolicyTargetTypeEnum = pgEnum('peripheral_policy_target_type', [
  'organization',
  'site',
  'group',
  'device'
]);

export const peripheralEventTypeEnum = pgEnum('peripheral_event_type', [
  'connected',
  'disconnected',
  'blocked',
  'mounted_read_only',
  'policy_override'
]);

export type PeripheralDeviceClass = typeof peripheralDeviceClassEnum.enumValues[number];
export type PeripheralPolicyAction = typeof peripheralPolicyActionEnum.enumValues[number];
export type PeripheralPolicyTargetType = typeof peripheralPolicyTargetTypeEnum.enumValues[number];
export type PeripheralEventType = typeof peripheralEventTypeEnum.enumValues[number];

export interface PeripheralPolicyTargetIds {
  siteIds?: string[];
  groupIds?: string[];
  deviceIds?: string[];
}

export interface PeripheralExceptionRule {
  vendor?: string;
  product?: string;
  serialNumber?: string;
  allow?: boolean;
  reason?: string;
  /** ISO 8601 timestamp; enforcement is agent-side — the API stores but does not filter expired rules */
  expiresAt?: string;
}

export const peripheralPolicies = pgTable('peripheral_policies', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  name: varchar('name', { length: 200 }).notNull(),
  deviceClass: peripheralDeviceClassEnum('device_class').notNull(),
  action: peripheralPolicyActionEnum('action').notNull(),
  targetType: peripheralPolicyTargetTypeEnum('target_type').notNull(),
  targetIds: jsonb('target_ids').$type<PeripheralPolicyTargetIds>().default({}),
  exceptions: jsonb('exceptions').$type<PeripheralExceptionRule[]>().default([]),
  isActive: boolean('is_active').notNull().default(true),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  orgActiveIdx: index('peripheral_policy_org_active_idx').on(table.orgId, table.isActive),
  orgClassIdx: index('peripheral_policy_org_class_idx').on(table.orgId, table.deviceClass),
}));

export const peripheralEvents = pgTable('peripheral_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  deviceId: uuid('device_id').notNull().references(() => devices.id),
  policyId: uuid('policy_id').references(() => peripheralPolicies.id),
  sourceEventId: varchar('source_event_id', { length: 255 }),
  eventType: peripheralEventTypeEnum('event_type').notNull(),
  peripheralType: varchar('peripheral_type', { length: 40 }).notNull(),
  vendor: varchar('vendor', { length: 255 }),
  product: varchar('product', { length: 255 }),
  serialNumber: varchar('serial_number', { length: 255 }),
  details: jsonb('details').$type<Record<string, unknown>>(),
  occurredAt: timestamp('occurred_at').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  orgDeviceTimeIdx: index('peripheral_events_org_device_time_idx').on(table.orgId, table.deviceId, table.occurredAt),
  typeIdx: index('peripheral_events_type_idx').on(table.eventType),
  orgPolicyTimeIdx: index('peripheral_events_org_policy_time_idx').on(table.orgId, table.policyId, table.occurredAt),
  sourceEventIdx: uniqueIndex('peripheral_events_source_event_idx')
    .on(table.orgId, table.deviceId, table.sourceEventId)
    .where(sql`source_event_id IS NOT NULL`),
  typeTimeIdx: index('peripheral_events_type_time_idx').on(table.eventType, table.occurredAt),
}));
