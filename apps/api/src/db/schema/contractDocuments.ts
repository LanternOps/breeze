import {
  pgTable, uuid, text, varchar, integer, smallint, char, date, jsonb, timestamp, pgEnum, index, uniqueIndex, foreignKey
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { partners, organizations } from './orgs';
// Reuse the exported `bytea` custom type (Buffer-mapped) from users.ts — same
// pattern as quotes.ts / invoiceDocuments.ts.
import { users, bytea } from './users';
import { quotes, quoteAcceptances } from './quotes';
import { contracts } from './contracts';

export const contractTemplateStatusEnum = pgEnum('contract_template_status', ['active', 'archived']);
export const contractTemplateVersionStatusEnum = pgEnum('contract_template_version_status', ['draft', 'published']);
export const contractTemplateSourceTypeEnum = pgEnum('contract_template_source_type', ['authored', 'uploaded']);

// Contract template library (epic #2135 partner-wide-first shape): a template
// is owned by EITHER an org OR a partner (org_id XOR partner_id), enforced by
// contract_templates_one_owner_chk. Dual-axis RLS policy mirrors
// software_policies (2026-07-01-software-policies-partner-ownership.sql).
export const contractTemplates = pgTable('contract_templates', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').references(() => organizations.id),
  partnerId: uuid('partner_id').references(() => partners.id),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  status: contractTemplateStatusEnum('status').notNull().default('active'),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
}, (t) => [
  index('contract_templates_partner_id_idx').on(t.partnerId),
  index('contract_templates_org_id_idx').on(t.orgId)
]);

// Immutable versions of a template's content. org_id/partner_id are
// denormalized from the parent template (FK children get NO RLS coverage for
// free — the app layer disallows changing a template's owner once versions
// exist, so this denorm cannot drift). Dual-axis RLS policy, same shape as
// contract_templates.
export const contractTemplateVersions = pgTable('contract_template_versions', {
  id: uuid('id').primaryKey().defaultRandom(),
  templateId: uuid('template_id').notNull().references(() => contractTemplates.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id').references(() => organizations.id),
  partnerId: uuid('partner_id').references(() => partners.id),
  versionNumber: integer('version_number').notNull(),
  status: contractTemplateVersionStatusEnum('status').notNull().default('draft'),
  sourceType: contractTemplateSourceTypeEnum('source_type').notNull(),
  bodyHtml: text('body_html'),
  fileData: bytea('file_data'),
  mime: varchar('mime', { length: 64 }),
  byteSize: integer('byte_size'),
  sha256: char('sha256', { length: 64 }),
  declaredVariables: jsonb('declared_variables').notNull().default([]),
  publishedAt: timestamp('published_at'),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull()
}, (t) => [
  uniqueIndex('contract_template_versions_template_version_uq').on(t.templateId, t.versionNumber),
  index('contract_template_versions_partner_id_idx').on(t.partnerId),
  index('contract_template_versions_org_id_idx').on(t.orgId)
]);

// Agreement request (#8865, spec 2026-10-15-standalone-agreement-signing §4.1):
// one client org asked to sign one pinned template version, outside a quote.
// Shape 1 (direct org_id NOT NULL — a per-org transactional record, like
// contract_documents). Migration 2026-12-31-210000-agreement-requests.sql is
// the source of truth for what Drizzle cannot express:
//  - agreement_requests_contract_org_fk: composite (contract_id, org_id) →
//    contracts(id, org_id) ON DELETE SET NULL (contract_id) DEFERRABLE — the
//    column-list SET NULL has no Drizzle spelling, so it is declared in SQL only
//    (same as service_deliverables_contract_org_fk);
//  - the status / outcome CHECKs.
// Deliberately no signed_agreement_id: the signed agreement is found through
// contract_documents.agreement_request_id (a back-reference would be an FK cycle).
export const agreementRequests = pgTable('agreement_requests', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  status: text('status').$type<AgreementRequestStatus>().notNull().default('draft'),
  templateId: uuid('template_id').notNull().references(() => contractTemplates.id, { onDelete: 'restrict' }),
  templateVersionId: uuid('template_version_id').notNull().references(() => contractTemplateVersions.id, { onDelete: 'restrict' }),
  contractId: uuid('contract_id'),
  publicLinkRevokedAt: timestamp('public_link_revoked_at', { withTimezone: true }),
  label: text('label'),
  coverMessage: text('cover_message'),
  variableValues: jsonb('variable_values').$type<Record<string, string>>().notNull().default({}),
  clientNameSnapshot: varchar('client_name_snapshot', { length: 255 }),
  clientAddressSnapshot: jsonb('client_address_snapshot'),
  sellerSnapshot: jsonb('seller_snapshot'),
  documentLocale: varchar('document_locale', { length: 16 }),
  renderLocale: varchar('render_locale', { length: 16 }),
  effectiveDate: date('effective_date'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  sentAt: timestamp('sent_at', { withTimezone: true }),
  firstViewedAt: timestamp('first_viewed_at', { withTimezone: true }),
  signedAt: timestamp('signed_at', { withTimezone: true }),
  declinedAt: timestamp('declined_at', { withTimezone: true }),
  voidedAt: timestamp('voided_at', { withTimezone: true }),
  expiredAt: timestamp('expired_at', { withTimezone: true }),
  declineReason: text('decline_reason'),
  voidReason: text('void_reason'),
  acceptTokenJti: varchar('accept_token_jti', { length: 128 }),
  acceptTokenIssuedAt: timestamp('accept_token_issued_at', { withTimezone: true }),
  acceptTokenExpiresAt: timestamp('accept_token_expires_at', { withTimezone: true }),
  acceptTokenKid: varchar('accept_token_kid', { length: 64 }),
  publicResponseJti: varchar('public_response_jti', { length: 128 }),
  publicResponseConsumedAt: timestamp('public_response_consumed_at', { withTimezone: true }),
  publicResponseOutcome: varchar('public_response_outcome', { length: 16 }).$type<'accepted' | 'declined'>(),
  reminderCount: integer('reminder_count').notNull().default(0),
  lastRemindedAt: timestamp('last_reminded_at', { withTimezone: true }),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  voidedBy: uuid('voided_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull()
}, (t) => [
  uniqueIndex('agreement_requests_id_org_uq').on(t.id, t.orgId),
  index('agreement_requests_org_idx').on(t.orgId),
  index('agreement_requests_org_status_idx').on(t.orgId, t.status),
  index('agreement_requests_contract_idx').on(t.contractId),
  index('agreement_requests_open_expiry_idx').on(t.expiresAt).where(sql`${t.status} IN ('sent', 'viewed')`)
]);

export type AgreementRequestStatus = 'draft' | 'sent' | 'viewed' | 'signed' | 'declined' | 'voided' | 'expired';
export type AgreementRequestRow = typeof agreementRequests.$inferSelect;

// Who an agreement request is sent to — mirrors quote_recipients. Composite
// (request_id, org_id) FK keeps a recipient in its request's org; DEFERRABLE in
// SQL so org merge can repoint parent and child in separate statements.
export const agreementRequestRecipients = pgTable('agreement_request_recipients', {
  id: uuid('id').primaryKey().defaultRandom(),
  requestId: uuid('request_id').notNull(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  email: varchar('email', { length: 255 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull()
}, (t) => [
  uniqueIndex('agreement_request_recipients_request_email_uq').on(t.requestId, t.email),
  index('agreement_request_recipients_org_idx').on(t.orgId),
  foreignKey({
    columns: [t.requestId, t.orgId],
    foreignColumns: [agreementRequests.id, agreementRequests.orgId],
    name: 'agreement_request_recipients_request_org_fk',
  }).onDelete('cascade'),
]);

// Executed contract instance for a specific client org — org-owned
// transactional record (org_id NOT NULL is deliberate, not an oversight; this
// is not a partner-wide config table). Shape-1 RLS (direct org_id), matching
// quotes.ts / invoiceDocuments.ts.
//
// #8865 W1b: `source_kind` is the durable source discriminator ('quote' |
// 'request'); quote_id / quote_acceptance_id / agreement_request_id are SET NULL
// conveniences that may legitimately all go NULL after the source is deleted
// (contract_documents_one_source_chk is deliberately NOT a strict XOR). The
// signer_* … acceptance_render_locale columns are the evidence snapshot, so a
// signed agreement keeps who/when/how after its quote or request is gone; NULL
// on a legacy row whose acceptance was already deleted before the back-fill.
export const contractDocuments = pgTable('contract_documents', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  quoteId: uuid('quote_id').references(() => quotes.id, { onDelete: 'set null' }),
  quoteAcceptanceId: uuid('quote_acceptance_id').references(() => quoteAcceptances.id, { onDelete: 'set null' }),
  contractId: uuid('contract_id').references(() => contracts.id, { onDelete: 'set null' }),
  templateId: uuid('template_id').notNull().references(() => contractTemplates.id, { onDelete: 'restrict' }),
  templateVersionId: uuid('template_version_id').notNull().references(() => contractTemplateVersions.id, { onDelete: 'restrict' }),
  renderedHtml: text('rendered_html'),
  pdfData: bytea('pdf_data').notNull(),
  mime: varchar('mime', { length: 64 }).notNull().default('application/pdf'),
  byteSize: integer('byte_size').notNull(),
  sha256: char('sha256', { length: 64 }).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  sourceKind: text('source_kind').$type<'quote' | 'request'>().notNull().default('quote'),
  agreementRequestId: uuid('agreement_request_id').references(() => agreementRequests.id, { onDelete: 'set null' }),
  signerName: varchar('signer_name', { length: 255 }),
  signerEmail: varchar('signer_email', { length: 255 }),
  signedAt: timestamp('signed_at', { withTimezone: true }),
  signerIp: varchar('signer_ip', { length: 64 }),
  signerUserAgent: text('signer_user_agent'),
  acceptanceOrigin: text('acceptance_origin').$type<'customer' | 'on_behalf'>(),
  acceptanceMethod: varchar('acceptance_method', { length: 32 }),
  acceptanceReference: text('acceptance_reference'),
  recordedByUserId: uuid('recorded_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  contentSha256: char('content_sha256', { length: 64 }),
  contentHashVersion: smallint('content_hash_version'),
  acceptanceRenderLocale: varchar('acceptance_render_locale', { length: 16 })
}, (t) => [
  index('contract_documents_org_idx').on(t.orgId),
  index('contract_documents_contract_idx').on(t.contractId),
  index('contract_documents_quote_idx').on(t.quoteId),
  uniqueIndex('contract_documents_agreement_request_uq').on(t.agreementRequestId).where(sql`${t.agreementRequestId} IS NOT NULL`)
]);
