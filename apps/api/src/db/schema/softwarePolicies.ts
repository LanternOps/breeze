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
} from 'drizzle-orm/pg-core';
import { organizations } from './orgs';
import { users } from './users';
import { devices } from './devices';

export const softwarePolicyModeEnum = pgEnum('software_policy_mode', [
  'allowlist',
  'blocklist',
  'audit',
]);

export type SoftwarePolicyRuleDefinition = {
  name: string;
  vendor?: string;
  minVersion?: string;
  maxVersion?: string;
  catalogId?: string;
  reason?: string;
};

export type SoftwarePolicyRulesDefinition = {
  software: SoftwarePolicyRuleDefinition[];
  allowUnknown?: boolean;
};

export type SoftwarePolicyViolation = {
  type: 'unauthorized' | 'missing'; // 'outdated' planned but not yet emitted
  software?: {
    name: string;
    version?: string | null;
    vendor?: string | null;
  };
  rule?: {
    name: string;
    minVersion?: string;
    maxVersion?: string;
    reason?: string;
  };
  severity: 'low' | 'medium' | 'high' | 'critical';
  detectedAt: string;
};

export type SoftwarePolicyRemediationOptions = {
  autoUninstall?: boolean;
  notifyUser?: boolean; // not yet implemented
  gracePeriod?: number; // hours; max 90 days
  cooldownMinutes?: number;
  maintenanceWindowOnly?: boolean; // not yet implemented
};

export type RemediationError = {
  softwareName?: string;
  message: string;
};

export const softwarePolicies = pgTable('software_policies', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  name: varchar('name', { length: 200 }).notNull(),
  description: text('description'),
  mode: softwarePolicyModeEnum('mode').notNull(),
  rules: jsonb('rules').notNull().$type<SoftwarePolicyRulesDefinition>(),
  targetType: varchar('target_type', { length: 50 }),
  targetIds: jsonb('target_ids').$type<string[]>(),
  priority: integer('priority').notNull().default(50),
  isActive: boolean('is_active').notNull().default(true),
  enforceMode: boolean('enforce_mode').notNull().default(false),
  remediationOptions: jsonb('remediation_options').$type<SoftwarePolicyRemediationOptions>(),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  orgIdIdx: index('software_policies_org_id_idx').on(table.orgId),
  targetTypeIdx: index('software_policies_target_type_idx').on(table.targetType),
  activePriorityIdx: index('software_policies_active_priority_idx').on(table.isActive, table.priority),
}));

export const softwareComplianceStatus = pgTable('software_compliance_status', {
  id: uuid('id').primaryKey().defaultRandom(),
  deviceId: uuid('device_id').notNull().references(() => devices.id),
  policyId: uuid('policy_id').notNull().references(() => softwarePolicies.id, { onDelete: 'cascade' }),
  status: varchar('status', { length: 20 }).notNull().default('compliant'),
  lastChecked: timestamp('last_checked').notNull(),
  violations: jsonb('violations').$type<SoftwarePolicyViolation[]>(),
  remediationStatus: varchar('remediation_status', { length: 20 }).default('none'),
  lastRemediationAttempt: timestamp('last_remediation_attempt'),
  remediationErrors: jsonb('remediation_errors').$type<RemediationError[]>(),
}, (table) => ({
  deviceIdIdx: index('software_compliance_device_id_idx').on(table.deviceId),
  policyIdIdx: index('software_compliance_policy_id_idx').on(table.policyId),
  statusIdx: index('software_compliance_status_idx').on(table.status),
  devicePolicyUnique: uniqueIndex('software_compliance_device_policy_unique').on(table.deviceId, table.policyId),
}));

export const softwarePolicyAudit = pgTable('software_policy_audit', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  policyId: uuid('policy_id').references(() => softwarePolicies.id, { onDelete: 'set null' }),
  deviceId: uuid('device_id').references(() => devices.id, { onDelete: 'set null' }),
  action: varchar('action', { length: 50 }).notNull(),
  actor: varchar('actor', { length: 50 }).notNull(),
  actorId: uuid('actor_id').references(() => users.id),
  details: jsonb('details'),
  timestamp: timestamp('timestamp').defaultNow().notNull(),
}, (table) => ({
  orgIdIdx: index('software_policy_audit_org_id_idx').on(table.orgId),
  policyIdIdx: index('software_policy_audit_policy_id_idx').on(table.policyId),
  deviceIdIdx: index('software_policy_audit_device_id_idx').on(table.deviceId),
  timestampIdx: index('software_policy_audit_timestamp_idx').on(table.timestamp),
}));
