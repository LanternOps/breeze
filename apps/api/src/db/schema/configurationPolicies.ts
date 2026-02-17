import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  jsonb,
  pgEnum,
  integer,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { organizations } from './orgs';
import { users } from './users';

export const configPolicyStatusEnum = pgEnum('config_policy_status', [
  'active',
  'inactive',
  'archived',
]);

export const configFeatureTypeEnum = pgEnum('config_feature_type', [
  'patch',
  'alert_rule',
  'backup',
  'security',
  'monitoring',
  'maintenance',
  'compliance',
]);

export const configAssignmentLevelEnum = pgEnum('config_assignment_level', [
  'partner',
  'organization',
  'site',
  'device_group',
  'device',
]);

export const configurationPolicies = pgTable('configuration_policies', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  status: configPolicyStatusEnum('status').notNull().default('active'),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  orgIdIdx: index('config_policies_org_id_idx').on(table.orgId),
  statusIdx: index('config_policies_status_idx').on(table.status),
}));

export const configPolicyFeatureLinks = pgTable('config_policy_feature_links', {
  id: uuid('id').primaryKey().defaultRandom(),
  configPolicyId: uuid('config_policy_id').notNull().references(() => configurationPolicies.id, { onDelete: 'cascade' }),
  featureType: configFeatureTypeEnum('feature_type').notNull(),
  featurePolicyId: uuid('feature_policy_id'),
  inlineSettings: jsonb('inline_settings'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  configPolicyIdIdx: index('config_feature_links_policy_id_idx').on(table.configPolicyId),
  featureTypeIdx: index('config_feature_links_feature_type_idx').on(table.featureType),
  uniqueFeaturePerPolicy: uniqueIndex('config_feature_links_unique').on(table.configPolicyId, table.featureType),
}));

export const configPolicyAssignments = pgTable('config_policy_assignments', {
  id: uuid('id').primaryKey().defaultRandom(),
  configPolicyId: uuid('config_policy_id').notNull().references(() => configurationPolicies.id, { onDelete: 'cascade' }),
  level: configAssignmentLevelEnum('level').notNull(),
  targetId: uuid('target_id').notNull(),
  priority: integer('priority').notNull().default(0),
  assignedBy: uuid('assigned_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  configPolicyIdIdx: index('config_assignments_policy_id_idx').on(table.configPolicyId),
  levelTargetIdx: index('config_assignments_level_target_idx').on(table.level, table.targetId),
  uniqueAssignment: uniqueIndex('config_assignments_unique').on(table.configPolicyId, table.level, table.targetId),
}));
