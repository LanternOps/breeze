import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  jsonb,
  pgEnum,
  integer,
  boolean,
  index,
  type AnyPgColumn
} from 'drizzle-orm/pg-core';
import { organizations } from './orgs';
import { users } from './users';
import { devices } from './devices';

export const policyTypeEnum = pgEnum('policy_type', [
  'monitoring',
  'patching',
  'security',
  'backup',
  'maintenance',
  'software',
  'alert',
  'custom'
]);

export const policyStatusEnum = pgEnum('policy_status', [
  'draft',
  'active',
  'inactive',
  'archived'
]);

export const policies = pgTable('policies', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  name: varchar('name', { length: 200 }).notNull(),
  description: text('description'),
  type: policyTypeEnum('type').notNull(),
  status: policyStatusEnum('status').notNull().default('draft'),
  priority: integer('priority').notNull().default(50),
  settings: jsonb('settings').notNull(),
  conditions: jsonb('conditions'),
  version: integer('version').notNull().default(1),
  parentId: uuid('parent_id').references((): AnyPgColumn => policies.id),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
}, (table) => ({
  orgIdIdx: index('policies_org_id_idx').on(table.orgId),
  typeIdx: index('policies_type_idx').on(table.type),
  statusIdx: index('policies_status_idx').on(table.status)
}));

export const policyVersions = pgTable('policy_versions', {
  id: uuid('id').primaryKey().defaultRandom(),
  policyId: uuid('policy_id').notNull().references(() => policies.id),
  version: integer('version').notNull(),
  settings: jsonb('settings').notNull(),
  conditions: jsonb('conditions'),
  changelog: text('changelog'),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull()
}, (table) => ({
  policyIdIdx: index('policy_versions_policy_id_idx').on(table.policyId)
}));

export const policyAssignments = pgTable('policy_assignments', {
  id: uuid('id').primaryKey().defaultRandom(),
  policyId: uuid('policy_id').notNull().references(() => policies.id),
  targetType: varchar('target_type', { length: 50 }).notNull(),
  targetId: uuid('target_id').notNull(),
  priority: integer('priority').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull()
}, (table) => ({
  policyIdIdx: index('policy_assignments_policy_id_idx').on(table.policyId)
}));

export const policyTemplates = pgTable('policy_templates', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 200 }).notNull(),
  description: text('description'),
  type: policyTypeEnum('type').notNull(),
  category: varchar('category', { length: 100 }),
  settings: jsonb('settings').notNull(),
  isBuiltIn: boolean('is_built_in').notNull().default(false),
  usageCount: integer('usage_count').notNull().default(0)
});

export const policyCompliance = pgTable('policy_compliance', {
  id: uuid('id').primaryKey().defaultRandom(),
  policyId: uuid('policy_id').notNull().references(() => policies.id),
  deviceId: uuid('device_id').notNull().references(() => devices.id),
  status: varchar('status', { length: 20 }).notNull().default('pending'),
  lastChecked: timestamp('last_checked'),
  details: jsonb('details'),
  remediationAttempts: integer('remediation_attempts').notNull().default(0)
}, (table) => ({
  policyIdIdx: index('policy_compliance_policy_id_idx').on(table.policyId),
  deviceIdIdx: index('policy_compliance_device_id_idx').on(table.deviceId)
}));
