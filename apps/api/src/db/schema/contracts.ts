import type { DeviceRole, RolloverPolicy } from '@breeze/shared';
import { desc, sql } from 'drizzle-orm';
import {
  pgTable, uuid, text, varchar, integer, boolean, numeric, jsonb, date, char,
  timestamp, pgEnum, index, uniqueIndex
} from 'drizzle-orm/pg-core';
import { partners, organizations } from './orgs';
import { users } from './users';

export const contractStatusEnum = pgEnum('contract_status', [
  'draft', 'active', 'paused', 'cancelled', 'expired'
]);
export const contractBillingTimingEnum = pgEnum('contract_billing_timing', [
  'advance', 'arrears'
]);
export const contractLineTypeEnum = pgEnum('contract_line_type', [
  'flat', 'per_device', 'per_device_role', 'per_device_group', 'per_seat', 'manual', 'hour_block'
]);
// #3205 W04 (#4607): what happens to the units above included_quantity.
export const contractOverageModeEnum = pgEnum('contract_overage_mode', ['bill', 'flag']);
export const contractRenewalNoticeKindEnum = pgEnum('contract_renewal_notice_kind', [
  'advance', 'renewed'
]);

export const contracts = pgTable('contracts', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  name: varchar('name', { length: 255 }).notNull(),
  status: contractStatusEnum('status').notNull().default('draft'),
  billingTiming: contractBillingTimingEnum('billing_timing').notNull().default('advance'),
  intervalMonths: integer('interval_months').notNull(),
  startDate: date('start_date').notNull(),
  endDate: date('end_date'),
  nextBillingAt: date('next_billing_at'),
  autoIssue: boolean('auto_issue').notNull().default(false),
  autoRenew: boolean('auto_renew').notNull().default(false),
  autopayExcluded: boolean('autopay_excluded').notNull().default(false),
  renewalTermMonths: integer('renewal_term_months'),
  renewalNoticeDays: integer('renewal_notice_days'),
  // Multi-currency (spec §5): stamped from the org (or copied from the source
  // document) at creation and immutable once monetary lines exist. Deliberately
  // NO .default() — every creation path must stamp it explicitly, so a missed
  // path is a loud insert failure, never a silent USD document.
  currencyCode: char('currency_code', { length: 3 }).notNull(),
  notes: text('notes'),
  terms: text('terms'),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
}, (t) => [
  index('contracts_org_status_idx').on(t.orgId, t.status),
  index('contracts_partner_status_idx').on(t.partnerId, t.status),
  // Real partial index (status='active') created in SQL; drizzle-kit only needs the column for drift.
  index('contracts_next_billing_idx').on(t.nextBillingAt),
  // Composite-FK target for invoice_lines(source_contract_id, org_id) (#3778).
  // Created in SQL migration 2026-09-02-a; declared here so db:check-drift stays clean.
  uniqueIndex('contracts_id_org_uq').on(t.id, t.orgId)
]);

export const contractLines = pgTable('contract_lines', {
  id: uuid('id').primaryKey().defaultRandom(),
  contractId: uuid('contract_id').notNull().references(() => contracts.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  lineType: contractLineTypeEnum('line_type').notNull(),
  description: text('description').notNull(),
  // catalog_item_id + site_id FKs created in SQL (ON DELETE SET NULL) to dodge import cycles.
  catalogItemId: uuid('catalog_item_id'),
  unitPrice: numeric('unit_price', { precision: 12, scale: 2 }).notNull(),
  manualQuantity: numeric('manual_quantity', { precision: 12, scale: 2 }),
  siteId: uuid('site_id'),
  // #4693: the site's name at write time. Survives the FK's ON DELETE SET NULL
  // (site_id), which is what makes a deleted site detectable. SQL-only
  // constraint: contract_lines_site_stamp_chk (2026-10-08-101400).
  siteName: varchar('site_name', { length: 255 }),
  // #3205: the SET of roles a per_device_role line bills. NULL on every other
  // type — enforced by contract_lines_device_roles_chk (SQL-only, like the
  // catalog_item_id / site_id FKs above). $type narrows the row to DeviceRole[]
  // so contractCoverage.ts needs no cast.
  deviceRoles: text('device_roles').array().$type<DeviceRole[]>(),
  // #4607: allowance + overage. All three are NULL together on a line with no
  // allowance, and NULL on flat/manual. The invariants live in
  // contract_lines_allowance_chk (SQL-only, like contract_lines_device_roles_chk)
  // and in contractLineInvariantIssues. included_quantity is the FIXED quantity
  // the base line bills every period — not a cap on a variable count.
  includedQuantity: numeric('included_quantity', { precision: 12, scale: 2 }),
  overageMode: contractOverageModeEnum('overage_mode'),
  overageUnitPrice: numeric('overage_unit_price', { precision: 12, scale: 2 }),
  // #4547 W01: hour_block columns. NULL on every other line type. The shape is
  // pinned by contract_lines_hour_block_chk (SQL-only, like the allowance and
  // device-role CHECKs above); contract_lines_allowance_chk was re-added to list
  // 'hour_block' and exempt it from integrality. included_quantity /
  // overage_mode / overage_unit_price above double as the block's hours and
  // overage terms. hour_block_first_period_start is server-stamped at insert.
  rolloverPolicy: text('rollover_policy').$type<RolloverPolicy>(),
  rolloverCapHours: numeric('rollover_cap_hours', { precision: 12, scale: 2 }),
  hourBlockAlertPct: integer('hour_block_alert_pct'),
  hourBlockFirstPeriodStart: date('hour_block_first_period_start'),
  hourBlockRetiredAt: timestamp('hour_block_retired_at', { withTimezone: true }),
  // #3205 W02: the device group a per_device_group line bills. Composite FK
  // (device_group_id, org_id) -> device_groups(id, org_id) ON DELETE SET NULL
  // (device_group_id), and contract_lines_device_group_chk, are SQL-only like
  // the site FK above. NULL id + non-null name = the group was deleted after a
  // terminated contract billed it.
  deviceGroupId: uuid('device_group_id'),
  deviceGroupName: varchar('device_group_name', { length: 255 }),
  taxable: boolean('taxable').notNull().default(false),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: timestamp('created_at').defaultNow().notNull()
}, (t) => [
  index('contract_lines_contract_sort_idx').on(t.contractId, t.sortOrder),
  index('contract_lines_org_idx').on(t.orgId),
  // Partial index (WHERE device_group_id IS NOT NULL); the SQL migration creates it, this mirrors it.
  index('contract_lines_device_group_id_idx').on(t.deviceGroupId).where(sql`${t.deviceGroupId} IS NOT NULL`),
  uniqueIndex('contract_lines_id_org_uq').on(t.id, t.orgId),
  // #4547: one LIVE block per org. The real partial unique index lives in SQL
  // (2026-12-17-100100); this mirrors it so db:check-drift stays clean.
  uniqueIndex('contract_lines_one_live_hour_block_per_org_uq').on(t.orgId)
    .where(sql`${t.lineType} = 'hour_block' AND ${t.hourBlockRetiredAt} IS NULL`),
]);

export const contractBillingPeriods = pgTable('contract_billing_periods', {
  id: uuid('id').primaryKey().defaultRandom(),
  contractId: uuid('contract_id').notNull().references(() => contracts.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  periodStart: date('period_start').notNull(),
  periodEnd: date('period_end').notNull(),
  // invoice_id FK created in SQL (ON DELETE SET NULL) to avoid coupling contract history to invoice deletion.
  invoiceId: uuid('invoice_id'),
  generatedAt: timestamp('generated_at').defaultNow().notNull()
}, (t) => [
  uniqueIndex('contract_billing_periods_contract_period_uq').on(t.contractId, t.periodStart),
  index('contract_billing_periods_org_idx').on(t.orgId),
  // Composite-FK target for cbp_outcomes_period_org_fk (#3205 W07). Built
  // CONCURRENTLY by migration 2026-10-08-101100-billing-evidence-fk-targets.sql.
  uniqueIndex('contract_billing_periods_id_org_uq').on(t.id, t.orgId),
]);

/**
 * #4547 W01: one row per CLOSED block-hours period (RLS Shape 1, org-owned — a
 * balance, not a policy). UNIQUE (contract_line_id, period_start) is the close
 * path's idempotency key. Written by W02; nothing writes it in W01.
 *
 * SQL-ONLY constraints (migration 2026-12-17-100200-contract-hour-periods.sql),
 * all DEFERRABLE INITIALLY IMMEDIATE:
 *   - (contract_id, org_id)        -> contracts(id, org_id)       ON DELETE CASCADE
 *   - (contract_line_id, org_id)   -> contract_lines(id, org_id)  ON DELETE RESTRICT
 *   - (overage_invoice_id, org_id) -> invoices(id, org_id)        ON DELETE SET NULL (overage_invoice_id)
 * CHECKs: contract_hour_periods_period_chk (period_end > period_start),
 * contract_hour_periods_hours_nonneg_chk (every hours column >= 0),
 * contract_hour_periods_close_source_chk. There is deliberately NO CHECK tying
 * overage_hours to overage_invoice_id: the invoice FK is SET NULL.
 */
export const contractHourPeriods = pgTable('contract_hour_periods', {
  id: uuid('id').primaryKey().defaultRandom(),
  contractLineId: uuid('contract_line_id').notNull(),
  contractId: uuid('contract_id').notNull(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  // Half-open [periodStart, periodEnd).
  periodStart: date('period_start').notNull(),
  periodEnd: date('period_end').notNull(),
  includedHours: numeric('included_hours', { precision: 12, scale: 2 }).notNull(),
  carriedInHours: numeric('carried_in_hours', { precision: 12, scale: 2 }).notNull(),
  consumedHours: numeric('consumed_hours', { precision: 12, scale: 2 }).notNull(),
  overageHours: numeric('overage_hours', { precision: 12, scale: 2 }).notNull(),
  carriedOutHours: numeric('carried_out_hours', { precision: 12, scale: 2 }).notNull(),
  // Hours absorbed from entries stamped in another currency (Decision 8 flag).
  foreignCurrencyHours: numeric('foreign_currency_hours', { precision: 12, scale: 2 }).notNull().default('0'),
  entryCount: integer('entry_count').notNull(),
  // Snapshots at close.
  overageUnitPrice: numeric('overage_unit_price', { precision: 12, scale: 2 }).notNull(),
  currencyCode: char('currency_code', { length: 3 }).notNull(),
  overageInvoiceId: uuid('overage_invoice_id'),
  closeSource: text('close_source').$type<'billing_run' | 'close_out'>().notNull(),
  closedAt: timestamp('closed_at', { withTimezone: true }).defaultNow().notNull()
}, (t) => [
  uniqueIndex('contract_hour_periods_line_period_uq').on(t.contractLineId, t.periodStart),
  index('contract_hour_periods_org_idx').on(t.orgId),
  index('contract_hour_periods_contract_idx').on(t.contractId, desc(t.periodStart)),
]);

/**
 * #3205 W07 (#4656): what one claimed billing period actually billed — and did
 * not bill. Exactly one row per contract_billing_periods row, written in the
 * same transaction immediately after the claim. A period with NO row was billed
 * before W07; that is the ONLY meaning of absence.
 *
 * snapshot_device_total = 0 means "no snapshot was evaluated" (a flat-only
 * contract), not "the org owns zero devices".
 *
 * SQL-ONLY constraints (migration 2026-10-08-101200-billing-evidence.sql):
 *   - (contract_billing_period_id, org_id) -> contract_billing_periods(id, org_id) ON DELETE CASCADE DEFERRABLE
 *   - (contract_id, org_id)                -> contracts(id, org_id)                ON DELETE CASCADE DEFERRABLE
 *   - (invoice_id, org_id)                 -> invoices(id, org_id)                 ON DELETE SET NULL (invoice_id) DEFERRABLE
 */
export const contractBillingPeriodOutcomes = pgTable('contract_billing_period_outcomes', {
  contractBillingPeriodId: uuid('contract_billing_period_id').primaryKey(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  contractId: uuid('contract_id').notNull(),
  invoiceId: uuid('invoice_id'),
  snapshotDeviceTotal: integer('snapshot_device_total').notNull().default(0),
  uncoveredTotal: integer('uncovered_total').notNull().default(0),
  flaggedTotal: integer('flagged_total').notNull().default(0),
  billedOverageTotal: integer('billed_overage_total').notNull().default(0),
  uncoveredByRole: jsonb('uncovered_by_role').notNull().default(sql`'{}'::jsonb`),
  overages: jsonb('overages').notNull().default(sql`'[]'::jsonb`),
  generatedAt: timestamp('generated_at', { withTimezone: true }).defaultNow().notNull()
}, (t) => [
  index('cbp_outcomes_contract_idx').on(t.contractId, desc(t.generatedAt)),
  index('cbp_outcomes_org_idx').on(t.orgId)
]);

export const contractRenewalNotices = pgTable('contract_renewal_notices', {
  id: uuid('id').primaryKey().defaultRandom(),
  contractId: uuid('contract_id').notNull().references(() => contracts.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  // The end_date the notice pertains to. For 'advance' this is the term about to lapse;
  // for 'renewed' this is the NEW end_date after extension. (contract_id, end_date, kind)
  // is UNIQUE — that triple is the once-per-term idempotency key.
  endDate: date('end_date').notNull(),
  kind: contractRenewalNoticeKindEnum('kind').notNull(),
  sentAt: timestamp('sent_at').defaultNow().notNull()
}, (t) => [
  uniqueIndex('contract_renewal_notices_uq').on(t.contractId, t.endDate, t.kind),
  index('contract_renewal_notices_org_idx').on(t.orgId)
]);
