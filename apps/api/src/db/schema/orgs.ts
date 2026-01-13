import { pgTable, uuid, varchar, text, timestamp, jsonb, pgEnum, integer } from 'drizzle-orm/pg-core';

export const partnerTypeEnum = pgEnum('partner_type', ['msp', 'enterprise', 'internal']);
export const planTypeEnum = pgEnum('plan_type', ['free', 'pro', 'enterprise', 'unlimited']);
export const orgTypeEnum = pgEnum('org_type', ['customer', 'internal']);
export const orgStatusEnum = pgEnum('org_status', ['active', 'suspended', 'trial', 'churned']);

export const partners = pgTable('partners', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 255 }).notNull(),
  slug: varchar('slug', { length: 100 }).notNull().unique(),
  type: partnerTypeEnum('type').notNull().default('msp'),
  plan: planTypeEnum('plan').notNull().default('free'),
  maxOrganizations: integer('max_organizations'),
  maxDevices: integer('max_devices'),
  settings: jsonb('settings').default({}),
  ssoConfig: jsonb('sso_config'),
  billingEmail: varchar('billing_email', { length: 255 }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  deletedAt: timestamp('deleted_at')
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
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  deletedAt: timestamp('deleted_at')
});

export const sites = pgTable('sites', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  name: varchar('name', { length: 255 }).notNull(),
  address: jsonb('address'),
  timezone: varchar('timezone', { length: 50 }).notNull().default('UTC'),
  contact: jsonb('contact'),
  settings: jsonb('settings').default({}),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
});

export const enrollmentKeys = pgTable('enrollment_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  siteId: uuid('site_id').references(() => sites.id),
  name: varchar('name', { length: 255 }).notNull(),
  key: varchar('key', { length: 64 }).notNull().unique(),
  usageCount: integer('usage_count').notNull().default(0),
  maxUsage: integer('max_usage'),
  expiresAt: timestamp('expires_at'),
  createdBy: uuid('created_by'),
  createdAt: timestamp('created_at').defaultNow().notNull()
});
