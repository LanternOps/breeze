import {
  boolean,
  char,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { organizations } from './orgs';

/**
 * M365 tenant sync snapshot tables (spec
 * docs/superpowers/specs/integrations/2026-09-08-m365-tenant-sync-foundation-design.md §3).
 *
 * Tenancy shape 1 throughout: direct `org_id NOT NULL`, RLS enabled + forced
 * with one FOR ALL `breeze_has_org_access(org_id)` policy per table, all
 * declared in `migrations/2026-10-16-170200-m365-tenant-sync-foundation.sql`.
 *
 * The two composite tenant FKs — `(connection_id, org_id) -> m365_connections(id, org_id)`
 * and `(breeze_device_id, org_id) -> devices(id, org_id)`, both DEFERRABLE
 * INITIALLY IMMEDIATE — are declared in SQL ONLY. Drizzle cannot express a
 * multi-column FK on a table definition; the static contract tests read column
 * *names*, which are present here. Same treatment as `manualAssets.ts`.
 */

export const m365SyncDomainEnum = pgEnum('m365_sync_domain', [
  'users',
  'signin_activity',
  'intune_devices',
  'ca_policies',
  'skus',
  'secure_score',
  'signin_events',
]);

export const m365SyncStatusEnum = pgEnum('m365_sync_status', [
  'success',
  'partial',
  'needs_consent',
  'throttled',
  'error',
]);

export const m365SyncState = pgTable(
  'm365_sync_state',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    connectionId: uuid('connection_id').notNull(),
    domain: m365SyncDomainEnum('domain').notNull(),
    /** Ticker due time. NULL = unscheduled (needs_consent, disconnected). */
    nextSyncAt: timestamp('next_sync_at', { withTimezone: true }),
    intervalSeconds: integer('interval_seconds').notNull(),
    /** Incremented on every claim; fences a late Phase-C persist. */
    runGeneration: integer('run_generation').notNull().default(0),
    leaseUntil: timestamp('lease_until', { withTimezone: true }),
    /** Opaque, executor-encrypted, tenant-bound. Never parsed API-side. */
    continuation: text('continuation'),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
    /** Last untruncated, primary-source-successful run; gates stale marking. */
    lastCompleteSnapshotAt: timestamp('last_complete_snapshot_at', { withTimezone: true }),
    lastStatus: m365SyncStatusEnum('last_status'),
    /** Sanitized code + message. Never row content. */
    lastError: text('last_error'),
    lastItemCount: integer('last_item_count'),
    truncated: boolean('truncated').notNull().default(false),
    sources: jsonb('sources').$type<Record<string, string>>(),
    lastCounts: jsonb('last_counts').$type<Record<string, number>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgDomainUniq: uniqueIndex('m365_sync_state_org_domain_uniq').on(table.orgId, table.domain),
    connectionIdx: index('m365_sync_state_connection_idx').on(table.connectionId),
  }),
);

export const m365Users = pgTable(
  'm365_users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    graphId: varchar('graph_id', { length: 64 }).notNull(),
    coreHash: char('core_hash', { length: 64 }).notNull(),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastChangedAt: timestamp('last_changed_at', { withTimezone: true }).notNull().defaultNow(),
    isStale: boolean('is_stale').notNull().default(false),
    staleSince: timestamp('stale_since', { withTimezone: true }),
    userPrincipalName: varchar('user_principal_name', { length: 320 }),
    displayName: varchar('display_name', { length: 255 }),
    mail: varchar('mail', { length: 320 }),
    accountEnabled: boolean('account_enabled'),
    jobTitle: varchar('job_title', { length: 255 }),
    department: varchar('department', { length: 255 }),
    usageLocation: varchar('usage_location', { length: 8 }),
    onPremisesSyncEnabled: boolean('on_premises_sync_enabled'),
    graphCreatedAt: timestamp('graph_created_at', { withTimezone: true }),
    assignedSkuIds: jsonb('assigned_sku_ids').$type<string[]>(),
    // NULL means "unknown / source unavailable", never "false".
    mfaRegistered: boolean('mfa_registered'),
    mfaCapable: boolean('mfa_capable'),
    defaultMfaMethod: varchar('default_mfa_method', { length: 64 }),
    adminRoles: jsonb('admin_roles').$type<
      Array<{ roleTemplateId: string; displayName: string; viaGroupId?: string }>
    >(),
    isAdmin: boolean('is_admin'),
    lastSuccessfulSignInAt: timestamp('last_successful_sign_in_at', { withTimezone: true }),
  },
  (table) => ({
    orgGraphUniq: uniqueIndex('m365_users_org_graph_uniq').on(table.orgId, table.graphId),
    orgStaleIdx: index('m365_users_org_stale_idx').on(table.orgId, table.isStale),
    orgUpnIdx: index('m365_users_org_upn_idx').on(table.orgId, table.userPrincipalName),
  }),
);

export const m365IntuneDevices = pgTable(
  'm365_intune_devices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    graphId: varchar('graph_id', { length: 64 }).notNull(),
    coreHash: char('core_hash', { length: 64 }).notNull(),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastChangedAt: timestamp('last_changed_at', { withTimezone: true }).notNull().defaultNow(),
    isStale: boolean('is_stale').notNull().default(false),
    staleSince: timestamp('stale_since', { withTimezone: true }),
    deviceName: varchar('device_name', { length: 255 }),
    operatingSystem: varchar('operating_system', { length: 64 }),
    osVersion: varchar('os_version', { length: 64 }),
    complianceState: varchar('compliance_state', { length: 64 }),
    lastIntuneSyncAt: timestamp('last_intune_sync_at', { withTimezone: true }),
    userPrincipalName: varchar('user_principal_name', { length: 320 }),
    ownerType: varchar('owner_type', { length: 64 }),
    enrolledAt: timestamp('enrolled_at', { withTimezone: true }),
    model: varchar('model', { length: 255 }),
    manufacturer: varchar('manufacturer', { length: 255 }),
    serialNumber: varchar('serial_number', { length: 255 }),
    azureAdDeviceId: varchar('azure_ad_device_id', { length: 64 }),
    managementAgent: varchar('management_agent', { length: 64 }),
    jailBroken: varchar('jail_broken', { length: 32 }),
    /**
     * Link, not ownership. Named `breeze_device_id` on purpose: `device_id`
     * would enrol the table in `breeze_device_child_orgid_tables()` (a generic
     * `SET org_id` re-stamp loop) and in `cascadeDelete.test.ts`'s device_id
     * contract, both wrong for a link column whose FK is ON DELETE SET NULL.
     */
    breezeDeviceId: uuid('breeze_device_id'),
  },
  (table) => ({
    orgGraphUniq: uniqueIndex('m365_intune_devices_org_graph_uniq').on(table.orgId, table.graphId),
    orgStaleIdx: index('m365_intune_devices_org_stale_idx').on(table.orgId, table.isStale),
    orgSerialIdx: index('m365_intune_devices_org_serial_idx').on(table.orgId, table.serialNumber),
    orgBreezeDeviceIdx: index('m365_intune_devices_org_breeze_device_idx').on(
      table.orgId,
      table.breezeDeviceId,
    ),
  }),
);

export const m365CaPolicies = pgTable(
  'm365_ca_policies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    graphId: varchar('graph_id', { length: 64 }).notNull(),
    coreHash: char('core_hash', { length: 64 }).notNull(),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastChangedAt: timestamp('last_changed_at', { withTimezone: true }).notNull().defaultNow(),
    isStale: boolean('is_stale').notNull().default(false),
    staleSince: timestamp('stale_since', { withTimezone: true }),
    displayName: varchar('display_name', { length: 255 }),
    state: varchar('state', { length: 64 }),
    graphCreatedAt: timestamp('graph_created_at', { withTimezone: true }),
    graphModifiedAt: timestamp('graph_modified_at', { withTimezone: true }),
    conditions: jsonb('conditions'),
    grantControls: jsonb('grant_controls'),
    sessionControls: jsonb('session_controls'),
    /** state + conditions + grant + session: a rename is not a policy change. */
    definitionHash: char('definition_hash', { length: 64 }).notNull(),
  },
  (table) => ({
    orgGraphUniq: uniqueIndex('m365_ca_policies_org_graph_uniq').on(table.orgId, table.graphId),
    orgStaleIdx: index('m365_ca_policies_org_stale_idx').on(table.orgId, table.isStale),
  }),
);

export const m365LicenseSkus = pgTable(
  'm365_license_skus',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    /** The subscribedSku skuId GUID. Named graph_id for one shared persist path. */
    graphId: varchar('graph_id', { length: 64 }).notNull(),
    coreHash: char('core_hash', { length: 64 }).notNull(),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastChangedAt: timestamp('last_changed_at', { withTimezone: true }).notNull().defaultNow(),
    isStale: boolean('is_stale').notNull().default(false),
    staleSince: timestamp('stale_since', { withTimezone: true }),
    skuPartNumber: varchar('sku_part_number', { length: 128 }),
    consumedUnits: integer('consumed_units'),
    prepaidEnabled: integer('prepaid_enabled'),
    prepaidSuspended: integer('prepaid_suspended'),
    prepaidWarning: integer('prepaid_warning'),
    capabilityStatus: varchar('capability_status', { length: 64 }),
    appliesTo: varchar('applies_to', { length: 64 }),
  },
  (table) => ({
    orgGraphUniq: uniqueIndex('m365_license_skus_org_graph_uniq').on(table.orgId, table.graphId),
    orgStaleIdx: index('m365_license_skus_org_stale_idx').on(table.orgId, table.isStale),
  }),
);

export const m365SecureScoreSnapshots = pgTable(
  'm365_secure_score_snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    /** The verified M365 tenant this row came from; history survives a rebind. */
    tenantId: uuid('tenant_id').notNull(),
    /** Date of Graph's createdDateTime on the score, NOT the fetch day. */
    scoreDate: date('score_date').notNull(),
    currentScore: numeric('current_score', { precision: 8, scale: 2 }),
    maxScore: numeric('max_score', { precision: 8, scale: 2 }),
    activeUserCount: integer('active_user_count'),
    licensedUserCount: integer('licensed_user_count'),
    controlScores: jsonb('control_scores').$type<
      Array<{ controlName: string; title: string | null; score: number; maxScore: number; implementationStatus: string }>
    >(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgDateUniq: uniqueIndex('m365_secure_score_snapshots_org_date_uniq').on(
      table.orgId,
      table.scoreDate,
    ),
  }),
);

export const m365PostureRollups = pgTable(
  'm365_posture_rollups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    tenantId: uuid('tenant_id').notNull(),
    rollupDate: date('rollup_date').notNull(),
    usersTotal: integer('users_total'),
    usersEnabled: integer('users_enabled'),
    usersMfaRegistered: integer('users_mfa_registered'),
    /** "unknown" counters keep partial enrichment from reading as "not registered". */
    usersMfaUnknown: integer('users_mfa_unknown'),
    usersAdmin: integer('users_admin'),
    adminsWithoutMfa: integer('admins_without_mfa'),
    adminsMfaUnknown: integer('admins_mfa_unknown'),
    devicesTotal: integer('devices_total'),
    devicesCompliant: integer('devices_compliant'),
    devicesNoncompliant: integer('devices_noncompliant'),
    devicesInGrace: integer('devices_in_grace'),
    devicesUnknown: integer('devices_unknown'),
    caPoliciesEnabled: integer('ca_policies_enabled'),
    caPoliciesReportOnly: integer('ca_policies_report_only'),
    caPoliciesDisabled: integer('ca_policies_disabled'),
    seatsPurchased: integer('seats_purchased'),
    seatsConsumed: integer('seats_consumed'),
    secureScore: numeric('secure_score', { precision: 8, scale: 2 }),
    secureScoreMax: numeric('secure_score_max', { precision: 8, scale: 2 }),
    domainsFresh: jsonb('domains_fresh').$type<Record<string, { asOf: string; complete: boolean }>>(),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgDateUniq: uniqueIndex('m365_posture_rollups_org_date_uniq').on(table.orgId, table.rollupDate),
  }),
);

/**
 * #5784 W05. Interactive Microsoft 365 sign-ins, append-only.
 *
 * NOT an entity domain: there is no core_hash, no is_stale and no stale_since,
 * and inventory-style "unseen means stale" reconciliation must never be applied
 * — marking an unreturned row stale would corrupt a closed reporting period.
 * Writes are idempotent upserts on (org_id, graph_id); the delta window
 * deliberately overlaps because Graph sign-in records surface with delay.
 *
 * No jsonb by design: the raw Graph payload stays out so nothing lands in the
 * excludedOpen export bucket and sign-in PII is exactly the fields the report
 * renders. No connection_id by design: connection identity lives in
 * m365_sync_state, and omitting it removes the composite-FK direction question.
 */
export const m365SigninEvents = pgTable(
  'm365_signin_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    /** The verified M365 tenant this row came from; history survives a rebind. */
    tenantId: uuid('tenant_id').notNull(),
    /** Graph signIn.id. (org_id, graph_id) is what makes re-sync idempotent. */
    graphId: text('graph_id').notNull(),
    /** Graph createdDateTime — the EVENT time, and the delta watermark. */
    signedInAt: timestamp('signed_in_at', { withTimezone: true }).notNull(),
    /** Stable id kept alongside the UPN, which is renameable. */
    userGraphId: text('user_graph_id'),
    userPrincipalName: text('user_principal_name'),
    /** Stable app id alongside the display name. */
    appId: text('app_id'),
    appDisplayName: text('app_display_name'),
    /** Legacy-auth detection. */
    clientAppUsed: text('client_app_used'),
    ipAddress: text('ip_address'),
    locationCity: text('location_city'),
    locationCountry: text('location_country'),
    /** success / failure / notApplied. */
    conditionalAccessStatus: text('conditional_access_status'),
    statusErrorCode: integer('status_error_code'),
    statusFailureReason: text('status_failure_reason'),
    /**
     * From the signIn resource under AuditLog.Read.All — NOT Identity
     * Protection, which would be a manifest v4 bump. Can come back as Graph's
     * `hidden` sentinel without P2; the report renders that as unmeasured.
     */
    riskLevelAggregated: text('risk_level_aggregated'),
    riskState: text('risk_state'),
    isInteractive: boolean('is_interactive'),
    /** Separate from signed_in_at so late arrivals are detectable. */
    ingestedAt: timestamp('ingested_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgGraphUniq: uniqueIndex('m365_signin_events_org_graph_uniq').on(table.orgId, table.graphId),
    orgSignedInIdx: index('m365_signin_events_org_signed_in_idx').on(table.orgId, table.signedInAt),
  }),
);

export type M365SigninEventRow = typeof m365SigninEvents.$inferSelect;
export type NewM365SigninEventRow = typeof m365SigninEvents.$inferInsert;

export type M365SyncStateRow = typeof m365SyncState.$inferSelect;
export type NewM365SyncStateRow = typeof m365SyncState.$inferInsert;
export type M365UserRow = typeof m365Users.$inferSelect;
export type NewM365UserRow = typeof m365Users.$inferInsert;
export type M365IntuneDeviceRow = typeof m365IntuneDevices.$inferSelect;
export type NewM365IntuneDeviceRow = typeof m365IntuneDevices.$inferInsert;
export type M365CaPolicyRow = typeof m365CaPolicies.$inferSelect;
export type NewM365CaPolicyRow = typeof m365CaPolicies.$inferInsert;
export type M365LicenseSkuRow = typeof m365LicenseSkus.$inferSelect;
export type NewM365LicenseSkuRow = typeof m365LicenseSkus.$inferInsert;
export type M365SecureScoreSnapshotRow = typeof m365SecureScoreSnapshots.$inferSelect;
export type NewM365SecureScoreSnapshotRow = typeof m365SecureScoreSnapshots.$inferInsert;
export type M365PostureRollupRow = typeof m365PostureRollups.$inferSelect;
export type NewM365PostureRollupRow = typeof m365PostureRollups.$inferInsert;
