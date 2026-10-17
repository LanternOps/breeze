import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../db';
import { readOwnPartnerAxisRows } from '../db/partnerAxisRead';
import { aiDataPolicies, organizations, type AiDataPolicyRow, type AiDeviceFileReadLevel } from '../db/schema';

export type AiDataPolicySource = 'org' | 'partner' | 'default';
export type EffectiveAiDataPolicy = {
  deviceFileReadLevel: AiDeviceFileReadLevel;
  toolOutputRetentionDays: number | null;
  source: { deviceFileReadLevel: AiDataPolicySource; toolOutputRetentionDays: AiDataPolicySource };
};

export const AI_DATA_POLICY_DEFAULTS = {
  deviceFileReadLevel: 'no_user_profiles',
  toolOutputRetentionDays: 30,
} as const;

const LEVEL_RANK: Record<AiDeviceFileReadLevel, number> = { off: 0, no_user_profiles: 1, any_with_approval: 2 };
export function levelRank(level: AiDeviceFileReadLevel): number { return LEVEL_RANK[level]; }

/** Pure merge: partner (or defaults) is the ceiling; the org row may only tighten. */
export function mergeAiDataPolicies(partner: AiDataPolicyRow | null, org: AiDataPolicyRow | null): EffectiveAiDataPolicy {
  const ceilingLevel = partner?.deviceFileReadLevel ?? AI_DATA_POLICY_DEFAULTS.deviceFileReadLevel;
  const ceilingLevelSource: AiDataPolicySource = partner?.deviceFileReadLevel ? 'partner' : 'default';
  const orgLevel = org?.deviceFileReadLevel ?? null;
  const level = orgLevel && levelRank(orgLevel) < levelRank(ceilingLevel) ? orgLevel : ceilingLevel;
  const levelSource: AiDataPolicySource = level === orgLevel && orgLevel !== null && levelRank(orgLevel) < levelRank(ceilingLevel) ? 'org' : ceilingLevelSource;

  // Retention: partner row present → its value (NULL = forever); no partner row → 30.
  const ceilingDays = partner ? partner.toolOutputRetentionDays : AI_DATA_POLICY_DEFAULTS.toolOutputRetentionDays;
  const ceilingDaysSource: AiDataPolicySource = partner ? 'partner' : 'default';
  const orgDays = org?.toolOutputRetentionDays ?? null;
  let days: number | null = ceilingDays;
  let daysSource: AiDataPolicySource = ceilingDaysSource;
  if (orgDays !== null && (ceilingDays === null || orgDays < ceilingDays)) { days = orgDays; daysSource = 'org'; }

  return { deviceFileReadLevel: level, toolOutputRetentionDays: days, source: { deviceFileReadLevel: levelSource, toolOutputRetentionDays: daysSource } };
}

/**
 * The org's owning partner, read under the CALLER's RLS. This read is the
 * access gate for everything below: an org the caller cannot see yields no
 * partner id, so no partner row is ever read on its behalf. Exported for the
 * executeTool gate, which treats `null` as "cannot establish" and refuses.
 */
export async function readOrgPartnerId(orgId: string): Promise<string | null> {
  const [row] = await db.select({ partnerId: organizations.partnerId }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
  return row?.partnerId ?? null;
}

/**
 * The partner's ceiling row (`org_id IS NULL`), read through
 * `readOwnPartnerAxisRows`. An organization-session JWT deliberately carries
 * `partnerId = null`, so its DB context has `currentPartnerId = null` and the
 * SELECT-only `ai_data_policies_partner_wide_select` branch cannot match: a
 * plain read returns zero rows and the merge silently falls back to the looser
 * built-in default. The helper reads in place when the ambient context can
 * see the partner's rows and otherwise escapes to a system read. `partnerId`
 * comes only from `readOrgPartnerId` (an access-checked org row) and the query is
 * pinned to it. The query goes through `db` on purpose: a caller-pinned
 * executor would keep it on the caller's connection inside the escape.
 */
async function readPartnerCeilingRow(partnerId: string): Promise<AiDataPolicyRow | null> {
  const [row] = await readOwnPartnerAxisRows(partnerId, () =>
    db.select().from(aiDataPolicies)
      .where(and(isNull(aiDataPolicies.orgId), eq(aiDataPolicies.partnerId, partnerId)))
      .limit(1));
  return row ?? null;
}

/** The org override row, read under the caller's RLS (never escalated). */
async function readOrgRow(orgId: string): Promise<AiDataPolicyRow | null> {
  const [row] = await db.select().from(aiDataPolicies).where(eq(aiDataPolicies.orgId, orgId)).limit(1);
  return row ?? null;
}

/**
 * Effective policy AND the partner ceiling for one org, from ONE partner-row
 * read. Use this where both are needed (the org settings GET): calling the two
 * resolvers separately would take the system escape twice per request for an
 * org session.
 */
export async function resolveAiDataPolicyWithCeiling(
  orgId: string,
): Promise<{ effective: EffectiveAiDataPolicy; ceiling: EffectiveAiDataPolicy }> {
  const partnerId = await readOrgPartnerId(orgId);
  const partner = partnerId ? await readPartnerCeilingRow(partnerId) : null;
  const org = await readOrgRow(orgId);
  return { effective: mergeAiDataPolicies(partner, org), ceiling: mergeAiDataPolicies(partner, null) };
}

/**
 * Effective policy for one org whose owning partner the CALLER has already
 * established (the executeTool gate, `aiDevicePathPolicy.ts`). The other
 * resolvers map "org invisible → no partner" to the built-in default, which
 * is right for the settings routes but would fail OPEN in the gate: the gate
 * reads the partner itself with `readOrgPartnerId` and refuses on `null`.
 * `partnerId` must come from that access-checked organizations row for `orgId`.
 */
export async function resolveAiDataPolicyForEstablishedPartner(orgId: string, partnerId: string): Promise<EffectiveAiDataPolicy> {
  const partner = await readPartnerCeilingRow(partnerId);
  const org = await readOrgRow(orgId);
  return mergeAiDataPolicies(partner, org);
}

/** Effective policy for one org: the partner ceiling, tightened by the org row. */
export async function resolveAiDataPolicy(orgId: string): Promise<EffectiveAiDataPolicy> {
  return (await resolveAiDataPolicyWithCeiling(orgId)).effective;
}

/** The partner ceiling alone, for validating an org write (never the effective value: that ratchets). */
export async function resolveAiDataPolicyCeiling(orgId: string): Promise<EffectiveAiDataPolicy> {
  const partnerId = await readOrgPartnerId(orgId);
  return mergeAiDataPolicies(partnerId ? await readPartnerCeilingRow(partnerId) : null, null);
}
