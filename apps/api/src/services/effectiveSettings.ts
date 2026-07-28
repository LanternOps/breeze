import { isDeepStrictEqual } from 'node:util';
import { eq } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { db } from '../db';
import { readWithPartnerAxisVisibility } from '../db/partnerAxisRead';
import { organizations, partners } from '../db/schema/orgs';
import { aiBudgets } from '../db/schema/ai';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Categories that can appear in partner/org settings JSONB */
const SETTING_CATEGORIES = [
  'security',
  'notifications',
  'eventLogs',
  'defaults',
  'branding',
] as const;

type SettingCategory = (typeof SETTING_CATEGORIES)[number];

interface EffectiveSettingsResult {
  /** Merged settings — partner values win, org fills gaps */
  effective: Record<string, Record<string, unknown>>;
  /** Dot-path list of fields locked by the partner (e.g. "security.requireMfa") */
  locked: string[];
}

interface EffectiveAiBudget {
  enabled: boolean;
  monthlyBudgetCents: number | null;
  dailyBudgetCents: number | null;
  maxTurnsPerSession: number;
  messagesPerMinutePerUser: number;
  messagesPerHourPerOrg: number;
  approvalMode: string;
}

const AI_BUDGET_DEFAULTS: EffectiveAiBudget = {
  enabled: true,
  monthlyBudgetCents: null,
  dailyBudgetCents: null,
  maxTurnsPerSession: 50,
  messagesPerMinutePerUser: 20,
  messagesPerHourPerOrg: 200,
  approvalMode: 'per_step',
};

const AI_BUDGET_FIELDS = [
  'enabled',
  'monthlyBudgetCents',
  'dailyBudgetCents',
  'maxTurnsPerSession',
  'messagesPerMinutePerUser',
  'messagesPerHourPerOrg',
  'approvalMode',
] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Safe cast of JSONB value to a plain object (returns {} for null/non-objects). */
function asRecord(val: unknown): Record<string, unknown> {
  if (val && typeof val === 'object' && !Array.isArray(val)) {
    return val as Record<string, unknown>;
  }
  return {};
}

/**
 * Merge a single settings category.
 * Partner fields always win and are added to `locked`.
 * Org fields only fill in fields the partner hasn't set.
 */
function mergeCategory(
  category: string,
  partnerCat: Record<string, unknown>,
  orgCat: Record<string, unknown>,
  locked: string[],
): Record<string, unknown> {
  const effective: Record<string, unknown> = {};

  // Partner fields win
  for (const [field, value] of Object.entries(partnerCat)) {
    effective[field] = value;
    locked.push(`${category}.${field}`);
  }

  // Org fills gaps
  for (const [field, value] of Object.entries(orgCat)) {
    if (!(field in partnerCat)) {
      effective[field] = value;
    }
  }

  return effective;
}

// ---------------------------------------------------------------------------
// getEffectiveOrgSettings
// ---------------------------------------------------------------------------

/**
 * Build the effective settings for an org by merging partner defaults on top.
 *
 * For each category (security, notifications, eventLogs, defaults, branding)
 * the partner value locks the field — the org value only applies where the
 * partner hasn't set anything.
 *
 * Also merges AI budget: partner JSONB `aiBudgets` overrides the org's
 * `ai_budgets` table row, with hard-coded defaults as the final fallback.
 */
export async function getEffectiveOrgSettings(
  orgId: string,
): Promise<EffectiveSettingsResult> {
  // Fetch the org + its partner in one go
  const org = await db
    .select({
      settings: organizations.settings,
      partnerId: organizations.partnerId,
    })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .then((rows) => rows[0]);

  if (!org) {
    throw new HTTPException(404, { message: 'Organization not found' });
  }

  // System context (#2822). `partners` is partner-axis
  // (`breeze_has_partner_access(id)`) and `computeAccessiblePartnerIds` returns
  // [] for scope 'organization', but GET /orgs/organizations/:id/effective-settings
  // is requireScope('organization','partner','system') and even has an explicit
  // org-scope branch — org callers are intended. Under the ambient context the
  // read returned zero rows and this threw 404 "Partner not found" for an org
  // admin looking at their OWN org's settings. Pinned to the partnerId of an
  // `organizations` row already resolved under the caller's own RLS context,
  // so it cannot reach a partner the caller can't already see through its org.
  const partner = await readWithPartnerAxisVisibility(() =>
    db
      .select({ settings: partners.settings })
      .from(partners)
      .where(eq(partners.id, org.partnerId))
      .then((rows) => rows[0])
  );

  if (!partner) {
    throw new HTTPException(404, { message: 'Partner not found' });
  }

  const partnerSettings = asRecord(partner.settings);
  const orgSettings = asRecord(org.settings);

  const effective: Record<string, Record<string, unknown>> = {};
  const locked: string[] = [];

  // Merge each category
  for (const category of SETTING_CATEGORIES) {
    const partnerCat = asRecord(partnerSettings[category]);
    const orgCat = asRecord(orgSettings[category]);

    // Only include the category if either side has data
    if (
      Object.keys(partnerCat).length > 0 ||
      Object.keys(orgCat).length > 0
    ) {
      effective[category] = mergeCategory(category, partnerCat, orgCat, locked);
    }
  }

  // Merge AI budget
  const partnerBudget = asRecord(partnerSettings.aiBudgets);

  const orgBudgetRow = await db
    .select()
    .from(aiBudgets)
    .where(eq(aiBudgets.orgId, orgId))
    .then((rows) => rows[0]);

  const mergedBudget: Record<string, unknown> = { ...AI_BUDGET_DEFAULTS };

  // Org table row fills in on top of defaults
  if (orgBudgetRow) {
    for (const field of AI_BUDGET_FIELDS) {
      const val = orgBudgetRow[field];
      if (val !== null && val !== undefined) {
        mergedBudget[field] = val;
      }
    }
  }

  // Partner JSONB wins and locks
  for (const field of AI_BUDGET_FIELDS) {
    if (field in partnerBudget && partnerBudget[field] !== undefined) {
      mergedBudget[field] = partnerBudget[field];
      locked.push(`aiBudgets.${field}`);
    }
  }

  effective.aiBudgets = mergedBudget;

  return { effective, locked };
}

// ---------------------------------------------------------------------------
// assertNotLocked
// ---------------------------------------------------------------------------

/**
 * Guard for org-level PATCH routes.
 *
 * `patch` maps each submitted field name to the value the org is trying to write.
 * A field is rejected only when the partner has set it AND the org is submitting
 * a *different* value — i.e. the org is genuinely attempting to change a locked
 * field. Re-submitting the value the partner already mandates is a no-op and is
 * allowed.
 *
 * That distinction matters because the org settings editors PUT the whole
 * `settings` blob on every save (see handleSaveSettings in OrgSettingsPage), so
 * every stored category is re-submitted even when the operator only touched one
 * field. Under the old presence-only test (`field in partnerCat`) a single
 * partner-set field therefore 403'd the entire request, blocking unrelated
 * fields the partner never intended to enforce (issue #2752 — `autoEnrollment`
 * is always present in the `defaults` payload, so it locked the whole category).
 *
 * Note this deliberately does NOT change `mergeCategory`/`locked` reporting: a
 * partner-set field is still advertised as locked, and getOrgAgentUpdateConfig's
 * presence-based resolution stays in lockstep with it. Only the write guard's
 * strictness changes, from "field present" to "value actually diverges".
 */
export async function assertNotLocked(
  orgId: string,
  category: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const org = await db
    .select({ partnerId: organizations.partnerId })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .then((rows) => rows[0]);

  if (!org) {
    throw new HTTPException(404, { message: 'Organization not found' });
  }

  // System context (#2822). Reached from PUT /ai/budget, which is
  // requireScope('organization','partner','system'): the ambient-context read
  // returned zero rows for an org-scoped admin, so this 404'd "Partner not
  // found" and the budget update never ran. Same pinning argument as
  // getEffectiveOrgSettings above.
  const partner = await readWithPartnerAxisVisibility(() =>
    db
      .select({ settings: partners.settings })
      .from(partners)
      .where(eq(partners.id, org.partnerId))
      .then((rows) => rows[0])
  );

  if (!partner) {
    throw new HTTPException(404, { message: 'Partner not found' });
  }

  const partnerSettings = asRecord(partner.settings);
  const partnerCat = asRecord(partnerSettings[category]);

  const lockedFields = Object.keys(patch).filter(
    (f) => f in partnerCat && !isDeepStrictEqual(patch[f], partnerCat[f]),
  );

  if (lockedFields.length > 0) {
    throw new HTTPException(403, {
      message: `The following fields are locked by the partner and cannot be changed: ${lockedFields.map((f) => `${category}.${f}`).join(', ')}`,
    });
  }
}

// ---------------------------------------------------------------------------
// getEffectiveAiBudget
// ---------------------------------------------------------------------------

/**
 * Lightweight helper for runtime budget checks.
 *
 * Returns the merged AI budget config for an org with defaults applied.
 * Partner JSONB `aiBudgets` overrides the org's `ai_budgets` table row.
 */
export async function getEffectiveAiBudget(
  orgId: string,
): Promise<EffectiveAiBudget> {
  const org = await db
    .select({ partnerId: organizations.partnerId })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .then((rows) => rows[0]);

  if (!org) {
    throw new HTTPException(404, { message: 'Organization not found' });
  }

  // The `partners` half runs in a system context (#2822). Callers
  // (services/aiCostTracker.ts checkBudget / checkAiRateLimit) wrap this in a
  // bare `withSystemDbAccessContext`, which is a NO-OP inside a request — it
  // inherits the caller's org scope — so under an org-scoped AI chat session
  // the read returned zero rows and every turn failed with "Unable to verify
  // budget. Please try again." Pinned to the org's own partnerId; the
  // `ai_budgets` half deliberately stays in the caller's context (it is
  // org-axis and RLS must keep guarding it).
  const [partner, orgBudgetRow] = await Promise.all([
    readWithPartnerAxisVisibility(() =>
      db
        .select({ settings: partners.settings })
        .from(partners)
        .where(eq(partners.id, org.partnerId))
        .then((rows) => rows[0])
    ),
    db
      .select()
      .from(aiBudgets)
      .where(eq(aiBudgets.orgId, orgId))
      .then((rows) => rows[0]),
  ]);

  // Start from defaults
  const result: EffectiveAiBudget = { ...AI_BUDGET_DEFAULTS };

  // Org table row overrides defaults
  if (orgBudgetRow) {
    for (const field of AI_BUDGET_FIELDS) {
      const val = orgBudgetRow[field];
      if (val !== null && val !== undefined) {
        result[field] = val as never;
      }
    }
  }

  // Partner JSONB wins
  if (!partner) {
    throw new HTTPException(404, { message: 'Partner not found' });
  }
  {
    const partnerBudget = asRecord(asRecord(partner.settings).aiBudgets);
    for (const field of AI_BUDGET_FIELDS) {
      if (field in partnerBudget && partnerBudget[field] !== undefined) {
        result[field] = partnerBudget[field] as never;
      }
    }
  }

  return result;
}
