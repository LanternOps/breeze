import { sql } from 'drizzle-orm';
import * as dbModule from '../db';

/** Hops followed by `resolveMergedOrgIds` before giving up. */
export const MERGE_CHAIN_DEPTH_CAP = 5;

const uuid = (v: string) => sql`${v}::uuid`;

/**
 * Walk `org_merge_events` forward from `orgId`, returning `[orgId, ...the
 * surviving orgs it was merged into]`. Used to keep a capability minted
 * against a since-merged org (a sent quote link) resolvable.
 *
 * `partnerId` is a hard filter on every hop, so a token's partner claim stays
 * the trust anchor and no chain can cross partners. Bounded by
 * `MERGE_CHAIN_DEPTH_CAP` and by a visited set, so neither a long chain nor a
 * cycle can spin.
 *
 * Scope escalation (M4) is load-bearing, not hygiene. `org_merge_events` is a
 * PARTNER-axis table: its RLS policy is `system OR
 * breeze_has_partner_access(partner_id)`, and an ORG-scoped context never
 * passes `breeze_has_partner_access` (the partner-wide-first playbook's rule —
 * org tokens carry a partnerId but RLS is stricter than the app layer). Under
 * an org-scoped ambient context every hop would return zero rows and this
 * would silently degrade to `[orgId]` — the exact behaviour it exists to
 * prevent, presented as a clean "no merge found". So the read is forced to
 * system scope the same way `tenantStatus.readAsSystem` does it: exit a
 * narrower ambient context first, then open a fresh system transaction.
 * Already-system callers (Task 6's public quote route) reuse their
 * transaction and acquire no extra connection.
 */
export async function resolveMergedOrgIds(orgId: string, partnerId: string): Promise<string[]> {
  const ambient = dbModule.getCurrentDbAccessContext();
  const readAsSystem = <T,>(fn: () => Promise<T>): Promise<T> =>
    ambient && ambient.scope !== 'system'
      ? dbModule.runOutsideDbContext(() => dbModule.withSystemDbAccessContext(fn))
      : dbModule.withSystemDbAccessContext(fn);

  return readAsSystem(async () => {
    const chain = [orgId];
    const seen = new Set([orgId]);
    let current = orgId;

    for (let hop = 0; hop < MERGE_CHAIN_DEPTH_CAP; hop++) {
      const rows = (await dbModule.db.execute(sql`
        SELECT survivor_org_id
          FROM org_merge_events
         WHERE loser_org_id = ${uuid(current)}
           AND partner_id = ${uuid(partnerId)}
         ORDER BY created_at DESC
         LIMIT 1`)) as unknown as Array<{ survivor_org_id: string }>;

      const next = rows[0]?.survivor_org_id;
      if (!next || seen.has(next)) break;
      chain.push(next);
      seen.add(next);
      current = next;
    }

    return chain;
  });
}
