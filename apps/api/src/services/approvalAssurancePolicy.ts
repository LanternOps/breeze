import { inArray } from 'drizzle-orm';
import type { AssuranceFloorOverrides, AssuranceLevel, RiskTier } from '@breeze/shared';
import { db, withDbTransactionIfHeld } from '../db';
import { readWithPartnerAxisVisibility } from '../db/partnerAxisRead';
import { organizations } from '../db/schema/orgs';
import { isEnforcing, loadPartnerPolicy, type PartnerAuthenticatorPolicy } from './authenticatorPolicy';

/**
 * The approval-security policies that govern ONE decision: the deciding
 * session's partner AND every partner that owns an org the decided rows
 * belong to. `null` entries are partners with no policy row (or a session /
 * org with no resolvable partner); they mean the platform default, exactly as
 * `isEnforcing(null, …)` reads them.
 *
 * Rule: a decision meets the approval-security policy of the partner that owns
 * the row's org AND the policy of the partner the approver is signed in to.
 * One identity can hold memberships in several partners, and decide authority
 * is resolved in the row's own partner, so the floor a partner chose for its
 * orgs holds whichever partner the session belongs to. The stricter of the two
 * wins, and a partner mismatch is never itself a refusal.
 */
export type ApprovalPolicySet = readonly (PartnerAuthenticatorPolicy | null)[];

/**
 * Load the policy set for a decision. Approve paths only: a deny must never
 * depend on a policy read (a technician must always be able to refuse).
 *
 * `rowOrgIds` come from rows the server already loaded (an intent, elevation,
 * diagnostic grant or script proposal), never from the client. Their owning
 * partner and that partner's policy are read under a system context, because
 * the caller's own RLS context normally cannot see another partner's
 * `authenticator_policies` row. The policy is only APPLIED to the decision; no
 * caller returns it, so nothing about another partner's configuration becomes
 * readable beyond the effect (the `requiredLevel` of a refusal).
 *
 * With no `rowOrgIds` this is the session partner's policy alone. Read errors
 * propagate, and every caller refuses the approve on one: the assurance ladder
 * answers 401 `assertion_failed`; the supervised plain-click shortcut and the
 * step-up grant redeem surface it as a 500.
 */
export async function loadApprovalPolicySet(input: {
  sessionPartnerId: string | null;
  rowOrgIds?: readonly (string | null | undefined)[];
}): Promise<ApprovalPolicySet> {
  const sessionPartnerId = input.sessionPartnerId ?? null;
  const orgIds = [...new Set((input.rowOrgIds ?? []).filter((id): id is string => !!id))];
  // The session-only read is unchanged (loadPartnerPolicy's own escape).
  if (orgIds.length === 0) return [await loadPartnerPolicy(sessionPartnerId)];

  // ONE system-context escape for the owner read and every policy read
  // inside it (loadPartnerPolicy skips its own escape when the ambient scope
  // is already system), so a caller inside a request transaction holds at most
  // one extra pooled connection, as it did before.
  //
  // The reads run in a savepoint of whatever transaction holds them. A caller
  // that is already system-scoped runs them in place on its request
  // transaction; without the savepoint, a failed read there would be rethrown
  // when that transaction ends, turning the caller's refusal into a 500.
  return readWithPartnerAxisVisibility(() => withDbTransactionIfHeld(async () => {
    const owners = await db
      .select({ id: organizations.id, partnerId: organizations.partnerId })
      .from(organizations)
      .where(inArray(organizations.id, orgIds));
    const ownerByOrg = new Map(owners.map((o) => [o.id, o.partnerId]));

    const partnerIds = new Set<string | null>([sessionPartnerId]);
    for (const orgId of orgIds) {
      // An org that no longer resolves contributes the platform default, the
      // same thing a partner without a policy row gets — never "no policy".
      partnerIds.add(ownerByOrg.get(orgId) ?? null);
    }

    const set: (PartnerAuthenticatorPolicy | null)[] = [];
    // Sequential: every read shares the one escaped connection.
    for (const partnerId of partnerIds) set.push(await loadPartnerPolicy(partnerId));
    return set;
  }));
}

/** The raise-only floor overrides of the set: per tier, the highest any policy sets. */
export function approvalPolicyFloorOverrides(set: ApprovalPolicySet): AssuranceFloorOverrides {
  const out: AssuranceFloorOverrides = {};
  for (const policy of set) {
    const overrides = (policy?.floorOverrides ?? {}) as AssuranceFloorOverrides;
    for (const [tier, level] of Object.entries(overrides) as [RiskTier, AssuranceLevel][]) {
      const current = out[tier];
      if (current === undefined || level > current) out[tier] = level;
    }
  }
  return out;
}

/**
 * Whether an under-assured approve at `riskTier` must be refused now: true
 * when ANY policy in the set enforces at that tier. An empty set reads as the
 * platform default (fail closed toward enforcement, never toward "off").
 */
export function isApprovalPolicySetEnforcing(set: ApprovalPolicySet, now: Date, riskTier: RiskTier): boolean {
  const policies: ApprovalPolicySet = set.length > 0 ? set : [null];
  return policies.some((policy) => isEnforcing(policy, now, riskTier));
}
