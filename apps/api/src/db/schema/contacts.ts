import {
  boolean,
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organizations, sites } from './orgs';

/**
 * First-class organization contacts (issue #3258, epic #3249 Phase 3).
 *
 * Replaces `organizations.billing_contact` / `sites.contact` as the place
 * contact data LIVES. Those two jsonb columns are kept as a dual-written
 * compatibility projection (services/contacts/compat.ts) and are NOT dropped:
 * a partner-export watermark trigger reads `sites.contact` by name, it is a
 * `.strict()` public partner-API DTO whose records are content-hashed, and
 * the two columns have deliberately different partner-API exposure.
 *
 * Moving the PII into real columns is the point: an unshaped jsonb column is
 * classified `excludedOpen`, so contact names/emails/phones were silently
 * dropped from every tenant export while the structured `billing_address_*`
 * columns beside them were included.
 *
 * Tenancy: Shape 1 (direct `org_id`), auto-discovered by the RLS coverage
 * test — no allowlist entry, and NOT in `DUAL_AXIS_TENANT_TABLES`. A contact
 * is customer data rather than config/policy, so #2135's partner-wide-first
 * default does not apply; the partner-side "person" is a `users` row.
 *
 * Deliberately no json/jsonb/bytea column — an open container is
 * `excludedOpen` and would drop the row's most interesting fields straight
 * back out of tenant export.
 */
export const contacts = pgTable('contacts', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull(),
  // Optional site pin. The composite FK below makes a cross-org pin
  // unrepresentable rather than merely validated.
  siteId: uuid('site_id'),
  // Nullable on purpose: a contact identified only by an address is real —
  // inbound email already creates name-less person rows, and blobs of the
  // form {"email": "ap@acme.com"} are common. `contacts_identifiable_chk`
  // keeps a wholly empty row unrepresentable.
  name: varchar('name', { length: 255 }),
  email: varchar('email', { length: 320 }),
  phone: varchar('phone', { length: 64 }),
  mobile: varchar('mobile', { length: 64 }),
  title: varchar('title', { length: 255 }),
  // App-validated vocabulary ('billing' | 'technical' | 'escalation' |
  // 'admin' | 'site' | 'after_hours' | 'portal'), grown per import source.
  // text[] rather than jsonb so the column survives tenant export.
  roles: text('roles').array().notNull().default(sql`'{}'`),
  // "The headline contact for this org (or this site)" — the row the compat
  // projection writes into the legacy jsonb. NOT per-role primacy: Pax8
  // readiness needs a primary admin AND billing AND technical at once, which
  // belongs in a `contact_roles` child table when a consumer needs it.
  isPrimary: boolean('is_primary').notNull().default(false),
  notes: text('notes'),
  createdBy: uuid('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  contactsOrgFk: foreignKey({
    columns: [table.orgId],
    foreignColumns: [organizations.id],
    name: 'contacts_org_fk',
  }).onDelete('cascade'),
  // Composite against `sites_id_org_id_uniq`. ON DELETE CASCADE rather than
  // SET NULL because a composite SET NULL would also null `org_id`, which is
  // NOT NULL.
  contactsSiteOrgFk: foreignKey({
    columns: [table.siteId, table.orgId],
    foreignColumns: [sites.id, sites.orgId],
    name: 'contacts_site_org_fk',
  }).onDelete('cascade'),
  contactsIdOrgIdUniq: uniqueIndex('contacts_id_org_id_uniq').on(table.id, table.orgId),
  contactsOrgIdx: index('contacts_org_idx').on(table.orgId),
  contactsSiteIdx: index('contacts_site_idx')
    .on(table.siteId).where(sql`${table.siteId} IS NOT NULL`),
  // NOT unique: a shared mailbox (info@, accounts@) is one address belonging
  // to several real people at one customer. Email is a preview-time match
  // hint; re-import idempotency comes from contact_external_links.
  contactsOrgEmailIdx: index('contacts_org_email_idx')
    .on(table.orgId, sql`lower(${table.email})`).where(sql`${table.email} IS NOT NULL`),
  contactsOrgPrimaryUniq: uniqueIndex('contacts_org_primary_uniq')
    .on(table.orgId).where(sql`${table.isPrimary} AND ${table.siteId} IS NULL`),
  contactsSitePrimaryUniq: uniqueIndex('contacts_site_primary_uniq')
    .on(table.siteId).where(sql`${table.isPrimary} AND ${table.siteId} IS NOT NULL`),
  contactsIdentifiableChk: check(
    'contacts_identifiable_chk',
    sql`${table.name} IS NOT NULL OR ${table.email} IS NOT NULL OR ${table.phone} IS NOT NULL OR ${table.mobile} IS NOT NULL`,
  ),
}));

/**
 * Re-import identity for contacts, mirroring `organization_external_links`.
 *
 * Email cannot serve as the dedupe key — shared mailboxes, phone-only
 * contacts, and email changes are all identity problems the `users` table
 * already paid for (email_epoch / pending_email). Records with no safe
 * natural key need an explicit source id.
 *
 * The unique index is ORG-scoped, deliberately diverging from
 * `organization_external_links`' PARTNER-scoped key: one person can work for
 * two of an MSP's customers, and partner scoping would collapse those two
 * relationships onto a single row spanning two tenants. Do not "fix" this to
 * match the org table.
 */
export const contactExternalLinks = pgTable('contact_external_links', {
  id: uuid('id').primaryKey().defaultRandom(),
  contactId: uuid('contact_id').notNull(),
  orgId: uuid('org_id').notNull(),
  system: text('system').notNull(),
  externalId: text('external_id').notNull(),
  createdBy: uuid('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  contactExternalLinksContactOrgFk: foreignKey({
    columns: [table.contactId, table.orgId],
    foreignColumns: [contacts.id, contacts.orgId],
    name: 'contact_external_links_contact_org_fk',
  }).onDelete('cascade'),
  contactExternalLinksUniq: uniqueIndex('contact_external_links_uniq')
    .on(table.orgId, table.system, table.externalId),
  contactExternalLinksContactIdx: index('contact_external_links_contact_idx')
    .on(table.contactId),
}));

export type Contact = typeof contacts.$inferSelect;
export type NewContact = typeof contacts.$inferInsert;
export type ContactExternalLink = typeof contactExternalLinks.$inferSelect;
export type NewContactExternalLink = typeof contactExternalLinks.$inferInsert;
