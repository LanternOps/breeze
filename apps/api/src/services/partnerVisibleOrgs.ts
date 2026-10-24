import { inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { organizations } from '../db/schema';
import { notHiddenOrgType } from './unassignedPool/visibility';

/**
 * The org population a partner-scope caller sees in `GET /orgs/organizations`
 * (#9170): the caller's accessible orgs, minus the hidden org types (Quick
 * Support and the unassigned-pool holding org), minus soft-deleted rows.
 *
 * `accessibleOrgIds` (computed once by authMiddleware) already limits ids to
 * active and trial orgs; suspended orgs are outside it (#2879). These are the
 * population predicates only: the list route adds its own search, archived
 * opt-in and pagination on top, and the partner settings inheritance read
 * model counts exactly this set, so its `orgCount` equals the list's total.
 *
 * Fails closed: an empty id list yields `false`, never an unscoped predicate.
 */
export function partnerVisibleOrgConditions(accessibleOrgIds: readonly string[]): SQL[] {
  if (accessibleOrgIds.length === 0) return [sql`false`];
  return [
    inArray(organizations.id, [...accessibleOrgIds]),
    notHiddenOrgType(),
    isNull(organizations.deletedAt),
  ];
}
