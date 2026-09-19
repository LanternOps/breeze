import { foreignKey, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { devices } from './devices';
import { organizations } from './orgs';

/**
 * Durable device identity for RMM re-import (#3257 W06).
 *
 * Every migration source exports a stable device UID (Datto `uid`, NinjaOne
 * device id, ConnectWise Automate `ComputerID`, N-central `applianceID`).
 * Recording it on the first successful match turns a fuzzy hostname join into
 * an exact lookup on every subsequent run — which is what makes a multi-day
 * migration (import, enroll more machines, re-import) work at all.
 *
 * Uniqueness is scoped per PARTNER — matching `organization_external_links`
 * and deliberately NOT `contact_external_links`: a Datto UID is unique across
 * the Datto tenant, which is partner-shaped, and a partner-scoped key survives
 * a device `moveOrg` untouched.
 *
 * `source_instance` is RESERVED (spec Open Decision 2). It ships nullable and
 * unused, but is already in the unique index via `COALESCE(source_instance,
 * '')`, so adopting an account/instance discriminator later (two Datto tenants,
 * or two unrelated CSVs both keyed `'1'`) is a BACKFILL rather than a migration
 * of a live unique key.
 *
 * The `.sql` migration is the source of truth for every index and constraint
 * here, including the expression-based unique key — this repo does not drive
 * migrations from Drizzle at all (`drizzle-kit generate`/`push` are unused; see
 * `scripts/check-drift.ts`). The declaration below models the same index for
 * typed query-building, and `deviceExternalLinks.integration.test.ts` asserts
 * the shipped one against the live catalog.
 *
 * Deliberately no json/jsonb column: open containers are `excludedOpen` in the
 * tenant-export policy and would be dropped from exports.
 */
export const deviceExternalLinks = pgTable('device_external_links', {
  id: uuid('id').primaryKey().defaultRandom(),
  deviceId: uuid('device_id').notNull(),
  orgId: uuid('org_id').notNull(),
  partnerId: uuid('partner_id').notNull(),
  // 'datto_rmm' | 'ninjaone' | 'cw_automate' | 'n_central' | 'csv' — free-form
  // on purpose; the importer seam supplies the value.
  system: text('system').notNull(),
  // RESERVED. Always null today; see the note above.
  sourceInstance: text('source_instance'),
  externalId: text('external_id').notNull(),
  label: text('label'),
  createdBy: uuid('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  // Structurally pins every link row to the SAME org as its device.
  // DEFERRABLE INITIALLY DEFERRED in SQL (org merge and the device-move trigger
  // re-point both sides in separate statements); Drizzle does not model
  // deferrability, so the migration is the source of truth.
  deviceExternalLinksDeviceOrgFk: foreignKey({
    columns: [table.deviceId, table.orgId],
    foreignColumns: [devices.id, devices.orgId],
    name: 'device_external_links_device_org_fk',
  }).onUpdate('cascade').onDelete('cascade'),
  deviceExternalLinksOrgPartnerFk: foreignKey({
    columns: [table.orgId, table.partnerId],
    foreignColumns: [organizations.id, organizations.partnerId],
    name: 'device_external_links_org_partner_fk',
  }).onDelete('cascade'),
  deviceExternalLinksDeviceIdx: index('device_external_links_device_idx').on(table.deviceId),
  deviceExternalLinksOrgIdx: index('device_external_links_org_idx').on(table.orgId),
  // Mirrors device_external_links_uniq. Declared as a raw expression because
  // the shipped index keys on COALESCE(source_instance, '').
  deviceExternalLinksUniq: uniqueIndex('device_external_links_uniq')
    .on(table.partnerId, table.system, sql`COALESCE(${table.sourceInstance}, '')`, table.externalId),
}));

export type DeviceExternalLink = typeof deviceExternalLinks.$inferSelect;
export type NewDeviceExternalLink = typeof deviceExternalLinks.$inferInsert;
