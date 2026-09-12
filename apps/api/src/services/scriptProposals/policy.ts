import { and, eq, isNull, or } from 'drizzle-orm';
import {
  riskTierRank,
  type AiAgentProtectedResources,
  type RiskTier,
  type TouchClass,
} from '@breeze/shared';
import { db } from '../../db';
import { aiScriptPolicies, type AiScriptPolicyRow } from '../../db/schema/aiScriptPolicies';
import { organizations } from '../../db/schema/orgs';

/**
 * Spec §9 partner-ceiling defaults. Used when a row is missing (a missing
 * row never turns the lane ON — see `unattendedEnabled` below — but the
 * numeric/list ceilings still need a value so the merge is total).
 */
export const SCRIPT_POLICY_DEFAULTS = Object.freeze({
  maxUnattendedRiskTier: 'low' as RiskTier,
  unattendedAllowedClasses: ['services', 'processes', 'temp_files', 'dns_cache', 'printing'] as TouchClass[],
  maxUnattendedPerHour: 10,
});

export const EMPTY_PROTECTED_RESOURCES: AiAgentProtectedResources = Object.freeze({
  services: [],
  paths: [],
  registryKeys: [],
  deviceTags: [],
}) as AiAgentProtectedResources;

/** Lower rank = stricter, exactly like AI_AGENT_MODE_RANK. */
const minTier = (a: RiskTier, b: RiskTier): RiskTier => (riskTierRank(a) <= riskTierRank(b) ? a : b);
const intersect = (a: readonly string[], b: readonly string[]): string[] =>
  a.filter((v) => b.includes(v)).sort();
const union = (a: readonly string[], b: readonly string[]): string[] =>
  Array.from(new Set([...a, ...b])).sort();

export interface EffectiveScriptPolicy {
  proposingEnabled: boolean;
  unattendedEnabled: boolean;
  maxUnattendedRiskTier: RiskTier;
  unattendedAllowedClasses: TouchClass[];
  maxUnattendedPerHour: number;
  protectedResources: AiAgentProtectedResources;
  reviewerModel: string | null;
  source: { partnerRowId: string | null; orgRowId: string | null };
}

/** The subset of a policy row the merge reads — lets callers that already hold
 *  both rows (the settings routes) compute the effective view without a
 *  second round trip. */
export type ScriptPolicyMergeInput = Pick<
  AiScriptPolicyRow,
  | 'id'
  | 'orgId'
  | 'proposingEnabled'
  | 'unattendedAllowed'
  | 'unattendedEnabled'
  | 'maxUnattendedRiskTier'
  | 'unattendedAllowedClasses'
  | 'maxUnattendedPerHour'
  | 'protectedResources'
  | 'reviewerModel'
>;

/**
 * Pure merge: PARTNER ceiling ∧ ORG grant (spec §4.1's table, D10).
 *
 * `unattendedEnabled` is FALSE whenever either row is missing: a blanket
 * partner enablement must never enable an org that never opted in, and an
 * org grant must never outrun its MSP's ceiling.
 */
export function mergeScriptPolicies(
  partner: ScriptPolicyMergeInput | null,
  org: ScriptPolicyMergeInput | null,
): EffectiveScriptPolicy {
  const unattendedEnabled = !!partner?.unattendedAllowed && !!org?.unattendedEnabled;
  const pr = partner?.protectedResources ?? EMPTY_PROTECTED_RESOURCES;
  const orr = org?.protectedResources ?? EMPTY_PROTECTED_RESOURCES;
  return {
    proposingEnabled: (partner?.proposingEnabled ?? true) && (org?.proposingEnabled ?? true),
    unattendedEnabled,
    maxUnattendedRiskTier: minTier(
      partner?.maxUnattendedRiskTier ?? SCRIPT_POLICY_DEFAULTS.maxUnattendedRiskTier,
      org?.maxUnattendedRiskTier ?? SCRIPT_POLICY_DEFAULTS.maxUnattendedRiskTier,
    ),
    unattendedAllowedClasses: intersect(
      partner?.unattendedAllowedClasses ?? SCRIPT_POLICY_DEFAULTS.unattendedAllowedClasses,
      org?.unattendedAllowedClasses ?? SCRIPT_POLICY_DEFAULTS.unattendedAllowedClasses,
    ) as TouchClass[],
    maxUnattendedPerHour: Math.min(
      partner?.maxUnattendedPerHour ?? SCRIPT_POLICY_DEFAULTS.maxUnattendedPerHour,
      org?.maxUnattendedPerHour ?? SCRIPT_POLICY_DEFAULTS.maxUnattendedPerHour,
    ),
    // UNION, not intersection: more protected is tighter
    // (aiAgents/effectivePolicy.ts makes the same call for agents).
    protectedResources: {
      services: union(pr.services ?? [], orr.services ?? []),
      paths: union(pr.paths ?? [], orr.paths ?? []),
      registryKeys: union(pr.registryKeys ?? [], orr.registryKeys ?? []),
      deviceTags: union(pr.deviceTags ?? [], orr.deviceTags ?? []),
    },
    reviewerModel: org?.reviewerModel ?? partner?.reviewerModel ?? null,
    source: { partnerRowId: partner?.id ?? null, orgRowId: org?.id ?? null },
  };
}

type PolicyExecutor = Pick<typeof db, 'select'>;

/**
 * Effective lane policy for one org.
 *
 * Both rows are fetched in ONE query with an OR predicate: the partner-wide
 * row is reachable from an org-scoped RLS context through the
 * `ai_script_policies_partner_wide_select` branch, so this read needs no
 * escalation. NEVER wrap this in
 * `runOutsideDbContext(() => withSystemDbAccessContext(...))` on a request
 * path — for a plain org-XOR-partner config table that double-holds a pooled
 * connection under the request transaction and bypasses RLS (#2417). Callers
 * with no request context (workers) run it inside their own
 * `withSystemDbAccessContext`, exactly like every other worker read.
 *
 * `executor` lets a caller inside a transaction (`createActionIntent`) read
 * through its own `tx` so the read shares the intent transaction's snapshot.
 */
export async function resolveEffectiveScriptPolicy(
  orgId: string,
  executor: PolicyExecutor = db,
): Promise<EffectiveScriptPolicy> {
  const [orgRow] = await executor
    .select({ partnerId: organizations.partnerId })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  const partnerId: string | null = orgRow?.partnerId ?? null;

  const rows: AiScriptPolicyRow[] = await executor
    .select()
    .from(aiScriptPolicies)
    .where(
      partnerId
        ? or(
            eq(aiScriptPolicies.orgId, orgId),
            and(isNull(aiScriptPolicies.orgId), eq(aiScriptPolicies.partnerId, partnerId)),
          )
        : eq(aiScriptPolicies.orgId, orgId),
    )
    .limit(2);

  const partner = rows.find((r) => r.orgId === null) ?? null;
  const org = rows.find((r) => r.orgId !== null) ?? null;
  return mergeScriptPolicies(partner, org);
}
