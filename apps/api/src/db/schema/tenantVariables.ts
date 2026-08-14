import { boolean, integer, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organizations, partners } from './orgs';
import { users } from './users';

/**
 * Tenant variables (#3409). A value an MSP defines once and references from
 * scripts / software deployment instead of hardcoding it per customer.
 *
 * Dual-axis ownership (Partner-Wide First, epic #2135): org_id XOR partner_id,
 * enforced by tenant_variables_one_owner_chk in
 * 2026-08-11-tenant-variables.sql. Resolution precedence is org > partner.
 *
 * `value` is ALWAYS ciphertext — write it only through
 * services/tenantVariables.ts, which binds the encryption AAD to the row id so
 * a ciphertext blob cannot be transplanted from another tenant's row. Never
 * insert or update this column with a plaintext literal.
 */
export const tenantVariables = pgTable(
  'tenant_variables',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    partnerId: uuid('partner_id').references(() => partners.id, { onDelete: 'cascade' }),
    orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'cascade' }),
    key: varchar('key', { length: 64 }).notNull(),
    value: text('value').notNull(),
    isSecret: boolean('is_secret').notNull().default(false),
    description: varchar('description', { length: 500 }),
    /** Bumped on every value change; PR 4 pins {variableId, version} in the four-eyes effect digest. */
    version: integer('version').notNull().default(1),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull()
  },
  (t) => [
    uniqueIndex('tenant_variables_org_key_uniq').on(t.orgId, t.key).where(sql`org_id IS NOT NULL`),
    uniqueIndex('tenant_variables_partner_key_uniq').on(t.partnerId, t.key).where(sql`partner_id IS NOT NULL`)
  ]
);

export type TenantVariableRow = typeof tenantVariables.$inferSelect;
