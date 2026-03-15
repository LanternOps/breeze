import { eq } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { db } from '../db';
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

  const partner = await db
    .select({ settings: partners.settings })
    .from(partners)
    .where(eq(partners.id, org.partnerId))
    .then((rows) => rows[0]);

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
 * Loads the partner's settings for the given org and checks whether any of the
 * `patchFields` are locked (i.e. set in the partner's category). Throws a 403
 * HTTPException listing the locked fields if any are found.
 */
export async function assertNotLocked(
  orgId: string,
  category: string,
  patchFields: string[],
): Promise<void> {
  const org = await db
    .select({ partnerId: organizations.partnerId })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .then((rows) => rows[0]);

  if (!org) {
    throw new HTTPException(404, { message: 'Organization not found' });
  }

  const partner = await db
    .select({ settings: partners.settings })
    .from(partners)
    .where(eq(partners.id, org.partnerId))
    .then((rows) => rows[0]);

  if (!partner) {
    throw new HTTPException(404, { message: 'Partner not found' });
  }

  const partnerSettings = asRecord(partner.settings);
  const partnerCat = asRecord(partnerSettings[category]);

  const lockedFields = patchFields.filter((f) => f in partnerCat);

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

  const [partner, orgBudgetRow] = await Promise.all([
    db
      .select({ settings: partners.settings })
      .from(partners)
      .where(eq(partners.id, org.partnerId))
      .then((rows) => rows[0]),
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
  if (partner) {
    const partnerBudget = asRecord(asRecord(partner.settings).aiBudgets);
    for (const field of AI_BUDGET_FIELDS) {
      if (field in partnerBudget && partnerBudget[field] !== undefined) {
        result[field] = partnerBudget[field] as never;
      }
    }
  }

  return result;
}
