import type { AgentHealthComponent, AgentHealthState } from '@breeze/shared';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { devices } from './devices';
import { organizations } from './orgs';

export const agentHealthObservations = pgTable('agent_health_observations', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  deviceId: uuid('device_id').notNull(),
  schemaVersion: integer('schema_version').notNull(),
  agentVersion: varchar('agent_version', { length: 64 }).notNull(),
  overall: varchar('overall', { length: 16 }).$type<AgentHealthState>().notNull(),
  metricsAvailable: boolean('metrics_available'),
  components: jsonb('components').$type<Record<string, AgentHealthComponent>>().notNull(),
  observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  foreignKey({
    columns: [table.deviceId, table.orgId],
    foreignColumns: [devices.id, devices.orgId],
    name: 'agent_health_observations_device_org_fkey',
  }).onUpdate('cascade').onDelete('cascade'),
  uniqueIndex('agent_health_observations_device_observed_uq')
    .on(table.deviceId, table.observedAt),
  uniqueIndex('agent_health_observations_identity_owner_uq')
    .on(table.id, table.orgId, table.deviceId),
  index('agent_health_observations_device_received_idx')
    .on(table.deviceId, table.receivedAt.desc(), table.id.desc()),
  index('agent_health_observations_org_idx').on(table.orgId),
  check('agent_health_observations_schema_version_chk', sql`${table.schemaVersion} > 0`),
  check(
    'agent_health_observations_overall_chk',
    sql`${table.overall} IN ('healthy', 'warning', 'error', 'unknown')`,
  ),
]);

export const deviceAgentHealthLatest = pgTable('device_agent_health_latest', {
  deviceId: uuid('device_id').primaryKey(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  observationId: uuid('observation_id').notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  foreignKey({
    columns: [table.deviceId, table.orgId],
    foreignColumns: [devices.id, devices.orgId],
    name: 'device_agent_health_latest_device_org_fkey',
  }).onUpdate('cascade').onDelete('cascade'),
  foreignKey({
    columns: [table.observationId, table.orgId, table.deviceId],
    foreignColumns: [
      agentHealthObservations.id,
      agentHealthObservations.orgId,
      agentHealthObservations.deviceId,
    ],
    name: 'device_agent_health_latest_observation_owner_fkey',
  }).onUpdate('cascade').onDelete('cascade'),
  index('device_agent_health_latest_org_idx').on(table.orgId),
  index('device_agent_health_latest_received_idx').on(table.receivedAt.desc()),
]);

export type AgentHealthObservationRow = typeof agentHealthObservations.$inferSelect;
export type NewAgentHealthObservationRow = typeof agentHealthObservations.$inferInsert;
export type DeviceAgentHealthLatestRow = typeof deviceAgentHealthLatest.$inferSelect;
