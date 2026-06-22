/**
 * PAM-native rules (#1163).
 *
 * Distinct from `software_policies`: the bridge (services/pamBridge.ts)
 * consults the device's winning software policy first; when no software
 * policy binds, ingest falls through to these PAM-native rules. The Rules
 * tab of the /pam admin UI (#1159) manages this table.
 *
 * Tenancy: Shape 1 (direct org_id) — RLS policies in the migration use
 * breeze_has_org_access(org_id), mirroring elevation_requests (#905).
 * site_id narrows a rule to one site; null = org-wide.
 */
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { organizations, sites } from './orgs';
import { users } from './users';

export const pamRuleVerdictEnum = pgEnum('pam_rule_verdict', [
  'auto_approve',
  'auto_deny',
  'require_approval',
  'ignore',
]);

/**
 * Optional time window during which a rule is active.
 * Times are "HH:MM" 24h in the org's timezone; days are 0-6 (Sun-Sat).
 * Absent/null window = always active.
 */
export interface PamRuleTimeWindow {
  start: string;
  end: string;
  days?: number[];
  timezone?: string;
}

/**
 * Criterion keys eligible for negation via pam_rules.match_negate. Each maps
 * to a single match* column; the engine inverts that criterion's result.
 * time_window is deliberately excluded (it narrows, it doesn't identify).
 */
export const PAM_RULE_NEGATE_KEYS = [
  'signer',
  'signerGroup',
  'hash',
  'pathGlob',
  'parentImage',
  'commandLine',
  'user',
  'adGroup',
  'toolName',
  'riskTier',
] as const;
export type PamRuleNegateKey = (typeof PAM_RULE_NEGATE_KEYS)[number];

/** Default verdict applied when no software policy or PAM rule matches. */
export const pamUnmatchedVerdictEnum = pgEnum('pam_unmatched_verdict', [
  'require_approval',
  'auto_deny',
]);

/**
 * Reusable trusted-publisher catalog (signer groups). An org maintains a named
 * set of Authenticode signer (subject CN) patterns once — e.g. a "Trusted
 * Vendors" group with Intuit Inc., Microsoft Corporation, TeamViewer GmbH —
 * and references it from many rules via pam_rules.match_signer_group_id. A rule
 * with a group matches when the candidate's signer equals ANY member (OR within
 * the group), while the rule's other criteria still AND. Resolution is entirely
 * server-side (the engine receives the resolved member list); the agent never
 * sees groups. Tenancy: Shape 1 (direct org_id), RLS mirrors pam_rules.
 */
export const pamSignerGroups = pgTable(
  'pam_signer_groups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 255 }).notNull(),
    description: text('description'),
    // Signer subject-CN patterns; matched case-insensitively, exact (same
    // semantics as pam_rules.match_signer). Empty = matches nothing.
    signers: jsonb('signers').$type<string[]>().notNull().default([]),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgNameUnique: uniqueIndex('pam_signer_groups_org_id_name_unique').on(
      table.orgId,
      table.name,
    ),
  }),
);

export type PamSignerGroup = typeof pamSignerGroups.$inferSelect;
export type NewPamSignerGroup = typeof pamSignerGroups.$inferInsert;

export const pamRules = pgTable(
  'pam_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // Tenancy (Shape 1)
    orgId: uuid('org_id').notNull().references(() => organizations.id),
    siteId: uuid('site_id').references(() => sites.id),

    name: varchar('name', { length: 255 }).notNull(),
    description: text('description'),
    enabled: boolean('enabled').notNull().default(true),

    // Lower number = evaluated first. Ties broken by created_at then id.
    priority: integer('priority').notNull().default(100),

    // Match criteria — all provided criteria must match (AND). A rule with
    // no criteria matches nothing (guarded at the API layer).
    matchSigner: varchar('match_signer', { length: 255 }),
    // Alternative to matchSigner: match the candidate signer against ANY member
    // of a reusable signer group (pam_signer_groups). Mutually exclusive with
    // matchSigner (the API rejects setting both). Resolved server-side.
    matchSignerGroupId: uuid('match_signer_group_id').references(
      () => pamSignerGroups.id,
      { onDelete: 'restrict' },
    ),
    matchHash: varchar('match_hash', { length: 64 }),
    matchPathGlob: text('match_path_glob'),
    matchParentImage: text('match_parent_image'),
    // Case-insensitive substring of the launched process command line. Lets a
    // rule scope auto-elevation to a specific invocation of an otherwise broad
    // binary — e.g. only `rundll32 ... printui.dll,PrintUIEntry`, not all of
    // rundll32. The uac_intercept payload carries `command_line`.
    matchCommandLine: text('match_command_line'),
    matchUser: varchar('match_user', { length: 255 }),
    matchAdGroup: varchar('match_ad_group', { length: 255 }),
    // Tool-action criteria (Phase 1 Helper governance). A rule is either
    // executable-shaped (signer/hash/path/parent) or tool-action-shaped
    // (tool name / risk tier) — the API layer rejects mixing the two.
    matchToolName: varchar('match_tool_name', { length: 100 }),
    matchRiskTier: smallint('match_risk_tier'),
    // Criterion keys whose match the engine INVERTS ("does NOT match"), e.g.
    // ["pathGlob"] turns a path-glob criterion into an exclusion. Negation
    // requires the candidate field to be present (absent data never satisfies
    // a negated criterion — it can't accidentally over-grant). See
    // pamRuleEngine.ruleMatches.
    matchNegate: jsonb('match_negate').$type<PamRuleNegateKey[] | null>(),
    timeWindow: jsonb('time_window').$type<PamRuleTimeWindow | null>(),

    verdict: pamRuleVerdictEnum('verdict').notNull(),

    // For verdict='auto_approve' / approve flows: how long the elevation
    // stays valid. Null falls back to the org default at decision time.
    approvalDurationMinutes: integer('approval_duration_minutes'),

    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgIdIdx: index('pam_rules_org_id_idx').on(table.orgId),
    orgEnabledPriorityIdx: index('pam_rules_org_enabled_priority_idx').on(
      table.orgId,
      table.enabled,
      table.priority,
    ),
  }),
);

export type PamRule = typeof pamRules.$inferSelect;
export type NewPamRule = typeof pamRules.$inferInsert;

/**
 * Per-org PAM configuration (#PAM matching cluster).
 *
 * Today: the default verdict for an elevation that matches no software policy
 * and no PAM rule. The historical behavior is `require_approval` (the request
 * waits for a human); an org can opt into `auto_deny` (block-by-default).
 *
 * Tenancy: Shape 1 (direct org_id) — RLS policies in the migration use
 * breeze_has_org_access(org_id), mirroring pam_rules. One row per org
 * (unique org_id); absence of a row means the `require_approval` default.
 */
export const pamOrgConfig = pgTable(
  'pam_org_config',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    defaultUnmatchedVerdict: pamUnmatchedVerdictEnum('default_unmatched_verdict')
      .notNull()
      .default('require_approval'),
    updatedByUserId: uuid('updated_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgIdUnique: uniqueIndex('pam_org_config_org_id_unique').on(table.orgId),
  }),
);

export type PamOrgConfig = typeof pamOrgConfig.$inferSelect;
export type NewPamOrgConfig = typeof pamOrgConfig.$inferInsert;
