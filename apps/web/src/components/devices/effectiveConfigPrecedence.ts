import type { JwtClaimsState } from '@/lib/authScope';

export type PrecedenceLevel = 'partner' | 'organization' | 'site' | 'device_group' | 'device' | 'default';

/** GET /configuration-policies/effective/:deviceId → policyOwners (#12306). */
export type PolicyOwners = Record<string, 'organization' | 'partner'>;

export type LostReason = 'more_specific_level' | 'lower_priority_number' | 'assigned_earlier';

// Mirrors LEVEL_PRIORITY in apps/api/src/services/configurationPolicy.ts, which
// resolveEffectiveConfigWithExecutor sorts by: a higher number is more specific
// and wins first. 'default' (Breeze Defaults) sits below every assignment.
const LEVEL_PRIORITY: Record<PrecedenceLevel, number> = {
  device: 5,
  device_group: 4,
  site: 3,
  organization: 2,
  partner: 1,
  default: 0,
};

/**
 * Whether the caller can open this policy's page (plan D4, the `canOpenParent`
 * rule). A partner-scope caller can open any policy it sees; anyone else only
 * an organization-owned one. An owner the API did not name is unknown, so the
 * page shows the name without a link rather than a link that answers 404.
 */
export function canOpenPolicy(
  policyId: string,
  owners: PolicyOwners | undefined,
  claims: JwtClaimsState,
): boolean {
  const isPartnerScope =
    claims.status === 'resolved' && claims.claims.scope === 'partner' && !!claims.claims.partnerId;
  return isPartnerScope || owners?.[policyId] === 'organization';
}

type ChainEntry<F extends string> = {
  level: PrecedenceLevel;
  targetId: string;
  policyId: string;
  priority: number;
  featureTypes: F[];
};
type Winner = {
  sourceLevel: PrecedenceLevel;
  sourceTargetId: string;
  sourcePolicyId: string;
  sourcePolicyName: string;
  sourcePriority: number;
};

export type LostClause<F extends string> = {
  winnerPolicyId: string;
  winnerPolicyName: string;
  featureTypes: F[];
  reason: LostReason;
};

/**
 * The features a chain row links but does not supply, grouped by the
 * assignment that won them, each with the reason it won. A row that won every
 * feature it links returns an empty list.
 */
export function lostClauses<F extends string>(
  entry: ChainEntry<F>,
  features: Partial<Record<F, Winner>>,
): LostClause<F>[] {
  const byWinner = new Map<string, LostClause<F>>();
  for (const ft of entry.featureTypes) {
    const winner = features[ft];
    if (!winner || winner.sourceLevel === 'default') continue;
    const contributes =
      winner.sourcePolicyId === entry.policyId &&
      winner.sourceLevel === entry.level &&
      winner.sourceTargetId === entry.targetId;
    if (contributes) continue;
    const key = `${winner.sourcePolicyId}|${winner.sourceLevel}|${winner.sourceTargetId}`;
    const clause = byWinner.get(key);
    if (clause) {
      clause.featureTypes.push(ft);
    } else {
      byWinner.set(key, {
        winnerPolicyId: winner.sourcePolicyId,
        winnerPolicyName: winner.sourcePolicyName,
        featureTypes: [ft],
        reason: lostReason(entry, winner),
      });
    }
  }
  return [...byWinner.values()];
}

/**
 * Why a chain row's policy lost a feature to `winner`, in the resolver's own
 * order: level, then priority ascending, then assignment age. The chain does
 * not carry assignment age, so "assigned earlier" is inferred when level and
 * priority tie.
 */
export function lostReason(
  entry: { level: PrecedenceLevel; priority: number },
  winner: { sourceLevel: PrecedenceLevel; sourcePriority: number },
): LostReason {
  if (LEVEL_PRIORITY[winner.sourceLevel] !== LEVEL_PRIORITY[entry.level]) return 'more_specific_level';
  if (winner.sourcePriority !== entry.priority) return 'lower_priority_number';
  return 'assigned_earlier';
}
