import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  jsonb,
  numeric,
  date,
  integer,
  index,
  uniqueIndex,
  foreignKey,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { partners, organizations } from './orgs';
import { users } from './users';
import { catalogItems } from './catalog';
import { contractLines } from './contracts';
import { quotes } from './quotes';
import { pax8Integrations } from './pax8';

export const pax8Orders = pgTable('pax8_orders', {
  id: uuid('id').primaryKey().defaultRandom(),
  integrationId: uuid('integration_id').notNull(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  orgId: uuid('org_id').notNull(),
  // Quote acceptance may stage an awaiting_details order before the customer
  // has a Pax8 company mapping. Preflight resolves this before submission.
  pax8CompanyId: varchar('pax8_company_id', { length: 64 }),
  status: varchar('status', { length: 20 }).notNull().default('draft'),
  source: varchar('source', { length: 10 }).notNull().default('direct'),
  sourceQuoteId: uuid('source_quote_id').references(() => quotes.id, { onDelete: 'set null' }),
  dedupeKey: varchar('dedupe_key', { length: 120 }).notNull(),
  pax8OrderId: varchar('pax8_order_id', { length: 64 }),
  error: text('error'),
  createdBy: uuid('created_by').references(() => users.id),
  submittedBy: uuid('submitted_by').references(() => users.id),
  submittedAt: timestamp('submitted_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  dedupeKeyIdx: uniqueIndex('pax8_orders_dedupe_key_uq').on(table.partnerId, table.dedupeKey),
  oneMutableDirectPerOrgIdx: uniqueIndex('pax8_orders_one_mutable_direct_per_org_uq')
    .on(table.partnerId, table.orgId)
    .where(sql`${table.source} = 'direct' AND ${table.status} IN ('draft', 'awaiting_details')`),
  idPartnerOrgIdx: uniqueIndex('pax8_orders_id_partner_org_idx')
    .on(table.id, table.partnerId, table.orgId),
  partnerIdx: index('pax8_orders_partner_idx').on(table.partnerId),
  orgIdx: index('pax8_orders_org_idx').on(table.orgId),
  statusIdx: index('pax8_orders_status_idx').on(table.partnerId, table.status),
  quoteIdx: index('pax8_orders_quote_idx').on(table.sourceQuoteId),
  integrationPartnerFk: foreignKey({
    columns: [table.integrationId, table.partnerId],
    foreignColumns: [pax8Integrations.id, pax8Integrations.partnerId],
    name: 'pax8_orders_integration_partner_fkey',
  }).onDelete('cascade'),
  orgPartnerFk: foreignKey({
    columns: [table.orgId, table.partnerId],
    foreignColumns: [organizations.id, organizations.partnerId],
    name: 'pax8_orders_org_partner_fkey',
  }).onDelete('cascade'),
}));

export const pax8OrderLines = pgTable('pax8_order_lines', {
  id: uuid('id').primaryKey().defaultRandom(),
  orderId: uuid('order_id').notNull(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  orgId: uuid('org_id').notNull(),
  action: varchar('action', { length: 20 }).notNull(),
  submitState: varchar('submit_state', { length: 20 }).notNull().default('pending'),
  pax8ProductId: varchar('pax8_product_id', { length: 64 }),
  catalogItemId: uuid('catalog_item_id'),
  billingTerm: varchar('billing_term', { length: 20 }),
  commitmentTermId: varchar('commitment_term_id', { length: 64 }),
  quantity: numeric('quantity', { precision: 12, scale: 2 }),
  authorizedBaselineQuantity: numeric('authorized_baseline_quantity', { precision: 12, scale: 2 }),
  provisioningDetails: jsonb('provisioning_details').notNull().default([]),
  targetSubscriptionId: varchar('target_subscription_id', { length: 64 }),
  cancelDate: date('cancel_date'),
  resultSubscriptionId: varchar('result_subscription_id', { length: 64 }),
  contractLineId: uuid('contract_line_id'),
  sourceQuoteLineId: uuid('source_quote_line_id'),
  error: text('error'),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  orderIdx: index('pax8_order_lines_order_idx').on(table.orderId),
  partnerIdx: index('pax8_order_lines_partner_idx').on(table.partnerId),
  orgIdx: index('pax8_order_lines_org_idx').on(table.orgId),
  contractLineIdx: index('pax8_order_lines_contract_line_idx').on(table.contractLineId),
  orderPartnerOrgFk: foreignKey({
    columns: [table.orderId, table.partnerId, table.orgId],
    foreignColumns: [pax8Orders.id, pax8Orders.partnerId, pax8Orders.orgId],
    name: 'pax8_order_lines_order_partner_org_fkey',
  }).onDelete('cascade'),
  orgPartnerFk: foreignKey({
    columns: [table.orgId, table.partnerId],
    foreignColumns: [organizations.id, organizations.partnerId],
    name: 'pax8_order_lines_org_partner_fkey',
  }).onDelete('cascade'),
  // Drizzle cannot express PostgreSQL's column-list SET NULL action. The SQL
  // migration narrows this to catalog_item_id so partner_id remains intact.
  catalogItemPartnerFk: foreignKey({
    columns: [table.catalogItemId, table.partnerId],
    foreignColumns: [catalogItems.id, catalogItems.partnerId],
    name: 'pax8_order_lines_catalog_item_partner_fkey',
  }).onDelete('set null'),
  // Likewise, the SQL migration narrows SET NULL to contract_line_id so the
  // required org_id tenancy-linkage column is never cleared.
  contractLineOrgFk: foreignKey({
    columns: [table.contractLineId, table.orgId],
    foreignColumns: [contractLines.id, contractLines.orgId],
    name: 'pax8_order_lines_contract_line_org_fkey',
  }).onDelete('set null'),
}));
