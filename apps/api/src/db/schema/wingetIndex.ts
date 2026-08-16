import { pgTable, uuid, varchar, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core';

/**
 * Searchable mirror of the microsoft/winget-pkgs manifest tree.
 *
 * Platform-global (no org_id/partner_id/device_id): the winget catalog is
 * public data identical for every tenant. Migration
 * 2026-08-16-c-winget-package-index.sql enables forced RLS with a public
 * SELECT policy and a system-context-only write policy.
 */
export const wingetPackageIndex = pgTable('winget_package_index', {
  id: uuid('id').primaryKey().defaultRandom(),
  packageId: varchar('package_id', { length: 256 }).notNull(),
  vendorSegment: varchar('vendor_segment', { length: 200 }).notNull(),
  nameSegment: varchar('name_segment', { length: 200 }).notNull(),
  latestVersion: varchar('latest_version', { length: 128 }),
  syncedCommitSha: varchar('synced_commit_sha', { length: 64 }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  packageIdUq: uniqueIndex('winget_package_index_package_id_uq').on(table.packageId),
  nameSegmentIdx: index('winget_package_index_name_segment_idx').on(table.nameSegment),
  syncedCommitShaIdx: index('winget_package_index_synced_commit_sha_idx').on(table.syncedCommitSha),
}));

export type WingetPackageIndexRow = typeof wingetPackageIndex.$inferSelect;
