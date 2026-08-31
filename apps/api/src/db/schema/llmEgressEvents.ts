// apps/api/src/db/schema/llmEgressEvents.ts
import { boolean, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { llmProviderCatalog, llmProviderCatalogRevisions } from './llmProviderCatalog';

/**
 * Where an egress attempt originated. Mirrors the CHECK constraint in
 * `2026-09-13-c-llm-egress-events.sql` — the two must be edited together.
 */
export const LLM_EGRESS_SURFACES = [
  'sdk_session_create',
  'sdk_proxy_connect',
  'one_shot_ticket_draft',
  'one_shot_email_draft',
  'one_shot_catalog_enrichment',
  'one_shot_probe',
  'workspace_enrichment',
] as const;

export type LlmEgressSurface = (typeof LLM_EGRESS_SURFACES)[number];

/**
 * One outbound LLM attempt, allowed or refused (#3922 phase 2). Per-request,
 * not per-session: a blocked dial in the middle of a healthy session is
 * exactly the event this table exists to make visible.
 *
 * `org_id` is a plain column (RLS shape 1) and the composite
 * `(org_id, partner_id)` FK to `organizations` keeps the two axes consistent.
 */
export const llmEgressEvents = pgTable('llm_egress_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull(),
  partnerId: uuid('partner_id').notNull(),
  catalogEntryId: uuid('catalog_entry_id').references(() => llmProviderCatalog.id, { onDelete: 'set null' }),
  revisionId: uuid('revision_id').references(() => llmProviderCatalogRevisions.id, { onDelete: 'set null' }),
  aiSessionId: uuid('ai_session_id'),
  surface: text('surface', { enum: LLM_EGRESS_SURFACES }).notNull(),
  host: text('host').notNull(),
  resolvedIp: text('resolved_ip'),
  blocked: boolean('blocked').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('llm_egress_events_org_idx').on(t.orgId, t.createdAt),
  index('llm_egress_events_partner_idx').on(t.partnerId, t.createdAt),
]);

export type LlmEgressEvent = typeof llmEgressEvents.$inferSelect;
export type NewLlmEgressEvent = typeof llmEgressEvents.$inferInsert;
