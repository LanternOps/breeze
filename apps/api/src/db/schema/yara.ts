import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  boolean,
  jsonb,
  integer,
  char,
  index,
  uniqueIndex,
  unique
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organizations, partners } from './orgs';
import { users, bytea } from './users';
import { threatSeverityEnum } from './security';

/**
 * YARA rule sets (#6263 W03, migration 2026-12-30-230000-yara-rule-sets.sql).
 *
 * Owned by an org XOR a partner, or the single read-only built-in pack
 * (isBuiltin, both owners NULL — written only under system scope). The
 * `published*` columns are the last pre-check-clean W02 §C2 source bundle,
 * served byte for byte to agents; `currentVersion` moves on every edit and
 * `stale` marks a set whose latest edit failed the pre-check (DECISION W03-a).
 */
export const yaraRuleSets = pgTable('yara_rule_sets', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'cascade' }),
  partnerId: uuid('partner_id').references(() => partners.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  source: varchar('source', { length: 50 }).notNull().default('custom'),
  isBuiltin: boolean('is_builtin').notNull().default(false),
  enabled: boolean('enabled').notNull().default(true),
  autoQuarantine: boolean('auto_quarantine').notNull().default(false),
  currentVersion: integer('current_version').notNull().default(0),
  publishedVersion: integer('published_version').notNull().default(0),
  publishedBundle: bytea('published_bundle'),
  publishedSha256: char('published_sha256', { length: 64 }),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  publishedEngine: varchar('published_engine', { length: 64 }),
  publishedPolicy: integer('published_policy'),
  stale: boolean('stale').notNull().default(false),
  ruleCount: integer('rule_count').notNull().default(0),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull()
}, (table) => ({
  orgIdx: index('yara_rule_sets_org_idx').on(table.orgId),
  partnerIdx: index('yara_rule_sets_partner_idx').on(table.partnerId),
  singleBuiltinIdx: uniqueIndex('yara_rule_sets_single_builtin_idx')
    .on(sql`(true)`)
    .where(sql`${table.isBuiltin}`)
}));

/**
 * One YARA rule. `orgId`/`partnerId`/`isBuiltin` are copied from the parent
 * set by the `yara_rules_inherit_owner` trigger on every write — whatever the
 * caller passes is overwritten (DECISION W03-c).
 */
export const yaraRules = pgTable('yara_rules', {
  id: uuid('id').primaryKey().defaultRandom(),
  ruleSetId: uuid('rule_set_id').notNull().references(() => yaraRuleSets.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'cascade' }),
  partnerId: uuid('partner_id').references(() => partners.id, { onDelete: 'cascade' }),
  isBuiltin: boolean('is_builtin').notNull().default(false),
  name: varchar('name', { length: 128 }).notNull(),
  source: text('source').notNull(),
  severity: threatSeverityEnum('severity').notNull().default('high'),
  tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
  meta: jsonb('meta'),
  enabled: boolean('enabled').notNull().default(true),
  compileError: text('compile_error'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull()
}, (table) => ({
  orgIdx: index('yara_rules_org_idx').on(table.orgId),
  partnerIdx: index('yara_rules_partner_idx').on(table.partnerId),
  setNameUniq: unique('yara_rules_set_name_uniq').on(table.ruleSetId, table.name)
}));

export type YaraRuleSet = typeof yaraRuleSets.$inferSelect;
export type YaraRule = typeof yaraRules.$inferSelect;
