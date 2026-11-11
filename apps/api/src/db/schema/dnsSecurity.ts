import { sql, type SQL } from 'drizzle-orm';
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
  date,
  type AnyPgColumn
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
  'quad9',
  'adguard_home'
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

// #6692 — the `dns_threat_category` enum mixes real security threats with
// content-policy categories. Only threat categories are security incidents
// (they raise `dns.threat.blocked` / a severity=high alert); a content-policy
// block is the filter doing its job. `unknown` is in neither group. Type-level
// only — the DB enum is unchanged. dnsSecurity.test.ts asserts this partitions
// the enum, so a new enum value must be placed in one group.
export const DNS_THREAT_CATEGORIES = [
  'phishing',
  'malware',
  'botnet',
  'ransomware',
  'cryptomining',
  'spam',
  'adware'
] as const satisfies readonly DnsThreatCategory[];

export const DNS_CONTENT_CATEGORIES = [
  'social_media',
  'streaming',
  'gambling',
  'adult_content'
] as const satisfies readonly DnsThreatCategory[];

export type DnsSecurityThreatCategory = typeof DNS_THREAT_CATEGORIES[number];
export type DnsContentCategory = typeof DNS_CONTENT_CATEGORIES[number];

const DNS_THREAT_CATEGORY_SET: ReadonlySet<string> = new Set(DNS_THREAT_CATEGORIES);

export function isDnsThreatCategory(value: unknown): value is DnsSecurityThreatCategory {
  return typeof value === 'string' && DNS_THREAT_CATEGORY_SET.has(value);
}

export type DnsPolicyType = typeof dnsPolicyTypeEnum.enumValues[number];
export type DnsPolicySyncStatus = typeof dnsPolicySyncStatusEnum.enumValues[number];

/** Sync cadence bounds (minutes) for `DnsIntegrationConfig.syncInterval`; shared by the job, the health stale arm and its index. */
export const DNS_SYNC_INTERVAL_MINUTES = { DEFAULT: 15, MIN: 5, MAX: 1440 } as const;

/** Shortest stale threshold the exact test can produce, in minutes. */
export const DNS_STALE_FLOOR_MINUTES = 60;

/*
 * Why the stale indexes below are on plain columns, not on this expression:
 * under RLS (breeze_app) the planner only pushes leakproof quals into an
 * index, and make_interval / the interval CASE / COALESCE are not, so an index
 * on the stale-at instant is never an Index Cond (verified on Postgres 16).
 * The source pre-filters on `last_sync < cutoff` (or, never synced,
 * `created_at < cutoff`), served by the two indexes, and rechecks the exact
 * test on the few rows that remain.
 */

/**
 * The instant after which a DNS integration's sync counts as stalled: last-ok
 * plus GREATEST(3 x effective sync interval, 60) minutes. The interval CASE
 * mirrors `syncIntervalMinutesFromConfig` for every value the job accepts; an
 * unparseable value reads as MAX, never earlier than the job's own threshold.
 * `[.]`, not an escaped dot: a template literal would cook the backslash away
 * and `::numeric` would then throw on e.g. "1a5".
 */
export function dnsFilterStaleAt(t: { lastSync: AnyPgColumn; createdAt: AnyPgColumn; config: AnyPgColumn }): SQL {
  const { DEFAULT, MIN, MAX } = DNS_SYNC_INTERVAL_MINUTES;
  return sql`(COALESCE(${t.lastSync}, ${t.createdAt}) + make_interval(mins => GREATEST(3 * (CASE
  WHEN ${t.config}->>'syncInterval' IS NULL THEN ${sql.raw(String(DEFAULT))}
  WHEN ${t.config}->>'syncInterval' ~ '^-?[0-9]+([.][0-9]+)?$'
    THEN LEAST(${sql.raw(String(MAX))}, GREATEST(${sql.raw(String(MIN))}, round((${t.config}->>'syncInterval')::numeric)))::int
  ELSE ${sql.raw(String(MAX))} END), ${sql.raw(String(DNS_STALE_FLOOR_MINUTES))})))`;
}

export interface DnsIntegrationConfig {
  organizationId?: string;
  accountId?: string;
  apiEndpoint?: string;
  syncInterval?: number;
  retentionDays?: number;
  categories?: string[];
  blocklistId?: string;
  allowlistId?: string;
  // Pi-hole admin API version. v5 uses the legacy `/admin/api.php?...&auth=`
  // token endpoint; v6 reworked it into a session-based REST API at `/api/...`.
  // Unset defaults to 'v5' so existing Pi-hole integrations keep working.
  piholeVersion?: 'v5' | 'v6';
  // Per-integration opt-in to reach a carrier-grade-NAT (100.64.0.0/10) endpoint
  // — the range an overlay network such as Tailscale assigns to an appliance.
  // Default absent (blocked). Only takes effect on a self-hosted deployment
  // (where the on-prem appliance modes are enabled at all), so it cannot widen
  // egress on the hosted platform. Enabling it is recorded in the audit log via
  // the integration create/update route.
  allowCarrierNatEgress?: boolean;
  // #10054 — per-integration opt-in to store ALLOWED DNS queries. Absent/false
  // (the default) stores blocked + redirected events only; allowed traffic is
  // ~99% of a provider's log. Resolved only through
  // services/dnsProviders/syncScope.ts. Applies to future syncs; rows already
  // stored are left to retention.
  storeAllowedTraffic?: boolean;
  // Sync state, not a setting: the time-slice width (ms) the last sliced
  // provider walk (Cisco Umbrella) ended on. Written only by the DNS sync job,
  // read back as the next run's starting width so a backlog does not pay its
  // splitting cost again every run (#10018). The create route's schema does
  // not accept it, so a tenant cannot set it.
  syncSliceWidthMs?: number;
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
  providerIdx: index('dns_filter_integrations_provider_idx').on(table.provider),
  // Connection health broken set (migration 2026-12-29-190000).
  syncErrorIdx: index('dns_filter_integrations_sync_error_idx')
    .on(table.id)
    .where(sql`${table.isActive} AND ${table.lastSyncStatus} = 'error'`),
  // Connection health stale arm (#10021, migration 2027-01-22-232700).
  staleIdx: index('dns_filter_integrations_stale_idx')
    .on(table.lastSync)
    .where(sql`${table.isActive}`),
  neverSyncedIdx: index('dns_filter_integrations_never_synced_idx')
    .on(table.createdAt)
    .where(sql`${table.isActive} AND ${table.lastSync} IS NULL`)
}));

export const dnsSecurityEvents = pgTable('dns_security_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  integrationId: uuid('integration_id').notNull().references(() => dnsFilterIntegrations.id, { onDelete: 'cascade' }),
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
  // Blocked-only Events tab list, keyset-paged on (timestamp, id) (#10054,
  // migration 2027-01-19-110000-dns-security-events-blocked-index.sql).
  orgBlockedTimestampIdx: index('dns_security_events_org_blocked_ts_idx')
    .on(table.orgId, table.timestamp, table.id)
    .where(sql`${table.action} = 'blocked'`),
  integrationIdIdx: index('dns_security_events_integration_id_idx').on(table.integrationId),
  deviceIdIdx: index('dns_security_events_device_id_idx').on(table.deviceId),
  domainIdx: index('dns_security_events_domain_idx').on(table.domain),
  actionCategoryIdx: index('dns_security_events_action_cat_idx').on(table.action, table.category),
  // (integration_id, provider_event_id) is served by the unique index below;
  // the non-unique copy dns_security_events_provider_id_idx was dropped (#10054).
  providerEventIdUnique: uniqueIndex('dns_security_events_provider_evt_uniq').on(table.integrationId, table.providerEventId)
}));

export const dnsPolicies = pgTable('dns_policies', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  integrationId: uuid('integration_id').notNull().references(() => dnsFilterIntegrations.id, { onDelete: 'cascade' }),
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
  integrationId: uuid('integration_id').references(() => dnsFilterIntegrations.id, { onDelete: 'cascade' }),
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
