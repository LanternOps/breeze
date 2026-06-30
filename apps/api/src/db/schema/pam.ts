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
  'signerThumbprint',
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

/**
 * Signer-group catalog entry (#1776). A group pins a publisher by:
 *   - subject CN only (WEAK tier — attacker-choosable, kept for back-compat);
 *   - SHA-256 Authenticode leaf-cert thumbprint only (STRONG tier — bound to a
 *     specific key, not forgeable without the private key); or
 *   - both (STRONG — the engine requires BOTH to match; see pamRuleEngine).
 * `thumbprint` is lowercase 64-char hex. A thumbprint-pinned entry NEVER falls
 * through to a CN match, so a forged cert bearing a trusted CN but a different
 * thumbprint is rejected — the elevation-of-privilege threat #1776 closes.
 */
export type SignerGroupEntry =
  | { subjectCn: string; thumbprint?: string }
  | { thumbprint: string };

/**
 * As persisted in pam_signer_groups.signers (jsonb). Backward-compatible with
 * the legacy `string[]` form: a bare string is a subject-CN-only entry. New
 * writes use the object form. normalizeSignerGroupEntries() maps either to the
 * canonical SignerGroupEntry the engine consumes — existing rows need no data
 * migration. The stored object form is intentionally looser than
 * SignerGroupEntry (both fields optional) so a malformed/partial row can't be a
 * type error on read; the normalizer drops entries with neither field.
 */
export type StoredSignerEntry = string | { subjectCn?: string; thumbprint?: string };

const SIGNER_THUMBPRINT_RE = /^[0-9a-f]{64}$/;

/**
 * Normalize the persisted `signers` array (legacy bare CNs and/or new entry
 * objects) into the canonical SignerGroupEntry[] the engine matches against.
 * Defensive: tolerates arbitrary jsonb (returns [] for non-arrays), trims, and
 * drops entries that carry neither a usable CN nor a valid 64-hex thumbprint
 * (fail closed — a junk entry must never widen a match).
 */
export function normalizeSignerGroupEntries(raw: unknown): SignerGroupEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: SignerGroupEntry[] = [];
  for (const el of raw) {
    if (typeof el === 'string') {
      const cn = el.trim();
      if (cn) out.push({ subjectCn: cn });
      continue;
    }
    if (el && typeof el === 'object') {
      const rec = el as { subjectCn?: unknown; thumbprint?: unknown };
      const cn = typeof rec.subjectCn === 'string' ? rec.subjectCn.trim() : '';
      const tpRaw = typeof rec.thumbprint === 'string' ? rec.thumbprint.trim().toLowerCase() : '';
      const tp = SIGNER_THUMBPRINT_RE.test(tpRaw) ? tpRaw : '';
      if (cn && tp) out.push({ subjectCn: cn, thumbprint: tp });
      else if (tp) out.push({ thumbprint: tp });
      else if (cn) out.push({ subjectCn: cn });
    }
  }
  return out;
}

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
    // Signer catalog entries (#1776). Legacy rows hold a `string[]` of subject
    // CNs (weak tier); new rows may hold entry objects pinning a SHA-256
    // thumbprint (strong tier). Read via normalizeSignerGroupEntries(); the
    // engine resolves these to SignerGroupEntry[] and matches per the
    // strong/weak precedence. Empty = matches nothing.
    signers: jsonb('signers').$type<StoredSignerEntry[]>().notNull().default([]),
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
    // STRONG-tier signer pin (#1776): SHA-256 Authenticode leaf-cert thumbprint,
    // lowercase 64-char hex. Present-gated + constant-time compared in the
    // engine — a rule pinning a thumbprint matches ONLY when the candidate
    // carries that exact thumbprint (fail closed when absent), closing the
    // CN-spoofing elevation-of-privilege gap. ANDs with matchSigner when both
    // are set (max strength); mutually exclusive with matchSignerGroupId.
    matchSignerThumbprint: varchar('match_signer_thumbprint', { length: 64 }),
    // Alternative to matchSigner: match the candidate signer against ANY member
    // of a reusable signer group (pam_signer_groups). Mutually exclusive with
    // matchSigner / matchSignerThumbprint (the API rejects combining them).
    // Resolved server-side.
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
 * `uacInterceptionEnabled` is the org-level fallback for whether the agent
 * captures UAC events at all, consulted only when no 'pam' config-policy
 * feature link resolves for the device. NULL means "no opinion" → the global
 * opt-in default (off). It is set to true by the 2026-07-01 grandfathering
 * migration for orgs that had deliberately configured PAM before the switch.
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
    uacInterceptionEnabled: boolean('uac_interception_enabled'),
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
