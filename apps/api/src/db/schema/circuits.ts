import { sql } from 'drizzle-orm';
import {
  pgTable, uuid, varchar, bigint, boolean, timestamp, primaryKey, index, foreignKey, check, unique,
} from 'drizzle-orm/pg-core';
import { organizations, sites } from './orgs';
import { topologyInterfaces } from './topologyCollections';

// Physical placement and circuits V1, Wave 1-B (spec §5.3-§5.5).
// The primary site is derived from the termination's interface; it is never stored.

const time = (name: string) => timestamp(name, { withTimezone: true });

export const circuits = pgTable('circuits', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  providerName: varchar('provider_name', { length: 255 }).notNull(),
  cid: varchar('cid', { length: 255 }).notNull(),
  bandwidthBps: bigint('bandwidth_bps', { mode: 'number' }),
  serviceType: varchar('service_type', { length: 64 }),
  administrativeStatus: varchar('administrative_status', { length: 24 }).notNull().default('active'),
  needsReassociation: boolean('needs_reassociation').notNull().default(false),
  createdAt: time('created_at').notNull().defaultNow(),
  updatedAt: time('updated_at').notNull().defaultNow(),
}, (t) => [
  unique('circuits_id_org_uniq').on(t.id, t.orgId),
  index('circuits_org_id_idx').on(t.orgId),
  index('circuits_org_id_cid_idx').on(t.orgId, t.cid),
  check('circuits_provider_name_chk', sql`length(btrim(provider_name)) BETWEEN 1 AND 255`),
  check('circuits_cid_chk', sql`length(btrim(cid)) BETWEEN 1 AND 255`),
  check('circuits_bandwidth_chk', sql`bandwidth_bps IS NULL OR bandwidth_bps > 0`),
  check('circuits_administrative_status_chk', sql`administrative_status IN ('active','planned','suspended','disconnected')`),
]);

export const circuitTerminations = pgTable('circuit_terminations', {
  circuitId: uuid('circuit_id').notNull(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  interfaceId: uuid('interface_id').notNull().unique(),
  createdAt: time('created_at').notNull().defaultNow(),
  updatedAt: time('updated_at').notNull().defaultNow(),
}, (t) => [
  primaryKey({ name: 'circuit_terminations_pkey', columns: [t.circuitId] }),
  foreignKey({ name: 'circuit_terminations_circuit_org_fk', columns: [t.circuitId, t.orgId], foreignColumns: [circuits.id, circuits.orgId] }).onDelete('cascade'),
  foreignKey({ name: 'circuit_terminations_interface_org_fk', columns: [t.interfaceId, t.orgId], foreignColumns: [topologyInterfaces.id, topologyInterfaces.orgId] }).onDelete('cascade'),
  index('circuit_terminations_org_id_idx').on(t.orgId),
]);

export const circuitServedSites = pgTable('circuit_served_sites', {
  circuitId: uuid('circuit_id').notNull(),
  siteId: uuid('site_id').notNull(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  createdAt: time('created_at').notNull().defaultNow(),
}, (t) => [
  primaryKey({ name: 'circuit_served_sites_pkey', columns: [t.circuitId, t.siteId] }),
  foreignKey({ name: 'circuit_served_sites_circuit_org_fk', columns: [t.circuitId, t.orgId], foreignColumns: [circuits.id, circuits.orgId] }).onDelete('cascade'),
  foreignKey({ name: 'circuit_served_sites_site_org_fk', columns: [t.siteId, t.orgId], foreignColumns: [sites.id, sites.orgId] }).onDelete('cascade'),
  index('circuit_served_sites_org_id_idx').on(t.orgId),
]);
