import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import type { PartnerServicePrincipalScope } from '../../services/partnerServicePrincipalScopes';
import { partners } from './orgs';
import { users } from './users';

export type PartnerServicePrincipalStatus = 'active' | 'disabled';
export type PartnerServicePrincipalKeyStatus = 'active' | 'revoked';

export const partnerServicePrincipals = pgTable('partner_service_principals', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id')
    .notNull()
    .references(() => partners.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description'),
  status: text('status').$type<PartnerServicePrincipalStatus>().notNull().default('active'),
  scopes: text('scopes')
    .array()
    .$type<PartnerServicePrincipalScope[]>()
    .notNull()
    .default([]),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  sourceCidrs: text('source_cidrs').array().notNull().default([]),
  createdBy: uuid('created_by').notNull().references(() => users.id),
  updatedBy: uuid('updated_by').notNull().references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  idPartnerUnique: unique('partner_service_principals_id_partner_unique')
    .on(table.id, table.partnerId),
  partnerNameUnique: unique('partner_service_principals_partner_name_unique')
    .on(table.partnerId, table.name),
  statusCheck: check(
    'partner_service_principals_status_check',
    sql`${table.status} IN ('active', 'disabled')`,
  ),
  scopesCheck: check(
    'partner_service_principals_scopes_check',
    sql`public.breeze_valid_partner_service_principal_scopes(${table.scopes})`,
  ),
}));

export const partnerServicePrincipalKeys = pgTable('partner_service_principal_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id')
    .notNull()
    .references(() => partners.id, { onDelete: 'cascade' }),
  partnerServicePrincipalId: uuid('partner_service_principal_id')
    .notNull()
    .references(() => partnerServicePrincipals.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  keyHash: text('key_hash').notNull(),
  keyPrefix: text('key_prefix').notNull(),
  status: text('status').$type<PartnerServicePrincipalKeyStatus>().notNull().default('active'),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  rateLimit: integer('rate_limit').notNull().default(600),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  rotatedFromId: uuid('rotated_from_id').references(
    (): AnyPgColumn => partnerServicePrincipalKeys.id,
    { onDelete: 'set null' },
  ),
  createdBy: uuid('created_by').notNull().references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  keyHashUnique: unique('partner_service_principal_keys_key_hash_unique').on(table.keyHash),
  idPartnerUnique: unique('partner_service_principal_keys_id_partner_unique')
    .on(table.id, table.partnerId),
  principalPartnerFk: foreignKey({
    columns: [table.partnerServicePrincipalId, table.partnerId],
    foreignColumns: [partnerServicePrincipals.id, partnerServicePrincipals.partnerId],
    name: 'partner_service_principal_keys_principal_partner_fk',
  }).onDelete('cascade'),
  rotatedFromPartnerFk: foreignKey({
    columns: [table.rotatedFromId, table.partnerId],
    foreignColumns: [table.id, table.partnerId],
    name: 'partner_service_principal_keys_rotated_from_partner_fk',
  }),
  statusCheck: check(
    'partner_service_principal_keys_status_check',
    sql`${table.status} IN ('active', 'revoked')`,
  ),
  rateLimitCheck: check(
    'partner_service_principal_keys_rate_limit_check',
    sql`${table.rateLimit} BETWEEN 1 AND 10000`,
  ),
}));

export type PartnerServicePrincipal = typeof partnerServicePrincipals.$inferSelect;
export type NewPartnerServicePrincipal = typeof partnerServicePrincipals.$inferInsert;
export type PartnerServicePrincipalKey = typeof partnerServicePrincipalKeys.$inferSelect;
export type NewPartnerServicePrincipalKey = typeof partnerServicePrincipalKeys.$inferInsert;
