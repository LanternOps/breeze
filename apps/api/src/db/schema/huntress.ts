import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  jsonb,
  boolean,
  index,
  uniqueIndex
} from 'drizzle-orm/pg-core';
import { organizations } from './orgs';
import { users } from './users';
import { devices } from './devices';

export const huntressIntegrations = pgTable('huntress_integrations', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  name: varchar('name', { length: 200 }).notNull(),
  apiKeyEncrypted: text('api_key_encrypted').notNull(),
  accountId: varchar('account_id', { length: 120 }),
  apiBaseUrl: varchar('api_base_url', { length: 300 }).notNull().default('https://api.huntress.io/v1'),
  webhookSecretEncrypted: text('webhook_secret_encrypted'),
  isActive: boolean('is_active').notNull().default(true),
  lastSyncAt: timestamp('last_sync_at'),
  lastSyncStatus: varchar('last_sync_status', { length: 20 }),
  lastSyncError: text('last_sync_error'),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  orgIdx: uniqueIndex('huntress_integrations_org_idx').on(table.orgId),
}));

export const huntressAgents = pgTable('huntress_agents', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  integrationId: uuid('integration_id').notNull().references(() => huntressIntegrations.id, { onDelete: 'cascade' }),
  huntressAgentId: varchar('huntress_agent_id', { length: 128 }).notNull(),
  deviceId: uuid('device_id').references(() => devices.id),
  hostname: varchar('hostname', { length: 255 }),
  platform: varchar('platform', { length: 32 }),
  status: varchar('status', { length: 20 }),
  lastSeenAt: timestamp('last_seen_at'),
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  agentIdIdx: uniqueIndex('huntress_agents_agent_id_idx').on(table.integrationId, table.huntressAgentId),
  orgDeviceIdx: index('huntress_agents_org_device_idx').on(table.orgId, table.deviceId),
}));

export const huntressIncidents = pgTable('huntress_incidents', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  integrationId: uuid('integration_id').notNull().references(() => huntressIntegrations.id, { onDelete: 'cascade' }),
  deviceId: uuid('device_id').references(() => devices.id),
  huntressIncidentId: varchar('huntress_incident_id', { length: 128 }).notNull(),
  severity: varchar('severity', { length: 20 }),
  category: varchar('category', { length: 60 }),
  title: text('title').notNull(),
  description: text('description'),
  recommendation: text('recommendation'),
  status: varchar('status', { length: 30 }).notNull(),
  reportedAt: timestamp('reported_at'),
  resolvedAt: timestamp('resolved_at'),
  details: jsonb('details'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  incidentIdIdx: uniqueIndex('huntress_incidents_external_idx').on(table.integrationId, table.huntressIncidentId),
  orgStatusIdx: index('huntress_incidents_org_status_idx').on(table.orgId, table.status),
}));
