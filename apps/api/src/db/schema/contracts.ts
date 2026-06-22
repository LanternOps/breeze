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
  'flat', 'per_device', 'per_seat', 'manual'
]);
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
  currencyCode: char('currency_code', { length: 3 }).notNull().default('USD'),
  notes: text('notes'),
  terms: text('terms'),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
}, (t) => [
  index('contracts_org_status_idx').on(t.orgId, t.status),
  index('contracts_partner_status_idx').on(t.partnerId, t.status),
  // Real partial index (status='active') created in SQL; drizzle-kit only needs the column for drift.
  index('contracts_next_billing_idx').on(t.nextBillingAt)
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
  taxable: boolean('taxable').notNull().default(false),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: timestamp('created_at').defaultNow().notNull()
}, (t) => [
  index('contract_lines_contract_sort_idx').on(t.contractId, t.sortOrder),
  index('contract_lines_org_idx').on(t.orgId),
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
