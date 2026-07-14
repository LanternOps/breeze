import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  jsonb,
  boolean,
  numeric,
  date,
  char,
  index,
  uniqueIndex,
  foreignKey,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { partners, organizations } from './orgs';
import { users } from './users';
import { catalogItems } from './catalog';
import { contractLines } from './contracts';

export const pax8Integrations = pgTable('pax8_integrations', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  name: varchar('name', { length: 200 }).notNull(),
  clientIdEncrypted: text('client_id_encrypted').notNull(),
  clientSecretEncrypted: text('client_secret_encrypted').notNull(),
  accessTokenEncrypted: text('access_token_encrypted'),
  accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
  apiBaseUrl: varchar('api_base_url', { length: 300 }).notNull().default('https://api.pax8.com/v1'),
  tokenUrl: varchar('token_url', { length: 300 }).notNull(),
  // Reserved for a future inbound Pax8 webhook handler. No consumer exists yet;
  // any handler that reads this MUST HMAC-verify the Pax8 signature before
  // trusting the payload. Stored encrypted (see encryptedColumnRegistry).
  webhookSecretEncrypted: text('webhook_secret_encrypted'),
  isActive: boolean('is_active').notNull().default(true),
  lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
  lastSyncStatus: varchar('last_sync_status', { length: 20 }),
  lastSyncError: text('last_sync_error'),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  partnerActiveIdx: uniqueIndex('pax8_integrations_partner_active_idx')
    .on(table.partnerId)
    .where(sql`${table.isActive} = true`),
  idPartnerIdx: uniqueIndex('pax8_integrations_id_partner_idx').on(table.id, table.partnerId),
}));

export const pax8CompanyMappings = pgTable('pax8_company_mappings', {
  id: uuid('id').primaryKey().defaultRandom(),
  integrationId: uuid('integration_id').notNull(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  pax8CompanyId: varchar('pax8_company_id', { length: 64 }).notNull(),
  pax8CompanyName: varchar('pax8_company_name', { length: 255 }).notNull(),
  status: varchar('status', { length: 40 }),
  orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'set null' }),
  ignored: boolean('ignored').notNull().default(false),
  metadata: jsonb('metadata').notNull().default({}),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  uniqueCompanyIdx: uniqueIndex('pax8_company_mappings_integration_company_uq').on(table.integrationId, table.pax8CompanyId),
  integrationIdx: index('pax8_company_mappings_integration_idx').on(table.integrationId),
  partnerIdx: index('pax8_company_mappings_partner_idx').on(table.partnerId),
  orgIdx: index('pax8_company_mappings_org_idx').on(table.orgId),
  integrationPartnerFk: foreignKey({
    columns: [table.integrationId, table.partnerId],
    foreignColumns: [pax8Integrations.id, pax8Integrations.partnerId],
    name: 'pax8_company_mappings_integration_partner_fkey',
  }).onDelete('cascade'),
  orgPartnerFk: foreignKey({
    columns: [table.orgId, table.partnerId],
    foreignColumns: [organizations.id, organizations.partnerId],
    name: 'pax8_company_mappings_org_partner_fkey',
  }),
}));

export const pax8SubscriptionSnapshots = pgTable('pax8_subscription_snapshots', {
  id: uuid('id').primaryKey().defaultRandom(),
  integrationId: uuid('integration_id').notNull(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  pax8CompanyId: varchar('pax8_company_id', { length: 64 }).notNull(),
  orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'set null' }),
  pax8SubscriptionId: varchar('pax8_subscription_id', { length: 64 }).notNull(),
  productId: varchar('product_id', { length: 64 }),
  productName: varchar('product_name', { length: 255 }),
  vendorName: varchar('vendor_name', { length: 255 }),
  vendorSkuId: varchar('vendor_sku_id', { length: 120 }),
  status: varchar('status', { length: 40 }),
  billingTerm: varchar('billing_term', { length: 40 }),
  quantity: numeric('quantity', { precision: 12, scale: 2 }).notNull().default('0'),
  quantityKnown: boolean('quantity_known').notNull().default(false),
  unitPrice: numeric('unit_price', { precision: 12, scale: 2 }),
  unitCost: numeric('unit_cost', { precision: 12, scale: 2 }),
  currencyCode: char('currency_code', { length: 3 }),
  startDate: date('start_date'),
  endDate: date('end_date'),
  billingStart: date('billing_start'),
  commitmentTermEndDate: date('commitment_term_end_date'),
  raw: jsonb('raw').notNull().default({}),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  uniqueSubscriptionIdx: uniqueIndex('pax8_subscription_snapshots_integration_sub_uq').on(table.integrationId, table.pax8SubscriptionId),
  integrationIdx: index('pax8_subscription_snapshots_integration_idx').on(table.integrationId),
  partnerIdx: index('pax8_subscription_snapshots_partner_idx').on(table.partnerId),
  orgIdx: index('pax8_subscription_snapshots_org_idx').on(table.orgId),
  companyIdx: index('pax8_subscription_snapshots_company_idx').on(table.integrationId, table.pax8CompanyId),
  productIdx: index('pax8_subscription_snapshots_product_idx').on(table.integrationId, table.productId),
  integrationPartnerFk: foreignKey({
    columns: [table.integrationId, table.partnerId],
    foreignColumns: [pax8Integrations.id, pax8Integrations.partnerId],
    name: 'pax8_subscription_snapshots_integration_partner_fkey',
  }).onDelete('cascade'),
  orgPartnerFk: foreignKey({
    columns: [table.orgId, table.partnerId],
    foreignColumns: [organizations.id, organizations.partnerId],
    name: 'pax8_subscription_snapshots_org_partner_fkey',
  }),
}));

export const pax8ProductMappings = pgTable('pax8_product_mappings', {
  id: uuid('id').primaryKey().defaultRandom(),
  integrationId: uuid('integration_id').notNull(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  pax8ProductId: varchar('pax8_product_id', { length: 64 }).notNull(),
  vendorSkuId: varchar('vendor_sku_id', { length: 120 }),
  productName: varchar('product_name', { length: 255 }),
  catalogItemId: uuid('catalog_item_id').references(() => catalogItems.id, { onDelete: 'set null' }),
  syncPricing: boolean('sync_pricing').notNull().default(false),
  metadata: jsonb('metadata').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  uniqueProductIdx: uniqueIndex('pax8_product_mappings_integration_product_uq').on(table.integrationId, table.pax8ProductId),
  partnerIdx: index('pax8_product_mappings_partner_idx').on(table.partnerId),
  catalogItemIdx: index('pax8_product_mappings_catalog_item_idx').on(table.catalogItemId),
  integrationPartnerFk: foreignKey({
    columns: [table.integrationId, table.partnerId],
    foreignColumns: [pax8Integrations.id, pax8Integrations.partnerId],
    name: 'pax8_product_mappings_integration_partner_fkey',
  }).onDelete('cascade'),
  catalogItemPartnerFk: foreignKey({
    columns: [table.catalogItemId, table.partnerId],
    foreignColumns: [catalogItems.id, catalogItems.partnerId],
    name: 'pax8_product_mappings_catalog_item_partner_fkey',
  }),
}));

export const pax8ContractLineLinks = pgTable('pax8_contract_line_links', {
  id: uuid('id').primaryKey().defaultRandom(),
  integrationId: uuid('integration_id').notNull(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  subscriptionSnapshotId: uuid('subscription_snapshot_id').notNull().references(() => pax8SubscriptionSnapshots.id, { onDelete: 'cascade' }),
  contractLineId: uuid('contract_line_id').notNull().references(() => contractLines.id, { onDelete: 'cascade' }),
  syncEnabled: boolean('sync_enabled').notNull().default(false),
  // Physical names are retained for migration compatibility. These values are
  // observations only; they are never applied to contract billing quantity.
  lastObservedQuantity: numeric('last_applied_quantity', { precision: 12, scale: 2 }),
  lastObservedAt: timestamp('last_applied_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  uniqueSubscriptionIdx: uniqueIndex('pax8_contract_line_links_subscription_uq').on(table.subscriptionSnapshotId),
  uniqueContractLineIdx: uniqueIndex('pax8_contract_line_links_contract_line_uq').on(table.contractLineId),
  partnerIdx: index('pax8_contract_line_links_partner_idx').on(table.partnerId),
  orgIdx: index('pax8_contract_line_links_org_idx').on(table.orgId),
  integrationPartnerFk: foreignKey({
    columns: [table.integrationId, table.partnerId],
    foreignColumns: [pax8Integrations.id, pax8Integrations.partnerId],
    name: 'pax8_contract_line_links_integration_partner_fkey',
  }).onDelete('cascade'),
  orgPartnerFk: foreignKey({
    columns: [table.orgId, table.partnerId],
    foreignColumns: [organizations.id, organizations.partnerId],
    name: 'pax8_contract_line_links_org_partner_fkey',
  }).onDelete('cascade'),
  contractLineOrgFk: foreignKey({
    columns: [table.contractLineId, table.orgId],
    foreignColumns: [contractLines.id, contractLines.orgId],
    name: 'pax8_contract_line_links_contract_line_org_fkey',
  }).onDelete('cascade'),
}));
