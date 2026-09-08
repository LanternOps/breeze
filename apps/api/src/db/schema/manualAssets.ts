import { pgTable, uuid, varchar, text, timestamp, pgEnum, index } from 'drizzle-orm/pg-core';
import { organizations } from './orgs';
import { discoveredAssetTypeEnum } from './discovery';

export const manualAssetSourceEnum = pgEnum('manual_asset_source', ['manual', 'import']);

/**
 * Manual asset entry (#4622). Non-networked inventory only — an asset with a
 * network identity (IP/hostname/URL) is a `discovered_assets` row (#5213), so
 * this table deliberately carries no address columns.
 *
 * Tenancy shape 1 (direct `org_id`). `org_id NOT NULL` justification: manual
 * assets are customer inventory records, not config/policy, and there is no
 * coherent partner-wide manual asset — the Partner-Wide First default does not
 * apply.
 *
 * The composite tenant FKs — `(site_id, org_id)`, `(linked_device_id, org_id)`,
 * `(linked_discovered_asset_id, org_id)` and `(assigned_contact_id, org_id)` —
 * are declared in SQL only (`2026-10-14-100000-manual-assets.sql`), all
 * DEFERRABLE INITIALLY IMMEDIATE. Drizzle cannot express a multi-column FK on a
 * table definition; the static contract tests read column *names*, which are
 * present here.
 */
export const manualAssets = pgTable(
  'manual_assets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    siteId: uuid('site_id').notNull(),
    name: varchar('name', { length: 255 }).notNull(),
    assetType: discoveredAssetTypeEnum('asset_type').notNull().default('unknown'),
    manufacturer: varchar('manufacturer', { length: 255 }),
    model: varchar('model', { length: 255 }),
    serialNumber: varchar('serial_number', { length: 255 }),
    assetTag: varchar('asset_tag', { length: 128 }),
    location: varchar('location', { length: 255 }),
    assignedContactId: uuid('assigned_contact_id'),
    source: manualAssetSourceEnum('source').notNull().default('manual'),
    linkedDeviceId: uuid('linked_device_id'),
    linkedDiscoveredAssetId: uuid('linked_discovered_asset_id'),
    notes: text('notes'),
    tags: text('tags').array().notNull().default([]),
    retiredAt: timestamp('retired_at', { withTimezone: true }),
    createdBy: uuid('created_by'),
    updatedBy: uuid('updated_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgIdx: index('manual_assets_org_idx').on(table.orgId),
    orgSiteIdx: index('manual_assets_org_site_idx').on(table.orgId, table.siteId),
  }),
);

export type ManualAsset = typeof manualAssets.$inferSelect;
export type NewManualAsset = typeof manualAssets.$inferInsert;
