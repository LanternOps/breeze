import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { deviceCommands, devices } from './devices';
import { organizations } from './orgs';
import { users } from './users';

export type AgentRollbackStatus = 'requested' | 'in_progress' | 'completed' | 'failed' | 'recovered' | 'expired';
export type AgentRollbackPhase = 'requested' | 'received' | 'downloaded' | 'verified' | 'staged' | 'swapped' | 'restart_requested' | 'healthy' | 'failed' | 'recovered';

export const agentRollbackDirectives = pgTable('agent_rollback_directives', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  deviceId: uuid('device_id').notNull(),
  platform: varchar('platform', { length: 16 }).notNull(),
  architecture: varchar('architecture', { length: 16 }).notNull(),
  currentVersion: varchar('current_version', { length: 100 }).notNull(),
  targetVersion: varchar('target_version', { length: 100 }).notNull(),
  componentVersions: jsonb('component_versions').$type<Record<string, { current: string; target: string }>>().notNull(),
  releaseManifest: text('release_manifest').notNull(),
  manifestSignature: text('manifest_signature').notNull(),
  manifestSigningKeyId: varchar('manifest_signing_key_id', { length: 255 }).notNull(),
  artifacts: jsonb('artifacts').$type<Array<Record<string, unknown>>>().notNull(),
  reason: text('reason').notNull(),
  authorizedBy: uuid('authorized_by').notNull().references(() => users.id),
  approvedAt: timestamp('approved_at', { withTimezone: true }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  directiveSigningKeyId: varchar('directive_signing_key_id', { length: 255 }).notNull(),
  directiveSignature: text('directive_signature').notNull(),
  commandId: uuid('command_id').references(() => deviceCommands.id, { onDelete: 'set null' }),
  status: varchar('status', { length: 24 }).$type<AgentRollbackStatus>().notNull().default('requested'),
  latestPhase: varchar('latest_phase', { length: 32 }).$type<AgentRollbackPhase>(),
  lastErrorCode: varchar('last_error_code', { length: 128 }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  deviceOrgFk: foreignKey({
    name: 'agent_rollback_directives_device_org_fk',
    columns: [table.deviceId, table.orgId],
    foreignColumns: [devices.id, devices.orgId],
  }).onDelete('cascade'),
  activeDeviceUq: uniqueIndex('agent_rollback_directives_active_device_uq')
    .on(table.deviceId)
    .where(sql`${table.status} IN ('requested', 'in_progress')`),
  identityUq: uniqueIndex('agent_rollback_directives_identity_uq').on(table.id, table.deviceId, table.orgId),
  orgCreatedIdx: index('agent_rollback_directives_org_created_idx').on(table.orgId, table.createdAt, table.id),
  statusCheck: check('agent_rollback_directives_status_chk', sql`${table.status} IN ('requested', 'in_progress', 'completed', 'failed', 'recovered', 'expired')`),
  expiryCheck: check('agent_rollback_directives_expiry_chk', sql`${table.expiresAt} > ${table.approvedAt}`),
}));

export const agentRollbackEvents = pgTable('agent_rollback_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  rollbackId: uuid('rollback_id').notNull(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  deviceId: uuid('device_id').notNull(),
  phase: varchar('phase', { length: 32 }).$type<AgentRollbackPhase>().notNull(),
  observationId: varchar('observation_id', { length: 255 }).notNull(),
  observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
  currentVersion: varchar('current_version', { length: 100 }).notNull(),
  componentVersions: jsonb('component_versions').$type<Record<string, string>>().notNull(),
  errorCode: varchar('error_code', { length: 128 }),
  observation: jsonb('observation').$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  deviceOrgFk: foreignKey({
    name: 'agent_rollback_events_device_org_fk',
    columns: [table.deviceId, table.orgId],
    foreignColumns: [devices.id, devices.orgId],
  }).onDelete('cascade'),
  rollbackIdentityFk: foreignKey({
    name: 'agent_rollback_events_rollback_identity_fk',
    columns: [table.rollbackId, table.deviceId, table.orgId],
    foreignColumns: [agentRollbackDirectives.id, agentRollbackDirectives.deviceId, agentRollbackDirectives.orgId],
  }).onDelete('cascade'),
  observationUq: uniqueIndex('agent_rollback_events_observation_uq').on(table.rollbackId, table.observationId),
  orgTimeIdx: index('agent_rollback_events_org_time_idx').on(table.orgId, table.observedAt, table.id),
  rollbackTimeIdx: index('agent_rollback_events_rollback_time_idx').on(table.rollbackId, table.observedAt, table.id),
  phaseCheck: check('agent_rollback_events_phase_chk', sql`${table.phase} IN ('requested', 'received', 'downloaded', 'verified', 'staged', 'swapped', 'restart_requested', 'healthy', 'failed', 'recovered')`),
}));
