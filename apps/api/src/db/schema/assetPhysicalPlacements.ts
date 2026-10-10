import { sql } from 'drizzle-orm';
import { foreignKey, index, integer, pgTable, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { devices } from './devices';
import { discoveredAssets } from './discovery';
import { organizations } from './orgs';

/**
 * Structured physical placement (room / rack / rack unit / height U) for one
 * network asset. Exactly one of `deviceId` / `discoveredAssetId` is set
 * (migration CHECK). No site column: the site is derived live from the subject.
 *
 * Spec: docs/superpowers/specs/monitoring/2026-10-07-physical-placement-circuits-design.md §5.1
 */
export const assetPhysicalPlacements = pgTable('asset_physical_placements', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  deviceId: uuid('device_id'),
  discoveredAssetId: uuid('discovered_asset_id'),
  room: varchar('room', { length: 255 }),
  rack: varchar('rack', { length: 128 }),
  rackUnit: integer('rack_unit'),
  heightU: integer('height_u'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  deviceUnique: uniqueIndex('asset_physical_placements_device_uniq')
    .on(table.deviceId)
    .where(sql`${table.deviceId} IS NOT NULL`),
  discoveredAssetUnique: uniqueIndex('asset_physical_placements_discovered_asset_uniq')
    .on(table.discoveredAssetId)
    .where(sql`${table.discoveredAssetId} IS NOT NULL`),
  orgIdIdx: index('asset_physical_placements_org_id_idx').on(table.orgId),
  deviceOrgFk: foreignKey({
    columns: [table.deviceId, table.orgId],
    foreignColumns: [devices.id, devices.orgId],
    name: 'asset_physical_placements_device_org_fk',
  }).onUpdate('cascade').onDelete('cascade'),
  discoveredAssetOrgFk: foreignKey({
    columns: [table.discoveredAssetId, table.orgId],
    foreignColumns: [discoveredAssets.id, discoveredAssets.orgId],
    name: 'asset_physical_placements_discovered_asset_org_fk',
  }).onUpdate('cascade').onDelete('cascade'),
}));
