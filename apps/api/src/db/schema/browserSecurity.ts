import {
  boolean,
  index,
  jsonb,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar
} from 'drizzle-orm/pg-core';
import { devices } from './devices';
import { organizations } from './orgs';
import { users } from './users';

export const browserExtensions = pgTable('browser_extensions', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  deviceId: uuid('device_id').notNull().references(() => devices.id),
  browser: varchar('browser', { length: 20 }).notNull(),
  extensionId: varchar('extension_id', { length: 255 }).notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  version: varchar('version', { length: 80 }),
  source: varchar('source', { length: 30 }).notNull(),
  permissions: jsonb('permissions').$type<string[]>().notNull(),
  riskLevel: varchar('risk_level', { length: 20 }).notNull(),
  enabled: boolean('enabled').notNull().default(true),
  firstSeenAt: timestamp('first_seen_at').notNull(),
  lastSeenAt: timestamp('last_seen_at').notNull(),
}, (table) => ({
  orgDeviceIdx: index('browser_ext_org_device_idx').on(table.orgId, table.deviceId),
  extensionIdIdx: index('browser_ext_extension_id_idx').on(table.extensionId),
  riskLevelIdx: index('browser_ext_risk_level_idx').on(table.orgId, table.riskLevel),
  orgDeviceBrowserExtUniq: uniqueIndex('browser_ext_org_device_browser_ext_uniq').on(
    table.orgId, table.deviceId, table.browser, table.extensionId
  ),
}));

export const browserPolicies = pgTable('browser_policies', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  name: varchar('name', { length: 200 }).notNull(),
  allowedExtensions: jsonb('allowed_extensions').$type<string[]>(),
  blockedExtensions: jsonb('blocked_extensions').$type<string[]>(),
  requiredExtensions: jsonb('required_extensions').$type<string[]>(),
  settings: jsonb('settings').$type<Record<string, unknown>>(),
  targetType: varchar('target_type', { length: 30 }).notNull(),
  targetIds: jsonb('target_ids').$type<string[]>(),
  isActive: boolean('is_active').notNull().default(true),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  orgIdx: index('browser_policy_org_idx').on(table.orgId),
}));

export const browserPolicyViolations = pgTable('browser_policy_violations', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  deviceId: uuid('device_id').notNull().references(() => devices.id),
  policyId: uuid('policy_id').references(() => browserPolicies.id),
  violationType: varchar('violation_type', { length: 40 }).notNull(),
  details: jsonb('details').$type<Record<string, unknown>>().notNull(),
  detectedAt: timestamp('detected_at').notNull(),
  resolvedAt: timestamp('resolved_at'),
}, (table) => ({
  orgDeviceIdx: index('browser_policy_violations_org_device_idx').on(table.orgId, table.deviceId),
  policyIdx: index('browser_policy_violations_policy_idx').on(table.policyId),
  unresolvedIdx: index('browser_policy_violations_unresolved_idx').on(table.orgId, table.resolvedAt),
}));
