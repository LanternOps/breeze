import { sql } from 'drizzle-orm';
import {
  boolean, check, cidr, foreignKey, index, inet, macaddr, pgTable, timestamp, unique, uuid, varchar,
} from 'drizzle-orm/pg-core';
import { organizations } from './orgs';
import { devices } from './devices';
import { users } from './users';
import { discoveryProfiles } from './discovery';

/**
 * Learned networks W01a (#12370, spec docs/superpowers/specs/monitoring/2026-11-20-learned-networks-discovery-gate-design.md §6).
 * Tenancy shape 1 on all five tables (direct org_id, RLS enabled + forced). Migration:
 * 2027-01-29-100000-learned-networks.sql, which also owns what Drizzle cannot express or this file must not declare:
 * DEFERRABLE INITIALLY IMMEDIATE on every composite FK, the `ON DELETE SET NULL (col)` link
 * (learned_networks_site_fk), the gated-invariant constraint triggers and the device org-move trigger.
 *
 * `org_id NOT NULL`: observed inventory of one org's devices plus an assignment to one of that org's sites;
 * nothing here is partner-wide policy.
 */

/** The named, assignable network. `site_id` set = assigned; never both assigned and ignored. */
export const learnedNetworks = pgTable('learned_networks', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  // Composite FK (site_id, org_id) -> sites(id, org_id) ON DELETE SET NULL (site_id) lives in the migration:
  // Drizzle cannot express a column-list SET NULL.
  siteId: uuid('site_id'),
  name: varchar('name', { length: 255 }),
  /** Last LAN prefix observed: display and suggestion only, never identity. */
  prefix: cidr('prefix'),
  ignoredAt: timestamp('ignored_at', { withTimezone: true }),
  assignedBy: uuid('assigned_by').references(() => users.id, { onDelete: 'set null' }),
  assignedAt: timestamp('assigned_at', { withTimezone: true }),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique('learned_networks_id_org_uniq').on(table.id, table.orgId),
  index('learned_networks_org_site_idx').on(table.orgId, table.siteId),
  index('learned_networks_site_idx').on(table.siteId).where(sql`site_id IS NOT NULL`),
  index('learned_networks_retention_idx').on(table.lastSeenAt).where(sql`site_id IS NULL AND ignored_at IS NULL`),
  check('learned_networks_assigned_or_ignored_chk', sql`site_id IS NULL OR ignored_at IS NULL`),
  check('learned_networks_prefix_ipv4_chk', sql`prefix IS NULL OR family(prefix) = 4`),
]);

/** A network's identity: one row per (gateway_mac, gateway_address) fingerprint, unique per org. */
export const learnedNetworkGateways = pgTable('learned_network_gateways', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  networkId: uuid('network_id').notNull(),
  gatewayAddress: inet('gateway_address').notNull(),
  gatewayMac: macaddr('gateway_mac').notNull(),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique('learned_network_gateways_id_org_uniq').on(table.id, table.orgId),
  unique('learned_network_gateways_fingerprint_uniq').on(table.orgId, table.gatewayMac, table.gatewayAddress),
  foreignKey({ name: 'learned_network_gateways_network_fk', columns: [table.networkId, table.orgId],
    foreignColumns: [learnedNetworks.id, learnedNetworks.orgId] }).onDelete('cascade'),
  index('learned_network_gateways_network_idx').on(table.networkId),
  check('learned_network_gateways_ipv4_host_chk', sql`family(gateway_address) = 4 AND masklen(gateway_address) = 32`),
]);

/**
 * Which devices were seen behind which fingerprint. Membership is per fingerprint: a device behind two gateways
 * of one network has two rows. Deleted on a device org move (BEFORE trigger breeze_learned_networks_device_moved).
 */
export const learnedNetworkDevices = pgTable('learned_network_devices', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  deviceId: uuid('device_id').notNull(),
  gatewayId: uuid('gateway_id').notNull(),
  interfaceName: varchar('interface_name', { length: 128 }).notNull(),
  localAddress: inet('local_address').notNull(),
  /** This interface carries the route to the Breeze server. */
  isPrimary: boolean('is_primary').notNull().default(false),
  isCurrent: boolean('is_current').notNull().default(true),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique('learned_network_devices_device_gateway_uniq').on(table.deviceId, table.gatewayId),
  foreignKey({ name: 'learned_network_devices_device_fk', columns: [table.deviceId, table.orgId],
    foreignColumns: [devices.id, devices.orgId] }).onDelete('cascade'),
  foreignKey({ name: 'learned_network_devices_gateway_fk', columns: [table.gatewayId, table.orgId],
    foreignColumns: [learnedNetworkGateways.id, learnedNetworkGateways.orgId] }).onDelete('cascade'),
  index('learned_network_devices_gateway_idx').on(table.gatewayId),
  index('learned_network_devices_current_idx').on(table.gatewayId, table.deviceId).where(sql`is_current`),
  index('learned_network_devices_last_seen_idx').on(table.lastSeenAt),
  check('learned_network_devices_ipv4_host_chk', sql`family(local_address) = 4 AND masklen(local_address) = 32`),
]);

/** WAN history per network. */
export const learnedNetworkWanAddresses = pgTable('learned_network_wan_addresses', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  networkId: uuid('network_id').notNull(),
  address: inet('address').notNull(),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique('learned_network_wan_addresses_network_address_uniq').on(table.networkId, table.address),
  foreignKey({ name: 'learned_network_wan_addresses_network_fk', columns: [table.networkId, table.orgId],
    foreignColumns: [learnedNetworks.id, learnedNetworks.orgId] }).onDelete('cascade'),
]);

/** The fingerprints a profile's saved SNMP secrets were entered for. A grant names a fingerprint, never a network. */
export const discoveryProfileSnmpGrants = pgTable('discovery_profile_snmp_grants', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  profileId: uuid('profile_id').notNull(),
  gatewayId: uuid('gateway_id').notNull(),
  grantedBy: uuid('granted_by').references(() => users.id, { onDelete: 'set null' }),
  grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique('discovery_profile_snmp_grants_profile_gateway_uniq').on(table.profileId, table.gatewayId),
  foreignKey({ name: 'discovery_profile_snmp_grants_profile_fk', columns: [table.profileId, table.orgId],
    foreignColumns: [discoveryProfiles.id, discoveryProfiles.orgId] }).onDelete('cascade'),
  foreignKey({ name: 'discovery_profile_snmp_grants_gateway_fk', columns: [table.gatewayId, table.orgId],
    foreignColumns: [learnedNetworkGateways.id, learnedNetworkGateways.orgId] }).onDelete('cascade'),
  index('discovery_profile_snmp_grants_gateway_idx').on(table.gatewayId),
]);
