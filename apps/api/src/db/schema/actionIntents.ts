import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  char,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { AI_APPROVAL_SCOPES, type AiApprovalScope, type AssuranceLevel } from '@breeze/shared';
import { organizations, partners } from './orgs';
import { users } from './users';
import { apiKeys } from './apiKeys';
import { aiAgentRuns } from './aiAgents';
import { devices } from './devices';
import { pamActuations } from './elevations';
import { tickets } from './portal';

// Action intents & durable approval layer (spec
// docs/superpowers/specs/ai-mcp/2026-07-18-action-intents-approval-layer-design.md).
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

// 'ai_agent' (wave 3, #3824): a headless agent proposal. Distinct from 'chat'
// because nobody is watching a chat pane — supervised agent intents must be
// notified. computeExpiresAt (intentService.ts) gives it an explicit
// AGENT_INTENT_EXPIRY_MS branch (wave 3b) — deliberately 24h, no longer
// inherited from the MCP window by accident.
export const actionIntentSourceEnum = ['chat', 'mcp_api', 'ai_agent'] as const;
export type ActionIntentSource = (typeof actionIntentSourceEnum)[number];

/**
 * Mirrors AuthContext's PrincipalKind, plus 'unknown' for rows created before
 * the discriminator existed. Pinned to the runtime union by a test.
 */
export const actionIntentOriginPrincipalKindEnum = [
  'user_session',
  'client_user',
  'api_key',
  'oauth_grant',
  'agent',
  // The AI agent principal (wave 3). NOT the same as 'agent', which is the Go
  // device agent — see actorContext.ts, where the two must map to different
  // AuthContexts.
  'ai_agent',
  'helper',
  'system',
  'unknown',
] as const;
export type ActionIntentOriginPrincipalKind =
  (typeof actionIntentOriginPrincipalKindEnum)[number];

// Widened in wave 2 (#3823): a DENIED or EXPIRED intent previously wrote no
// outbox row at all, so a requester whose chat turn had ended could never be
// told the outcome. Pinned by a CHECK in SQL — see
// 2026-09-04-ai-agent-notifications.sql.
export const intentOutboxEventEnum = [
  'intent_created',
  'intent_approved',
  'intent_rejected',
  'intent_expired',
  'pam.desired_state_changed',
] as const;
export type IntentOutboxEvent = (typeof intentOutboxEventEnum)[number];

/**
 * Tier-3 supervised/four_eyes classification (spec
 * docs/superpowers/specs/ai-mcp/2026-08-05-tier3-supervised-four-eyes-split-design.md
 * §4.1). Decided once by checkGuardrails at createIntent time.
 *
 * Re-export of the single shared declaration (`AI_APPROVAL_SCOPES` in
 * packages/shared/src/types/ai.ts) under the local schema-file naming
 * convention — NOT an independent copy. The SQL CHECK constraint in
 * 2026-08-14-intent-approval-scope-and-deadlines.sql is pinned to these
 * members by a test in actionIntents.test.ts.
 *
 * There is deliberately no Zod schema for this column: approvalScope is never
 * client-supplied, it is derived server-side by checkGuardrails at intent
 * creation. Adding a validator would wrongly imply callers can pass it.
 */
export const actionIntentApprovalScopeEnum = AI_APPROVAL_SCOPES;
export type ActionIntentApprovalScope = AiApprovalScope;

/**
 * Wave 5 Part A (#3827): the policy-decide lifecycle state. Every intent is
 * created `human_required` in THIS PR — `resolvePolicyDecisionState` is a
 * stub that always returns it (intentService.ts), so `unattempted` and
 * `authorized` are declared but never written yet. Part B's real decision
 * path stamps `unattempted` at creation instead and transitions it to
 * `authorized` (policy satisfied, fanout skipped) or leaves it
 * `human_required` (policy declined or inapplicable, fanout runs).
 *
 * DEFAULT on the column is 'human_required' — deliberately the BACKFILL
 * value for pre-existing rows (they all went through human fanout), not the
 * value Part B's INSERT stamps for a new row. See the migration header.
 *
 * Pinned to the SQL CHECK in 2026-09-16-ai-agents-policy-decide-foundations.sql
 * by a test in actionIntents.test.ts.
 */
export const actionIntentPolicyDecisionStateEnum = [
  'unattempted',
  'authorized',
  'human_required',
] as const;
export type ActionIntentPolicyDecisionState =
  (typeof actionIntentPolicyDecisionStateEnum)[number];

export const actionIntents = pgTable(
  'action_intents',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // Tenancy (Shape 1)
    orgId: uuid('org_id').notNull().references(() => organizations.id),
    partnerId: uuid('partner_id').references(() => partners.id),

    // Identity / attribution. Exactly ONE of requestedByUserId /
    // requestingApiKeyId / requestingAgentRunId is set — enforced by
    // action_intents_one_actor_chk (migration only; not modeled here, mirrors
    // elevations.ts precedent).
    requestedByUserId: uuid('requested_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    requestingApiKeyId: uuid('requesting_api_key_id').references(() => apiKeys.id, {
      onDelete: 'set null',
    }),
    /**
     * The ai_agent_runs row that produced this intent (wave 3, #3824). Set iff
     * origin_principal_kind = 'ai_agent' — paired by
     * action_intents_agent_origin_chk, and `source` is paired to both by
     * action_intents_agent_source_chk.
     *
     * This is the requester's replacement, not a breadcrumb: release
     * revalidation (PR 3b) will reconstruct the agent AuthContext from this
     * run's immutable policy_snapshot and re-check it against the agent's
     * CURRENT effective policy, so a flipped kill switch or a tightened
     * allowlist vetoes an already-approved proposal. Until then
     * buildAuthContextForIntent (actorContext.ts) fails closed on any intent
     * that carries this column.
     *
     * FK declared as a COMPOSITE (requesting_agent_run_id, org_id) →
     * ai_agent_runs(id, org_id) in the table-options block below. No
     * single-column .references() here — the composite FK is the only DB-level
     * tie, and it is what stops an intent in one org from being attributed to
     * an agent run in another (mirrors elevation_audit, elevations.ts:197).
     *
     * ON DELETE RESTRICT — agents and their runs are never hard-deleted
     * (ai-agents spec, 2026-08-22-ai-agents-program-and-wave1-design.md §2 —
     * NOT this file's action-intents spec) and attribution must survive.
     * Immutable, covered by action_intents_immutable_trg.
     */
    requestingAgentRunId: uuid('requesting_agent_run_id'),
    // P2-2 typed target scope. `scopeKind` is immutable; `scopeDeviceId` may
    // only tombstone (non-null -> NULL), never retarget — enforced by
    // action_intents_block_content_update() (migrations/2026-09-23-ai-agents-
    // scheduled-sweeps.sql). Column is NOT named device_id on purpose:
    // cascadeDelete.test.ts keys on `device_id`, and this column's
    // device-delete contract is the two events below, not a cascade list.
    //
    // Two device-lifecycle events produce the tombstone, both landing on the
    // SAME non-null -> NULL transition the trigger permits:
    //   - device DELETE: the FK's `ON DELETE SET NULL` fires automatically.
    //   - device moveOrg: `routes/devices/moveOrg.ts`'s transaction runs an
    //     explicit `UPDATE action_intents SET scope_device_id = NULL WHERE
    //     scope_device_id = <movedDeviceId> AND status IN
    //     ('pending_approval','approved','executing')` — scoped to LIVE
    //     statuses only, since a terminal-status intent is a historical
    //     record of an already-decided action, not something a future
    //     release re-validates (same reasoning as ai_agent_runs' org_id
    //     being left un-restamped by that same transaction).
    // The release path (Task A3, `services/actionIntents/intentTargetScope.ts`)
    // fails closed on either a tombstoned (NULL) scope_device_id or a device
    // whose CURRENT org_id no longer matches the intent's org_id — the second
    // case is what a moveOrg landing between decide and release, or a bug in
    // the detach step above, would otherwise produce.
    scopeKind: text('scope_kind').$type<'device' | 'ticket'>(),
    scopeDeviceId: uuid('scope_device_id').references(() => devices.id, { onDelete: 'set null' }),
    /**
     * P2-4 (#4191) typed target scope for a ticket-triage intent.
     * `scopeKind = 'ticket'` pairs with this column
     * (action_intents_scope_ticket_chk), same shape as scopeDeviceId's
     * pairing with `scopeKind = 'device'`.
     *
     * Deliberately a COMPOSITE (scope_ticket_id, org_id) FK ->
     * tickets(id, org_id) in the table-options block below — stronger than
     * scopeDeviceId's plain single-column FK to devices(id) (a Task-2
     * design choice per the P2-4 plan): a forged cross-tenant ticket
     * pointer is 23503 even under system context, not just an app-layer
     * check. ON DELETE SET NULL is the tombstone transition; the
     * immutability trigger (action_intents_block_content_update(),
     * migrations/2026-09-25-ai-agents-ticket-triage.sql) permits only the
     * same non-null -> NULL transition it already permits for
     * scopeDeviceId, never a retarget.
     */
    scopeTicketId: uuid('scope_ticket_id'),
    source: text('source').notNull().$type<ActionIntentSource>(),
    /**
     * The KIND of principal that created this intent, recorded as a durable
     * fact rather than derived at release time.
     *
     * `source` is a lossy proxy: it has only 'chat' | 'mcp_api' | 'ai_agent',
     * while an AuthContext principal can be user_session/client_user/api_key/
     * oauth_grant/agent/helper/system. And the actor columns cannot stand in
     * for it either — `requested_by_user_id` is written for EVERY intent
     * (holding the key's CREATOR for API-key callers) and
     * `requesting_api_key_id` is never written at all. Gates meaning "a human
     * did this" must read this column.
     *
     * 'unknown' is the backfill value for rows predating the discriminator.
     * It is deliberately NOT 'user_session': a human-required gate must fail
     * on an unknown origin, not pass.
     *
     * Immutable — covered by action_intents_immutable_trg.
     */
    originPrincipalKind: text('origin_principal_kind')
      .notNull()
      .default('unknown')
      .$type<ActionIntentOriginPrincipalKind>(),
    /** Key/grant id when the origin was an api_key or oauth_grant. Immutable. */
    originPrincipalId: text('origin_principal_id'),
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
    /**
     * Tier-3 classification from checkGuardrails, decided once at creation.
     * Immutable — covered by action_intents_immutable_trg (extended in
     * 2026-08-14-intent-approval-scope-and-deadlines.sql). Live
     * pre-migration rows backfill as 'four_eyes' via the column DEFAULT.
     */
    approvalScope: text('approval_scope')
      .notNull()
      .default('four_eyes')
      .$type<ActionIntentApprovalScope>(),
    /** Version of the classification ruleset that produced approvalScope. Immutable. */
    classificationVersion: integer('classification_version').notNull().default(0),
    /**
     * Content-pinning digest (script content hash / quote-invoice revision /
     * target state-version), pinned at creation whenever a resolver exists
     * for the tool/action — regardless of approval scope (changed
     * 2026-08-06; see services/actionIntents/effectDigest.ts's header).
     * Revalidated by both release paths (content_changed on drift). NULL
     * only when no resolver exists for the tool/action, or a resolver
     * exists but couldn't resolve the target at creation — not an indicator
     * of approval scope. Immutable.
     */
    effectDigest: char('effect_digest', { length: 64 }),

    // Lifecycle (mutable).
    status: text('status').notNull().default('pending_approval').$type<ActionIntentStatus>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /**
     * Pending-approval deadline, split out of expiresAt (advisor-confirmed
     * trap: a single expires_at could reap an intent approved at 59:59
     * before the release worker claims it). Backfilled from expiresAt for
     * rows that predate the split.
     */
    approvalExpiresAt: timestamp('approval_expires_at', { withTimezone: true }),
    /**
     * Execution lease deadline, stamped atomically by the decide-path when
     * an approval wins. The reaper expires on approvalExpiresAt for pending
     * intents and releaseBy for approved ones.
     */
    releaseBy: timestamp('release_by', { withTimezone: true }),
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

    // Wave 5 Part A (#3827): policy-decide lifecycle + safe provenance.
    // Migration: 2026-09-16-ai-agents-policy-decide-foundations.sql.
    // Lifecycle (mutable, unlike the immutable content block above) — Part
    // B's decision path is the only writer of the five nullable columns;
    // this PR's createActionIntent stamps only policyDecisionState, always
    // 'human_required' (resolvePolicyDecisionState stub).
    policyDecisionState: text('policy_decision_state')
      .notNull()
      .default('human_required')
      .$type<ActionIntentPolicyDecisionState>(),
    /** Which POLICY_DECIDABLE_TIER3 entry authorized this intent. Part-B-written. */
    policyAuthorizationKey: text('policy_authorization_key'),
    /** Digest of the agent's policy snapshot the decision was made against. Part-B-written. */
    policySnapshotDigest: text('policy_snapshot_digest'),
    /** Version of POLICY_DECIDABLE_TIER3 that produced the decision. Part-B-written. */
    policyClassificationVersion: integer('policy_classification_version'),
    /** ai_unattended_exposure row reserved for this decision, if any. Part-B-written. */
    policyReservationId: uuid('policy_reservation_id'),
    /** ai_kill_state.epoch observed at decision time. Part-B-written. */
    policyKillEpoch: bigint('policy_kill_epoch', { mode: 'number' }),
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

    // Composite FK: (requesting_agent_run_id, org_id) → ai_agent_runs(id, org_id).
    // Structural guarantee that an agent proposal can never be filed under a
    // different tenant than the run that produced it — RLS on action_intents
    // checks only action_intents.org_id and would not catch it.
    // ON DELETE RESTRICT: runs are never hard-deleted; attribution survives.
    //
    // COUPLING (wave 3b resolves it): ai_agent_runs is currently in
    // CORE_DEVICE_ORG_DENORMALIZED_TABLES (routes/devices/core.ts), so a
    // device move-org rewrites the run's org_id — which this FK (ON UPDATE
    // NO ACTION) turns into a 23503 the moment an agent intent exists.
    // Unreachable while createActionIntent rejects the ai_agent principal;
    // PR 3b removes ai_agent_runs from the re-stamp list (owner decision
    // 2026-08-23: agent history stays with the source org) BEFORE lifting
    // that guard. If 3b is reordered or dropped, this note is the tripwire.
    requestingAgentRunOrgFk: foreignKey({
      columns: [table.requestingAgentRunId, table.orgId],
      foreignColumns: [aiAgentRuns.id, aiAgentRuns.orgId],
      name: 'action_intents_requesting_agent_run_id_org_id_fkey',
    }).onDelete('restrict'),
    // P2-2: mirrors migrations/2026-09-23-ai-agents-scheduled-sweeps.sql's
    // action_intents_scope_device_idx.
    scopeDeviceIdx: index('action_intents_scope_device_idx')
      .on(table.scopeDeviceId).where(sql`${table.scopeDeviceId} IS NOT NULL`),
    // P2-4: composite-FK target for ticket_drafts.intent_id
    // (ticketDrafts.ts) — action_intents had no unique(id, org_id) before
    // this (ai_agent_runs already got one, as a named UNIQUE CONSTRAINT, in
    // 2026-09-05-a-agent-originated-intents.sql). This one is a plain
    // CREATE UNIQUE INDEX in the migration (not ADD CONSTRAINT), so it's
    // modeled with `uniqueIndex()` here rather than `unique()` — either
    // form satisfies Postgres's "FK needs a unique index over exactly its
    // referenced columns" requirement identically; redundant with PRIMARY
    // KEY(id) for lookups.
    idOrgUq: uniqueIndex('action_intents_id_org_uq').on(table.id, table.orgId),
    // P2-4: composite FK so a forged cross-tenant ticket pointer is 23503
    // even under system context — see scopeTicketId's column comment above.
    // Also DEFERRABLE INITIALLY IMMEDIATE in the migration (org-lifecycle
    // contract) — drizzle-orm's foreignKey() builder has no deferrable
    // option, so that detail lives in the migration only (same limitation as
    // ticketDrafts.ts's composite FKs / deviceMtlsCertificates.ts).
    scopeTicketOrgFk: foreignKey({
      columns: [table.scopeTicketId, table.orgId],
      foreignColumns: [tickets.id, tickets.orgId],
      name: 'action_intents_scope_ticket_org_fk',
    }).onDelete('set null'),
    scopeTicketIdx: index('action_intents_scope_ticket_idx')
      .on(table.scopeTicketId).where(sql`${table.scopeTicketId} IS NOT NULL`),
    // P2-6 (#4193, migrations/2026-09-30-ai-agents-impact.sql): the rollup's
    // fixes_proposed/fixes_executed scans. orgStatusIdx above is
    // (org_id, status, expires_at) — neither created_at nor executed_at is
    // covered.
    orgCreatedIdx: index('action_intents_org_created_idx').on(table.orgId, table.createdAt),
    orgExecutedIdx: index('action_intents_org_executed_idx')
      .on(table.orgId, table.executedAt).where(sql`${table.executedAt} IS NOT NULL`),
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
    intentId: uuid('intent_id').references(() => actionIntents.id, {
      onDelete: 'cascade',
    }),
    pamActuationId: uuid('pam_actuation_id').references(() => pamActuations.id, {
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
    pamActuationIdIdx: index('intent_outbox_pam_actuation_id_idx').on(table.pamActuationId),
    // Note: the partial index intent_outbox_unpublished_idx (WHERE
    // published_at IS NULL) is declared in the SQL migration only — Drizzle's
    // index DSL doesn't model partial indexes cleanly (same precedent as
    // elevations.ts's elevation_requests_org_pending_idx et al).
  }),
);

export type IntentOutboxRow = typeof intentOutbox.$inferSelect;
export type NewIntentOutboxRow = typeof intentOutbox.$inferInsert;
