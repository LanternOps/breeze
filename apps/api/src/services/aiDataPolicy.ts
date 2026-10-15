import { and, eq, isNull, or } from 'drizzle-orm';
import { db } from '../db';
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

type PolicyExecutor = Pick<typeof db, 'select'>;

async function partnerIdOf(orgId: string, executor: PolicyExecutor): Promise<string | null> {
  const [row] = await executor.select({ partnerId: organizations.partnerId }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
  return row?.partnerId ?? null;
}

/**
 * Effective policy for one org. One query, both rows: the partner row is
 * visible from an org-scoped context through the SELECT-only partner branch,
 * so no escalation. Never wrap in withSystemDbAccessContext on a request path.
 */
export async function resolveAiDataPolicy(orgId: string, executor: PolicyExecutor = db): Promise<EffectiveAiDataPolicy> {
  const partnerId = await partnerIdOf(orgId, executor);
  const rows = await executor.select().from(aiDataPolicies).where(
    partnerId
      ? or(eq(aiDataPolicies.orgId, orgId), and(isNull(aiDataPolicies.orgId), eq(aiDataPolicies.partnerId, partnerId)))
      : eq(aiDataPolicies.orgId, orgId),
  ).limit(2);
  return mergeAiDataPolicies(rows.find((r) => r.orgId === null) ?? null, rows.find((r) => r.orgId !== null) ?? null);
}

/** The partner ceiling alone, for validating an org write (never the effective value: that ratchets). */
export async function resolveAiDataPolicyCeiling(orgId: string, executor: PolicyExecutor = db): Promise<EffectiveAiDataPolicy> {
  const partnerId = await partnerIdOf(orgId, executor);
  if (!partnerId) return mergeAiDataPolicies(null, null);
  const [partner] = await executor.select().from(aiDataPolicies)
    .where(and(isNull(aiDataPolicies.orgId), eq(aiDataPolicies.partnerId, partnerId))).limit(1);
  return mergeAiDataPolicies(partner ?? null, null);
}
