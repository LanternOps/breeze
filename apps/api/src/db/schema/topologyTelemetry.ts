import { sql } from 'drizzle-orm';
import { pgTable, uuid, varchar, timestamp, numeric, integer, bigint, jsonb, primaryKey, index, foreignKey, check } from 'drizzle-orm/pg-core';
import { TOPOLOGY_INTERFACE_SAMPLE_RESOLUTIONS } from '@breeze/shared';
import { topologyCollectionSources, topologyInterfaces } from './topologyCollections';

export type TopologyInterfaceSampleResolution = typeof TOPOLOGY_INTERFACE_SAMPLE_RESOLUTIONS[number];

/**
 * M3 interface measurements (migration 2026-11-03-090000). Partitioned LIST
 * (resolution) -> RANGE (sampled_at) with bounded daily leaves and no default
 * partition; Drizzle models the parent only, leaves are created by
 * `breeze_ensure_topology_interface_sample_partition`. Identity is
 * (interface id + epoch, `if_metrics` source + producer epoch, sampled time);
 * `source_sequence` is the accepted batch sequence (uint64 decimal string).
 * Raw readings are immutable; aggregate rows are recomputed in place.
 */
export const topologyInterfaceSamples = pgTable('topology_interface_samples', {
  orgId: uuid('org_id').notNull(),
  siteId: uuid('site_id').notNull(),
  interfaceId: uuid('interface_id').notNull(),
  interfaceEpoch: varchar('interface_epoch', { length: 255 }).notNull(),
  sourceId: uuid('source_id').notNull(),
  producerEpoch: varchar('producer_epoch', { length: 255 }).notNull(),
  sourceSequence: numeric('source_sequence', { precision: 20, scale: 0 }).notNull(),
  sampledAt: timestamp('sampled_at', { withTimezone: true }).notNull(),
  resolution: varchar('resolution', { length: 8 }).$type<TopologyInterfaceSampleResolution>().notNull(),
  readings: jsonb('readings').$type<Record<string, unknown>>().notNull().default({}),
  validDurationMs: bigint('valid_duration_ms', { mode: 'number' }).notNull().default(0),
  sampleCount: integer('sample_count').notNull().default(0),
  gapDurationMs: bigint('gap_duration_ms', { mode: 'number' }).notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  primaryKey({ name: 'topology_interface_samples_pkey', columns: [t.resolution, t.sampledAt, t.orgId, t.siteId, t.interfaceId, t.interfaceEpoch, t.sourceId, t.producerEpoch] }),
  index('topology_interface_samples_lookup_idx').on(t.orgId, t.siteId, t.interfaceId, t.resolution, t.sampledAt.desc()),
  index('topology_interface_samples_source_idx').on(t.sourceId, t.producerEpoch, t.sourceSequence),
  foreignKey({ name: 'topology_interface_samples_interface_fk', columns: [t.interfaceId, t.orgId, t.siteId], foreignColumns: [topologyInterfaces.id, topologyInterfaces.orgId, topologyInterfaces.siteId] }).onDelete('cascade'),
  foreignKey({ name: 'topology_interface_samples_source_fk', columns: [t.sourceId, t.orgId, t.siteId], foreignColumns: [topologyCollectionSources.id, topologyCollectionSources.orgId, topologyCollectionSources.siteId] }).onDelete('cascade'),
  check('topology_interface_samples_resolution_chk', sql`resolution IN ('raw','5m','1h')`),
  check('topology_interface_samples_sequence_chk', sql`source_sequence BETWEEN 0 AND 18446744073709551615`),
  check('topology_interface_samples_bounds_chk', sql`valid_duration_ms >= 0 AND sample_count >= 0 AND gap_duration_ms >= 0`),
  check('topology_interface_samples_epochs_chk', sql`char_length(interface_epoch) > 0 AND char_length(producer_epoch) > 0`),
  check('topology_interface_samples_readings_chk', sql`jsonb_typeof(readings) = 'object' AND octet_length(readings::text) <= 16384`),
]);
