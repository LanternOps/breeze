import { sql } from 'drizzle-orm';
import {
  char, doublePrecision, index, integer, jsonb, pgTable, smallint, text, timestamp, uniqueIndex, uuid, varchar,
} from 'drizzle-orm/pg-core';
import type { FixKind, FixMemoryStatus, FixOutcomeState, FixVote } from '@breeze/shared';
import { alerts } from './alerts';
import { deviceFilesystemCleanupRuns } from './filesystem';
import { metricAnomalyEpisodes } from './metricAnomalyEpisodes';
import { organizations, partners } from './orgs';
import { playbookDefinitions } from './playbooks';
import { remediationSuggestions } from './remediationSuggestions';
import { scriptExecutions, scripts, scriptVersions } from './scripts';
import { users } from './users';

/**
 * One row per fix attempt (AI Suggested Fixes W1). Shape 1 RLS on org_id.
 * The composite (org_id, partner_id) → organizations(id, partner_id) FK
 * (DEFERRABLE) and the cross-column shape CHECKs live in the migration only —
 * same convention as aiAgentFixWatches. device_id deliberately has no FK and
 * is never re-stamped on a device move (history stays with the source org).
 */
export const fixOutcomes = pgTable('fix_outcomes', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull(),
  partnerId: uuid('partner_id').notNull(),
  deviceId: uuid('device_id').notNull(),
  suggestionId: uuid('suggestion_id').references(() => remediationSuggestions.id, { onDelete: 'set null' }),
  sourceType: varchar('source_type', { length: 20 }).$type<'alert' | 'anomaly' | 'correlation' | 'rca'>().notNull(),
  sourceId: varchar('source_id', { length: 255 }).notNull(),
  alertId: uuid('alert_id').references(() => alerts.id, { onDelete: 'set null' }),
  anomalyEpisodeId: uuid('anomaly_episode_id').references(() => metricAnomalyEpisodes.id, { onDelete: 'set null' }),
  signatureVersion: smallint('signature_version'),
  signatureKey: char('signature_key', { length: 64 }),
  broadKey: char('broad_key', { length: 64 }),
  signatureFacets: jsonb('signature_facets'),
  osType: varchar('os_type', { length: 20 }),
  fixKind: varchar('fix_kind', { length: 30 }).$type<FixKind>().notNull(),
  fixIdentity: varchar('fix_identity', { length: 200 }),
  scriptId: uuid('script_id').references(() => scripts.id, { onDelete: 'set null' }),
  scriptVersionId: uuid('script_version_id').references(() => scriptVersions.id, { onDelete: 'set null' }),
  builtinAction: varchar('builtin_action', { length: 60 }),
  playbookId: uuid('playbook_id').references(() => playbookDefinitions.id, { onDelete: 'set null' }),
  instructionsRef: varchar('instructions_ref', { length: 120 }),
  scriptExecutionId: uuid('script_execution_id').references(() => scriptExecutions.id, { onDelete: 'set null' }),
  actionCommandId: uuid('action_command_id'),
  actionCleanupRunId: uuid('action_cleanup_run_id').references(() => deviceFilesystemCleanupRuns.id, { onDelete: 'set null' }),
  state: varchar('state', { length: 30 }).$type<FixOutcomeState>().notNull().default('pending'),
  stateReason: varchar('state_reason', { length: 80 }),
  humanVote: varchar('human_vote', { length: 10 }).$type<FixVote>(),
  votedBy: uuid('voted_by').references(() => users.id, { onDelete: 'set null' }),
  votedAt: timestamp('voted_at', { withTimezone: true }),
  recoveredAt: timestamp('recovered_at', { withTimezone: true }),
  deadlineAt: timestamp('deadline_at', { withTimezone: true }).notNull(),
  holdingUntil: timestamp('holding_until', { withTimezone: true }),
  terminalAt: timestamp('terminal_at', { withTimezone: true }),
  countedAt: timestamp('counted_at', { withTimezone: true }),
  recountRequestedAt: timestamp('recount_requested_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  suggestionUq: uniqueIndex('fix_outcomes_suggestion_uq').on(t.suggestionId).where(sql`suggestion_id IS NOT NULL`),
  activeIdx: index('fix_outcomes_active_idx').on(t.state, t.deadlineAt),
  orgCreatedIdx: index('fix_outcomes_org_created_idx').on(t.orgId, t.createdAt),
  deviceStateIdx: index('fix_outcomes_device_state_idx').on(t.deviceId, t.state),
}));

/**
 * Derived partner-wide / org-private aggregate. org_id XOR partner_id
 * (fix_memory_one_owner_chk). Written ONLY by services/fixMemory/store.ts.
 * Stores counts and ids — never hostnames, alert text, output or prose.
 */
export const fixMemory = pgTable('fix_memory', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'cascade' }),
  partnerId: uuid('partner_id').references(() => partners.id, { onDelete: 'cascade' }),
  signatureVersion: smallint('signature_version').notNull(),
  signatureKey: char('signature_key', { length: 64 }).notNull(),
  broadKey: char('broad_key', { length: 64 }).notNull(),
  osType: varchar('os_type', { length: 20 }).notNull(),
  fixKind: varchar('fix_kind', { length: 30 }).$type<FixKind>().notNull(),
  fixIdentity: varchar('fix_identity', { length: 200 }).notNull(),
  scriptId: uuid('script_id').references(() => scripts.id, { onDelete: 'cascade' }),
  scriptVersionId: uuid('script_version_id').references(() => scriptVersions.id, { onDelete: 'cascade' }),
  builtinAction: varchar('builtin_action', { length: 60 }),
  playbookId: uuid('playbook_id').references(() => playbookDefinitions.id, { onDelete: 'cascade' }),
  instructionsRef: varchar('instructions_ref', { length: 120 }),
  attempts: integer('attempts').notNull().default(0),
  verifiedCount: integer('verified_count').notNull().default(0),
  failedCount: integer('failed_count').notNull().default(0),
  recurredCount: integer('recurred_count').notNull().default(0),
  upVotes: integer('up_votes').notNull().default(0),
  downVotes: integer('down_votes').notNull().default(0),
  rollingSuccessRate: doublePrecision('rolling_success_rate').notNull().default(0),
  consecutiveFailures: integer('consecutive_failures').notNull().default(0),
  consecutiveVerified: integer('consecutive_verified').notNull().default(0),
  recentOutcomes: text('recent_outcomes').array().notNull().default(sql`'{}'::text[]`),
  status: varchar('status', { length: 20 }).$type<FixMemoryStatus>().notNull().default('active'),
  retiredBy: uuid('retired_by').references(() => users.id, { onDelete: 'set null' }),
  retiredAt: timestamp('retired_at', { withTimezone: true }),
  lastVerifiedAt: timestamp('last_verified_at', { withTimezone: true }),
  staleSince: timestamp('stale_since', { withTimezone: true }),
  /** Durable org-erasure rebuild requests; stale_since cannot clear while non-empty (see migration). */
  rebuildPendingOrgIds: uuid('rebuild_pending_org_ids').array().notNull().default(sql`'{}'::uuid[]`),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  orgIdentityUq: uniqueIndex('fix_memory_org_identity_uq')
    .on(t.orgId, t.signatureVersion, t.signatureKey, t.osType, t.fixIdentity).where(sql`org_id IS NOT NULL`),
  partnerIdentityUq: uniqueIndex('fix_memory_partner_identity_uq')
    .on(t.partnerId, t.signatureVersion, t.signatureKey, t.osType, t.fixIdentity).where(sql`partner_id IS NOT NULL`),
  lookupIdx: index('fix_memory_lookup_idx').on(t.signatureVersion, t.osType, t.signatureKey),
  broadIdx: index('fix_memory_broad_idx').on(t.signatureVersion, t.osType, t.broadKey),
}));

export type FixOutcomeRow = typeof fixOutcomes.$inferSelect;
export type FixMemoryRow = typeof fixMemory.$inferSelect;
