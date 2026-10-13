import { sql } from 'drizzle-orm';
import {
  bigint, boolean, check, cidr, foreignKey, index, inet, jsonb, macaddr, pgTable, text, timestamp, uniqueIndex, uuid, varchar,
} from 'drizzle-orm/pg-core';
import { organizations, sites } from './orgs';
import { devices } from './devices';

/**
 * Topology site location W2 (#7886): the presence read model (spec S§7.1,
 * docs/superpowers/specs/monitoring/2026-10-03-topology-site-location-design.md).
 * Derived runtime state, written only by the presence evaluator; RLS shape 1 on org_id.
 * Migration: 2026-12-25-140000-topology-presence-read-model.sql (SQL owns the
 * DEFERRABLE INITIALLY IMMEDIATE composite FKs, the triggers and the expression index).
 * Nothing that reads these tables may write devices.site_id: presence never moves a device.
 */

export type TopologyPresenceCoverage = 'complete' | 'limited' | 'not_configured';
export type TopologyFingerprintStatus = 'anchored' | 'unconfirmed' | 'ambiguous';
export type TopologyFingerprintGatewayMac = { mac: string; observerDeviceIds: string[]; lastConfirmedAt: string };
export type TopologyPresenceEvidence = {
  relationshipIds: string[]; observerNodeId: string; interfaceName: string | null; confirmedAt: string; freshUntil: string;
  prefix: string; gateway: string; classification: string; reason: string | null; siteId: string | null;
};

export const topologyOrgPresenceState = pgTable('topology_org_presence_state', {
  orgId: uuid('org_id').primaryKey().references(() => organizations.id, { onDelete: 'cascade' }),
  fingerprintVersion: bigint('fingerprint_version', { mode: 'bigint' }).notNull().default(0n),
  coverage: varchar('coverage', { length: 16 }).$type<TopologyPresenceCoverage>().notNull().default('not_configured'),
  coverageReason: varchar('coverage_reason', { length: 64 }),
  dirtyAt: timestamp('dirty_at', { withTimezone: true }),
  evaluatedAt: timestamp('evaluated_at', { withTimezone: true }),
  nextEvaluationAt: timestamp('next_evaluation_at', { withTimezone: true }),
  inputDigest: varchar('input_digest', { length: 64 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('topology_org_presence_state_due_idx').on(table.dirtyAt, table.nextEvaluationAt),
  check('topology_org_presence_state_fingerprint_version_check', sql`fingerprint_version >= 0`),
  check('topology_org_presence_state_coverage_check', sql`coverage IN ('complete', 'limited', 'not_configured')`),
]);

export const topologySiteFingerprints = pgTable('topology_site_fingerprints', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull(),
  siteId: uuid('site_id').notNull(),
  family: varchar('family', { length: 8 }).notNull().default('ipv4'),
  prefix: cidr('prefix').notNull(),
  gatewayAddress: inet('gateway_address'),
  status: varchar('status', { length: 16 }).$type<TopologyFingerprintStatus>().notNull(),
  consumerDefault: boolean('consumer_default').notNull().default(false),
  declaredBy: text('declared_by').array().notNull().default(sql`'{}'`),
  declarationIds: uuid('declaration_ids').array().notNull().default(sql`'{}'`),
  observerDeviceIds: uuid('observer_device_ids').array().notNull().default(sql`'{}'`),
  gatewayMacs: jsonb('gateway_macs').$type<TopologyFingerprintGatewayMac[]>().notNull().default([]),
  neighborCoverage: varchar('neighbor_coverage', { length: 16 }).$type<'complete' | 'limited'>().notNull().default('limited'),
  fingerprintVersion: bigint('fingerprint_version', { mode: 'bigint' }).notNull(),
  evaluatedAt: timestamp('evaluated_at', { withTimezone: true }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  foreignKey({ name: 'topology_site_fingerprints_site_fk', columns: [table.siteId, table.orgId], foreignColumns: [sites.id, sites.orgId] }).onDelete('cascade'),
  uniqueIndex('topology_site_fingerprints_key_uniq').on(table.orgId, table.siteId, table.prefix, sql`coalesce(${table.gatewayAddress}, '0.0.0.0'::inet)`),
  index('topology_site_fingerprints_org_prefix_idx').on(table.orgId, table.prefix),
  index('topology_site_fingerprints_site_idx').on(table.siteId),
  check('topology_site_fingerprints_family_check', sql`family = 'ipv4'`),
  check('topology_site_fingerprints_status_check', sql`status IN ('anchored', 'unconfirmed', 'ambiguous')`),
  check('topology_site_fingerprints_neighbor_coverage_check', sql`neighbor_coverage IN ('complete', 'limited')`),
]);

export const topologyDevicePresence = pgTable('topology_device_presence', {
  deviceId: uuid('device_id').primaryKey(),
  orgId: uuid('org_id').notNull(),
  /** The assignment evaluated against: a reconciliation guard (S§7.3), never rewritten. */
  assignedSiteId: uuid('assigned_site_id').notNull(),
  state: varchar('state', { length: 16 }).$type<'home' | 'visiting' | 'unrecognized' | 'ambiguous' | 'stale' | 'unknown'>().notNull(),
  reason: varchar('reason', { length: 48 }),
  matchedSiteId: uuid('matched_site_id'),
  declaringSiteIds: uuid('declaring_site_ids').array().notNull().default(sql`'{}'`),
  prefix: cidr('prefix'),
  gatewayAddress: inet('gateway_address'),
  gatewayMac: macaddr('gateway_mac'),
  macCorroborated: boolean('mac_corroborated').notNull().default(false),
  evidence: jsonb('evidence').$type<TopologyPresenceEvidence[]>().notNull().default([]),
  observedAt: timestamp('observed_at', { withTimezone: true }),
  freshUntil: timestamp('fresh_until', { withTimezone: true }),
  fingerprintVersion: bigint('fingerprint_version', { mode: 'bigint' }).notNull(),
  evaluatedAt: timestamp('evaluated_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  foreignKey({ name: 'topology_device_presence_device_fk', columns: [table.deviceId, table.orgId], foreignColumns: [devices.id, devices.orgId] }).onDelete('cascade'),
  foreignKey({ name: 'topology_device_presence_matched_site_fk', columns: [table.matchedSiteId, table.orgId], foreignColumns: [sites.id, sites.orgId] }).onDelete('cascade'),
  index('topology_device_presence_visiting_idx').on(table.orgId, table.matchedSiteId).where(sql`state = 'visiting'`),
  index('topology_device_presence_assigned_idx').on(table.orgId, table.assignedSiteId),
  index('topology_device_presence_matched_site_idx').on(table.matchedSiteId),
  check('topology_device_presence_state_check', sql`state IN ('home', 'visiting', 'unrecognized', 'ambiguous', 'stale', 'unknown')`),
  check('topology_device_presence_visiting_chk', sql`(state = 'visiting') = (matched_site_id IS NOT NULL)`),
]);
