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
  index,
  numeric,
  uniqueIndex,
  check,
  customType
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { NOTIFICATION_CHANNEL_TYPES } from '@breeze/shared';
import { organizations, partners } from './orgs';
import { devices } from './devices';
import { users } from './users';

// Postgres 64-bit transaction id. Kept as a decimal STRING end to end: xid8
// values exceed Number.MAX_SAFE_INTEGER over a database's lifetime.
const xid8 = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'xid8';
  },
});

export const alertSeverityEnum = pgEnum('alert_severity', ['critical', 'high', 'medium', 'low', 'info']);
// 'dismissed' is terminal: hidden from list views by default and honored by
// synthetic-alert evaluators (warranty expiry) so a dismissed alert is never
// re-created for the same underlying condition.
export const alertStatusEnum = pgEnum('alert_status', ['active', 'acknowledged', 'resolved', 'suppressed', 'dismissed']);
export const notificationChannelTypeEnum = pgEnum('notification_channel_type', NOTIFICATION_CHANNEL_TYPES);

// An alert template is owned by EITHER an org (orgId set, partnerId NULL) OR a
// partner (partnerId set, orgId NULL — "partner-wide / all orgs", #1357/#1425),
// never both: CHECK `alert_templates_one_owner_chk` (migration
// 2026-08-25-alert-templates-one-owner). Rows with NEITHER axis set are legal
// and mean "global" — the seeded built-ins, plus system-created rows with no
// orgId — which is why the constraint is "never both" rather than a strict XOR.
//
// Before that migration the create route ALSO wrote partnerId onto org-owned
// rows, and the read predicate's `partner_id = <caller partner>` branch then
// selected every template under the partner — a cross-org read for partner
// callers with restricted org access (security review 2026-08-16 §1.5).
// Partner-wide MUST always be expressed as `partner_id = X AND org_id IS NULL`.
//
// isBuiltIn is NOT an ownership axis: policyAlertBridge auto-creates ORG-OWNED
// rows with isBuiltIn true, so a global-visibility predicate must say
// `is_built_in = true AND org_id IS NULL`, never a bare `is_built_in = true`.
export const alertTemplates = pgTable('alert_templates', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').references(() => organizations.id),
  partnerId: uuid('partner_id').references(() => partners.id),
  name: varchar('name', { length: 200 }).notNull(),
  description: text('description'),
  category: varchar('category', { length: 100 }),
  conditions: jsonb('conditions').notNull(),
  severity: alertSeverityEnum('severity').notNull(),
  titleTemplate: text('title_template').notNull(),
  messageTemplate: text('message_template').notNull(),
  targets: jsonb('targets'),
  autoResolve: boolean('auto_resolve').notNull().default(false),
  autoResolveConditions: jsonb('auto_resolve_conditions'),
  cooldownMinutes: integer('cooldown_minutes').notNull().default(5),
  isBuiltIn: boolean('is_built_in').notNull().default(false),
  // #5289: set only on rows COMPILED from a monitor definition. The compiler
  // (services/monitors/monitorCompiler.ts) is the single writer; every other
  // writer refuses a row carrying this with 409. Declared without .references()
  // to avoid an import cycle with monitorDefinitions (which references the
  // severity enum and escalation policies from this file); the FK itself is in
  // the migration and drift detection compares columns, not FK declarations.
  managedByMonitorId: uuid('managed_by_monitor_id'),
  // W05c1 retirement (2026-10-23-120000-legacy-source-retirement-columns.sql):
  // Converted or operator-retired rows stay for history; readers filter
  // retired_at IS NULL. FK to monitor_definitions ON DELETE SET NULL in SQL.
  retiredAt: timestamp('retired_at', { withTimezone: true }),
  retiredReason: text('retired_reason'),
  convertedToMonitorId: uuid('converted_to_monitor_id'),
  // Fleet Designer W03 (#5653): free-text "why" when a template is created
  // from a design; NULL otherwise.
  rationale: text('rationale'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
}, (table) => ({
  partnerIdIdx: index('alert_templates_partner_id_idx').on(table.partnerId)
}));

// An alert rule is owned by EITHER an org (orgId set, partnerId NULL — the
// original shape) OR a partner (partnerId set, orgId NULL — "partner-wide /
// all orgs", epic #2135 / #2128). Exactly one axis is set per row; the CHECK
// constraint `alert_rules_one_owner_chk` (migration 2026-07-01) enforces it.
// Partner-wide rules always use targetType 'all' with targetId = partnerId
// (targetId is NOT NULL; the 'all' match ignores it). Fired alerts ALWAYS
// carry the device's org (alerts.org_id NOT NULL), never the rule's.
export const alertRules = pgTable('alert_rules', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').references(() => organizations.id),
  partnerId: uuid('partner_id').references(() => partners.id),
  templateId: uuid('template_id').notNull().references(() => alertTemplates.id),
  name: varchar('name', { length: 200 }).notNull(),
  targetType: varchar('target_type', { length: 50 }).notNull(),
  targetId: uuid('target_id').notNull(),
  overrideSettings: jsonb('override_settings'),
  isActive: boolean('is_active').notNull().default(true),
  // #5289 — see alertTemplates.managedByMonitorId. A compiled rule uses
  // targetType 'monitor' with targetId = the monitor definition id.
  managedByMonitorId: uuid('managed_by_monitor_id'),
  // W05c1 retirement (2026-10-23-120000-legacy-source-retirement-columns.sql):
  // Converted or operator-retired rows stay for history; readers filter
  // retired_at IS NULL. FK to monitor_definitions ON DELETE SET NULL in SQL.
  retiredAt: timestamp('retired_at', { withTimezone: true }),
  retiredReason: text('retired_reason'),
  convertedToMonitorId: uuid('converted_to_monitor_id'),
  createdAt: timestamp('created_at').defaultNow().notNull()
}, (table) => ({
  orgIdIdx: index('alert_rules_org_id_idx').on(table.orgId),
  partnerIdIdx: index('alert_rules_partner_id_idx').on(table.partnerId),
  templateIdIdx: index('alert_rules_template_id_idx').on(table.templateId)
}));

export const alerts = pgTable('alerts', {
  id: uuid('id').primaryKey().defaultRandom(),
  // ON DELETE SET NULL (2026-10-25-130200, #6509): the compiled alert_rules
  // row for a monitor is cascade-deleted with the monitor, and a historical
  // alert must survive that even though it already carries its own
  // title/message/context.
  ruleId: uuid('rule_id').references(() => alertRules.id, { onDelete: 'set null' }),
  deviceId: uuid('device_id').notNull().references(() => devices.id),
  // W03 (hardware & RAID monitoring, migration 2026-10-30-110300): identifies
  // the specific subject (e.g. a component) an open alert covers, so multiple
  // independently-breaching subjects under the same rule/device can each hold
  // their own open alert. NULL for every non-subject alert source. CHECK
  // `alerts_subject_key_nonempty_chk` forbids empty string; unique index
  // `alerts_open_rule_device_subject_uidx` enforces open-alert identity below.
  subjectKey: text('subject_key'),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  configPolicyId: uuid('config_policy_id'),
  configItemName: varchar('config_item_name', { length: 200 }),
  status: alertStatusEnum('status').notNull().default('active'),
  severity: alertSeverityEnum('severity').notNull(),
  title: varchar('title', { length: 500 }).notNull(),
  message: text('message'),
  context: jsonb('context'),
  triggeredAt: timestamp('triggered_at').defaultNow().notNull(),
  acknowledgedAt: timestamp('acknowledged_at'),
  acknowledgedBy: uuid('acknowledged_by').references(() => users.id),
  resolvedAt: timestamp('resolved_at'),
  resolvedBy: uuid('resolved_by').references(() => users.id),
  resolutionNote: text('resolution_note'),
  suppressedUntil: timestamp('suppressed_until'),
  dismissedAt: timestamp('dismissed_at'),
  dismissedBy: uuid('dismissed_by').references(() => users.id),
  // #5289: provenance for alerts raised by a compiled monitor rule, so the UI
  // can link an alert back to the monitor that authored it. ON DELETE SET NULL
  // in SQL — deleting a monitor must not delete its history.
  monitorId: uuid('monitor_id'),
  // #5290 — the breach episode this alert belongs to (null for non-monitor
  // alerts). ON DELETE SET NULL in SQL.
  episodeId: uuid('episode_id'),
  // #5290 — a recurrence-escalation alert. NEVER auto-resolved, never
  // auto-suppressed by an AI verdict, always its own correlation root.
  requiresHuman: boolean('requires_human').notNull().default(false),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  // Partner API alerts feed change marker (2026-10-30-130000): stamped with
  // pg_current_xact_id() by a BEFORE INSERT OR UPDATE trigger on every write.
  // Never set it from application code.
  partnerFeedXid: xid8('partner_feed_xid').notNull().default(sql`'1'::xid8`)
}, (table) => ({
  // Backs the `alerts.critical` device-filter field (#968).
  activeCriticalIdx: index('idx_alerts_active_critical')
    .on(table.deviceId)
    .where(sql`status = 'active' AND severity = 'critical'`),
  // Backs the suppression-expiry reaper's due-rows scan
  // (apps/api/src/jobs/suppressionExpiryReaper.ts).
  suppressedExpiryIdx: index('idx_alerts_suppressed_expiry')
    .on(table.suppressedUntil)
    .where(sql`status = 'suppressed' AND suppressed_until IS NOT NULL`),
  subjectKeyNonempty: check('alerts_subject_key_nonempty_chk', sql`${table.subjectKey} <> ''`),
  openRuleDeviceSubjectUidx: uniqueIndex('alerts_open_rule_device_subject_uidx')
    .on(table.ruleId, table.deviceId, sql`COALESCE(${table.subjectKey}, '')`)
    .where(sql`${table.ruleId} IS NOT NULL AND ${table.status} IN ('active', 'acknowledged', 'suppressed')`),
  // Partner alerts feed keyset (2026-10-30-130100, built CONCURRENTLY).
  partnerFeedXidIdx: index('idx_alerts_partner_feed_xid').on(table.partnerFeedXid, table.id)
}));

export const alertCorrelations = pgTable('alert_correlations', {
  id: uuid('id').primaryKey().defaultRandom(),
  parentAlertId: uuid('parent_alert_id').notNull().references(() => alerts.id),
  childAlertId: uuid('child_alert_id').notNull().references(() => alerts.id),
  correlationType: varchar('correlation_type', { length: 50 }).notNull(),
  confidence: numeric('confidence', { precision: 3, scale: 2 }),
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at').defaultNow().notNull()
}, (table) => ({
  parentAlertIdIdx: index('alert_correlations_parent_alert_id_idx').on(table.parentAlertId),
  childAlertIdIdx: index('alert_correlations_child_alert_id_idx').on(table.childAlertId)
}));

export const alertCorrelationGroups = pgTable('alert_correlation_groups', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  groupKey: varchar('group_key', { length: 255 }).notNull(),
  rootAlertId: uuid('root_alert_id').references(() => alerts.id, { onDelete: 'set null' }),
  status: varchar('status', { length: 40 }).notNull().default('open'),
  score: numeric('score', { precision: 3, scale: 2 }),
  noiseReductionPercent: integer('noise_reduction_percent').notNull().default(0),
  memberCount: integer('member_count').notNull().default(0),
  firstSeenAt: timestamp('first_seen_at').notNull(),
  lastSeenAt: timestamp('last_seen_at').notNull(),
  metadata: jsonb('metadata').notNull().default({}),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
}, (table) => ({
  orgKeyUniq: uniqueIndex('alert_correlation_groups_org_key_uq').on(table.orgId, table.groupKey),
  orgStatusSeenIdx: index('alert_correlation_groups_org_status_seen_idx').on(table.orgId, table.status, table.lastSeenAt),
  rootAlertIdx: index('alert_correlation_groups_root_alert_idx').on(table.rootAlertId)
}));

export const alertCorrelationMembers = pgTable('alert_correlation_members', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  groupId: uuid('group_id').notNull().references(() => alertCorrelationGroups.id, { onDelete: 'cascade' }),
  alertId: uuid('alert_id').notNull().references(() => alerts.id, { onDelete: 'cascade' }),
  role: varchar('role', { length: 40 }).notNull().default('related'),
  confidence: numeric('confidence', { precision: 3, scale: 2 }),
  evidence: jsonb('evidence').notNull().default({}),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
}, (table) => ({
  groupAlertUniq: uniqueIndex('alert_correlation_members_group_alert_uq').on(table.groupId, table.alertId),
  orgAlertIdx: index('alert_correlation_members_org_alert_idx').on(table.orgId, table.alertId),
  orgGroupIdx: index('alert_correlation_members_org_group_idx').on(table.orgId, table.groupId)
}));

// Delivery rails (#2131 sibling, issue #2130): a channel / routing rule /
// escalation policy is owned by EITHER an org (orgId set, partnerId NULL —
// the original shape) OR a partner (partnerId set, orgId NULL — "partner-wide
// / all orgs", epic #2135). Exactly one axis per row; CHECK constraints
// `*_one_owner_chk` (migration 2026-07-01) enforce it. alert_notifications
// stay alert-join (the alert's org) and are unchanged.
export const notificationChannels = pgTable('notification_channels', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').references(() => organizations.id),
  partnerId: uuid('partner_id').references(() => partners.id),
  name: varchar('name', { length: 255 }).notNull(),
  type: notificationChannelTypeEnum('type').notNull(),
  // `config` (destination + secrets) is READ from notificationChannelConfigs
  // below, NOT from this row (#6379): an org session can read a partner-wide
  // channel row through the SELECT-only partner-wide branch, and RLS cannot hide
  // a column. The legacy `config` column still exists in the database (nullable)
  // for one release so an image rollback keeps delivering; it is deliberately
  // NOT declared here so no select()/returning() on this table can read it. It
  // is written only through a module-private view in
  // services/notificationChannelConfig.ts and is dropped by the contract step
  // (follow-up to #6379). Guard: notificationChannelLegacyConfig.test.ts.
  templates: jsonb('templates').default({}),
  enabled: boolean('enabled').notNull().default(true),
  lastTestedAt: timestamp('last_tested_at', { withTimezone: true }),
  lastTestStatus: varchar('last_test_status', { length: 16 }),
  // Why the last test failed (#3697). NULL when the last test passed or the
  // channel was never tested — a stale reason under a green verdict would be
  // worse than none. Secret-scrubbed and length-capped before write: provider
  // errors can echo back the destination, and for slack/teams/webhook the
  // destination URL *is* the credential (see notificationChannelSecrets.ts).
  lastTestError: text('last_test_error'),
  // Feature #4: per-channel sliding-window throttle. NULL = unlimited.
  throttleMaxPerWindow: integer('throttle_max_per_window'),
  throttleWindowSeconds: integer('throttle_window_seconds').default(3600),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
}, (table) => ({
  partnerIdIdx: index('notification_channels_partner_id_idx').on(table.partnerId),
}));

/**
 * A channel's destination/secret config (#6379), one row per channel.
 *
 * Split off `notification_channels` so config confidentiality is enforced by
 * the database, not only by API redaction. The RLS policy
 * (2026-10-31-101100-notification-channel-configs.sql) is parent OWNERSHIP —
 * system, OR org access to the parent's org_id, OR partner access to the
 * parent's partner_id — and deliberately does NOT mirror the parent's
 * SELECT-only partner-wide branch. So an org session sees an inherited
 * partner-wide channel's name/type, but never its config.
 *
 * Secret fields inside `config` stay sealed under the AAD tag
 * `notification_channels.config` (the column's historical home), see
 * notificationChannelSecrets.ts and encryptedColumnRegistry.ts.
 *
 * Every channel is written with its config row in the same transaction
 * (services/notificationChannelConfig.ts), which also mirrors the value into the
 * legacy parent column until the contract step drops it. No org_id: it reaches its tenant
 * through the parent and is removed by the parent's ON DELETE CASCADE.
 */
export const notificationChannelConfigs = pgTable('notification_channel_configs', {
  channelId: uuid('channel_id')
    .primaryKey()
    .references(() => notificationChannels.id, { onDelete: 'cascade' }),
  config: jsonb('config').notNull(),
});

/** Evaluated by services/delivery/resolveDelivery.ts. Unknown keys are ignored. */
export interface RoutingRuleConditions {
  severities?: string[];
  monitorKinds?: string[];
  siteIds?: string[];
}

export const notificationRoutingRules = pgTable('notification_routing_rules', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').references(() => organizations.id),
  partnerId: uuid('partner_id').references(() => partners.id),
  name: varchar('name', { length: 255 }).notNull(),
  priority: integer('priority').notNull(),
  conditions: jsonb('conditions').notNull().$type<RoutingRuleConditions>(),
  channelIds: jsonb('channel_ids').notNull().$type<string[]>(),
  enabled: boolean('enabled').notNull().default(true),
  // W05b (alerting consolidation): the winning row may name an escalation
  // policy; one is_default "Everything else" row per axis replaces the
  // dispatcher's all-enabled-channels fallback (migration 2026-10-23-100000-delivery-routing-default-rows.sql).
  escalationPolicyId: uuid('escalation_policy_id').references(() => escalationPolicies.id, { onDelete: 'set null' }),
  isDefault: boolean('is_default').notNull().default(false),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
}, (table) => ({
  orgIdIdx: index('notification_routing_rules_org_id_idx').on(table.orgId),
  priorityIdx: index('notification_routing_rules_priority_idx').on(table.orgId, table.priority),
  partnerIdIdx: index('notification_routing_rules_partner_id_idx').on(table.partnerId),
  orgDefaultUidx: uniqueIndex('notification_routing_rules_org_default_uidx')
    .on(table.orgId)
    .where(sql`${table.isDefault} AND ${table.partnerId} IS NULL`),
  partnerDefaultUidx: uniqueIndex('notification_routing_rules_partner_default_uidx')
    .on(table.partnerId)
    .where(sql`${table.isDefault} AND ${table.orgId} IS NULL`),
}));

export const escalationPolicies = pgTable('escalation_policies', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').references(() => organizations.id),
  partnerId: uuid('partner_id').references(() => partners.id),
  name: varchar('name', { length: 255 }).notNull(),
  steps: jsonb('steps').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
}, (table) => ({
  partnerIdIdx: index('escalation_policies_partner_id_idx').on(table.partnerId),
}));

// Send identity (wave 3.5c, #4085): a send is uniquely identified by
// (alertId, channelId, escalationStep) — step 0 is the baseline fan-out, 1..N
// are escalation waves (scheduleEscalation, notificationDispatcher.ts). The
// unique index backs a claim-style state machine in processSendNotification:
// insert-onConflictDoNothing on this triple, then either skip (already
// 'sent') or reclaim the existing row for a retry. No org_id column — tenant
// scope is derived transitively via alertId, so this table needs no cascade/
// export registration of its own. It DOES have RLS: FORCE ROW LEVEL SECURITY
// with EXISTS-join policies over alerts.org_id (migration
// 2026-05-30-fk-child-tables-rls.sql), registered as an alert-join table in
// rls-coverage.integration.test.ts — "no org_id column" is not "no RLS".
export const alertNotifications = pgTable('alert_notifications', {
  id: uuid('id').primaryKey().defaultRandom(),
  alertId: uuid('alert_id').notNull().references(() => alerts.id),
  channelId: uuid('channel_id').notNull().references(() => notificationChannels.id),
  escalationStep: integer('escalation_step').notNull().default(0),
  status: varchar('status', { length: 20 }).notNull().default('pending'),
  sentAt: timestamp('sent_at'),
  errorMessage: text('error_message'),
  createdAt: timestamp('created_at').defaultNow().notNull()
}, (table) => ({
  sendIdentityUniq: uniqueIndex('alert_notifications_send_identity_uq')
    .on(table.alertId, table.channelId, table.escalationStep)
}));
