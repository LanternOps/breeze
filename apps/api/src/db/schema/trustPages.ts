import { sql } from 'drizzle-orm';
import { pgTable, pgEnum, uuid, varchar, text, integer, char, boolean, timestamp, jsonb, index, uniqueIndex, primaryKey } from 'drizzle-orm/pg-core';
import { organizations, partners } from './orgs';
import { users } from './users';
import type { TrustPagePublicPayloadAny, TrustPublishedConfig } from '@breeze/shared';

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
  // W2: the inheritable settings are nullable with no default — NULL = inherit (partner template, then the
  // built-in default; resolveEffectiveTrustSettings in @breeze/shared).
  searchIndexable: boolean('search_indexable'),
  showPercentages: boolean('show_percentages'),
  showDeviceCount: boolean('show_device_count'),
  showManagedBy: boolean('show_managed_by'),
  securityContactEmail: varchar('security_contact_email', { length: 320 }),
  websiteUrl: text('website_url'),
  introHtml: text('intro_html'),
  hiddenControlIds: text('hidden_control_ids').array(),
  frameworkView: text('framework_view').array(),
  showHistory: boolean('show_history'),
  ndaText: text('nda_text'),
  accessRequestCreatesTicket: boolean('access_request_creates_ticket').notNull().default(false),
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
  // Stored snapshots may be v1 (W1) or v2; every reader normalizes (normalizeTrustPagePayload).
  payload: jsonb('payload').$type<TrustPagePublicPayloadAny>().notNull(),
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

// ---- Trust Center W2 (#8770 W02a; migration 2026-12-30-120300-trust-center-w2.sql). Shape 1. As above, the
// composite deferrable FKs ((trust_page_id, org_id) → trust_pages, (request_id, org_id) → requests,
// (evidence_document_id, org_id) → org_documents) live in SQL only.
export const trustAccessRequestStatusEnum = pgEnum('trust_access_request_status', ['pending_verification', 'pending_approval', 'approved', 'denied', 'revoked']);
export const trustAccessTokenPurposeEnum = pgEnum('trust_access_token_purpose', ['verify_email', 'download']);
export const trustSubprocessorSourceEnum = pgEnum('trust_subprocessor_source', ['manual', 'security_product', 'backup', 'm365']);

/** Declared-control attestations. Attribution and dates are immutable (trust_page_declarations_immutable_trg). */
export const trustPageDeclarations = pgTable('trust_page_declarations', {
  id: uuid('id').primaryKey().defaultRandom(),
  trustPageId: uuid('trust_page_id').notNull(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  controlId: varchar('control_id', { length: 64 }).notNull(),
  statement: text('statement').notNull(),
  evidenceDocumentId: uuid('evidence_document_id'),
  evidenceDocumentSha256: char('evidence_document_sha256', { length: 64 }),
  declaredByPartnerName: varchar('declared_by_partner_name', { length: 255 }).notNull(),
  declaredByUserId: uuid('declared_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  declaredAt: timestamp('declared_at', { withTimezone: true }).defaultNow().notNull(),
  /** Exactly declared_at + 365 days (CHECK, written as 8760 hours). */
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  supersededAt: timestamp('superseded_at', { withTimezone: true }),
  withdrawnAt: timestamp('withdrawn_at', { withTimezone: true }),
  withdrawnByUserId: uuid('withdrawn_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  reminderSentAt: timestamp('reminder_sent_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  uniqueIndex('trust_page_declarations_id_org_uq').on(t.id, t.orgId),
  uniqueIndex('trust_page_declarations_active_uq').on(t.trustPageId, t.controlId).where(sql`${t.supersededAt} IS NULL AND ${t.withdrawnAt} IS NULL`),
  index('trust_page_declarations_reminder_idx').on(t.expiresAt).where(sql`${t.supersededAt} IS NULL AND ${t.withdrawnAt} IS NULL AND ${t.reminderSentAt} IS NULL`),
  index('trust_page_declarations_org_idx').on(t.orgId),
]);
export type TrustPageDeclarationRow = typeof trustPageDeclarations.$inferSelect;

export const trustPageAccessRequests = pgTable('trust_page_access_requests', {
  id: uuid('id').primaryKey().defaultRandom(),
  trustPageId: uuid('trust_page_id').notNull(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  requesterEmail: varchar('requester_email', { length: 320 }).notNull(),
  requesterName: varchar('requester_name', { length: 200 }).notNull(),
  requesterCompany: varchar('requester_company', { length: 200 }).notNull(),
  purpose: varchar('purpose', { length: 2000 }).notNull(),
  /** The snapshot the requester saw; no FK (snapshots are pruned). */
  snapshotId: uuid('snapshot_id'),
  ndaTextAccepted: text('nda_text_accepted'),
  ndaTextSha256: char('nda_text_sha256', { length: 64 }),
  ndaAcceptedAt: timestamp('nda_accepted_at', { withTimezone: true }),
  status: trustAccessRequestStatusEnum('status').notNull().default('pending_verification'),
  emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  decidedByUserId: uuid('decided_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  decisionNote: varchar('decision_note', { length: 500 }),
  grantExpiresAt: timestamp('grant_expires_at', { withTimezone: true }),
  grantedDocumentIds: uuid('granted_document_ids').array(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  revokedByUserId: uuid('revoked_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  lastDownloadedAt: timestamp('last_downloaded_at', { withTimezone: true }),
  downloadCount: integer('download_count').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  uniqueIndex('trust_page_access_requests_id_org_uq').on(t.id, t.orgId),
  index('trust_page_access_requests_page_status_idx').on(t.trustPageId, t.status, t.createdAt.desc()),
  index('trust_page_access_requests_org_idx').on(t.orgId),
  index('trust_page_access_requests_updated_idx').on(t.updatedAt),
]);
export type TrustPageAccessRequestRow = typeof trustPageAccessRequests.$inferSelect;

/** Raw tokens are never stored: token_hash = sha256 hex of a 48-char nanoid (amendment 32). */
export const trustPageAccessTokens = pgTable('trust_page_access_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  requestId: uuid('request_id').notNull(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  purpose: trustAccessTokenPurposeEnum('purpose').notNull(),
  tokenHash: char('token_hash', { length: 64 }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  uniqueIndex('trust_page_access_tokens_hash_uq').on(t.tokenHash),
  index('trust_page_access_tokens_request_idx').on(t.requestId),
  index('trust_page_access_tokens_expires_idx').on(t.expiresAt),
  index('trust_page_access_tokens_org_idx').on(t.orgId),
]);
export type TrustPageAccessTokenRow = typeof trustPageAccessTokens.$inferSelect;

export const trustPageFaqItems = pgTable('trust_page_faq_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  trustPageId: uuid('trust_page_id').notNull(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  question: varchar('question', { length: 300 }).notNull(),
  answerHtml: text('answer_html').notNull(),
  sortOrder: integer('sort_order').notNull(),
  updatedByUserId: uuid('updated_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index('trust_page_faq_items_page_sort_idx').on(t.trustPageId, t.sortOrder),
  index('trust_page_faq_items_org_idx').on(t.orgId),
]);
export type TrustPageFaqItemRow = typeof trustPageFaqItems.$inferSelect;

export const trustPageSubprocessors = pgTable('trust_page_subprocessors', {
  id: uuid('id').primaryKey().defaultRandom(),
  trustPageId: uuid('trust_page_id').notNull(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  name: varchar('name', { length: 200 }).notNull(),
  purpose: varchar('purpose', { length: 300 }).notNull(),
  location: varchar('location', { length: 120 }),
  websiteUrl: varchar('website_url', { length: 2048 }),
  source: trustSubprocessorSourceEnum('source').notNull().default('manual'),
  sourceKey: varchar('source_key', { length: 120 }),
  sortOrder: integer('sort_order').notNull(),
  updatedByUserId: uuid('updated_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  uniqueIndex('trust_page_subprocessors_source_key_uq').on(t.trustPageId, t.sourceKey).where(sql`${t.sourceKey} IS NOT NULL`),
  index('trust_page_subprocessors_page_sort_idx').on(t.trustPageId, t.sortOrder),
  index('trust_page_subprocessors_org_idx').on(t.orgId),
]);
export type TrustPageSubprocessorRow = typeof trustPageSubprocessors.$inferSelect;
