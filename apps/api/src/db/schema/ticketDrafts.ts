import { sql } from 'drizzle-orm';
import { check, foreignKey, index, pgTable, text, timestamp, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { organizations } from './orgs';
import { tickets } from './portal';
import { aiAgentRuns } from './aiAgents';
import { actionIntents } from './actionIntents';
import { users } from './users';

// Phase 2 wave P2-4 (#4187 / #4191): AI ticket triage.
// Migration: 2026-09-25-ai-agents-ticket-triage.sql.
//
// A ticket_drafts row is a proposed reply or resolution note an agent has
// written for a ticket, sitting in `active` state until a human consumes
// (posts) or discards it, or a fresher draft of the same kind supersedes it
// (ticket_drafts_active_uq: at most one `active` row per (ticket_id, kind)).
// It is NOT itself the ticket_comments row that ends up visible on the
// ticket — consuming a draft is the write path that creates one (Task
// A6/A8/A10), stamping ticket_comments.origin_principal_kind = 'ai_agent'
// and .agent_run_id, subject to the one-AI-note-per-run partial unique index
// added on ticket_comments in the same migration.
//
// Tenancy Shape 1: direct NOT NULL org_id. RLS policy is the canonical
// single-clause breeze_has_org_access(org_id) idiom (no separate system
// branch — see the migration's RLS comment for why the dual-clause
// ai_agent_schedules pattern does NOT apply here).
export const ticketDraftKindEnum = ['reply', 'resolution_note'] as const;
export type TicketDraftKind = (typeof ticketDraftKindEnum)[number];

export const ticketDraftStateEnum = ['active', 'consumed', 'discarded', 'superseded'] as const;
export type TicketDraftState = (typeof ticketDraftStateEnum)[number];

export const ticketDrafts = pgTable(
  'ticket_drafts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    // Composite FK (ticket_id, org_id) -> tickets(id, org_id) declared in the
    // table-options block below (needs tickets_id_org_uq, same migration) —
    // no single-column .references() here, mirroring actionIntents.ts's
    // requestingAgentRunId precedent.
    ticketId: uuid('ticket_id').notNull(),
    /**
     * The ai_agent_runs row that produced this draft, if any. Composite FK
     * (run_id, org_id) -> ai_agent_runs(id, org_id) declared below — mirrors
     * action_intents.requestingAgentRunOrgFk (actionIntents.ts:325-345)
     * EXACTLY, including ON DELETE RESTRICT (runs are never hard-deleted;
     * attribution survives). Nullable: a draft need not originate from a run.
     */
    runId: uuid('run_id'),
    /**
     * The action_intents row this draft's posting was gated behind, if any
     * (a triage proposal that required approval before becoming a comment).
     * Composite FK (intent_id, org_id) -> action_intents(id, org_id) below,
     * same ON DELETE RESTRICT treatment as runId.
     */
    intentId: uuid('intent_id'),
    kind: text('kind').notNull().$type<TicketDraftKind>(),
    content: text('content').notNull(),
    state: text('state').notNull().default('active').$type<TicketDraftState>(),
    /**
     * The draft that replaced this one when superseded. ON DELETE SET NULL —
     * losing the successor doesn't resurrect this row. Lazy `(): AnyPgColumn
     * =>` self-reference (not a plain `() =>` typed one) — same pattern as
     * aiAlertVerdicts.supersededBy / aiAgentSchedules.baselineScheduleId,
     * needed because `ticketDrafts` isn't assigned yet while this callback
     * runs.
     */
    supersededBy: uuid('superseded_by').references((): AnyPgColumn => ticketDrafts.id, { onDelete: 'set null' }),
    /** Who consumed (posted) this draft. Required together with consumedAt whenever state = 'consumed' (ticket_drafts_consumed_chk). */
    consumedBy: uuid('consumed_by').references(() => users.id, { onDelete: 'set null' }),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // All three composite FKs below are also DEFERRABLE INITIALLY IMMEDIATE
    // in the migration (org-lifecycle contract,
    // 2026-09-12-100001-org-lifecycle-foundations.sql) — drizzle-orm's
    // foreignKey() builder has no deferrable option, so that detail lives in
    // the migration only (same documented limitation as
    // deviceMtlsCertificates.ts's device_org_fkey; db:check-drift does not
    // compare FK options against the DB).
    ticketOrgFk: foreignKey({
      columns: [table.ticketId, table.orgId],
      foreignColumns: [tickets.id, tickets.orgId],
      name: 'ticket_drafts_ticket_org_fk',
    }).onDelete('cascade'),
    runOrgFk: foreignKey({
      columns: [table.runId, table.orgId],
      foreignColumns: [aiAgentRuns.id, aiAgentRuns.orgId],
      name: 'ticket_drafts_run_org_fk',
    }).onDelete('restrict'),
    intentOrgFk: foreignKey({
      columns: [table.intentId, table.orgId],
      foreignColumns: [actionIntents.id, actionIntents.orgId],
      name: 'ticket_drafts_intent_org_fk',
    }).onDelete('restrict'),
    consumedChk: check(
      'ticket_drafts_consumed_chk',
      sql`${table.state} <> 'consumed' OR (${table.consumedBy} IS NOT NULL AND ${table.consumedAt} IS NOT NULL)`,
    ),
    orgIdx: index('ticket_drafts_org_idx').on(table.orgId),
    ticketIdx: index('ticket_drafts_ticket_idx').on(table.ticketId),
    // Note: ticket_drafts_active_uq (WHERE state = 'active') is a PARTIAL
    // unique index declared in the SQL migration only — Drizzle's index DSL
    // doesn't model partial indexes cleanly (same precedent as
    // intent_outbox_unpublished_idx / elevations.ts's
    // elevation_requests_org_pending_idx et al).
  }),
);

export type TicketDraft = typeof ticketDrafts.$inferSelect;
export type NewTicketDraft = typeof ticketDrafts.$inferInsert;
