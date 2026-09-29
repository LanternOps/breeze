import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { partners } from './orgs';

export type DevicePoolAssignmentEventType = 'enrolled' | 'assigned' | 'expired' | 'purged';
export type DevicePoolAssignmentMethod = 'manual' | 'bulk';

/**
 * Pre-assignment holding-area ledger. Partner-axis,
 * append-only (UPDATE blocked by trigger). device/org/key/actor columns are
 * snapshots with no FK — see migrations/2026-11-08-190200-device-pool-assignment-events.sql.
 */
export const devicePoolAssignmentEvents = pgTable('device_pool_assignment_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id, { onDelete: 'cascade' }),
  deviceId: uuid('device_id').notNull(),
  deviceAgentId: varchar('device_agent_id', { length: 64 }).notNull(),
  eventType: text('event_type').$type<DevicePoolAssignmentEventType>().notNull(),
  fromOrgId: uuid('from_org_id'),
  toOrgId: uuid('to_org_id'),
  deployKeyId: uuid('deploy_key_id'),
  deployKeyName: varchar('deploy_key_name', { length: 255 }),
  assignmentMethod: text('assignment_method').$type<DevicePoolAssignmentMethod>(),
  assignedByUserId: uuid('assigned_by_user_id'),
  stepUpGrantRef: text('step_up_grant_ref'),
  parkedAt: timestamp('parked_at', { withTimezone: true }),
  parkedDurationSeconds: integer('parked_duration_seconds'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index('device_pool_assignment_events_partner_created_idx').on(table.partnerId, table.createdAt),
  index('device_pool_assignment_events_device_idx').on(table.deviceId),
  index('device_pool_assignment_events_deploy_key_idx').on(table.deployKeyId),
  check('device_pool_assignment_events_event_type_chk',
    sql`${table.eventType} IN ('enrolled', 'assigned', 'expired', 'purged')`),
  check('device_pool_assignment_events_method_chk',
    sql`${table.assignmentMethod} IS NULL OR ${table.assignmentMethod} IN ('manual', 'bulk')`),
  check('device_pool_assignment_events_duration_chk',
    sql`${table.parkedDurationSeconds} IS NULL OR ${table.parkedDurationSeconds} >= 0`),
]);

export type DevicePoolAssignmentEvent = typeof devicePoolAssignmentEvents.$inferSelect;
export type NewDevicePoolAssignmentEvent = typeof devicePoolAssignmentEvents.$inferInsert;
