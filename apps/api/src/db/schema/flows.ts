import {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  smallint,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type { FlowAdmissionRefusal, FlowPausedReason, FlowStatus, FlowWebhookAuthFailure } from '@breeze/shared';
import { organizations, partners } from './orgs';
import { users } from './users';
import { aiSessions } from './ai';
import { aiAgents } from './aiAgents';

/**
 * Tool Catalog W03 (#5215 / #5218) — flows (draft documents in W03; enable,
 * runs and webhooks arrive in W04/W05).
 * Spec: docs/superpowers/specs/ai-mcp/2026-09-07-tool-catalog-and-flows-design.md §6.4.
 *
 * Ownership follows "Partner-Wide First": org_id XOR partner_id, enforced by
 * `flows_one_owner_chk` in 2027-01-02-130000-flows.sql (CHECKs live in the
 * migration, per the house convention), together with the slug, status,
 * paused-reason, tier and definition-shape CHECKs.
 *
 * `definition` is the validated FlowDocumentV1. It is overwritten on every
 * draft save (`definition_version` + 1); W04 runs pin an immutable
 * `flow_versions` publication instead (flowRuns.ts).
 * Export policy: excludedOpen (jsonb).
 */
export const flows = pgTable(
  'flows',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'cascade' }),
    partnerId: uuid('partner_id').references(() => partners.id, { onDelete: 'cascade' }),
    slug: varchar('slug', { length: 48 }).notNull(),
    name: varchar('name', { length: 120 }).notNull(),
    description: text('description'),
    definition: jsonb('definition').$type<Record<string, unknown>>().notNull(),
    definitionVersion: integer('definition_version').notNull().default(1),
    effectiveTier: smallint('effective_tier').notNull(),
    status: text('status').$type<FlowStatus>().notNull().default('draft'),
    /** Values pinned by flows_paused_reason_values_chk (W04, 2027-01-06-130000-flow-runs.sql). */
    pausedReason: text('paused_reason').$type<FlowPausedReason>(),
    enabledByUserId: uuid('enabled_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    enabledAt: timestamp('enabled_at', { withTimezone: true }),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    /** Back-filled from the authenticated chat session, never from tool input. */
    aiSessionId: uuid('ai_session_id').references(() => aiSessions.id, { onDelete: 'set null' }),
    managedByAgentId: uuid('managed_by_agent_id').references(() => aiAgents.id, { onDelete: 'set null' }),
    /**
     * W04: the live flow_versions.publication_seq runs pin. Set iff status is
     * enabled or paused (flows_enabled_publication_chk). No FK back to
     * flow_versions — flow_versions already references flows.
     */
    enabledPublicationSeq: integer('enabled_publication_seq'),
    /** W04: the last schedule occurrence the tick enqueued (dedupe across ticks). */
    scheduleLastOccurrenceKey: text('schedule_last_occurrence_key'),
    /**
     * W05 (2027-01-07-140000-flow-webhooks-tools-budgets.sql): the per-flow webhook secret,
     * secretCrypto ciphertext with row-bound AAD (encryptedColumnRegistry
     * `flows.webhook_secret_encrypted`; export excludedSensitive). Set together with the
     * fingerprint and rotated_at (flows_webhook_secret_pair_chk). The fingerprint is for
     * display and change detection only — never a verifier.
     */
    webhookSecretEncrypted: text('webhook_secret_encrypted'),
    webhookSecretFingerprint: text('webhook_secret_fingerprint'),
    webhookSecretRotatedAt: timestamp('webhook_secret_rotated_at', { withTimezone: true }),
    /** W05: last unauthenticated delivery, written at most once a minute (flows_webhook_auth_failure_chk). */
    webhookLastAuthFailureAt: timestamp('webhook_last_auth_failure_at', { withTimezone: true }),
    webhookLastAuthFailureReason: text('webhook_last_auth_failure_reason').$type<FlowWebhookAuthFailure>(),
    /** W05: last admission refusal (a monthly cap or the active queue), ≤ once a minute (flows_last_admission_refusal_chk). */
    lastAdmissionRefusalAt: timestamp('last_admission_refusal_at', { withTimezone: true }),
    lastAdmissionRefusalCode: text('last_admission_refusal_code').$type<FlowAdmissionRefusal>(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    orgSlugUq: uniqueIndex('flows_org_slug_uq')
      .on(table.orgId, table.slug)
      .where(sql`${table.orgId} IS NOT NULL`),
    partnerSlugUq: uniqueIndex('flows_partner_slug_uq')
      .on(table.partnerId, table.slug)
      .where(sql`${table.orgId} IS NULL`),
    orgStatusIdx: index('flows_org_status_idx').on(table.orgId, table.status),
    partnerWideIdx: index('flows_partner_wide_idx')
      .on(table.partnerId)
      .where(sql`${table.orgId} IS NULL`),
  }),
);

export type FlowRow = typeof flows.$inferSelect;
