// AI chargeback W10 (#7608): the monthly close of chargeable AI usage. SQL owns
// the CHECKs, the composite (org_id, partner_id) FKs and the unique keys
// (2026-11-26-100200). run_id has no FK on purpose (see the migration).
import { bigint, boolean, char, date, index, integer, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { organizations, partners } from './orgs';
import { supportedCurrencies } from './currency';

export const AI_USAGE_CHARGE_STATUSES = ['not_billed', 'billed', 'no_charge', 'unpriced'] as const;
export type AiUsageChargeStatus = (typeof AI_USAGE_CHARGE_STATUSES)[number];

export const aiUsageChargeRuns = pgTable('ai_usage_charge_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  periodStart: date('period_start').notNull(),
  periodEnd: date('period_end').notNull(),
  invocationCount: integer('invocation_count').notNull().default(0),
  chargeCount: integer('charge_count').notNull().default(0),
  unpricedInvocationCount: integer('unpriced_invocation_count').notNull().default(0),
  lateInvocationCount: integer('late_invocation_count').notNull().default(0),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex('ai_usage_charge_runs_org_period_uq').on(t.orgId, t.periodStart)]);

const tokens = (name: string) => bigint(name, { mode: 'number' }).notNull().default(0);

export const aiUsageCharges = pgTable('ai_usage_charges', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  runId: uuid('run_id').notNull(),
  periodStart: date('period_start').notNull(),
  periodEnd: date('period_end').notNull(),
  usagePeriodStart: date('usage_period_start').notNull(),
  currencyCode: char('currency_code', { length: 3 }).notNull().references(() => supportedCurrencies.code),
  servedModel: text('served_model').notNull(),
  modelLabel: text('model_label').notNull(),
  priced: boolean('priced').notNull(),
  invocationCount: integer('invocation_count').notNull(),
  inputTokens: tokens('input_tokens'),
  outputTokens: tokens('output_tokens'),
  cacheReadTokens: tokens('cache_read_tokens'),
  cacheWriteTokens: tokens('cache_write_tokens'),
  amountExact: numeric('amount_exact', { precision: 20, scale: 6 }),
  amount: numeric('amount', { precision: 12, scale: 2 }),
  billingStatus: text('billing_status').$type<AiUsageChargeStatus>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('ai_usage_charges_run_group_uq').on(t.runId, t.usagePeriodStart, t.currencyCode, t.servedModel, t.priced),
  uniqueIndex('ai_usage_charges_id_org_uq').on(t.id, t.orgId),
  index('ai_usage_charges_org_status_period_idx').on(t.orgId, t.billingStatus, t.periodStart),
]);

export const aiUsageChargeClaims = pgTable('ai_usage_charge_claims', {
  invocationId: uuid('invocation_id').primaryKey(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  runId: uuid('run_id').notNull(),
  // SQL owns the composite (charge_id, org_id) → ai_usage_charges(id, org_id) FK.
  chargeId: uuid('charge_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('ai_usage_charge_claims_charge_idx').on(t.chargeId),
  index('ai_usage_charge_claims_org_idx').on(t.orgId),
]);
