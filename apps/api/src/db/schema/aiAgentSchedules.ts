// apps/api/src/db/schema/aiAgentSchedules.ts
import { boolean, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type { AiSweepKind, AiAgentScheduleKind, AiAgentScheduleRunSummary } from '@breeze/shared';
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
  // INVARIANT (review round 1, Important 3, #4189) — enforced in the WRITE
  // PATH, not by a DB constraint (no composite FK: both parents are
  // dual-owner, so a NULL-bearing composite FK is unenforced for org rows):
  //   - an org override's baseline must be a partner row belonging to the
  //     org's OWN partner, with the SAME agentId as the override;
  //   - a partner row's agent must itself be a partner-wide triage agent
  //     under that SAME partnerId.
  // Enforced by services/aiAgents/scheduleService.ts (Task A8) under a
  // SELECT ... FOR SHARE on the baseline row at write time, with an
  // integration test there. See the migration's matching comment.
  agentId: uuid('agent_id').notNull().references(() => aiAgents.id, { onDelete: 'cascade' }),
  // Same cross-tenant-pointer invariant as agentId above — see that comment.
  baselineScheduleId: uuid('baseline_schedule_id').references((): AnyPgColumn => aiAgentSchedules.id, { onDelete: 'cascade' }),
  // P2-3 (#4190): which lane this schedule drives. A narrative schedule is its
  // OWN row (never a flag on a sweep row); an org override may not disagree
  // with its baseline, enforced by the composite self-FK
  // ai_agent_schedules_baseline_kind_fk (baseline_schedule_id, kind) →
  // (id, kind) in migrations/2026-09-24-b-ai-agents-org-narrative.sql, which
  // is also where its backing UNIQUE (id, kind) index lives. Declared in SQL
  // only — same treatment as every CHECK on this table; Drizzle is used for
  // typed queries here, not as the constraint source of truth.
  kind: text('kind').$type<AiAgentScheduleKind>().notNull().default('sweep'),
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
