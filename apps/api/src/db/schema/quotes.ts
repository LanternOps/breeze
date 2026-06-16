import { sql, type SQL } from 'drizzle-orm';
import {
  pgTable, uuid, text, varchar, integer, boolean, numeric, jsonb, timestamp,
  char, date, pgEnum, index, uniqueIndex, primaryKey, type AnyPgColumn
} from 'drizzle-orm/pg-core';
import { partners, organizations } from './orgs';
// Reuse the exported `bytea` custom type (Buffer-mapped) from users.ts instead
// of redefining it locally — same pattern as users.avatarData.
import { users, bytea } from './users';

export const quoteStatusEnum = pgEnum('quote_status', [
  'draft', 'sent', 'viewed', 'accepted', 'declined', 'expired', 'converted'
]);
export const quoteLineSourceTypeEnum = pgEnum('quote_line_source_type', ['catalog', 'bundle', 'manual']);
export const quoteLineRecurrenceEnum = pgEnum('quote_line_recurrence', ['one_time', 'monthly', 'annual']);
export const quoteBlockTypeEnum = pgEnum('quote_block_type', ['heading', 'rich_text', 'image', 'line_items']);

function sqlNumberPresent(t: { quoteNumber: unknown }): SQL { return sql`${t.quoteNumber} IS NOT NULL`; }
function sqlOpenForExpiry(t: { status: unknown }): SQL { return sql`${t.status} IN ('sent','viewed')`; }

export const quotes = pgTable('quotes', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  siteId: uuid('site_id'),
  quoteNumber: varchar('quote_number', { length: 40 }),
  status: quoteStatusEnum('status').notNull().default('draft'),
  currencyCode: char('currency_code', { length: 3 }).notNull().default('USD'),
  issueDate: date('issue_date'),
  expiryDate: date('expiry_date'),
  acceptedAt: timestamp('accepted_at'),
  declinedAt: timestamp('declined_at'),
  convertedAt: timestamp('converted_at'),
  subtotal: numeric('subtotal', { precision: 12, scale: 2 }).notNull().default('0'),
  taxRate: numeric('tax_rate', { precision: 6, scale: 3 }),
  taxTotal: numeric('tax_total', { precision: 12, scale: 2 }).notNull().default('0'),
  total: numeric('total', { precision: 12, scale: 2 }).notNull().default('0'),
  oneTimeTotal: numeric('one_time_total', { precision: 12, scale: 2 }).notNull().default('0'),
  monthlyRecurringTotal: numeric('monthly_recurring_total', { precision: 12, scale: 2 }).notNull().default('0'),
  annualRecurringTotal: numeric('annual_recurring_total', { precision: 12, scale: 2 }).notNull().default('0'),
  billToName: varchar('bill_to_name', { length: 255 }),
  billToAddress: jsonb('bill_to_address'),
  billToTaxId: varchar('bill_to_tax_id', { length: 100 }),
  introNotes: text('intro_notes'),
  terms: text('terms'),
  convertedInvoiceId: uuid('converted_invoice_id'),
  pdfDocumentRef: text('pdf_document_ref'),
  pdfSha256: char('pdf_sha256', { length: 64 }),
  sentAt: timestamp('sent_at'),
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
  description: text('description').notNull(),
  quantity: numeric('quantity', { precision: 12, scale: 2 }).notNull(),
  unitPrice: numeric('unit_price', { precision: 12, scale: 2 }).notNull(),
  taxable: boolean('taxable').notNull().default(false),
  customerVisible: boolean('customer_visible').notNull().default(true),
  lineTotal: numeric('line_total', { precision: 12, scale: 2 }).notNull().default('0'),
  recurrence: quoteLineRecurrenceEnum('recurrence').notNull().default('one_time'),
  termMonths: integer('term_months'),
  billingFrequency: varchar('billing_frequency', { length: 20 }),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: timestamp('created_at').defaultNow().notNull()
}, (t) => [
  index('quote_lines_quote_sort_idx').on(t.quoteId, t.sortOrder),
  index('quote_lines_block_idx').on(t.blockId),
  index('quote_lines_org_idx').on(t.orgId)
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
