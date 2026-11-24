/**
 * Id-level filters over the configuration-policy read rule (#12462 W03a).
 *
 * For surfaces that already hold policy ids or rows from another read (a
 * client's id list, the policies attached to a monitor, the policy assigned to
 * a group, the policies referencing a backup profile) and must not name one
 * the caller may not read. Everything runs on the ambient `db`, in the
 * caller's own request context; `policyReadCondition` is the authority.
 */
import { and, inArray } from 'drizzle-orm';
import { db } from '../db';
import { configurationPolicies } from '../db/schema';
import type { AuthContext } from '../middleware/auth';
import { policyReadCondition } from './configPolicyReadScope';
import { canManagePartnerWidePolicies } from './partnerWideAccess';

/**
 * The subset of `policyIds` the caller may read, through `policyReadCondition`
 * (the reader `listConfigPolicies` and `getConfigPolicy(…, { access: 'read' })`
 * use).
 */
export async function readablePolicyIds(auth: AuthContext, policyIds: readonly string[]): Promise<string[]> {
  const ids = [...new Set(policyIds)];
  if (ids.length === 0) return [];
  const readCond = policyReadCondition(auth);
  const where = readCond
    ? and(inArray(configurationPolicies.id, ids), readCond)
    : inArray(configurationPolicies.id, ids);
  const rows = await db.select({ id: configurationPolicies.id }).from(configurationPolicies).where(where);
  return rows.map((row) => row.id);
}

/**
 * Drops the rows naming a partner-owned (MSP-managed) policy the caller may
 * not read. An org-owned policy row is left to the caller's own org filter,
 * which every one of these surfaces already applies. System scope and callers
 * who may manage partner-wide policies read every policy of their partner, so
 * they skip the extra statement, as does a page with no partner-owned row.
 */
export async function keepReadablePolicies<T>(
  auth: AuthContext,
  rows: readonly T[],
  policyOf: (row: T) => { id: string; orgId: string | null },
): Promise<T[]> {
  if (auth.scope === 'system' || canManagePartnerWidePolicies(auth)) return [...rows];
  const partnerOwned = rows.map(policyOf).filter((p) => p.orgId === null).map((p) => p.id);
  if (partnerOwned.length === 0) return [...rows];
  const readable = new Set(await readablePolicyIds(auth, partnerOwned));
  return rows.filter((row) => {
    const policy = policyOf(row);
    return policy.orgId !== null || readable.has(policy.id);
  });
}
