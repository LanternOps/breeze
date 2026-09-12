import { sql } from 'drizzle-orm';
import { pgTable, pgEnum, uuid, varchar, text, integer, char, boolean, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { organizations } from './orgs';
import { users, bytea } from './users';

export const orgDocumentCategoryEnum = pgEnum('org_document_category', [
  'baseline', 'runbook', 'policy', 'evidence', 'report', 'export', 'other',
]);

/**
 * Organization document library (spec #5573 §4.4). Shape 1 (direct org_id).
 *
 * NEVER select `data` outside the content path — use ORG_DOCUMENT_META_COLUMNS.
 * The composite self-FK on (supersedes_document_id, org_id) is declared in SQL
 * only; Drizzle cannot express DEFERRABLE, so the column is left unreferenced
 * here and the migration is the authority.
 */
export const orgDocuments = pgTable('org_documents', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  title: varchar('title', { length: 200 }).notNull(),
  description: text('description'),
  category: orgDocumentCategoryEnum('category').notNull().default('other'),
  storageBackend: text('storage_backend').$type<'s3' | 'db'>().notNull(),
  storageKey: text('storage_key'),
  data: bytea('data'),
  contentType: varchar('content_type', { length: 255 }).notNull(),
  byteSize: integer('byte_size').notNull(),
  sha256: char('sha256', { length: 64 }).notNull(),
  originalFilename: varchar('original_filename', { length: 255 }).notNull(),
  uploadedByUserId: uuid('uploaded_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  portalVisible: boolean('portal_visible').notNull().default(false),
  supersedesDocumentId: uuid('supersedes_document_id'),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  deletedBy: uuid('deleted_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  uniqueIndex('org_documents_id_org_uq').on(t.id, t.orgId),
  uniqueIndex('org_documents_supersedes_uq').on(t.supersedesDocumentId)
    .where(sql`${t.supersedesDocumentId} IS NOT NULL`),
  index('org_documents_org_category_idx').on(t.orgId, t.category),
  index('org_documents_org_created_idx').on(t.orgId, t.createdAt),
]);

export type OrgDocumentRow = typeof orgDocuments.$inferSelect;
/** Structurally identical to the `OrgDocumentCategory` in
 *  packages/shared/src/validators/orgDocuments.ts. API code imports the SHARED
 *  one so the API and the web agree on a single definition; this alias exists
 *  for schema-local typing. Keep the two enum member lists in step. */
export type OrgDocumentCategory = (typeof orgDocumentCategoryEnum.enumValues)[number];

/** Client-safe column subset. `data` and `storageKey` are server-only. */
export const ORG_DOCUMENT_META_COLUMNS = {
  id: orgDocuments.id,
  orgId: orgDocuments.orgId,
  title: orgDocuments.title,
  description: orgDocuments.description,
  category: orgDocuments.category,
  contentType: orgDocuments.contentType,
  byteSize: orgDocuments.byteSize,
  sha256: orgDocuments.sha256,
  originalFilename: orgDocuments.originalFilename,
  uploadedByUserId: orgDocuments.uploadedByUserId,
  portalVisible: orgDocuments.portalVisible,
  supersedesDocumentId: orgDocuments.supersedesDocumentId,
  createdAt: orgDocuments.createdAt,
} as const;
