import { sql } from 'drizzle-orm';
import {
  check,
  cidr,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { partners } from './orgs';
import { users } from './users';

export type PartnerDeployKeyStatus = 'active' | 'revoked';

/**
 * Deploy keys for the holding area (#8318 wave D-1, spec §10.1).
 * Partner-axis (shape 3), RLS system-only on top of the partner-axis policy —
 * see migrations/2027-01-31-100000-partner-deploy-keys.sql. Only the peppered
 * hash of the key is stored; the plaintext is shown once.
 */
export const partnerDeployKeys = pgTable('partner_deploy_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 255 }).notNull(),
  imageLabel: varchar('image_label', { length: 100 }).notNull(),
  keyHash: varchar('key_hash', { length: 64 }).notNull(),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  maxUsage: integer('max_usage').notNull(),
  usageCount: integer('usage_count').notNull().default(0),
  maxParked: integer('max_parked').notNull(),
  status: text('status').$type<PartnerDeployKeyStatus>().notNull().default('active'),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  revokedBy: uuid('revoked_by').references(() => users.id, { onDelete: 'set null' }),
  rotatedFromId: uuid('rotated_from_id').references((): AnyPgColumn => partnerDeployKeys.id, { onDelete: 'set null' }),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  lastUsedIp: varchar('last_used_ip', { length: 45 }),
  sourceCidrs: cidr('source_cidrs').array(),
}, (table) => [
  unique('partner_deploy_keys_key_hash_key').on(table.keyHash),
  index('partner_deploy_keys_partner_created_idx').on(table.partnerId, table.createdAt),
  index('partner_deploy_keys_partner_image_active_idx')
    .on(table.partnerId, sql`lower(${table.imageLabel})`)
    .where(sql`${table.status} = 'active'`),
  index('partner_deploy_keys_rotated_from_idx').on(table.rotatedFromId),
  check('partner_deploy_keys_name_chk', sql`length(btrim(${table.name})) > 0`),
  check('partner_deploy_keys_image_label_chk', sql`length(btrim(${table.imageLabel})) > 0`),
  check('partner_deploy_keys_max_usage_chk', sql`${table.maxUsage} BETWEEN 1 AND 1000`),
  check('partner_deploy_keys_max_parked_chk', sql`${table.maxParked} BETWEEN 1 AND 20`),
  check('partner_deploy_keys_usage_count_chk', sql`${table.usageCount} >= 0 AND ${table.usageCount} <= ${table.maxUsage}`),
  check('partner_deploy_keys_lifetime_chk',
    sql`${table.expiresAt} > ${table.createdAt} AND ${table.expiresAt} <= ${table.createdAt} + interval '365 days'`),
  check('partner_deploy_keys_status_chk', sql`${table.status} IN ('active', 'revoked')`),
  check('partner_deploy_keys_revocation_shape_chk', sql`(${table.status} = 'active' AND ${table.revokedAt} IS NULL AND ${table.revokedBy} IS NULL)
    OR (${table.status} = 'revoked' AND ${table.revokedAt} IS NOT NULL)`),
  check('partner_deploy_keys_source_cidrs_chk', sql`${table.sourceCidrs} IS NULL OR cardinality(${table.sourceCidrs}) > 0`),
  check('partner_deploy_keys_rotation_chk', sql`${table.rotatedFromId} IS NULL OR ${table.rotatedFromId} <> ${table.id}`),
]);

export type PartnerDeployKey = typeof partnerDeployKeys.$inferSelect;
export type NewPartnerDeployKey = typeof partnerDeployKeys.$inferInsert;
