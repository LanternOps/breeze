import { sql, type SQL } from 'drizzle-orm';
import {
  pgTable, uuid, text, varchar, boolean, numeric, jsonb, timestamp, pgEnum,
  index, uniqueIndex
} from 'drizzle-orm/pg-core';
import { partners, organizations } from './orgs';
import { users } from './users';

export const catalogItemTypeEnum = pgEnum('catalog_item_type', ['hardware', 'software', 'service']);
export const catalogBillingTypeEnum = pgEnum('catalog_billing_type', ['one_time', 'recurring']);

// Drizzle partial-index predicate helper (kept local; drizzle-kit only needs it
// for drift detection — the real index is created in the SQL migration).
function sqlSkuNotNull(t: { sku: unknown }): SQL {
  return sql`${t.sku} IS NOT NULL`;
}

// Partner-axis (RLS shape 3). partner_id is the isolation axis.
export const catalogItems = pgTable('catalog_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  itemType: catalogItemTypeEnum('item_type').notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  sku: varchar('sku', { length: 100 }),
  description: text('description'),
  billingType: catalogBillingTypeEnum('billing_type').notNull().default('one_time'),
  unitPrice: numeric('unit_price', { precision: 12, scale: 2 }).notNull(),
  costBasis: numeric('cost_basis', { precision: 12, scale: 2 }),
  markupPercent: numeric('markup_percent', { precision: 6, scale: 2 }),
  unitOfMeasure: varchar('unit_of_measure', { length: 50 }).notNull().default('each'),
  taxable: boolean('taxable').notNull().default(true),
  taxCategory: varchar('tax_category', { length: 100 }),
  isBundle: boolean('is_bundle').notNull().default(false),
  attributes: jsonb('attributes').notNull().default({}),
  isActive: boolean('is_active').notNull().default(true),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
}, (t) => [
  index('catalog_items_partner_type_idx').on(t.partnerId, t.itemType),
  index('catalog_items_partner_active_idx').on(t.partnerId, t.isActive),
  // partial: only enforce uniqueness when sku is present
  // (the real partial unique index is created in the SQL migration; drizzle-kit
  // only needs the predicate for drift detection)
  uniqueIndex('catalog_items_partner_sku_uq').on(t.partnerId, t.sku).where(sqlSkuNotNull(t))
]);

// Org-axis (RLS shape 1, direct org_id). Per-customer sell-price override.
export const catalogItemOrgPricing = pgTable('catalog_item_org_pricing', {
  id: uuid('id').primaryKey().defaultRandom(),
  catalogItemId: uuid('catalog_item_id').notNull().references(() => catalogItems.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  unitPrice: numeric('unit_price', { precision: 12, scale: 2 }).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
}, (t) => [
  uniqueIndex('catalog_item_org_pricing_item_org_uq').on(t.catalogItemId, t.orgId),
  index('catalog_item_org_pricing_org_idx').on(t.orgId)
]);

// Partner-axis via denormalized partner_id (RLS shape 3, flat policy — avoids the
// nested-EXISTS bound-param bug; also enforces components share the bundle's partner).
export const catalogBundleComponents = pgTable('catalog_bundle_components', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  bundleItemId: uuid('bundle_item_id').notNull().references(() => catalogItems.id, { onDelete: 'cascade' }),
  componentItemId: uuid('component_item_id').notNull().references(() => catalogItems.id, { onDelete: 'restrict' }),
  quantity: numeric('quantity', { precision: 12, scale: 2 }).notNull().default('1'),
  showOnInvoice: boolean('show_on_invoice').notNull().default(false),
  revenueAllocation: numeric('revenue_allocation', { precision: 12, scale: 2 }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
}, (t) => [
  uniqueIndex('catalog_bundle_components_bundle_comp_uq').on(t.bundleItemId, t.componentItemId),
  index('catalog_bundle_components_partner_idx').on(t.partnerId)
]);
