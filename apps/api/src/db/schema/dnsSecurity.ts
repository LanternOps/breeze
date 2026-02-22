import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  jsonb,
  pgEnum,
  boolean,
  integer,
  index,
  uniqueIndex,
  date
} from 'drizzle-orm/pg-core';
import { organizations } from './orgs';
import { users } from './users';
import { devices } from './devices';

export const dnsProviderEnum = pgEnum('dns_provider', [
  'umbrella',
  'cloudflare',
  'dnsfilter',
  'pihole',
  'opendns',
  'quad9'
]);

export const dnsActionEnum = pgEnum('dns_action', [
  'allowed',
  'blocked',
  'redirected'
]);

export const dnsThreatCategoryEnum = pgEnum('dns_threat_category', [
  'malware',
  'phishing',
  'botnet',
  'cryptomining',
  'ransomware',
  'spam',
  'adware',
  'adult_content',
  'gambling',
  'social_media',
  'streaming',
  'unknown'
]);

export const dnsPolicyTypeEnum = pgEnum('dns_policy_type', ['blocklist', 'allowlist']);
export const dnsPolicySyncStatusEnum = pgEnum('dns_policy_sync_status', ['pending', 'synced', 'error']);

export type DnsProvider = typeof dnsProviderEnum.enumValues[number];
export type DnsAction = typeof dnsActionEnum.enumValues[number];
export type DnsThreatCategory = typeof dnsThreatCategoryEnum.enumValues[number];
export type DnsPolicyType = typeof dnsPolicyTypeEnum.enumValues[number];
export type DnsPolicySyncStatus = typeof dnsPolicySyncStatusEnum.enumValues[number];

export interface DnsIntegrationConfig {
  organizationId?: string;
  accountId?: string;
  apiEndpoint?: string;
  syncInterval?: number;
  retentionDays?: number;
  categories?: string[];
  blocklistId?: string;
  allowlistId?: string;
}

export interface DnsPolicyDomain {
  domain: string;
  reason?: string;
  addedAt: string;
  addedBy?: string;
}

export const dnsFilterIntegrations = pgTable('dns_filter_integrations', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  provider: dnsProviderEnum('provider').notNull(),
  name: varchar('name', { length: 200 }).notNull(),
  description: text('description'),
  apiKey: text('api_key'),
  apiSecret: text('api_secret'),
  config: jsonb('config').$type<DnsIntegrationConfig>().notNull().default({}),
  isActive: boolean('is_active').notNull().default(true),
  lastSync: timestamp('last_sync'),
  lastSyncStatus: varchar('last_sync_status', { length: 20 }),
  lastSyncError: text('last_sync_error'),
  totalEventsProcessed: integer('total_events_processed').notNull().default(0),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
}, (table) => ({
  orgIdIdx: index('dns_filter_integrations_org_id_idx').on(table.orgId),
  providerIdx: index('dns_filter_integrations_provider_idx').on(table.provider)
}));

export const dnsSecurityEvents = pgTable('dns_security_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  integrationId: uuid('integration_id').notNull().references(() => dnsFilterIntegrations.id),
  deviceId: uuid('device_id').references(() => devices.id),
  timestamp: timestamp('timestamp').notNull(),
  domain: varchar('domain', { length: 500 }).notNull(),
  queryType: varchar('query_type', { length: 10 }).notNull().default('A'),
  action: dnsActionEnum('action').notNull(),
  category: dnsThreatCategoryEnum('category'),
  threatType: varchar('threat_type', { length: 100 }),
  threatScore: integer('threat_score'),
  sourceIp: varchar('source_ip', { length: 45 }),
  sourceHostname: varchar('source_hostname', { length: 255 }),
  providerEventId: varchar('provider_event_id', { length: 255 }).notNull(),
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at').defaultNow().notNull()
}, (table) => ({
  orgTimestampIdx: index('dns_security_events_org_ts_idx').on(table.orgId, table.timestamp),
  integrationIdIdx: index('dns_security_events_integration_id_idx').on(table.integrationId),
  deviceIdIdx: index('dns_security_events_device_id_idx').on(table.deviceId),
  domainIdx: index('dns_security_events_domain_idx').on(table.domain),
  actionCategoryIdx: index('dns_security_events_action_cat_idx').on(table.action, table.category),
  providerEventIdIdx: index('dns_security_events_provider_id_idx').on(table.integrationId, table.providerEventId),
  providerEventIdUnique: uniqueIndex('dns_security_events_provider_evt_uniq').on(table.integrationId, table.providerEventId)
}));

export const dnsPolicies = pgTable('dns_policies', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  integrationId: uuid('integration_id').notNull().references(() => dnsFilterIntegrations.id),
  name: varchar('name', { length: 200 }).notNull(),
  description: text('description'),
  type: dnsPolicyTypeEnum('type').notNull(),
  domains: jsonb('domains').$type<DnsPolicyDomain[]>().notNull().default([]),
  categories: jsonb('categories').$type<string[]>().notNull().default([]),
  syncStatus: dnsPolicySyncStatusEnum('sync_status').notNull().default('pending'),
  lastSynced: timestamp('last_synced'),
  syncError: text('sync_error'),
  isActive: boolean('is_active').notNull().default(true),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
}, (table) => ({
  orgIdIdx: index('dns_policies_org_id_idx').on(table.orgId),
  integrationIdIdx: index('dns_policies_integration_id_idx').on(table.integrationId)
}));

export const dnsEventAggregations = pgTable('dns_event_aggregations', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  date: date('date').notNull(),
  integrationId: uuid('integration_id').references(() => dnsFilterIntegrations.id),
  deviceId: uuid('device_id').references(() => devices.id),
  domain: varchar('domain', { length: 500 }),
  category: dnsThreatCategoryEnum('category'),
  totalQueries: integer('total_queries').notNull().default(0),
  blockedQueries: integer('blocked_queries').notNull().default(0),
  allowedQueries: integer('allowed_queries').notNull().default(0)
}, (table) => ({
  orgDateIdx: index('dns_event_agg_org_date_idx').on(table.orgId, table.date),
  orgDateIntegrationIdx: index('dns_event_agg_org_date_integration_idx').on(table.orgId, table.date, table.integrationId),
  integrationIdIdx: index('dns_event_agg_integration_id_idx').on(table.integrationId),
  deviceIdIdx: index('dns_event_agg_device_id_idx').on(table.deviceId)
}));
