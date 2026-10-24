import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { devices } from './devices';
import { organizations } from './orgs';
import { softwarePolicies } from './softwarePolicies';

/** Vendors a status row may name. Mirrors the registry (`services/securityAgents/securityAgentVendors.ts`). */
export const SECURITY_AGENT_STATUS_VENDORS = ['huntress', 'sentinelone', 'controld', 'nextdns'] as const;
export type SecurityAgentStatusVendor = (typeof SECURITY_AGENT_STATUS_VENDORS)[number];

export const SECURITY_AGENT_COVERAGE_STATES = [
  'covered',
  'gap',
  'vendor_only',
  'vendor_offline',
  'mismatched_org',
  'not_applicable',
  'pending',
] as const;
export type SecurityAgentCoverageState = (typeof SECURITY_AGENT_COVERAGE_STATES)[number];

/**
 * Persisted per-(device, vendor) coverage state for managed security agents
 * (#6960, W03). Derived observed state, not config: `org_id` is the DEVICE's
 * org (never the policy owner's). RLS shape 1.
 *
 * Writers: the software compliance worker (`not_applicable` ↔ `pending`) and
 * the coverage reconciler (everything else, plus `vendor_only` rows with a
 * NULL device). The prior state is what gap/mismatch alerts fire on, so it is
 * load-bearing.
 *
 * The composite (device_id, org_id) FK is DEFERRABLE INITIALLY IMMEDIATE in the
 * migration (org merge defers constraints); Drizzle's foreignKey() builder
 * cannot express that, so the migration is authoritative.
 *
 * NO jsonb/bytea columns: a new column must be classified in
 * CORE_TENANT_EXPORT_POLICY in the same PR.
 */
export const securityAgentDeviceStatus = pgTable('security_agent_device_status', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  /** NULL only for `vendor_only` rows. */
  deviceId: uuid('device_id'),
  /** Breeze-side id of the vendor endpoint row (huntress_agents.id today). */
  vendorEndpointId: varchar('vendor_endpoint_id', { length: 128 }),
  vendor: varchar('vendor', { length: 32 }).$type<SecurityAgentStatusVendor>().notNull(),
  state: varchar('state', { length: 24 }).$type<SecurityAgentCoverageState>().notNull(),
  reasonCode: varchar('reason_code', { length: 48 }),
  detail: text('detail'),
  policyId: uuid('policy_id').references(() => softwarePolicies.id, { onDelete: 'set null' }),
  lastEvaluatedAt: timestamp('last_evaluated_at', { withTimezone: true }).notNull().defaultNow(),
  stateChangedAt: timestamp('state_changed_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  foreignKey({
    columns: [table.deviceId, table.orgId],
    foreignColumns: [devices.id, devices.orgId],
    name: 'security_agent_device_status_device_org_fk',
  }).onUpdate('cascade').onDelete('cascade'),
  uniqueIndex('security_agent_device_status_device_vendor_uidx')
    .on(table.deviceId, table.vendor)
    .where(sql`${table.deviceId} IS NOT NULL`),
  uniqueIndex('security_agent_device_status_vendor_only_uidx')
    .on(table.orgId, table.vendor, table.vendorEndpointId)
    .where(sql`${table.deviceId} IS NULL`),
  index('security_agent_device_status_org_state_idx').on(table.orgId, table.vendor, table.state),
  index('security_agent_device_status_policy_idx')
    .on(table.policyId)
    .where(sql`${table.policyId} IS NOT NULL`),
  check(
    'security_agent_device_status_vendor_chk',
    sql`${table.vendor} IN ('huntress', 'sentinelone', 'controld', 'nextdns')`,
  ),
  check(
    'security_agent_device_status_state_chk',
    sql`${table.state} IN ('covered', 'gap', 'vendor_only', 'vendor_offline', 'mismatched_org', 'not_applicable', 'pending')`,
  ),
  check(
    'security_agent_device_status_shape_chk',
    sql`((${table.deviceId} IS NULL) = (${table.state} = 'vendor_only')) AND (${table.deviceId} IS NOT NULL OR ${table.vendorEndpointId} IS NOT NULL)`,
  ),
]);

export type SecurityAgentDeviceStatus = typeof securityAgentDeviceStatus.$inferSelect;
export type NewSecurityAgentDeviceStatus = typeof securityAgentDeviceStatus.$inferInsert;
