import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  boolean,
  integer,
  jsonb,
  index,
  uniqueIndex
} from 'drizzle-orm/pg-core';
import { organizations } from './orgs';
import { users } from './users';
import { devices } from './devices';

export const s1Integrations = pgTable('s1_integrations', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  name: varchar('name', { length: 200 }).notNull(),
  apiTokenEncrypted: text('api_token_encrypted').notNull(),
  managementUrl: text('management_url').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  lastSyncAt: timestamp('last_sync_at'),
  lastSyncStatus: varchar('last_sync_status', { length: 20 }),
  lastSyncError: text('last_sync_error'),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
}, (table) => ({
  orgIdx: uniqueIndex('s1_integrations_org_idx').on(table.orgId)
}));

export const s1Agents = pgTable('s1_agents', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  integrationId: uuid('integration_id').notNull().references(() => s1Integrations.id),
  s1AgentId: varchar('s1_agent_id', { length: 128 }).notNull(),
  deviceId: uuid('device_id').references(() => devices.id),
  status: varchar('status', { length: 30 }),
  infected: boolean('infected').default(false),
  threatCount: integer('threat_count').default(0),
  policyName: varchar('policy_name', { length: 200 }),
  lastSeenAt: timestamp('last_seen_at'),
  metadata: jsonb('metadata'),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
}, (table) => ({
  s1AgentIdx: uniqueIndex('s1_agents_external_idx').on(table.integrationId, table.s1AgentId),
  orgDeviceIdx: index('s1_agents_org_device_idx').on(table.orgId, table.deviceId),
  integrationIdx: index('s1_agents_integration_idx').on(table.integrationId)
}));

export const s1Threats = pgTable('s1_threats', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  integrationId: uuid('integration_id').notNull().references(() => s1Integrations.id),
  deviceId: uuid('device_id').references(() => devices.id),
  s1ThreatId: varchar('s1_threat_id', { length: 128 }).notNull(),
  classification: varchar('classification', { length: 60 }),
  severity: varchar('severity', { length: 20 }),
  threatName: text('threat_name'),
  processName: text('process_name'),
  filePath: text('file_path'),
  mitreTactics: jsonb('mitre_tactics'),
  status: varchar('status', { length: 30 }).notNull(),
  detectedAt: timestamp('detected_at'),
  resolvedAt: timestamp('resolved_at'),
  details: jsonb('details'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
}, (table) => ({
  threatIdx: uniqueIndex('s1_threats_external_idx').on(table.integrationId, table.s1ThreatId),
  orgStatusIdx: index('s1_threats_org_status_idx').on(table.orgId, table.status),
  orgSeverityStatusIdx: index('s1_threats_org_severity_status_idx').on(table.orgId, table.severity, table.status),
  integrationIdx: index('s1_threats_integration_idx').on(table.integrationId),
  integrationDetectedIdx: index('s1_threats_integration_detected_idx').on(table.integrationId, table.detectedAt),
  deviceIdx: index('s1_threats_device_idx').on(table.deviceId)
}));

export const s1Actions = pgTable('s1_actions', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  deviceId: uuid('device_id').references(() => devices.id),
  requestedBy: uuid('requested_by').references(() => users.id),
  action: varchar('action', { length: 40 }).notNull(),
  payload: jsonb('payload'),
  status: varchar('status', { length: 20 }).notNull().default('queued'),
  providerActionId: varchar('provider_action_id', { length: 128 }),
  requestedAt: timestamp('requested_at').defaultNow().notNull(),
  completedAt: timestamp('completed_at'),
  error: text('error')
}, (table) => ({
  orgStatusIdx: index('s1_actions_org_status_idx').on(table.orgId, table.status),
  providerActionIdx: index('s1_actions_provider_action_idx').on(table.providerActionId)
}));
