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
import { organizations, partners } from './orgs';
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

export type SoftwarePolicyExecutableRule = {
  name: string;
  sha256?: string;
  signer?: string;
  publisher?: string;
  pathGlob?: string;
};

export type SoftwarePolicyRulesDefinition = {
  software: SoftwarePolicyRuleDefinition[];
  allowUnknown?: boolean;
  executable?: SoftwarePolicyExecutableRule[];
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

// A software policy is owned by EITHER an org (orgId set, partnerId NULL — the
// original shape) OR a partner (partnerId set, orgId NULL — "partner-wide /
// all orgs" template, epic #2135 / #2126). Exactly one axis is set per row;
// the CHECK constraint `software_policies_one_owner_chk` (migration
// 2026-07-01) enforces it. Mirrors configuration_policies (#1724).
export const softwarePolicies = pgTable('software_policies', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').references(() => organizations.id),
  partnerId: uuid('partner_id').references(() => partners.id),
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
  partnerIdIdx: index('software_policies_partner_id_idx').on(table.partnerId),
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

// Audit rows are dual-owned but NOT XOR (unlike the policy table): an event for
// a partner-wide policy acting on a device carries BOTH the device's org_id
// (so the org admin sees it) and the policy's partner_id (so the partner admin
// sees it). Policy-level events with no device carry whichever axis owns the
// policy. CHECK `software_policy_audit_owner_chk` requires at least one axis.
export const softwarePolicyAudit = pgTable('software_policy_audit', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').references(() => organizations.id),
  partnerId: uuid('partner_id').references(() => partners.id),
  policyId: uuid('policy_id').references(() => softwarePolicies.id, { onDelete: 'set null' }),
  deviceId: uuid('device_id').references(() => devices.id, { onDelete: 'set null' }),
  action: varchar('action', { length: 50 }).notNull(),
  actor: varchar('actor', { length: 50 }).notNull(),
  actorId: uuid('actor_id').references(() => users.id),
  details: jsonb('details'),
  timestamp: timestamp('timestamp').defaultNow().notNull(),
}, (table) => ({
  orgIdIdx: index('software_policy_audit_org_id_idx').on(table.orgId),
  partnerIdIdx: index('software_policy_audit_partner_id_idx').on(table.partnerId),
  policyIdIdx: index('software_policy_audit_policy_id_idx').on(table.policyId),
  deviceIdIdx: index('software_policy_audit_device_id_idx').on(table.deviceId),
  timestampIdx: index('software_policy_audit_timestamp_idx').on(table.timestamp),
}));
