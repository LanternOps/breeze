import {
  pgTable,
  uuid,
  varchar,
  text,
  boolean,
  timestamp,
  index,
  uniqueIndex,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organizations, partners } from './orgs';

/**
 * Service catalog foundation, R1 (#8325).
 * Migration: 2026-12-28-120000-service-catalog-foundation.sql.
 * Spec: docs/superpowers/specs/ticketing/2026-10-10-service-catalog-design.md §6.1.
 *
 * Config-ish dual-axis tables: exactly one of `partner_id` / `org_id` is set
 * (`*_one_owner_chk`). In the initial delivery rows are created only at the
 * partner level, one catalog per partner; the org axis is schema readiness only.
 *
 * The composite FKs from an item to its catalog (`(catalog_id, partner_id)` and
 * `(catalog_id, org_id)`, DEFERRABLE INITIALLY IMMEDIATE) and the
 * `(id, partner_id)` / `(id, org_id)` unique keys are declared in SQL only,
 * because Drizzle cannot express DEFERRABLE. The single-column `references()`
 * below exist for typing, matching this directory convention.
 */
export const serviceCatalogs = pgTable('service_catalogs', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id').references(() => partners.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 255 }).notNull(),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  check('service_catalogs_one_owner_chk', sql`(${t.orgId} IS NULL) <> (${t.partnerId} IS NULL)`),
  uniqueIndex('service_catalogs_one_per_partner').on(t.partnerId).where(sql`${t.partnerId} IS NOT NULL`),
  index('service_catalogs_org_idx').on(t.orgId),
]);

export const serviceCatalogItems = pgTable('service_catalog_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  catalogId: uuid('catalog_id').notNull().references(() => serviceCatalogs.id),
  partnerId: uuid('partner_id').references(() => partners.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  check('service_catalog_items_one_owner_chk', sql`(${t.orgId} IS NULL) <> (${t.partnerId} IS NULL)`),
  index('service_catalog_items_catalog_idx').on(t.catalogId),
  index('service_catalog_items_partner_idx').on(t.partnerId),
  index('service_catalog_items_org_idx').on(t.orgId),
]);
