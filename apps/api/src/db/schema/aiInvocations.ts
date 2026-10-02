// AI model registry W02 (#7600, spec §5.5): the append-only invocation ledger.
// APPEND-ONLY: breeze_app holds SELECT/INSERT + column UPDATE (org_id) only;
// the trigger admits nothing but an org-merge re-point. Registered in
// AUDIT_ADMIN_REQUIRED_TABLES. No FKs on provenance ids (see the migration).
import { sql } from 'drizzle-orm';
import { bigint, boolean, char, index, integer, jsonb, numeric, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import type { AiSurface, PromptProfile } from '@breeze/shared';
import { organizations } from './orgs';

export const AI_INVOCATION_LEDGER_MODES = ['shadow', 'authoritative'] as const;
export type AiInvocationLedgerMode = (typeof AI_INVOCATION_LEDGER_MODES)[number];

const cents = (name: string) => numeric(name, { precision: 20, scale: 6, mode: 'number' });
const tokens = (name: string) => bigint(name, { mode: 'number' }).notNull().default(0);

// AI chargeback (#7608): the frozen client-price snapshot (2026-11-26-100100).
export const AI_CHARGE_COVERAGES = ['billable', 'included', 'non_billable', 'not_eligible'] as const;
export const AI_CHARGE_BASES = ['price_list', 'markup', 'unpriced'] as const;

export const aiInvocations = pgTable('ai_invocations', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  surface: text('surface').$type<AiSurface>().notNull(),
  role: text('role').notNull().default('default'),
  userId: uuid('user_id'),
  sessionId: uuid('session_id'),
  agentRunId: uuid('agent_run_id'),
  sourceRef: text('source_ref'),
  offeringId: uuid('offering_id'),
  connectionId: uuid('connection_id'),
  fundingSource: text('funding_source', { enum: ['platform', 'partner_key'] }).notNull(),
  requestedModel: text('requested_model').notNull(),
  servedModel: text('served_model').notNull(),
  optionsSent: jsonb('options_sent').$type<Record<string, unknown>>().notNull().default({}),
  thinkingModeSent: text('thinking_mode_sent'),
  inferenceGeoSent: text('inference_geo_sent'),
  stopReason: text('stop_reason'),
  refusalCategory: text('refusal_category'),
  fallbackUsed: boolean('fallback_used').notNull().default(false),
  catalogRevisionId: uuid('catalog_revision_id'),
  connectionConfigVersion: integer('connection_config_version'),
  inputTokens: tokens('input_tokens'),
  outputTokens: tokens('output_tokens'),
  cacheReadTokens: tokens('cache_read_tokens'),
  cacheWriteTokens: tokens('cache_write_tokens'),
  rateSnapshot: jsonb('rate_snapshot').$type<Record<string, unknown>>(),
  costCents: cents('cost_cents'),
  chargeable: boolean('chargeable').notNull().default(false),
  sdkReportedCostUsd: cents('sdk_reported_cost_usd'),
  ledgerMode: text('ledger_mode').$type<AiInvocationLedgerMode>().notNull().default('shadow'),
  legacyCostCents: cents('legacy_cost_cents'),
  chargeBillingProfileId: uuid('charge_billing_profile_id'),
  chargeCoverage: text('charge_coverage').$type<(typeof AI_CHARGE_COVERAGES)[number]>(),
  chargeBasis: text('charge_basis').$type<(typeof AI_CHARGE_BASES)[number]>(),
  chargeCurrency: char('charge_currency', { length: 3 }),
  // String mode on purpose: client money is never a JS float (W10 rounding rules).
  chargeAmount: numeric('charge_amount', { precision: 20, scale: 6 }),
  /** W11 (#7609): the prompt profile the call was dispatched under; NULL before W11. CHECK ai_invocations_prompt_provenance_chk. */
  promptProfile: text('prompt_profile').$type<PromptProfile>(),
  /** W11: the prompt variant appended to the system prompt (`surface/profile@n`); NULL = the surface's base prompt. */
  promptVariant: text('prompt_variant'),
  /** W11: when the turn was first settled; survives a deferred replay (created_at does not). Ordering only, never a billing period. */
  occurredAt: timestamp('occurred_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('ai_invocations_org_created_idx').on(t.orgId, t.createdAt.desc()),
  index('ai_invocations_created_idx').on(t.createdAt),
  index('ai_invocations_session_idx').on(t.sessionId).where(sql`${t.sessionId} IS NOT NULL`),
  index('ai_invocations_agent_run_idx').on(t.agentRunId).where(sql`${t.agentRunId} IS NOT NULL`),
  index('ai_invocations_offering_idx').on(t.offeringId, t.createdAt).where(sql`${t.offeringId} IS NOT NULL`),
  index('ai_invocations_chargeable_idx').on(t.orgId, t.createdAt)
    .where(sql`${t.chargeable} AND ${t.ledgerMode} = 'authoritative'`),
]);

export type AiInvocationRow = typeof aiInvocations.$inferSelect;
