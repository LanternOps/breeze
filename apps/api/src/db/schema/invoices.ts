import { sql, type SQL } from 'drizzle-orm';
import {
  pgTable, uuid, text, varchar, integer, boolean, numeric, jsonb, timestamp,
  char, date, pgEnum, index, uniqueIndex, primaryKey, type AnyPgColumn
} from 'drizzle-orm/pg-core';
import { partners, organizations } from './orgs';
import { users } from './users';
import {
  INVOICE_STATUSES,
  INVOICE_LINE_SOURCE_TYPES,
  PAYMENT_METHODS,
  INVOICE_LINE_DEVICE_COUNTED_AS,
} from '@breeze/shared';

// Spread the readonly SSOT tuples into pgEnum's mutable `[string, ...string[]]`.
// Keep this a DIRECT spread of the const tuple — routing through a `string[]`
// intermediate would silently widen the column type and drop literal narrowing.
export const invoiceStatusEnum = pgEnum('invoice_status', [...INVOICE_STATUSES]);
export const invoiceLineSourceTypeEnum = pgEnum('invoice_line_source_type', [...INVOICE_LINE_SOURCE_TYPES]);
export const paymentMethodEnum = pgEnum('payment_method', [...PAYMENT_METHODS]);
export const invoiceLineDeviceCountedAsEnum = pgEnum('invoice_line_device_counted_as', [...INVOICE_LINE_DEVICE_COUNTED_AS]);

// Partial-index predicate helpers (real partial indexes created in SQL migration;
// drizzle-kit only needs these for drift detection).
function sqlNumberPresent(t: { invoiceNumber: unknown }): SQL {
  return sql`${t.invoiceNumber} IS NOT NULL`;
}
function sqlOpenForOverdue(t: { status: unknown }): SQL {
  return sql`${t.status} IN ('sent','partially_paid')`;
}
function sqlPublicLinkHashPresent(t: { publicLinkTokenHash: unknown }): SQL {
  return sql`${t.publicLinkTokenHash} IS NOT NULL`;
}

export const invoices = pgTable('invoices', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  // site_id FK created in SQL (ON DELETE SET NULL) to avoid an import cycle with sites.
  siteId: uuid('site_id'),
  invoiceNumber: varchar('invoice_number', { length: 40 }),
  status: invoiceStatusEnum('status').notNull().default('draft'),
  // Multi-currency (spec §5): stamped from the org (or copied from the source
  // document) at creation and immutable once monetary lines exist. Deliberately
  // NO .default() — every creation path must stamp it explicitly, so a missed
  // path is a loud insert failure, never a silent USD document.
  currencyCode: char('currency_code', { length: 3 }).notNull(),
  issueDate: date('issue_date'),
  dueDate: date('due_date'),
  subtotal: numeric('subtotal', { precision: 12, scale: 2 }).notNull().default('0'),
  taxRate: numeric('tax_rate', { precision: 8, scale: 5 }),
  taxTotal: numeric('tax_total', { precision: 12, scale: 2 }).notNull().default('0'),
  total: numeric('total', { precision: 12, scale: 2 }).notNull().default('0'),
  amountPaid: numeric('amount_paid', { precision: 12, scale: 2 }).notNull().default('0'),
  balance: numeric('balance', { precision: 12, scale: 2 }).notNull().default('0'),
  // Deposit due at acceptance, snapshotted from the quote. NULL = ordinary invoice.
  depositDue: numeric('deposit_due', { precision: 12, scale: 2 }),
  billToName: varchar('bill_to_name', { length: 255 }),
  billToAddress: jsonb('bill_to_address'),
  billToTaxId: varchar('bill_to_tax_id', { length: 100 }),
  billToTaxExempt: boolean('bill_to_tax_exempt').notNull().default(false),
  notes: text('notes'),
  terms: text('terms'),
  sellerSnapshot: jsonb('seller_snapshot'),
  // Render-locale snapshot, stamped once at issue/send (#3777). NULL = resolve from partner at render.
  documentLocale: varchar('document_locale', { length: 16 }),
  // #3205 W07 appendix gate. NULL pre-issue = "inherit partners.invoice_device_appendix";
  // both issuance writers stamp the RESOLVED boolean at issue and the renderer
  // reads ONLY this column afterwards, so a later partner-default change cannot
  // alter what a sanctioned re-render produces.
  deviceAppendix: boolean('device_appendix'),
  // #3205 W07: 1 = billing evidence written at generation. NULL = pre-W07 or
  // never generated from a contract. Invoice-level `recorded` flag — never
  // derived from an evidence row count.
  evidenceVersion: integer('evidence_version'),
  termsAndConditions: text('terms_and_conditions'),
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
  // Public view-and-pay link (2026-08-21 spec): SHA-256 hex of the opaque bearer
  // token (the lookup key — replacing it revokes every issued link), the token
  // encrypted at rest (row-bound AAD via encryptedColumnRegistry, so copy-link
  // reproduces the same url), and the expiry persisted at mint.
  publicLinkTokenHash: char('public_link_token_hash', { length: 64 }),
  publicLinkTokenCt: text('public_link_token_ct'),
  publicLinkExpiresAt: timestamp('public_link_expires_at'),
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
  uniqueIndex('invoices_id_org_uq').on(t.id, t.orgId),
  // Public-link lookup key + cross-invoice collision guard (2026-08-21).
  uniqueIndex('invoices_public_link_hash_uq').on(t.publicLinkTokenHash).where(sqlPublicLinkHashPresent(t))
]);

export const invoiceLines = pgTable('invoice_lines', {
  id: uuid('id').primaryKey().defaultRandom(),
  invoiceId: uuid('invoice_id').notNull().references(() => invoices.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  sourceType: invoiceLineSourceTypeEnum('source_type').notNull(),
  // sourceId is polymorphic (time_entries|ticket_parts) — FK-by-convention, no DB FK.
  sourceId: uuid('source_id'),
  // Durable contract lineage (#3778, wave 6). Unlike the polymorphic sourceId,
  // this survives contract_lines deletion (removeContractLine is permitted on
  // ACTIVE contracts) and is same-tenant-enforced by the composite FK
  // (source_contract_id, org_id) -> contracts(id, org_id) ON DELETE SET NULL
  // (source_contract_id), created in SQL migration 2026-09-02-a. It is the ONLY
  // predicate the ACTIVE-contract currency restamp keys on.
  sourceContractId: uuid('source_contract_id'),
  // catalog_item_id + ticket_id FKs created in SQL (ON DELETE SET NULL) to avoid coupling
  // issued-invoice history to catalog/ticket deletion and dodge import cycles.
  catalogItemId: uuid('catalog_item_id'),
  parentLineId: uuid('parent_line_id').references((): AnyPgColumn => invoiceLines.id, { onDelete: 'cascade' }),
  ticketId: uuid('ticket_id'),
  // Title (mirrors catalog name). Nullable for legacy lines created before the
  // split, where `description` holds the title and the renderer falls back to it.
  name: varchar('name', { length: 255 }),
  // Optional descriptive blurb shown beneath the title (mirrors catalog description).
  description: text('description'),
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
  index('invoice_lines_source_idx').on(t.sourceType, t.sourceId),
  // Composite-FK target for invoice_line_devices_line_org_fk (#3205 W07).
  // Built CONCURRENTLY by migration 2026-10-08-100300; declared here as an
  // ordinary uniqueIndex because db:check-drift compares definitions, not how
  // they were built.
  uniqueIndex('invoice_lines_id_org_uq').on(t.id, t.orgId),
]);

/**
 * #3205 W07 (#4656): which devices an auto-counted invoice line actually billed.
 *
 * One row per counted device per invoice line. `invoice_line_id` is NOT NULL in
 * every case — "uncovered" is an aggregate on contract_billing_period_outcomes,
 * never a row here. Written by generateDueInvoice inside the billing
 * transaction, AFTER the period claim; never mutated afterwards except by the
 * device-delete / move-org detaches and the org-merge repoint.
 *
 * SQL-ONLY constraints (declared in migration 2026-10-08-100400, deliberately
 * not mirrored here — same treatment as W01's site FK and W02's group FK):
 *   - (invoice_line_id, org_id) -> invoice_lines(id, org_id) ON DELETE CASCADE DEFERRABLE
 *   - (invoice_id, org_id)      -> invoices(id, org_id)      ON DELETE CASCADE DEFERRABLE
 *   - (site_id, org_id)         -> sites(id, org_id)         ON DELETE SET NULL (site_id) DEFERRABLE
 * The device_id FK IS single-column and SQL-only below: a composite
 * (device_id, org_id) would forbid every cross-org device move.
 */
export const invoiceLineDevices = pgTable('invoice_line_devices', {
  id: uuid('id').primaryKey().defaultRandom(),
  invoiceLineId: uuid('invoice_line_id').notNull(),
  invoiceId: uuid('invoice_id').notNull(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  // FK is SQL-only to avoid an import cycle with devices.ts.
  deviceId: uuid('device_id'),
  hostname: varchar('hostname', { length: 255 }).notNull(),
  deviceRole: text('device_role').notNull(),
  siteId: uuid('site_id'),
  countedAs: invoiceLineDeviceCountedAsEnum('counted_as').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull()
}, (t) => [
  uniqueIndex('invoice_line_devices_line_device_uq').on(t.invoiceLineId, t.deviceId),
  index('invoice_line_devices_line_read_idx').on(t.invoiceLineId, t.hostname, t.id),
  index('invoice_line_devices_invoice_read_idx').on(t.invoiceId, t.hostname, t.id),
  index('invoice_line_devices_device_idx').on(t.deviceId).where(sql`${t.deviceId} IS NOT NULL`),
  index('invoice_line_devices_org_idx').on(t.orgId)
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
