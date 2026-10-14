import { sql } from 'drizzle-orm';
import { pgTable, pgEnum, uuid, varchar, text, integer, char, boolean, timestamp, jsonb, index, uniqueIndex, primaryKey } from 'drizzle-orm/pg-core';
import { organizations, partners } from './orgs';
import { users } from './users';
import type { TrustPagePublicPayload, TrustPublishedConfig } from '@breeze/shared';

export const trustPageDocumentVisibilityEnum = pgEnum('trust_page_document_visibility', ['public', 'gated']);

/**
 * Trust Center (spec trust-center/2026-10-12 §9). Shape 1 (direct org_id).
 * The composite deferrable FKs (org_id, partner_id) → organizations and the
 * children's (x, org_id) → parent(id, org_id) are declared in SQL only; Drizzle
 * cannot express DEFERRABLE, so the migration is the authority (orgDocuments precedent).
 * No back-pointer to the current snapshot: see migration header.
 */
export const trustPages = pgTable('trust_pages', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().unique().references(() => organizations.id),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  isPartnerHome: boolean('is_partner_home').notNull().default(false),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  publicationRevision: integer('publication_revision').notNull().default(0),
  searchIndexable: boolean('search_indexable').notNull().default(false),
  showPercentages: boolean('show_percentages').notNull().default(false),
  showDeviceCount: boolean('show_device_count').notNull().default(false),
  showManagedBy: boolean('show_managed_by').notNull().default(true),
  securityContactEmail: varchar('security_contact_email', { length: 320 }),
  websiteUrl: text('website_url'),
  introHtml: text('intro_html'),
  hiddenControlIds: text('hidden_control_ids').array().notNull().default(sql`'{}'::text[]`),
  publicationAuthorizedBy: varchar('publication_authorized_by', { length: 200 }),
  publicationAuthorizedAt: timestamp('publication_authorized_at', { withTimezone: true }),
  publicationAuthorizedByUserId: uuid('publication_authorized_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  lastEvaluatedAt: timestamp('last_evaluated_at', { withTimezone: true }),
  /** Frozen at publish; the refresh builds from this, not the draft columns (spec §19 item 17). */
  publishedConfig: jsonb('published_config').$type<TrustPublishedConfig>(),
  createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  updatedByUserId: uuid('updated_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  uniqueIndex('trust_pages_id_org_uq').on(t.id, t.orgId),
  uniqueIndex('trust_pages_partner_home_uq').on(t.partnerId).where(sql`${t.isPartnerHome}`),
  index('trust_pages_published_idx').on(t.publishedAt).where(sql`${t.publishedAt} IS NOT NULL`),
]);
export type TrustPageRow = typeof trustPages.$inferSelect;

export const trustPageSnapshots = pgTable('trust_page_snapshots', {
  id: uuid('id').primaryKey().defaultRandom(),
  trustPageId: uuid('trust_page_id').notNull(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  payload: jsonb('payload').$type<TrustPagePublicPayload>().notNull(),
  payloadSha256: char('payload_sha256', { length: 64 }).notNull(),
  catalogVersion: text('catalog_version').notNull(),
  publicationRevision: integer('publication_revision').notNull(),
  isCurrent: boolean('is_current').notNull().default(false),
  generatedAt: timestamp('generated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  uniqueIndex('trust_page_snapshots_current_uq').on(t.trustPageId).where(sql`${t.isCurrent}`),
  index('trust_page_snapshots_page_generated_idx').on(t.trustPageId, t.generatedAt),
]);
export type TrustPageSnapshotRow = typeof trustPageSnapshots.$inferSelect;

export const trustPageDocuments = pgTable('trust_page_documents', {
  trustPageId: uuid('trust_page_id').notNull(),
  // No .references(): the only FK is the composite (document_id, org_id) →
  // org_documents(id, org_id) in SQL (serviceDeliverables.documentId precedent).
  documentId: uuid('document_id').notNull(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  visibility: trustPageDocumentVisibilityEnum('visibility').notNull().default('public'),
  disclosureConfirmedAt: timestamp('disclosure_confirmed_at', { withTimezone: true }),
  disclosureConfirmedByUserId: uuid('disclosure_confirmed_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  primaryKey({ columns: [t.trustPageId, t.documentId] }),
  index('trust_page_documents_org_idx').on(t.orgId),
]);
export type TrustPageDocumentRow = typeof trustPageDocuments.$inferSelect;
