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
    matchHash: varchar('match_hash', { length: 64 }),
    matchPathGlob: text('match_path_glob'),
    matchParentImage: text('match_parent_image'),
    matchUser: varchar('match_user', { length: 255 }),
    matchAdGroup: varchar('match_ad_group', { length: 255 }),
    // Tool-action criteria (Phase 1 Helper governance). A rule is either
    // executable-shaped (signer/hash/path/parent) or tool-action-shaped
    // (tool name / risk tier) — the API layer rejects mixing the two.
    matchToolName: varchar('match_tool_name', { length: 100 }),
    matchRiskTier: smallint('match_risk_tier'),
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
