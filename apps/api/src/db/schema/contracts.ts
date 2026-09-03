import type { DeviceRole } from '@breeze/shared';
import { sql } from 'drizzle-orm';
import {
  pgTable, uuid, text, varchar, integer, boolean, numeric, date, char,
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
  'flat', 'per_device', 'per_device_role', 'per_device_group', 'per_seat', 'manual'
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
  uniqueIndex('contract_lines_id_org_uq').on(t.id, t.orgId)
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
  index('contract_billing_periods_org_idx').on(t.orgId)
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
