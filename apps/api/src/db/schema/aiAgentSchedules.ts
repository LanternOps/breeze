// apps/api/src/db/schema/aiAgentSchedules.ts
import { boolean, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type { AiSweepKind, AiAgentScheduleRunSummary } from '@breeze/shared';
import { organizations, partners } from './orgs';
import { users } from './users';
import { aiAgents } from './aiAgents';

// Dual-ownership (#2135): a schedule is a PARTNER baseline (partner_id set,
// org_id NULL, baseline_schedule_id NULL) or an ORG override (org_id set,
// baseline_schedule_id → the partner row it tightens). CHECKs
// ai_agent_schedules_one_owner_chk / _baseline_chk live in the migration.
export const aiAgentSchedules = pgTable('ai_agent_schedules', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'cascade' }),
  partnerId: uuid('partner_id').references(() => partners.id, { onDelete: 'cascade' }),
  agentId: uuid('agent_id').notNull().references(() => aiAgents.id, { onDelete: 'cascade' }),
  baselineScheduleId: uuid('baseline_schedule_id').references((): any => aiAgentSchedules.id, { onDelete: 'cascade' }),
  cron: text('cron').notNull(),
  timezone: text('timezone').notNull().default('UTC'),
  sweepKinds: text('sweep_kinds').array().$type<AiSweepKind[]>().notNull().default(sql`'{}'::text[]`),
  enabled: boolean('enabled').notNull().default(true),
  lastEnqueuedAt: timestamp('last_enqueued_at', { withTimezone: true }),
  lastOccurrenceKey: text('last_occurrence_key'),
  lastRunSummary: jsonb('last_run_summary').$type<AiAgentScheduleRunSummary>(),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  partnerIdx: index('ai_agent_schedules_partner_idx').on(t.partnerId).where(sql`${t.partnerId} IS NOT NULL`),
  orgIdx: index('ai_agent_schedules_org_idx').on(t.orgId).where(sql`${t.orgId} IS NOT NULL`),
  agentIdx: index('ai_agent_schedules_agent_idx').on(t.agentId),
  orgBaselineUq: uniqueIndex('ai_agent_schedules_org_baseline_uq').on(t.orgId, t.baselineScheduleId).where(sql`${t.orgId} IS NOT NULL`),
}));

export type AiAgentScheduleRow = typeof aiAgentSchedules.$inferSelect;
export type NewAiAgentScheduleRow = typeof aiAgentSchedules.$inferInsert;
