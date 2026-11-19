import { sql, type SQL } from 'drizzle-orm';
import { portalUsers } from '../db/schema';

/**
 * Case-insensitive portal-login address matching (#11529, #11541).
 *
 * `portal_users.email` carries no case-insensitive uniqueness. Today's writers
 * lower-case the address, but older rows and IdP-provisioned rows can hold
 * mixed case, so an exact `eq(email, ...)` lookup leaves such a login
 * invitable but not loginable, resettable or recognisable as an inbound
 * sender. Every lookup that resolves a portal login by address uses
 * `portalLoginEmailEquals`.
 *
 * Widening the match has a cost: two rows that differ only by case now both
 * match. A caller that must pick ONE row treats that as ambiguous and fails
 * closed rather than choosing; see `portalLoginEmailMatchIsAmbiguous` and
 * `soleCaseInsensitiveMatch`.
 */

/** The lookup key: trimmed and lower-cased, the same transform as the SQL side. */
export function portalLoginEmailKey(email: string): string {
  return email.trim().toLowerCase();
}

/** `lower(portal_users.email) = <lower-cased, trimmed address>`. */
export function portalLoginEmailEquals(email: string): SQL {
  return sql`lower(${portalUsers.email}) = ${portalLoginEmailKey(email)}`;
}

/**
 * True when two matched rows belong to the same org. Under a
 * case-insensitive match that means one org holds two logins whose addresses
 * differ only by case: there is no principled way to pick one, so a caller
 * that issues a credential or attributes an action to the result must refuse.
 */
export function portalLoginEmailMatchIsAmbiguous(rows: ReadonlyArray<{ orgId: string }>): boolean {
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.orgId)) return true;
    seen.add(row.orgId);
  }
  return false;
}

/**
 * The row when exactly one matched, otherwise null. For lookups that resolve a
 * sender to one login: several matches (case variants, or one address in
 * several orgs) are ambiguous, and an arbitrary pick could attribute the
 * message to the wrong person or the wrong tenant. Query with `.limit(2)`.
 *
 * The caller cannot tell "ambiguous" from "unknown", so the ambiguous case is
 * logged here for the operator: `lookup` names the call site and `context`
 * carries internal ids only, never the address.
 */
export function soleCaseInsensitiveMatch<T extends { id: string }>(
  rows: ReadonlyArray<T>,
  lookup: string,
  context: Record<string, string> = {},
): T | null {
  if (rows.length > 1) {
    console.warn(`[portal] ${lookup}: the address matches several portal logins; treated as no login`, {
      ...context,
      portalUserIds: rows.map((r) => r.id),
    });
  }
  return rows.length === 1 ? rows[0]! : null;
}
