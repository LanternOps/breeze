import { sql } from 'drizzle-orm';
import {
  pgTable, uuid, text, char, integer, boolean, jsonb, timestamp, numeric, pgEnum, index,
} from 'drizzle-orm/pg-core';
import type { ScriptVerificationClaim } from '@breeze/shared';
import { organizations } from './orgs';
import { users } from './users';
import { aiSessions } from './ai';
import { scriptLanguageEnum } from './scripts';

export const scriptProposalStatusEnum = pgEnum('script_proposal_status', [
  'proposed', 'scan_rejected', 'review_failed', 'reviewed',
  'approved', 'rejected', 'changes_requested', 'expired', 'superseded',
  'executed', 'verified', 'verification_failed', 'promoted',
]);

/**
 * An AI-authored script proposal: immutable, content-addressed, incident-bound.
 *
 * org_id NOT NULL is justified (and is NOT a partner-wide config table, spec
 * §4.1): a proposal targets specific devices in one org and dies with the
 * incident. org_id is trigger-immutable, like action_intents.
 *
 * `intentId`, `supersedesId`, `promotedScriptId` and `promotedVersionId` are
 * bare uuids on purpose — the rows they name change org or die on different
 * schedules, and a self-referencing supersedes FK would put a cycle in the
 * cascade order (tenantCascade rejects cycles).
 */
export const scriptProposals = pgTable('script_proposals', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  authorKind: text('author_kind').$type<'chat_session' | 'agent_run'>().notNull(),
  sessionId: uuid('session_id').references(() => aiSessions.id, { onDelete: 'set null' }),
  agentRunId: uuid('agent_run_id'),
  language: scriptLanguageEnum('language').notNull(),
  content: text('content').notNull(),
  contentDigest: char('content_digest', { length: 64 }).notNull(),
  timeoutSeconds: integer('timeout_seconds').notNull(),
  runAs: text('run_as').$type<'system' | 'user'>().notNull().default('system'),
  goal: text('goal').notNull(),
  expectedEffect: text('expected_effect').notNull(),
  verification: jsonb('verification').$type<ScriptVerificationClaim>().notNull(),
  rollbackNote: text('rollback_note'),
  targetDeviceIds: uuid('target_device_ids').array().notNull(),
  scannerVersion: text('scanner_version').notNull(),
  basicHits: text('basic_hits').array().notNull().default(sql`'{}'::text[]`),
  strictHits: text('strict_hits').array().notNull().default(sql`'{}'::text[]`),
  touchClasses: text('touch_classes').array().notNull().default(sql`'{}'::text[]`),
  /** W03: (submitted ∩ strict_hits) as resolved at decide time. Rides the
   *  dispatch payload as acknowledgedSecurityPatterns. */
  acknowledgedPatterns: text('acknowledged_patterns').array().notNull().default(sql`'{}'::text[]`),
  status: scriptProposalStatusEnum('status').notNull().default('proposed'),
  revision: integer('revision').notNull().default(1),
  supersedesId: uuid('supersedes_id'),
  riskTier: text('risk_tier').$type<'low' | 'medium' | 'high' | 'critical'>(),
  decidedBy: uuid('decided_by').references(() => users.id, { onDelete: 'set null' }),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  decisionNote: text('decision_note'),
  intentId: uuid('intent_id'),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  verificationResult: jsonb('verification_result'),
  promotedScriptId: uuid('promoted_script_id'),
  promotedVersionId: uuid('promoted_version_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull().default(sql`NOW() + INTERVAL '24 hours'`),
}, (table) => ({
  orgCreatedIdx: index('script_proposals_org_created_idx').on(table.orgId, table.createdAt.desc()),
  orgStatusIdx: index('script_proposals_org_status_idx').on(table.orgId, table.status),
  unconsumedIdx: index('script_proposals_unconsumed_idx')
    .on(table.orgId, table.expiresAt)
    .where(sql`intent_id IS NULL`),
}));

/** Append-only: REVOKE UPDATE/DELETE from breeze_app + an immutability trigger. */
export const scriptProposalReviews = pgTable('script_proposal_reviews', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  // Composite (proposal_id, org_id) FK, DEFERRABLE INITIALLY IMMEDIATE, lives
  // in the migration — Drizzle does not model composite FKs on a single column.
  proposalId: uuid('proposal_id').notNull(),
  reviewerKind: text('reviewer_kind').$type<'static_scan' | 'model'>().notNull(),
  model: text('model'),
  reviewerPromptVersion: text('reviewer_prompt_version'),
  status: text('status').$type<'completed' | 'failed' | 'timeout'>().notNull(),
  summary: text('summary'),
  riskTier: text('risk_tier').$type<'low' | 'medium' | 'high' | 'critical'>(),
  goalMatch: text('goal_match').$type<'yes' | 'partial' | 'no'>(),
  reversible: boolean('reversible'),
  verificationAdequate: boolean('verification_adequate'),
  recommendedAction: text('recommended_action').$type<'approve' | 'changes' | 'reject'>(),
  verdict: jsonb('verdict'),
  inputTokens: integer('input_tokens'),
  outputTokens: integer('output_tokens'),
  costCents: numeric('cost_cents', { precision: 12, scale: 4 }),
  budgetReservationId: text('budget_reservation_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  proposalCreatedIdx: index('script_proposal_reviews_proposal_created_idx')
    .on(table.proposalId, table.createdAt.desc()),
  orgIdx: index('script_proposal_reviews_org_idx').on(table.orgId),
}));

export type ScriptProposalRow = typeof scriptProposals.$inferSelect;
export type ScriptProposalReviewRow = typeof scriptProposalReviews.$inferSelect;
