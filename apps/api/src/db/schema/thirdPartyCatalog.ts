import { pgTable, uuid, varchar, text, boolean, timestamp } from 'drizzle-orm/pg-core';
import { patchSourceEnum, patchSeverityEnum } from './patches';

export const thirdPartyPackageCatalog = pgTable('third_party_package_catalog', {
  id: uuid('id').primaryKey().defaultRandom(),
  source: patchSourceEnum('source').notNull(),
  packageId: varchar('package_id', { length: 256 }).notNull(),
  vendor: varchar('vendor', { length: 255 }).notNull(),
  friendlyName: varchar('friendly_name', { length: 255 }).notNull(),
  category: varchar('category', { length: 64 }).notNull().default('application'),
  defaultSeverity: patchSeverityEnum('default_severity').notNull().default('unknown'),
  breezeTested: boolean('breeze_tested').notNull().default(false),
  lastTestedAt: timestamp('last_tested_at', { withTimezone: true }),
  lastTestedVersion: varchar('last_tested_version', { length: 64 }),
  lastTestedResult: varchar('last_tested_result', { length: 32 }),
  notes: text('notes'),
  homepageUrl: text('homepage_url'),
  lastCveCheckAt: timestamp('last_cve_check_at', { withTimezone: true }),
  osvEcosystem: varchar('osv_ecosystem', { length: 64 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type ThirdPartyPackageCatalog = typeof thirdPartyPackageCatalog.$inferSelect;

export const thirdPartyReleaseTests = pgTable('third_party_release_tests', {
  id: uuid('id').primaryKey().defaultRandom(),
  catalogId: uuid('catalog_id').notNull().references(() => thirdPartyPackageCatalog.id, { onDelete: 'cascade' }),
  version: varchar('version', { length: 64 }).notNull(),
  status: varchar('status', { length: 32 }).notNull().default('queued'),
  result: varchar('result', { length: 32 }),
  log: text('log'),
  startedAt: timestamp('started_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type ThirdPartyReleaseTest = typeof thirdPartyReleaseTests.$inferSelect;
