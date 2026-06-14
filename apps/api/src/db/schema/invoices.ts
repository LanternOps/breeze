import { sql, type SQL } from 'drizzle-orm';
import {
  pgTable, uuid, text, varchar, integer, boolean, numeric, jsonb, timestamp,
  char, date, pgEnum, index, uniqueIndex, primaryKey, type AnyPgColumn
} from 'drizzle-orm/pg-core';
import { partners, organizations } from './orgs';
import { users } from './users';

export const invoiceStatusEnum = pgEnum('invoice_status', [
  'draft', 'sent', 'partially_paid', 'overdue', 'paid', 'void'
]);
export const invoiceLineSourceTypeEnum = pgEnum('invoice_line_source_type', [
  'time_entry', 'part', 'catalog', 'bundle', 'manual', 'contract'
]);
export const paymentMethodEnum = pgEnum('payment_method', [
  'cash', 'check', 'bank_transfer', 'card', 'other'
]);

// Partial-index predicate helpers (real partial indexes created in SQL migration;
// drizzle-kit only needs these for drift detection).
function sqlNumberPresent(t: { invoiceNumber: unknown }): SQL {
  return sql`${t.invoiceNumber} IS NOT NULL`;
}
function sqlOpenForOverdue(t: { status: unknown }): SQL {
  return sql`${t.status} IN ('sent','partially_paid')`;
}

export const invoices = pgTable('invoices', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  // site_id FK created in SQL (ON DELETE SET NULL) to avoid an import cycle with sites.
  siteId: uuid('site_id'),
  invoiceNumber: varchar('invoice_number', { length: 40 }),
  status: invoiceStatusEnum('status').notNull().default('draft'),
  currencyCode: char('currency_code', { length: 3 }).notNull().default('USD'),
  issueDate: date('issue_date'),
  dueDate: date('due_date'),
  subtotal: numeric('subtotal', { precision: 12, scale: 2 }).notNull().default('0'),
  taxRate: numeric('tax_rate', { precision: 6, scale: 3 }),
  taxTotal: numeric('tax_total', { precision: 12, scale: 2 }).notNull().default('0'),
  total: numeric('total', { precision: 12, scale: 2 }).notNull().default('0'),
  amountPaid: numeric('amount_paid', { precision: 12, scale: 2 }).notNull().default('0'),
  balance: numeric('balance', { precision: 12, scale: 2 }).notNull().default('0'),
  billToName: varchar('bill_to_name', { length: 255 }),
  billToAddress: jsonb('bill_to_address'),
  billToTaxId: varchar('bill_to_tax_id', { length: 100 }),
  billToTaxExempt: boolean('bill_to_tax_exempt').notNull().default(false),
  notes: text('notes'),
  terms: text('terms'),
  sentAt: timestamp('sent_at'),
  firstViewedAt: timestamp('first_viewed_at'),
  viewedAt: timestamp('viewed_at'),
  paidAt: timestamp('paid_at'),
  markedOverdueAt: timestamp('marked_overdue_at'),
  voidedAt: timestamp('voided_at'),
  voidReason: text('void_reason'),
  // self-FKs created in SQL (ON DELETE SET NULL) to keep drizzle types simple
  replacesInvoiceId: uuid('replaces_invoice_id'),
  replacedByInvoiceId: uuid('replaced_by_invoice_id'),
  pdfDocumentRef: text('pdf_document_ref'),
  pdfSha256: char('pdf_sha256', { length: 64 }),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
}, (t) => [
  index('invoices_org_status_idx').on(t.orgId, t.status),
  index('invoices_partner_status_idx').on(t.partnerId, t.status),
  index('invoices_org_issue_date_idx').on(t.orgId, t.issueDate),
  index('invoices_due_overdue_idx').on(t.dueDate).where(sqlOpenForOverdue(t)),
  uniqueIndex('invoices_partner_number_uq').on(t.partnerId, t.invoiceNumber).where(sqlNumberPresent(t)),
  // Composite-FK target for the child (invoice_id, org_id) FKs and the
  // invoices(org_id, partner_id) → organizations dual-axis FK. Created in SQL
  // migration 2026-06-15-b; declared here so db:check-drift stays clean.
  uniqueIndex('invoices_id_org_uq').on(t.id, t.orgId)
]);

export const invoiceLines = pgTable('invoice_lines', {
  id: uuid('id').primaryKey().defaultRandom(),
  invoiceId: uuid('invoice_id').notNull().references(() => invoices.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  sourceType: invoiceLineSourceTypeEnum('source_type').notNull(),
  // sourceId is polymorphic (time_entries|ticket_parts) — FK-by-convention, no DB FK.
  sourceId: uuid('source_id'),
  // catalog_item_id + ticket_id FKs created in SQL (ON DELETE SET NULL) to avoid coupling
  // issued-invoice history to catalog/ticket deletion and dodge import cycles.
  catalogItemId: uuid('catalog_item_id'),
  parentLineId: uuid('parent_line_id').references((): AnyPgColumn => invoiceLines.id, { onDelete: 'cascade' }),
  ticketId: uuid('ticket_id'),
  description: text('description').notNull(),
  quantity: numeric('quantity', { precision: 12, scale: 2 }).notNull(),
  unitPrice: numeric('unit_price', { precision: 12, scale: 2 }).notNull(),
  costBasis: numeric('cost_basis', { precision: 12, scale: 2 }),
  revenueAllocation: numeric('revenue_allocation', { precision: 12, scale: 2 }),
  taxable: boolean('taxable').notNull().default(false),
  customerVisible: boolean('customer_visible').notNull().default(true),
  lineTotal: numeric('line_total', { precision: 12, scale: 2 }).notNull().default('0'),
  isUnapprovedTime: boolean('is_unapproved_time').notNull().default(false),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: timestamp('created_at').defaultNow().notNull()
}, (t) => [
  index('invoice_lines_invoice_sort_idx').on(t.invoiceId, t.sortOrder),
  index('invoice_lines_org_idx').on(t.orgId),
  index('invoice_lines_source_idx').on(t.sourceType, t.sourceId)
]);

export const invoicePayments = pgTable('invoice_payments', {
  id: uuid('id').primaryKey().defaultRandom(),
  invoiceId: uuid('invoice_id').notNull().references(() => invoices.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  // amount > 0 enforced by a SQL-only CHECK in migration 2026-06-15-a (kept out of
  // Drizzle to avoid a name-mismatch drift since migrations are hand-written).
  amount: numeric('amount', { precision: 12, scale: 2 }).notNull(),
  method: paymentMethodEnum('method').notNull(),
  reference: varchar('reference', { length: 255 }),
  receivedAt: date('received_at').notNull(),
  recordedBy: uuid('recorded_by').references(() => users.id),
  note: text('note'),
  createdAt: timestamp('created_at').defaultNow().notNull()
}, (t) => [
  index('invoice_payments_invoice_idx').on(t.invoiceId),
  index('invoice_payments_org_idx').on(t.orgId)
]);

export const partnerInvoiceSequences = pgTable('partner_invoice_sequences', {
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  year: integer('year').notNull(),
  counter: integer('counter').notNull().default(0)
}, (t) => [
  primaryKey({ columns: [t.partnerId, t.year] })
]);
