import {
  pgTable, uuid, text, varchar, integer, char, jsonb, timestamp, pgEnum, index, uniqueIndex
} from 'drizzle-orm/pg-core';
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

// Executed contract instance for a specific client org — org-owned
// transactional record (org_id NOT NULL is deliberate, not an oversight; this
// is not a partner-wide config table). Shape-1 RLS (direct org_id), matching
// quotes.ts / invoiceDocuments.ts.
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
  createdAt: timestamp('created_at').defaultNow().notNull()
}, (t) => [
  index('contract_documents_org_idx').on(t.orgId),
  index('contract_documents_contract_idx').on(t.contractId),
  index('contract_documents_quote_idx').on(t.quoteId)
]);
