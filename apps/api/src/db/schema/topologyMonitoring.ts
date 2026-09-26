import { sql } from 'drizzle-orm';
import { pgTable, uuid, varchar, timestamp, bigint, integer, jsonb, uniqueIndex, index, foreignKey, check } from 'drizzle-orm/pg-core';
import { sites } from './orgs';
import { devices } from './devices';
import { discoveryProfiles } from './discovery';
import { topologyNodes } from './topology';

/** One armed interface, frozen at arm time: canonical id + generation and the source-local ifIndex. */
export type TopologyTelemetryArmInterface = { interfaceId: string; interfaceEpoch: string; ifIndex: number };

/**
 * M3-D2/D3 standing SNMP interface-telemetry arm (migration 2026-11-02-110000).
 * Human-only, MFA-fresh, outside the settings digest. The arm pins the exact
 * target (node + address), collector, credential source + digest, interfaces
 * and expiry; `generation` rotates on any material change and is the telemetry
 * authority's configuration generation. SQL owns DEFERRABLE INITIALLY IMMEDIATE.
 */
export const topologyTelemetryArms = pgTable('topology_telemetry_arms', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull(),
  siteId: uuid('site_id').notNull(),
  producerKind: varchar('producer_kind', { length: 16 }).notNull().default('snmp'),
  targetNodeId: uuid('target_node_id').notNull(),
  collectorDeviceId: uuid('collector_device_id').notNull().references(() => devices.id, { onDelete: 'cascade' }),
  credentialProfileId: uuid('credential_profile_id').notNull().references(() => discoveryProfiles.id, { onDelete: 'cascade' }),
  authorityKey: varchar('authority_key', { length: 255 }).notNull(),
  targetAddress: varchar('target_address', { length: 64 }).notNull(),
  credentialDigest: varchar('credential_digest', { length: 64 }).notNull(),
  interfaces: jsonb('interfaces').$type<TopologyTelemetryArmInterface[]>().notNull(),
  intervalSeconds: integer('interval_seconds').notNull().default(60),
  state: varchar('state', { length: 16 }).$type<'armed' | 'revoked' | 'blocked'>().notNull().default('armed'),
  blockedReason: varchar('blocked_reason', { length: 64 }),
  generation: bigint('generation', { mode: 'bigint' }).notNull().default(1n),
  armedBy: uuid('armed_by').notNull(),
  authorityActor: jsonb('authority_actor').$type<Record<string, unknown>>().notNull(),
  authorityPermissionVersion: varchar('authority_permission_version', { length: 256 }).notNull(),
  effectDigest: varchar('effect_digest', { length: 64 }).notNull(),
  armedAt: timestamp('armed_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  revokedBy: uuid('revoked_by'),
  nextPollAt: timestamp('next_poll_at', { withTimezone: true }),
  lastPolledAt: timestamp('last_polled_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('topology_telemetry_arms_id_org_site_uniq').on(t.id, t.orgId, t.siteId),
  uniqueIndex('topology_telemetry_arms_live_uniq').on(t.orgId, t.siteId, t.producerKind, t.authorityKey).where(sql`state = 'armed'`),
  index('topology_telemetry_arms_due_idx').on(t.nextPollAt).where(sql`state = 'armed'`),
  index('topology_telemetry_arms_collector_idx').on(t.collectorDeviceId),
  index('topology_telemetry_arms_profile_idx').on(t.credentialProfileId),
  foreignKey({ name: 'topology_telemetry_arms_site_fk', columns: [t.siteId, t.orgId], foreignColumns: [sites.id, sites.orgId] }).onDelete('cascade'),
  foreignKey({ name: 'topology_telemetry_arms_target_node_fk', columns: [t.targetNodeId, t.orgId, t.siteId], foreignColumns: [topologyNodes.id, topologyNodes.orgId, topologyNodes.siteId] }).onDelete('cascade'),
  check('topology_telemetry_arms_kind_chk', sql`producer_kind IN ('snmp')`),
  check('topology_telemetry_arms_state_chk', sql`state IN ('armed','revoked','blocked')`),
  check('topology_telemetry_arms_interval_chk', sql`interval_seconds BETWEEN 30 AND 300`),
  check('topology_telemetry_arms_generation_chk', sql`generation >= 1`),
  check('topology_telemetry_arms_authority_key_chk', sql`authority_key LIKE 'snmp:%' AND char_length(authority_key) > 5`),
  check('topology_telemetry_arms_digests_chk', sql`credential_digest ~ '^[a-f0-9]{64}$' AND effect_digest ~ '^[a-f0-9]{64}$'`),
  check('topology_telemetry_arms_interfaces_chk', sql`jsonb_typeof(interfaces) = 'array' AND jsonb_array_length(interfaces) BETWEEN 1 AND 256 AND octet_length(interfaces::text) <= 65536`),
  check('topology_telemetry_arms_actor_chk', sql`jsonb_typeof(authority_actor) = 'object' AND octet_length(authority_actor::text) <= 16384`),
  check('topology_telemetry_arms_expiry_chk', sql`expires_at > armed_at`),
  check('topology_telemetry_arms_revoked_chk', sql`(state = 'revoked') = (revoked_at IS NOT NULL)`),
]);
