import {
  bigserial,
  char,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import type { AssuranceLevel } from '@breeze/shared';
import { organizations, partners } from './orgs';
import { users } from './users';
import { apiKeys } from './apiKeys';

// Action intents & durable approval layer (spec
// docs/superpowers/specs/2026-07-18-action-intents-approval-layer-design.md).
//
// Tenancy Shape 1: direct `org_id` column. `partner_id` is denormalized for
// ops queries only (mirrors elevations.ts / devices.ts) — it is NOT an
// ownership axis (not dual-axis; org_id is always required). RLS policies key
// on breeze_has_org_access(org_id), same migration.
//
// status/source/event_type are plain string unions backed by TEXT + CHECK
// columns in the migration, not Drizzle's `pgEnum()` — every existing
// `pgEnum()` in this codebase (elevationStatusEnum, approvalStatusEnum,
// cisBaselineLevelEnum, ...) is paired with a real `CREATE TYPE ... AS ENUM`.
// This table intentionally has none (see the migration header for why), so
// modeling it as `pgEnum()` here would claim a native type that doesn't
// exist. `.$type<T>()` on a `text()` column is the established alternative
// for CHECK-constrained string columns without a backing enum type (see
// apps/api/src/db/schema/m365.ts — profile/authMode/status).

export const actionIntentStatusEnum = [
  'pending_approval',
  'approved',
  'executing',
  'completed',
  'failed',
  'rejected',
  'expired',
  'cancelled',
] as const;
export type ActionIntentStatus = (typeof actionIntentStatusEnum)[number];

export const actionIntentSourceEnum = ['chat', 'mcp_api'] as const;
export type ActionIntentSource = (typeof actionIntentSourceEnum)[number];

export const intentOutboxEventEnum = ['intent_created', 'intent_approved'] as const;
export type IntentOutboxEvent = (typeof intentOutboxEventEnum)[number];

export const actionIntents = pgTable(
  'action_intents',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // Tenancy (Shape 1)
    orgId: uuid('org_id').notNull().references(() => organizations.id),
    partnerId: uuid('partner_id').references(() => partners.id),

    // Identity / attribution. Exactly one of requestedByUserId /
    // requestingApiKeyId is set — enforced by action_intents_one_actor_chk
    // (migration only; not modeled here, mirrors elevations.ts precedent).
    requestedByUserId: uuid('requested_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    requestingApiKeyId: uuid('requesting_api_key_id').references(() => apiKeys.id, {
      onDelete: 'set null',
    }),
    source: text('source').notNull().$type<ActionIntentSource>(),
    requestingClientLabel: varchar('requesting_client_label', { length: 255 }),

    // Immutable action content (UPDATE-blocked by action_intents_immutable_trg
    // in the migration — material edits are a new intent, not an edit).
    actionName: varchar('action_name', { length: 255 }).notNull(),
    actionVersion: integer('action_version').notNull().default(1),
    arguments: jsonb('arguments').$type<Record<string, unknown>>().notNull().default({}),
    argumentDigest: char('argument_digest', { length: 64 }).notNull(),
    targetSummary: text('target_summary').notNull(),
    impactSummary: text('impact_summary').notNull(),
    reason: text('reason'),
    // 3 (Tier-3) only in v1; column exists for future Tier-2 policy use.
    riskTier: smallint('risk_tier').notNull(),
    // M365 mutation forward-compat (dormant until stage 5).
    connectionId: uuid('connection_id'),
    tenantId: uuid('tenant_id'),
    idempotencyKey: text('idempotency_key').notNull(),
    correlationId: uuid('correlation_id').notNull(),

    // Lifecycle (mutable).
    status: text('status').notNull().default('pending_approval').$type<ActionIntentStatus>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decidedByUserId: uuid('decided_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    // Mirrors elevations.ts's decidedAssuranceLevel: DB-capped range is
    // enforced by the release/decision handlers (later tasks), not a DB
    // CHECK here; `.$type` keeps the inferred read type aligned.
    decidedAssuranceLevel: smallint('decided_assurance_level').$type<AssuranceLevel>(),
    decidedVia: text('decided_via'),
    // Stamped by the release worker when it CASes the intent
    // approved -> executing (Task 5). Stale-execution detection keys off
    // this (COALESCE'd to decidedAt for rows that predate the column or
    // were never stamped) rather than decidedAt, which can precede
    // execution start when approval->execution lags.
    executionStartedAt: timestamp('execution_started_at', { withTimezone: true }),
    executedAt: timestamp('executed_at', { withTimezone: true }),
    result: jsonb('result').$type<Record<string, unknown> | null>(),
    errorCode: text('error_code'),
  },
  (table) => ({
    orgStatusIdx: index('action_intents_org_status_idx').on(
      table.orgId,
      table.status,
      table.expiresAt,
    ),
    // Note: action_intents_org_idem_uniq is a PARTIAL unique index (WHERE
    // status IN ('pending_approval','approved','executing') — IMPORTANT-4)
    // declared in the SQL migration only; Drizzle's index DSL doesn't model
    // partial indexes cleanly (same precedent as intent_outbox_unpublished_idx
    // below / elevations.ts's elevation_requests_org_pending_idx et al). The
    // matching partial predicate is passed to onConflictDoNothing's `where`
    // in intentService.ts's createActionIntent — see the comment there.
  }),
);

export type ActionIntent = typeof actionIntents.$inferSelect;
export type NewActionIntent = typeof actionIntents.$inferInsert;

// Transactional outbox: written in the same transaction as the intent
// row/status transition it announces. System-scoped (no org RLS, workers
// only) — same shape as devices.ts's device_commands, documented as
// INTENTIONAL_UNSCOPED in rls-coverage.integration.test.ts. FK is ON DELETE
// CASCADE from action_intents, so org erasure cleans this up for free — no
// separate entry in tenantCascade.ts's CORE_ORG_CASCADE_DELETE_ORDER.
export const intentOutbox = pgTable(
  'intent_outbox',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    intentId: uuid('intent_id').notNull().references(() => actionIntents.id, {
      onDelete: 'cascade',
    }),
    eventType: text('event_type').notNull().$type<IntentOutboxEvent>(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    publishAttempts: integer('publish_attempts').notNull().default(0),
  },
  (table) => ({
    intentIdIdx: index('intent_outbox_intent_id_idx').on(table.intentId),
    // Note: the partial index intent_outbox_unpublished_idx (WHERE
    // published_at IS NULL) is declared in the SQL migration only — Drizzle's
    // index DSL doesn't model partial indexes cleanly (same precedent as
    // elevations.ts's elevation_requests_org_pending_idx et al).
  }),
);

export type IntentOutboxRow = typeof intentOutbox.$inferSelect;
export type NewIntentOutboxRow = typeof intentOutbox.$inferInsert;
