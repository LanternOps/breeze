import { foreignKey, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { organizations } from './orgs';

/**
 * One-to-many external-system linkage for organizations (issue #3242).
 *
 * Replaces the single-valued `organizations.accounting_provider` /
 * `accounting_external_id` pair as the idempotency key for org import
 * sources: an org can simultaneously be linked to a Datto CSV, ConnectWise
 * for ticketing, and QuickBooks for billing. Uniqueness is scoped per
 * partner via `(partner_id, system, external_id)`; the composite FK to
 * `organizations (id, partner_id)` keeps the denormalised `partner_id`
 * honest (same pattern as `deployment_invites_org_partner_fk`).
 *
 * Deliberately no json/jsonb column: open containers are `excludedOpen` in
 * the tenant-export policy and would be dropped from exports.
 */
export const organizationExternalLinks = pgTable('organization_external_links', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull(),
  partnerId: uuid('partner_id').notNull(),
  // 'quickbooks' | 'connectwise' | 'datto_rmm' | 'csv' | ... — free-form on
  // purpose; the seam (services/orgImport) supplies the value.
  system: text('system').notNull(),
  externalId: text('external_id').notNull(),
  label: text('label'),
  createdBy: uuid('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  organizationExternalLinksOrgPartnerFk: foreignKey({
    columns: [table.orgId, table.partnerId],
    foreignColumns: [organizations.id, organizations.partnerId],
    name: 'organization_external_links_org_partner_fk',
  }).onDelete('cascade'),
  organizationExternalLinksUniq: uniqueIndex('organization_external_links_uniq')
    .on(table.partnerId, table.system, table.externalId),
  organizationExternalLinksOrgIdx: index('organization_external_links_org_idx').on(table.orgId),
}));

export type OrganizationExternalLink = typeof organizationExternalLinks.$inferSelect;
export type NewOrganizationExternalLink = typeof organizationExternalLinks.$inferInsert;
