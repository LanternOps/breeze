import { boolean, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type { AiAgentProtectedResources, RiskTier, TouchClass } from '@breeze/shared';
import { organizations, partners } from './orgs';
import { users } from './users';

/**
 * AI script authoring W04 (#5612). Dual-ownership (#2135): the PARTNER row is
 * a CEILING, the ORG row is a GRANT. A missing org row means the lane is off
 * for that org regardless of the partner row (spec D10). CHECK constraints
 * (ai_script_policies_one_owner_chk / _org_grant_chk / _partner_ceiling_chk /
 * _tier_chk / _classes_chk / _per_hour_chk) live in
 * migrations/2026-10-16-120200-ai-script-policies.sql — Drizzle is for typed
 * queries, never the constraint source of truth.
 */
export const aiScriptPolicies = pgTable(
  'ai_script_policies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'cascade' }),
    partnerId: uuid('partner_id').references(() => partners.id, { onDelete: 'cascade' }),
    proposingEnabled: boolean('proposing_enabled').notNull().default(true),
    /** PARTNER ceiling only: may any org under this partner use the lane. */
    unattendedAllowed: boolean('unattended_allowed').notNull().default(false),
    /** ORG grant only: this org has opted in. */
    unattendedEnabled: boolean('unattended_enabled').notNull().default(false),
    maxUnattendedRiskTier: text('max_unattended_risk_tier').$type<RiskTier>().notNull().default('low'),
    unattendedAllowedClasses: text('unattended_allowed_classes')
      .array()
      .$type<TouchClass[]>()
      .notNull()
      .default(sql`ARRAY['services','processes','temp_files','dns_cache','printing']::text[]`),
    maxUnattendedPerHour: integer('max_unattended_per_hour').notNull().default(10),
    protectedResources: jsonb('protected_resources')
      .$type<AiAgentProtectedResources>()
      .notNull()
      .default(sql`'{"services":[],"paths":[],"registryKeys":[],"deviceTags":[]}'::jsonb`),
    reviewerModel: text('reviewer_model'),
    unattendedEnabledBy: uuid('unattended_enabled_by').references(() => users.id, { onDelete: 'set null' }),
    unattendedEnabledAt: timestamp('unattended_enabled_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Total uniques (NULLs never collide), so `keep-survivor` merge applies.
    orgUq: uniqueIndex('ai_script_policies_org_uq').on(t.orgId),
    partnerUq: uniqueIndex('ai_script_policies_partner_uq').on(t.partnerId),
  }),
);

export type AiScriptPolicyRow = typeof aiScriptPolicies.$inferSelect;
export type NewAiScriptPolicyRow = typeof aiScriptPolicies.$inferInsert;
