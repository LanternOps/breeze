import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  boolean,
  jsonb,
  pgEnum,
  integer,
  real,
  uniqueIndex
} from 'drizzle-orm/pg-core';
import { organizations } from './orgs';
import { users } from './users';

export const pluginTypeEnum = pgEnum('plugin_type', [
  'integration',
  'automation',
  'reporting',
  'collector',
  'notification',
  'ui'
]);

export const pluginInstallStatusEnum = pgEnum('plugin_install_status', [
  'available',
  'installing',
  'installed',
  'updating',
  'uninstalling',
  'error'
]);

export const pluginCatalog = pgTable('plugin_catalog', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: varchar('slug', { length: 100 }).notNull().unique(),
  name: varchar('name', { length: 255 }).notNull(),
  version: varchar('version', { length: 50 }).notNull(),
  description: text('description'),
  type: pluginTypeEnum('type').notNull(),
  author: varchar('author', { length: 255 }),
  authorUrl: text('author_url'),
  homepage: text('homepage'),
  repository: text('repository'),
  license: varchar('license', { length: 100 }),
  manifestUrl: text('manifest_url'),
  downloadUrl: text('download_url'),
  checksum: varchar('checksum', { length: 128 }),
  minAgentVersion: varchar('min_agent_version', { length: 50 }),
  minApiVersion: varchar('min_api_version', { length: 50 }),
  dependencies: jsonb('dependencies'),
  permissions: jsonb('permissions'),
  hooks: jsonb('hooks'),
  iconUrl: text('icon_url'),
  screenshotUrls: text('screenshot_urls').array().default([]),
  category: varchar('category', { length: 100 }),
  tags: text('tags').array().default([]),
  installCount: integer('install_count').notNull().default(0),
  rating: real('rating').notNull().default(0),
  isVerified: boolean('is_verified').notNull().default(false),
  isFeatured: boolean('is_featured').notNull().default(false),
  isDeprecated: boolean('is_deprecated').notNull().default(false),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
});

export const pluginInstallations = pgTable('plugin_installations', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  catalogId: uuid('catalog_id').notNull().references(() => pluginCatalog.id),
  version: varchar('version', { length: 50 }).notNull(),
  status: pluginInstallStatusEnum('status').notNull().default('installed'),
  enabled: boolean('enabled').notNull().default(true),
  config: jsonb('config').notNull().default({}),
  permissions: jsonb('permissions'),
  sandboxEnabled: boolean('sandbox_enabled').notNull().default(true),
  resourceLimits: jsonb('resource_limits'),
  installedAt: timestamp('installed_at'),
  installedBy: uuid('installed_by').references(() => users.id),
  lastActiveAt: timestamp('last_active_at'),
  errorMessage: text('error_message'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
}, (table) => ({
  orgCatalogUnique: uniqueIndex('plugin_installations_org_catalog_unique').on(table.orgId, table.catalogId)
}));

export const pluginLogs = pgTable('plugin_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  installationId: uuid('installation_id').notNull().references(() => pluginInstallations.id),
  level: varchar('level', { length: 20 }).notNull(),
  message: text('message').notNull(),
  context: jsonb('context'),
  timestamp: timestamp('timestamp').defaultNow().notNull()
});
