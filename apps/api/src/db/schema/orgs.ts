import { pgTable, uuid, varchar, text, timestamp, jsonb, pgEnum, integer, boolean, numeric, char, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const partnerTypeEnum = pgEnum('partner_type', ['msp', 'enterprise', 'internal']);
export const partnerStatusEnum = pgEnum('partner_status', ['pending', 'active', 'suspended', 'churned']);
export type PartnerStatus = typeof partnerStatusEnum.enumValues[number];
export const planTypeEnum = pgEnum('plan_type', ['free', 'starter', 'community', 'pro', 'enterprise', 'unlimited']);
export const orgTypeEnum = pgEnum('org_type', ['customer', 'internal']);
export const orgStatusEnum = pgEnum('org_status', ['active', 'suspended', 'trial', 'churned']);

export const partners = pgTable('partners', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 255 }).notNull(),
  slug: varchar('slug', { length: 100 }).notNull().unique(),
  inboundLocalPart: varchar('inbound_local_part', { length: 63 }),
  type: partnerTypeEnum('type').notNull().default('msp'),
  plan: planTypeEnum('plan').notNull().default('free'),
  status: partnerStatusEnum('status').notNull().default('active'),
  maxOrganizations: integer('max_organizations'),
  maxDevices: integer('max_devices'),
  // First-class partner timezone (issue #1318). The canonical default that a tz
  // field resolves to when no more-specific scope (explicit/site/org) is set.
  // Kept in sync with the legacy `settings.timezone` JSONB key, which remains
  // the UI write target until the full call-site migration lands.
  timezone: varchar('timezone', { length: 64 }).notNull().default('UTC'),
  settings: jsonb('settings').default({}),
  ssoConfig: jsonb('sso_config'),
  billingEmail: varchar('billing_email', { length: 255 }),
  // Plain-text signature appended to outbound customer emails (quote sends).
  emailSignature: text('email_signature'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  deletedAt: timestamp('deleted_at'),
  mcpOrigin: boolean('mcp_origin').notNull().default(false),
  mcpOriginIp: text('mcp_origin_ip'),
  mcpOriginUserAgent: text('mcp_origin_user_agent'),
  // Signup attribution for web registrations (abuse detection). MCP-originated
  // signups already record mcp_origin_ip/mcp_origin_user_agent above.
  signupIp: varchar('signup_ip', { length: 45 }),
  signupUserAgent: text('signup_user_agent'),
  emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
  paymentMethodAttachedAt: timestamp('payment_method_attached_at', { withTimezone: true }),
  stripeCustomerId: text('stripe_customer_id'),
  currencyCode: char('currency_code', { length: 3 }).notNull().default('USD'),
  defaultTaxRate: numeric('default_tax_rate', { precision: 8, scale: 5 }),
  invoiceNumberPrefix: varchar('invoice_number_prefix', { length: 12 }).notNull().default('INV'),
  invoiceTermsDays: integer('invoice_terms_days').notNull().default(30),
  invoiceFooter: text('invoice_footer'),
  billingCompanyName: varchar('billing_company_name', { length: 255 }),
  billingPhone: varchar('billing_phone', { length: 40 }),
  billingWebsite: varchar('billing_website', { length: 255 }),
  billingAddressLine1: varchar('billing_address_line1', { length: 255 }),
  billingAddressLine2: varchar('billing_address_line2', { length: 255 }),
  billingAddressCity: varchar('billing_address_city', { length: 120 }),
  billingAddressRegion: varchar('billing_address_region', { length: 120 }),
  billingAddressPostalCode: varchar('billing_address_postal_code', { length: 40 }),
  billingAddressCountry: char('billing_address_country', { length: 2 }),
  billingTermsAndConditions: text('billing_terms_and_conditions'),
  // Default markup over distributor cost (percent) used to pre-fill the listed
  // price when importing catalog items; feeds the catalog `markupPercent` field.
  // Percent value 0..9999.99. (The import view shows the resulting gross margin
  // alongside.)
  defaultMarkupPercent: numeric('default_markup_percent', { precision: 6, scale: 2 }),
  // When true (default), hardware catalog items are pre-flagged as taxable when
  // added or imported. Partners can opt out if their jurisdiction treats hardware
  // as non-taxable or they prefer to set taxability item-by-item.
  autoTaxHardware: boolean('auto_tax_hardware').notNull().default(true),
  // Partner-authored AI copy style for enrich/polish (NULL = built-in house
  // format: generic customer-friendly name + "• "-bulleted spec description).
  catalogAiStyle: text('catalog_ai_style'),
  // AI for Office is a per-partner entitlement the platform operator grants
  // (off by default). The session-minting exchange and the /client-ai/admin
  // surface gate on this; it is NOT in settings JSONB because that is
  // partner-writable and the partner must not be able to self-enable.
  aiForOfficeEnabled: boolean('ai_for_office_enabled').notNull().default(false),
});

export const organizations = pgTable('organizations', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  name: varchar('name', { length: 255 }).notNull(),
  slug: varchar('slug', { length: 100 }).notNull(),
  type: orgTypeEnum('type').notNull().default('customer'),
  status: orgStatusEnum('status').notNull().default('active'),
  maxDevices: integer('max_devices'),
  settings: jsonb('settings').default({}),
  ssoConfig: jsonb('sso_config'),
  contractStart: timestamp('contract_start'),
  contractEnd: timestamp('contract_end'),
  billingContact: jsonb('billing_contact'),
  taxId: varchar('tax_id', { length: 100 }),
  taxExempt: boolean('tax_exempt').notNull().default(false),
  taxRate: numeric('tax_rate', { precision: 8, scale: 5 }),
  billingAddressLine1: varchar('billing_address_line1', { length: 255 }),
  billingAddressLine2: varchar('billing_address_line2', { length: 255 }),
  billingAddressCity: varchar('billing_address_city', { length: 120 }),
  billingAddressRegion: varchar('billing_address_region', { length: 120 }),
  billingAddressPostalCode: varchar('billing_address_postal_code', { length: 40 }),
  billingAddressCountry: char('billing_address_country', { length: 2 }),
  accountingProvider: text('accounting_provider'),
  accountingExternalId: text('accounting_external_id'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  partnerExportUpdatedAt: timestamp('partner_export_updated_at', { precision: 3 }).defaultNow().notNull(),
  deletedAt: timestamp('deleted_at')
}, (table) => ({
  orgPartnerUnique: uniqueIndex('organizations_id_partner_id_unique').on(table.id, table.partnerId),
  accountingExternalUnique: uniqueIndex('organizations_accounting_external_uniq')
    .on(table.partnerId, table.accountingProvider, table.accountingExternalId)
    .where(sql`accounting_external_id IS NOT NULL`),
}));

export const sites = pgTable('sites', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  name: varchar('name', { length: 255 }).notNull(),
  address: jsonb('address'),
  timezone: varchar('timezone', { length: 50 }).notNull().default('UTC'),
  contact: jsonb('contact'),
  settings: jsonb('settings').default({}),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  partnerExportUpdatedAt: timestamp('partner_export_updated_at', { precision: 3 }).defaultNow().notNull()
}, (table) => ({
  idOrgUnique: uniqueIndex('sites_id_org_id_uniq').on(table.id, table.orgId),
}));

export const enrollmentKeys = pgTable('enrollment_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  siteId: uuid('site_id').references(() => sites.id),
  name: varchar('name', { length: 255 }).notNull(),
  key: varchar('key', { length: 64 }).notNull().unique(),
  keySecretHash: varchar('key_secret_hash', { length: 64 }),
  usageCount: integer('usage_count').notNull().default(0),
  maxUsage: integer('max_usage'),
  expiresAt: timestamp('expires_at'),
  createdBy: uuid('created_by'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  shortCode: varchar('short_code', { length: 12 }),
  installerPlatform: varchar('installer_platform', { length: 16 }),
});
