import { sql, type SQL } from 'drizzle-orm';
import {
  pgTable, uuid, text, varchar, integer, smallint, boolean, numeric, jsonb, timestamp,
  char, date, pgEnum, index, uniqueIndex, primaryKey, foreignKey, type AnyPgColumn
} from 'drizzle-orm/pg-core';
import { partners, organizations } from './orgs';
// Reuse the exported `bytea` custom type (Buffer-mapped) from users.ts instead
// of redefining it locally — same pattern as users.avatarData.
import { users, bytea } from './users';
import { catalogItemTypeEnum } from './catalog';
import { contractLineTypeEnum, contractOverageModeEnum } from './contracts';

export const quoteStatusEnum = pgEnum('quote_status', [
  'draft', 'sent', 'viewed', 'accepted', 'declined', 'expired', 'converted', 'superseded'
]);
export const quoteLineSourceTypeEnum = pgEnum('quote_line_source_type', ['catalog', 'bundle', 'manual']);
export const quoteLineRecurrenceEnum = pgEnum('quote_line_recurrence', ['one_time', 'monthly', 'annual']);
export const quoteBlockTypeEnum = pgEnum('quote_block_type', ['heading', 'rich_text', 'image', 'line_items', 'contract', 'table', 'callout']);
export const quoteDepositTypeEnum = pgEnum('quote_deposit_type', ['none', 'percent', 'selected_lines']);

/** Reason codes persisted in quotes.send_email_reason (plain text column, not
 *  a pg enum — adding a code is a type change, not a migration). The first
 *  four appear on SENT quotes (send committed, email step failed);
 *  'schedule_failed' appears only on DRAFTS (a scheduled send was rejected at
 *  fire time — nothing was sent). Keep the web mirror
 *  (`QuoteSendEmailReason` in apps/web/src/lib/api/quotes.ts) in sync. */
export type SendQuoteEmailReason =
  | 'no_email_service' | 'no_billing_contact' | 'pdf_render_failed' | 'send_failed'
  | 'schedule_failed';

function sqlNumberPresent(t: { quoteNumber: unknown }): SQL { return sql`${t.quoteNumber} IS NOT NULL`; }
function sqlOpenForExpiry(t: { status: unknown }): SQL { return sql`${t.status} IN ('sent','viewed')`; }

export const quotes = pgTable('quotes', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  siteId: uuid('site_id'),
  quoteNumber: varchar('quote_number', { length: 40 }),
  title: varchar('title', { length: 200 }),
  status: quoteStatusEnum('status').notNull().default('draft'),
  // Multi-currency (spec §5): stamped from the org (or copied from the source
  // document) at creation and immutable once monetary lines exist. Deliberately
  // NO .default() — every creation path must stamp it explicitly, so a missed
  // path is a loud insert failure, never a silent USD document.
  currencyCode: char('currency_code', { length: 3 }).notNull(),
  issueDate: date('issue_date'),
  expiryDate: date('expiry_date'),
  acceptedAt: timestamp('accepted_at'),
  declinedAt: timestamp('declined_at'),
  convertedAt: timestamp('converted_at'),
  subtotal: numeric('subtotal', { precision: 12, scale: 2 }).notNull().default('0'),
  taxRate: numeric('tax_rate', { precision: 8, scale: 5 }),
  taxTotal: numeric('tax_total', { precision: 12, scale: 2 }).notNull().default('0'),
  total: numeric('total', { precision: 12, scale: 2 }).notNull().default('0'),
  oneTimeTotal: numeric('one_time_total', { precision: 12, scale: 2 }).notNull().default('0'),
  monthlyRecurringTotal: numeric('monthly_recurring_total', { precision: 12, scale: 2 }).notNull().default('0'),
  annualRecurringTotal: numeric('annual_recurring_total', { precision: 12, scale: 2 }).notNull().default('0'),
  depositType: quoteDepositTypeEnum('deposit_type').notNull().default('none'),
  // Whole-percent scale (30.00 = 30%), only meaningful for deposit_type='percent'.
  // CHECK quotes_deposit_percent_range_chk (0<pct<100) + quotes_deposit_percent_type_chk
  // (non-percent types carry no percent), migration 2026-07-06-z, enforce it at the DB.
  depositPercent: numeric('deposit_percent', { precision: 5, scale: 2 }),
  // Stored snapshot of the computed deposit due; recomputed on every draft edit.
  // CHECK quotes_deposit_amount_nonneg_chk (migration 2026-07-06-z) forbids negatives.
  depositAmount: numeric('deposit_amount', { precision: 12, scale: 2 }),
  billToName: varchar('bill_to_name', { length: 255 }),
  billToAddress: jsonb('bill_to_address'),
  billToTaxId: varchar('bill_to_tax_id', { length: 100 }),
  introNotes: text('intro_notes'),
  terms: text('terms'),
  sellerSnapshot: jsonb('seller_snapshot'),
  // Enhanced-proposals cover page content (title, logo, hero image, etc.) —
  // contract documents + enhanced proposals Phase 1.
  coverPage: jsonb('cover_page'),
  // Frozen { theme, pageSize } captured at send so sent quotes never restyle
  // when the partner later changes theme (sellerSnapshot pattern).
  presentationSnapshot: jsonb('presentation_snapshot'),
  // Render-locale snapshot, stamped once at issue/send (#3777). NULL = resolve from partner at render.
  documentLocale: varchar('document_locale', { length: 16 }),
  termsAndConditions: text('terms_and_conditions'),
  declineReason: text('decline_reason'),
  convertedInvoiceId: uuid('converted_invoice_id'),
  pdfDocumentRef: text('pdf_document_ref'),
  pdfSha256: char('pdf_sha256', { length: 64 }),
  sentAt: timestamp('sent_at'),
  // Undo-send window (delayed dispatch): when a send is scheduled, the fire
  // time + BullMQ job id live here so the UI can offer Undo and the worker can
  // detect a cancel/reschedule race. Cleared on fire, failure, or cancel.
  sendScheduledAt: timestamp('send_scheduled_at', { withTimezone: true }),
  sendJobId: text('send_job_id'),
  // Delayed-dispatch outcome marker: null = delivered/not-sent-yet. On a SENT
  // quote, the reason the email step failed after the send committed; on a
  // DRAFT, marks a scheduled send that was rejected at fire time (the UI shows
  // a persistent failure banner). Cleared when a fresh schedule is stamped and
  // by sendQuote's draft→sent claim.
  sendEmailReason: text('send_email_reason').$type<SendQuoteEmailReason>(),
  firstViewedAt: timestamp('first_viewed_at'),
  viewedAt: timestamp('viewed_at'),
  // Identity of the accept token minted at send. NOT the token itself — these
  // are the non-secret claim parts (jti/iat/exp) plus the signing kid, enough to
  // reproduce the exact same JWT via regenerateQuoteAcceptToken *given the
  // signing key*. That is what lets a re-send or "copy share link" hand out the
  // SAME url the customer already has, without a bearer credential at rest.
  // NULL on drafts and on quotes sent before this shipped (those mint fresh).
  acceptTokenJti: varchar('accept_token_jti', { length: 128 }),
  acceptTokenIssuedAt: timestamp('accept_token_issued_at', { withTimezone: true }),
  acceptTokenExpiresAt: timestamp('accept_token_expires_at', { withTimezone: true }),
  acceptTokenKid: varchar('accept_token_kid', { length: 128 }),
  publicTokenVersion: integer('public_token_version').notNull().default(0),
  publicResponseJti: varchar('public_response_jti', { length: 128 }),
  publicResponseConsumedAt: timestamp('public_response_consumed_at', { withTimezone: true }),
  publicResponseOutcome: varchar('public_response_outcome', { length: 16 }),
  publicLinkRevokedAt: timestamp('public_link_revoked_at', { withTimezone: true }),
  // Quote revisions: immediate-parent link + 1-based position in the lineage.
  // cloneLineagePair writes the parent link and correlated revision number.
  // Enforced TODAY: linearity via quotes_revision_of_uq (one successor ever),
  // root-vs-revision via quotes_revision_number_chk, and same-tenant lineage
  // via the composite FK to (id, org_id).
  // Revisions keep the root's number with an -R<n> suffix. Sending one will
  // flip its parent to 'superseded' in a later wave (see
  // docs/superpowers/plans/2026-08-17-quote-revisions.md); that behavior does
  // not exist in sendQuote yet.
  revisionOfQuoteId: uuid('revision_of_quote_id'),
  revisionNumber: integer('revision_number').notNull().default(1),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
}, (t) => [
  index('quotes_org_status_idx').on(t.orgId, t.status),
  index('quotes_partner_status_idx').on(t.partnerId, t.status),
  index('quotes_org_issue_date_idx').on(t.orgId, t.issueDate),
  index('quotes_expiry_idx').on(t.expiryDate).where(sqlOpenForExpiry(t)),
  uniqueIndex('quotes_partner_number_uq').on(t.partnerId, t.quoteNumber).where(sqlNumberPresent(t)),
  uniqueIndex('quotes_id_org_uq').on(t.id, t.orgId),
  uniqueIndex('quotes_revision_of_uq').on(t.revisionOfQuoteId).where(sql`${t.revisionOfQuoteId} IS NOT NULL`),
  foreignKey({
    columns: [t.revisionOfQuoteId, t.orgId],
    foreignColumns: [t.id, t.orgId],
    name: 'quotes_revision_of_fk',
  }),
]);

export const quoteBlocks = pgTable('quote_blocks', {
  id: uuid('id').primaryKey().defaultRandom(),
  quoteId: uuid('quote_id').notNull().references(() => quotes.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  blockType: quoteBlockTypeEnum('block_type').notNull(),
  content: jsonb('content').notNull().default({}),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: timestamp('created_at').defaultNow().notNull()
}, (t) => [
  index('quote_blocks_quote_sort_idx').on(t.quoteId, t.sortOrder),
  index('quote_blocks_org_idx').on(t.orgId)
]);

export const quoteLines = pgTable('quote_lines', {
  id: uuid('id').primaryKey().defaultRandom(),
  quoteId: uuid('quote_id').notNull().references(() => quotes.id, { onDelete: 'cascade' }),
  blockId: uuid('block_id').references((): AnyPgColumn => quoteBlocks.id, { onDelete: 'set null' }),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  sourceType: quoteLineSourceTypeEnum('source_type').notNull(),
  catalogItemId: uuid('catalog_item_id'),
  parentLineId: uuid('parent_line_id').references((): AnyPgColumn => quoteLines.id, { onDelete: 'cascade' }),
  // Title (mirrors catalog name). Nullable for legacy lines created before the
  // split, where `description` holds the title and the renderer falls back to it.
  name: varchar('name', { length: 255 }),
  // Optional descriptive blurb shown beneath the title (mirrors catalog description).
  description: text('description'),
  quantity: numeric('quantity', { precision: 12, scale: 2 }).notNull(),
  unitPrice: numeric('unit_price', { precision: 12, scale: 2 }).notNull(),
  taxable: boolean('taxable').notNull().default(false),
  customerVisible: boolean('customer_visible').notNull().default(true),
  lineTotal: numeric('line_total', { precision: 12, scale: 2 }).notNull().default('0'),
  recurrence: quoteLineRecurrenceEnum('recurrence').notNull().default('one_time'),
  termMonths: integer('term_months'),
  billingFrequency: varchar('billing_frequency', { length: 20 }),
  // #3205 W05: device-set descriptor. All NULL together on an ordinary line —
  // contract_line_type IS NULL is the whole feature switch. The invariants live
  // in quote_lines_device_set_chk (SQL-only, like contract_lines_device_roles_chk)
  // and in quoteLineDeviceSetIssues.
  contractLineType: contractLineTypeEnum('contract_line_type'),
  deviceRoles: text('device_roles').array(),
  deviceGroupId: uuid('device_group_id'),
  // Stamped at write; outlives the id (the FK is ON DELETE SET NULL on the id
  // only), which is how a deleted reference is detected.
  deviceGroupName: varchar('device_group_name', { length: 255 }),
  siteId: uuid('site_id'),
  siteName: varchar('site_name', { length: 255 }),
  includedQuantity: numeric('included_quantity', { precision: 12, scale: 2 }),
  overageMode: contractOverageModeEnum('overage_mode'),
  overageUnitPrice: numeric('overage_unit_price', { precision: 12, scale: 2 }),
  // Internal builder economics — never serialized to the customer document.
  unitCost: numeric('unit_cost', { precision: 12, scale: 2 }),
  // Counts toward a 'selected_lines' deposit. Catalog hardware defaults it on.
  depositEligible: boolean('deposit_eligible').notNull().default(false),
  // Catalog item type snapshotted at add-time (null for manual lines) — drives
  // the per-category subtotal breakdown without a portal-invisible catalog join.
  itemType: catalogItemTypeEnum('item_type'),
  sku: varchar('sku', { length: 100 }),
  partNumber: varchar('part_number', { length: 100 }),
  // Vendor identity snapshotted at add-time from catalog_items.attributes
  // (never joined live: the distributor price table is partner-axis RLS and the
  // attributes jsonb has three incompatible shapes). NULL = unknown/manual.
  procurementSource: varchar('procurement_source', { length: 40 }),
  vendorSku: varchar('vendor_sku', { length: 100 }),
  manufacturer: varchar('manufacturer', { length: 255 }),
  // Optional per-line product image (quote_images row on the SAME quote; the
  // service enforces that). Wins over the catalog item's image when both exist.
  imageId: uuid('image_id').references((): AnyPgColumn => quoteImages.id, { onDelete: 'set null' }),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: timestamp('created_at').defaultNow().notNull()
}, (t) => [
  index('quote_lines_quote_sort_idx').on(t.quoteId, t.sortOrder),
  index('quote_lines_block_idx').on(t.blockId),
  index('quote_lines_org_idx').on(t.orgId),
  index('quote_lines_image_idx').on(t.imageId),
  uniqueIndex('quote_lines_id_quote_uq').on(t.id, t.quoteId),
  index('quote_lines_device_group_id_idx').on(t.deviceGroupId).where(sql`${t.deviceGroupId} IS NOT NULL`),
  // The CHECK and all three composite FKs are SQL-only (2026-10-08-100700) —
  // the W01/W02 pattern. Drizzle cannot express ON DELETE SET NULL (col) or
  // DEFERRABLE, and drift detection compares columns/indexes, not constraints.
]);

export const quoteImages = pgTable('quote_images', {
  id: uuid('id').primaryKey().defaultRandom(),
  quoteId: uuid('quote_id').notNull().references(() => quotes.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  imageData: bytea('image_data').notNull(),
  mime: varchar('mime', { length: 64 }).notNull(),
  byteSize: integer('byte_size').notNull(),
  sha256: char('sha256', { length: 64 }).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull()
}, (t) => [
  index('quote_images_quote_idx').on(t.quoteId),
  index('quote_images_org_idx').on(t.orgId)
]);

export const quoteAcceptances = pgTable('quote_acceptances', {
  id: uuid('id').primaryKey().defaultRandom(),
  quoteId: uuid('quote_id').notNull().references(() => quotes.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  signerName: varchar('signer_name', { length: 255 }).notNull(),
  signerEmail: varchar('signer_email', { length: 255 }),
  signedAt: timestamp('signed_at').defaultNow().notNull(),
  ipAddress: varchar('ip_address', { length: 64 }),
  userAgent: text('user_agent'),
  quoteSha256: char('quote_sha256', { length: 64 }).notNull(),
  // #3205 W05: which computeQuoteSha256 algorithm produced quoteSha256.
  // Existing rows default to 1 because that is what hashed them.
  hashVersion: smallint('hash_version').notNull().default(1),
  acceptanceTokenJti: varchar('acceptance_token_jti', { length: 128 }),
  // Render locale the acceptance hash + executed contract PDF were computed
  // with (#3777 follow-up): the quote's send-time document_locale, or 'en'
  // for a pre-stamp quote. NULL only on rows older than the backfill
  // (2026-09-01-b) — read through acceptanceRenderLocale(), never directly.
  renderLocale: varchar('render_locale', { length: 16 }),
  createdAt: timestamp('created_at').defaultNow().notNull()
}, (t) => [
  index('quote_acceptances_quote_idx').on(t.quoteId),
  index('quote_acceptances_org_idx').on(t.orgId)
]);

/** Portal identities authorized to perform legal/billing actions on a quote.
 * Rows are written when the quote is sent; legacy quotes without rows fail
 * closed until they are explicitly re-sent/authorized. `email` is stored in
 * trimmed lowercase form so authorization comparisons are deterministic. */
export const quoteRecipients = pgTable('quote_recipients', {
  id: uuid('id').primaryKey().defaultRandom(),
  quoteId: uuid('quote_id').notNull(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  email: varchar('email', { length: 255 }).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => [
  uniqueIndex('quote_recipients_quote_email_uq').on(t.quoteId, t.email),
  index('quote_recipients_org_idx').on(t.orgId),
  foreignKey({
    columns: [t.quoteId, t.orgId],
    foreignColumns: [quotes.id, quotes.orgId],
    name: 'quote_recipients_quote_id_org_id_fkey',
  }).onDelete('cascade'),
]);

export const quoteOrders = pgTable('quote_orders', {
  id: uuid('id').primaryKey().defaultRandom(),
  quoteId: uuid('quote_id').notNull(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  procurementSource: varchar('procurement_source', { length: 40 }),
  vendorName: varchar('vendor_name', { length: 255 }),
  orderRef: varchar('order_ref', { length: 120 }),
  orderedBy: uuid('ordered_by').references(() => users.id, { onDelete: 'set null' }),
  orderedAt: timestamp('ordered_at').defaultNow().notNull(),
  notes: text('notes'),
  // Double-click / retry dedupe: the client sends a UUID per Mark-ordered submit.
  clientRequestId: uuid('client_request_id'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => [
  index('quote_orders_quote_idx').on(t.quoteId),
  index('quote_orders_org_idx').on(t.orgId),
  uniqueIndex('quote_orders_id_quote_org_uq').on(t.id, t.quoteId, t.orgId),
  uniqueIndex('quote_orders_client_request_uq').on(t.quoteId, t.clientRequestId)
    .where(sql`${t.clientRequestId} IS NOT NULL`),
  foreignKey({
    columns: [t.quoteId, t.orgId], foreignColumns: [quotes.id, quotes.orgId],
    name: 'quote_orders_quote_org_fkey',
  }).onDelete('cascade'),
]);

export const quoteOrderLines = pgTable('quote_order_lines', {
  id: uuid('id').primaryKey().defaultRandom(),
  orderId: uuid('order_id').notNull(),
  quoteId: uuid('quote_id').notNull(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  quoteLineId: uuid('quote_line_id').notNull(),
  orderedQty: numeric('ordered_qty', { precision: 12, scale: 2 }).notNull(),
  receivedQty: numeric('received_qty', { precision: 12, scale: 2 }).notNull().default('0'),
  trackingNumber: varchar('tracking_number', { length: 120 }),
  eta: date('eta'),
  receivedAt: timestamp('received_at'),
  cancelledAt: timestamp('cancelled_at'),
  notes: text('notes'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => [
  index('quote_order_lines_order_idx').on(t.orderId),
  index('quote_order_lines_org_idx').on(t.orgId),
  index('quote_order_lines_quote_idx').on(t.quoteId),
  index('quote_order_lines_quote_line_idx').on(t.quoteLineId),
  foreignKey({
    columns: [t.orderId, t.quoteId, t.orgId],
    foreignColumns: [quoteOrders.id, quoteOrders.quoteId, quoteOrders.orgId],
    name: 'quote_order_lines_order_fkey',
  }).onDelete('cascade'),
  foreignKey({
    columns: [t.quoteLineId, t.quoteId], foreignColumns: [quoteLines.id, quoteLines.quoteId],
    name: 'quote_order_lines_quote_line_fkey',
  }).onDelete('cascade'),
]);

export const partnerQuoteSequences = pgTable('partner_quote_sequences', {
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  year: integer('year').notNull(),
  counter: integer('counter').notNull().default(0)
}, (t) => [
  primaryKey({ columns: [t.partnerId, t.year] })
]);
