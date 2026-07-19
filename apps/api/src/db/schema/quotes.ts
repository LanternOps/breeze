import { sql, type SQL } from 'drizzle-orm';
import {
  pgTable, uuid, text, varchar, integer, boolean, numeric, jsonb, timestamp,
  char, date, pgEnum, index, uniqueIndex, primaryKey, type AnyPgColumn
} from 'drizzle-orm/pg-core';
import { partners, organizations } from './orgs';
// Reuse the exported `bytea` custom type (Buffer-mapped) from users.ts instead
// of redefining it locally — same pattern as users.avatarData.
import { users, bytea } from './users';
import { catalogItemTypeEnum } from './catalog';

export const quoteStatusEnum = pgEnum('quote_status', [
  'draft', 'sent', 'viewed', 'accepted', 'declined', 'expired', 'converted'
]);
export const quoteLineSourceTypeEnum = pgEnum('quote_line_source_type', ['catalog', 'bundle', 'manual']);
export const quoteLineRecurrenceEnum = pgEnum('quote_line_recurrence', ['one_time', 'monthly', 'annual']);
export const quoteBlockTypeEnum = pgEnum('quote_block_type', ['heading', 'rich_text', 'image', 'line_items', 'contract']);
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
  currencyCode: char('currency_code', { length: 3 }).notNull().default('USD'),
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
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
}, (t) => [
  index('quotes_org_status_idx').on(t.orgId, t.status),
  index('quotes_partner_status_idx').on(t.partnerId, t.status),
  index('quotes_org_issue_date_idx').on(t.orgId, t.issueDate),
  index('quotes_expiry_idx').on(t.expiryDate).where(sqlOpenForExpiry(t)),
  uniqueIndex('quotes_partner_number_uq').on(t.partnerId, t.quoteNumber).where(sqlNumberPresent(t)),
  uniqueIndex('quotes_id_org_uq').on(t.id, t.orgId)
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
  // Internal builder economics — never serialized to the customer document.
  unitCost: numeric('unit_cost', { precision: 12, scale: 2 }),
  // Counts toward a 'selected_lines' deposit. Catalog hardware defaults it on.
  depositEligible: boolean('deposit_eligible').notNull().default(false),
  // Catalog item type snapshotted at add-time (null for manual lines) — drives
  // the per-category subtotal breakdown without a portal-invisible catalog join.
  itemType: catalogItemTypeEnum('item_type'),
  sku: varchar('sku', { length: 100 }),
  partNumber: varchar('part_number', { length: 100 }),
  // Optional per-line product image (quote_images row on the SAME quote; the
  // service enforces that). Wins over the catalog item's image when both exist.
  imageId: uuid('image_id').references((): AnyPgColumn => quoteImages.id, { onDelete: 'set null' }),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: timestamp('created_at').defaultNow().notNull()
}, (t) => [
  index('quote_lines_quote_sort_idx').on(t.quoteId, t.sortOrder),
  index('quote_lines_block_idx').on(t.blockId),
  index('quote_lines_org_idx').on(t.orgId),
  index('quote_lines_image_idx').on(t.imageId)
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
  acceptanceTokenJti: varchar('acceptance_token_jti', { length: 128 }),
  createdAt: timestamp('created_at').defaultNow().notNull()
}, (t) => [
  index('quote_acceptances_quote_idx').on(t.quoteId),
  index('quote_acceptances_org_idx').on(t.orgId)
]);

export const partnerQuoteSequences = pgTable('partner_quote_sequences', {
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  year: integer('year').notNull(),
  counter: integer('counter').notNull().default(0)
}, (t) => [
  primaryKey({ columns: [t.partnerId, t.year] })
]);
