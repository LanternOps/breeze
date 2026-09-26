import { pgTable, pgEnum, uuid, varchar, text, timestamp, boolean, jsonb, integer, index, real, uniqueIndex, foreignKey, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organizations, partners, sites } from './orgs';
import { devices } from './devices';
import { discoveredAssets } from './discovery';
import { alertSeverityEnum } from './alerts';

export const monitorTypeEnum = pgEnum('monitor_type', ['icmp_ping', 'tcp_port', 'http_check', 'dns_check']);
export const monitorStatusEnum = pgEnum('monitor_status', ['online', 'offline', 'degraded', 'unknown']);

export const networkMonitors = pgTable('network_monitors', {
  id: uuid('id').primaryKey().defaultRandom(),
  // #5291 W04 — network_monitors is a config table now: org_id XOR partner_id,
  // pinned by network_monitors_one_owner_chk. A partner-wide row authors one
  // check that monitorWorker fans out to every org under the partner.
  orgId: uuid('org_id').references(() => organizations.id),
  partnerId: uuid('partner_id').references(() => partners.id),
  // Set when this row is a compiled artefact of a `network_check` monitor
  // definition; the compiler owns it and managedRowGuard refuses hand edits.
  managedByMonitorId: uuid('managed_by_monitor_id'),
  siteId: uuid('site_id'),
  assetId: uuid('asset_id').references(() => discoveredAssets.id),
  name: varchar('name', { length: 200 }).notNull(),
  monitorType: monitorTypeEnum('monitor_type').notNull(),
  target: varchar('target', { length: 500 }).notNull(),
  config: jsonb('config').notNull().default({}),
  pollingInterval: integer('polling_interval').notNull().default(60),
  timeout: integer('timeout').notNull().default(5),
  isActive: boolean('is_active').notNull().default(true),
  lastChecked: timestamp('last_checked'),
  lastStatus: monitorStatusEnum('last_status').notNull().default('unknown'),
  lastResponseMs: real('last_response_ms'),
  lastError: text('last_error'),
  consecutiveFailures: integer('consecutive_failures').notNull().default(0),
  // #5754 — the certificate observed on the last http_check, promoted out of
  // the untyped network_monitor_results.details blob so the expiring_certs
  // sweep kind has a queryable evidence source. NULL everywhere means "never
  // observed under the current agent"; there is deliberately no backfill,
  // because historical rows carry no observed host or state.
  tlsNotAfter: timestamp('tls_not_after', { withTimezone: true }),
  // THE endpoint the certificate belongs to. Redirects are followed by
  // default, so a monitor on a.example can legitimately report b.example's
  // certificate; a finding that omits this names the wrong endpoint.
  tlsObservedHost: varchar('tls_observed_host', { length: 255 }),
  tlsIssuer: varchar('tls_issuer', { length: 255 }),
  tlsObservedAt: timestamp('tls_observed_at', { withTimezone: true }),
  // 'observed' | 'handshake_failed' | 'not_tls', emitted by the agent and
  // never derived: a handshake failure returns before certificate extraction,
  // so a null tls_not_after must never read as "fine".
  tlsState: varchar('tls_state', { length: 16 }),
  // Explicit retirement: 'unconvertible:<code>' or 'operator'. Converted
  // checks are adopted through managed_by_monitor_id and stay live.
  retiredAt: timestamp('retired_at', { withTimezone: true }),
  retiredReason: text('retired_reason'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
}, (table) => ({
  idOrgSiteUnique: uniqueIndex('network_monitors_id_org_site_uniq').on(table.id,table.orgId,table.siteId),
  siteScopeFk: foreignKey({name:'network_monitors_site_scope_fk',columns:[table.siteId,table.orgId],foreignColumns:[sites.id,sites.orgId]}),
  assetSiteScopeFk: foreignKey({name:'network_monitors_asset_site_scope_fk',columns:[table.assetId,table.orgId,table.siteId],foreignColumns:[discoveredAssets.id,discoveredAssets.orgId,discoveredAssets.siteId]}),
  siteOwnerCheck: check('network_monitors_site_owner_chk',sql`site_id IS NULL OR org_id IS NOT NULL`),
  orgIdIdx: index('network_monitors_org_id_idx').on(table.orgId),
  unmanagedPendingIdx: index('network_monitors_unmanaged_pending_idx')
    .on(table.orgId)
    .where(sql`${table.managedByMonitorId} IS NULL AND ${table.retiredAt} IS NULL`),
  partnerIdIdx: index('network_monitors_partner_id_idx').on(table.partnerId),
  monitorTypeIdx: index('network_monitors_monitor_type_idx').on(table.monitorType),
  isActiveIdx: index('network_monitors_is_active_idx').on(table.isActive)
}));

export const networkMonitorResults = pgTable('network_monitor_results', {
  id: uuid('id').primaryKey().defaultRandom(),
  monitorId: uuid('monitor_id').notNull().references(() => networkMonitors.id, { onDelete: 'cascade' }),
  // #5291 W04 — the org the check ran FOR and the device it ran FROM. A
  // partner-wide parent has no org_id, so the old EXISTS-join RLS policy was
  // blind for it; this makes the child Shape 1. NULLABLE until the batched
  // production backfill lands (follow-up), but every writer sets it.
  orgId: uuid('org_id').references(() => organizations.id),
  deviceId: uuid('device_id').references(() => devices.id, { onDelete: 'set null' }),
  status: monitorStatusEnum('status').notNull(),
  responseMs: real('response_ms'),
  statusCode: integer('status_code'),
  error: text('error'),
  details: jsonb('details'),
  timestamp: timestamp('timestamp').notNull().defaultNow()
}, (table) => ({
  monitorIdIdx: index('network_monitor_results_monitor_id_idx').on(table.monitorId),
  orgIdIdx: index('network_monitor_results_org_id_idx').on(table.orgId),
  deviceIdIdx: index('network_monitor_results_device_id_idx').on(table.deviceId),
  timestampIdx: index('network_monitor_results_timestamp_idx').on(table.timestamp)
}));

export const networkMonitorAlertRules = pgTable('network_monitor_alert_rules', {
  id: uuid('id').primaryKey().defaultRandom(),
  monitorId: uuid('monitor_id').notNull().references(() => networkMonitors.id, { onDelete: 'cascade' }),
  condition: varchar('condition', { length: 50 }).notNull(),
  threshold: varchar('threshold', { length: 100 }),
  severity: alertSeverityEnum('severity').notNull(),
  message: text('message'),
  isActive: boolean('is_active').notNull().default(true),
  // Stamped 'converted' on adopted checks' rules; revert clears retirement.
  retiredAt: timestamp('retired_at', { withTimezone: true }),
  retiredReason: text('retired_reason')
});
