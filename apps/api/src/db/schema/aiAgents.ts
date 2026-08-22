import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import type {
  AiAgentKind,
  AiAgentLimits,
  AiAgentMode,
  AiAgentPolicySnapshot,
  AiAgentProtectedResources,
  AiAgentRecipients,
  AiAgentRunStatus,
  AiAgentTriggerKind,
  AiAgentTriggers,
} from '@breeze/shared';
import { alerts } from './alerts';
import { aiSessions } from './ai';
import { devices } from './devices';
import { organizations, partners } from './orgs';
import { users } from './users';

// Dual-ownership (#2135, spec §4.1): an agent belongs to EITHER one org
// (org_id set) OR a whole partner (partner_id set, org_id NULL). The XOR
// CHECK `ai_agents_one_owner_chk` lives in 2026-09-01-ai-agents.sql.
// Never hard-deleted: `disabled_at` is the soft delete and the partial
// unique indexes only consider live rows.
export const aiAgents = pgTable('ai_agents', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').references(() => organizations.id),
  partnerId: uuid('partner_id').references(() => partners.id),
  kind: text('kind').$type<AiAgentKind>().notNull(),
  name: varchar('name', { length: 120 }).notNull(),
  enabled: boolean('enabled').notNull().default(false),
  mode: text('mode').$type<AiAgentMode>().notNull().default('off'),
  model: varchar('model', { length: 100 }),
  toolAllowlist: jsonb('tool_allowlist').$type<string[]>().notNull().default([]),
  protectedResources: jsonb('protected_resources').$type<Partial<AiAgentProtectedResources>>().notNull().default({}),
  limits: jsonb('limits').$type<Partial<AiAgentLimits>>().notNull().default({}),
  triggers: jsonb('triggers').$type<Partial<AiAgentTriggers>>().notNull().default({}),
  recipients: jsonb('recipients').$type<Partial<AiAgentRecipients>>().notNull().default({}),
  instructions: text('instructions'),
  cooldownSeconds: integer('cooldown_seconds').notNull().default(900),
  disabledAt: timestamp('disabled_at', { withTimezone: true }),
  disabledBy: uuid('disabled_by').references(() => users.id),
  createdBy: uuid('created_by').notNull().references(() => users.id),
  lastUpdatedBy: uuid('last_updated_by').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  partnerKindUq: uniqueIndex('ai_agents_partner_kind_uq').on(table.partnerId, table.kind)
    .where(sql`${table.orgId} IS NULL AND ${table.disabledAt} IS NULL`),
  orgKindUq: uniqueIndex('ai_agents_org_kind_uq').on(table.orgId, table.kind)
    .where(sql`${table.disabledAt} IS NULL`),
  partnerIdx: index('ai_agents_partner_id_idx').on(table.partnerId),
  orgIdx: index('ai_agents_org_id_idx').on(table.orgId),
}));

// Ledger (spec §4.2). org_id is ALWAYS the target org (the device's org), even
// for a partner-wide agent. Shape 1 RLS + device cascade + org-denormalized.
export const aiAgentRuns = pgTable('ai_agent_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  agentId: uuid('agent_id').notNull().references(() => aiAgents.id, { onDelete: 'restrict' }),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  deviceId: uuid('device_id').references(() => devices.id, { onDelete: 'set null' }),
  alertId: uuid('alert_id').references(() => alerts.id, { onDelete: 'set null' }),
  sessionId: uuid('session_id').references(() => aiSessions.id, { onDelete: 'set null' }),
  triggerKind: text('trigger_kind').$type<AiAgentTriggerKind>().notNull(),
  triggerEventId: varchar('trigger_event_id', { length: 64 }),
  triggerRef: jsonb('trigger_ref').$type<Record<string, unknown>>().notNull().default({}),
  dedupeKey: varchar('dedupe_key', { length: 255 }).notNull(),
  modeAtStart: text('mode_at_start').$type<Exclude<AiAgentMode, 'off'>>().notNull(),
  policySnapshot: jsonb('policy_snapshot').$type<AiAgentPolicySnapshot>().notNull(),
  status: text('status').$type<AiAgentRunStatus>().notNull().default('queued'),
  summary: text('summary'),
  outcome: jsonb('outcome').$type<Record<string, unknown>>().notNull().default({}),
  intentIds: uuid('intent_ids').array().notNull().default(sql`'{}'::uuid[]`),
  turnCount: integer('turn_count').notNull().default(0),
  costCents: integer('cost_cents').notNull().default(0),
  errorCode: varchar('error_code', { length: 64 }),
  correlationId: varchar('correlation_id', { length: 64 }),
  queuedAt: timestamp('queued_at', { withTimezone: true }).defaultNow().notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
}, (table) => ({
  dedupeUq: unique('ai_agent_runs_dedupe_key_uq').on(table.dedupeKey),
  agentQueuedIdx: index('ai_agent_runs_agent_queued_idx').on(table.agentId, table.queuedAt.desc()),
  orgQueuedIdx: index('ai_agent_runs_org_queued_idx').on(table.orgId, table.queuedAt.desc()),
  deviceIdx: index('ai_agent_runs_device_id_idx').on(table.deviceId),
}));

export type AiAgentRow = typeof aiAgents.$inferSelect;
export type AiAgentRunRow = typeof aiAgentRuns.$inferSelect;
