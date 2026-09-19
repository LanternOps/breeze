import {
  bigserial,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { organizations } from './orgs';
import { tickets } from './portal';

// Transactional outbox for ticket lifecycle events (wave 6 PR 3, #3828 —
// docs/superpowers/plans/ai-mcp/2026-08-28-ai-agents-wave6-3-ticket-shadow.md).
//
// Clone of intent_outbox's shape (db/schema/actionIntents.ts) with one
// deliberate difference: intent_outbox is INTENTIONALLY UNSCOPED (no org_id
// column, no RLS — see its migration header) because its only readers are a
// system-scoped publisher and the row it announces is reachable one hop away
// via intent_id. ticket_outbox instead carries its own `org_id` and IS
// RLS-scoped (Tenancy Shape 1, direct org_id, auto-discovered by
// rls-coverage.integration.test.ts) — the durable eventSubscriberRegistry
// subscriber (Task 3) needs to resolve helpdesk agents by org directly off
// this table's admission path, and a partner-wide agent read needs the same
// org-scoped access the rest of the tenancy model gives every other table.
// No partner_id: a single direct org_id FK is sufficient (mirrors
// intentOutbox's simplicity otherwise) — org RLS via breeze_has_org_access
// already grants system scope for the publisher worker, same as
// action_intents.
//
// Written in the SAME transaction as the ticket mutation that announces it
// (ticketService.ts, Task 2) — never as a follow-up write. Payload is
// id-only by construction (never subject/description/resolutionNote), but
// jsonb is still classified excludedOpen in the export policy regardless of
// what it happens to contain today (CLAUDE.md: "any json/jsonb/bytea column
// ... cannot go in `included` even when its contents look harmless").
export const ticketOutboxEventEnum = [
  'ticket.created',
  'ticket.status_changed',
  'ticket.updated',
  'ticket.assigned',
  'ticket.commented',
  'ticket.restored',
] as const;
export type TicketOutboxEvent = (typeof ticketOutboxEventEnum)[number];

export const ticketOutbox = pgTable(
  'ticket_outbox',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    orgId: uuid('org_id').notNull().references(() => organizations.id, {
      onDelete: 'cascade',
    }),
    ticketId: uuid('ticket_id').notNull().references(() => tickets.id, {
      onDelete: 'cascade',
    }),
    eventType: text('event_type').notNull().$type<TicketOutboxEvent>(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    publishAttempts: integer('publish_attempts').notNull().default(0),
  },
  (table) => ({
    orgIdx: index('ticket_outbox_org_id_idx').on(table.orgId),
    ticketIdIdx: index('ticket_outbox_ticket_id_idx').on(table.ticketId),
    // #4210 — supports ticketOutboxRetention.ts's delivered-row cutoff scan
    // (published_at < cutoff), the mirror image of the unpublished partial
    // index below.
    publishedAtIdx: index('ticket_outbox_published_at_idx').on(table.publishedAt),
    // Note: the partial index ticket_outbox_unpublished_idx (WHERE
    // published_at IS NULL, on (published_at, id) per the plan) is declared
    // in the SQL migration only — Drizzle's index DSL doesn't model partial
    // indexes cleanly (same precedent as intent_outbox_unpublished_idx /
    // elevations.ts's elevation_requests_org_pending_idx et al).
  }),
);

export type TicketOutboxRow = typeof ticketOutbox.$inferSelect;
export type NewTicketOutboxRow = typeof ticketOutbox.$inferInsert;
