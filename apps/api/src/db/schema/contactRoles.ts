import { sql } from 'drizzle-orm';
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
} from 'drizzle-orm/pg-core';
import { contacts } from './contacts';
import { deviceGroups } from './devices';
import { sites } from './orgs';

/**
 * Canonical scoped responsibility assignments for organization contacts.
 *
 * Tenancy: Shape 1 (direct org_id). Scope is encoded by nullable subordinate
 * FKs rather than a duplicated scope_type column:
 *   - site_id NULL + device_group_id NULL => Organization
 *   - site_id SET  + device_group_id NULL => Site
 *   - site_id NULL + device_group_id SET  => Device Group
 *
 * Composite FKs make cross-org assignments unrepresentable. The SQL migration
 * declares those FKs DEFERRABLE INITIALLY IMMEDIATE; Drizzle has no builder
 * option for that qualifier, so the migration remains the source of truth.
 */
export const contactRoles = pgTable('contact_roles', {
  id: uuid('id').primaryKey().defaultRandom(),
  contactId: uuid('contact_id').notNull(),
  orgId: uuid('org_id').notNull(),
  role: text('role').notNull(),
  isPrimary: boolean('is_primary').notNull().default(false),
  siteId: uuid('site_id'),
  deviceGroupId: uuid('device_group_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  contactOrgFk: foreignKey({
    columns: [table.contactId, table.orgId],
    foreignColumns: [contacts.id, contacts.orgId],
    name: 'contact_roles_contact_org_fk',
  }).onDelete('cascade'),
  siteOrgFk: foreignKey({
    columns: [table.siteId, table.orgId],
    foreignColumns: [sites.id, sites.orgId],
    name: 'contact_roles_site_org_fk',
  }).onDelete('cascade'),
  deviceGroupOrgFk: foreignKey({
    columns: [table.deviceGroupId, table.orgId],
    foreignColumns: [deviceGroups.id, deviceGroups.orgId],
    name: 'contact_roles_device_group_org_fk',
  }).onDelete('cascade'),
  // Migration adds NULLS NOT DISTINCT (PG16 project floor). Drizzle cannot
  // express that qualifier, so this declaration mirrors the indexed columns.
  exactAssignmentUniq: uniqueIndex('contact_roles_exact_assignment_uniq')
    .on(table.orgId, table.contactId, table.role, table.siteId, table.deviceGroupId),
  orgRoleIdx: index('contact_roles_org_role_idx').on(table.orgId, table.role),
  siteRoleIdx: index('contact_roles_site_role_idx')
    .on(table.siteId, table.role).where(sql`${table.siteId} IS NOT NULL`),
  deviceGroupRoleIdx: index('contact_roles_device_group_role_idx')
    .on(table.deviceGroupId, table.role).where(sql`${table.deviceGroupId} IS NOT NULL`),
  contactIdx: index('contact_roles_contact_idx').on(table.contactId),
  scopeChk: check(
    'contact_roles_scope_chk',
    sql`NOT (${table.siteId} IS NOT NULL AND ${table.deviceGroupId} IS NOT NULL)`,
  ),
  roleChk: check(
    'contact_roles_role_chk',
    sql`${table.role} IN ('billing', 'technical', 'escalation', 'admin', 'site', 'after_hours', 'portal')`,
  ),
}));

export type ContactRole = typeof contactRoles.$inferSelect;
export type NewContactRole = typeof contactRoles.$inferInsert;
