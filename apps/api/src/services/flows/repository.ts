/**
 * Tool Catalog W03 (#5218) — read-only, system-context lookups the flows
 * service needs across owners. Never writes.
 *
 * Both reads cross what the caller's RLS can see on purpose and are bounded by
 * explicit owner predicates instead:
 *  - the slug shadow rule spans the partner's partner-wide flows AND every
 *    org flow under that partner (an org token cannot see sibling orgs);
 *  - a stored row's owner partner is re-derived from `organizations`.
 * Callers have already authorized the caller for `owner` (flows/owner.ts) or
 * loaded the row in the caller's own context.
 */
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { flows, organizations } from '../../db/schema';
import type { ToolOwnerRef } from '../toolSources/resolver';

function system<T>(fn: () => Promise<T>, label: string): Promise<T> {
  return runOutsideDbContext(() => withSystemDbAccessContext(fn, label));
}

/**
 * Slugs equal to `base` or `base_<n>` that a new flow of `owner` must not
 * take: W05 resolves `flow__<slug>` for an org with its partner's partner-wide
 * flows in scope, so an org flow must never shadow — or be shadowed by — a
 * partner-wide flow of its partner (quorum P1, both directions).
 *  - org owner: the org's own flows + its partner's partner-wide flows;
 *  - partner owner: its partner-wide flows + every org flow under the partner.
 * `base` is a validated slug (`[a-z0-9_]` only), so it is safe inside the regex.
 */
export async function takenFlowSlugs(owner: ToolOwnerRef, base: string): Promise<Set<string>> {
  const rows = await system(async () => {
    const slugMatch = sql`${flows.slug} ~ ${`^${base}(_[0-9]+)?$`}`;
    const partnerWide = and(isNull(flows.orgId), eq(flows.partnerId, owner.partnerId));
    const scope = owner.orgId
      ? or(eq(flows.orgId, owner.orgId), partnerWide)
      : or(
        partnerWide,
        inArray(flows.orgId, db.select({ id: organizations.id }).from(organizations).where(eq(organizations.partnerId, owner.partnerId))),
      );
    return db.select({ slug: flows.slug }).from(flows).where(and(slugMatch, scope));
  }, 'flows.takenFlowSlugs');
  return new Set(rows.map((r) => r.slug));
}

/** The validation owner of a stored row; null when an org row's org no longer exists. */
export async function ownerForFlowRow(row: { orgId: string | null; partnerId: string | null }): Promise<ToolOwnerRef | null> {
  if (!row.orgId) return row.partnerId ? { orgId: null, partnerId: row.partnerId } : null;
  const orgId = row.orgId;
  const [org] = await system(
    async () => db.select({ partnerId: organizations.partnerId }).from(organizations).where(eq(organizations.id, orgId)).limit(1),
    'flows.ownerForFlowRow',
  );
  return org?.partnerId ? { orgId, partnerId: org.partnerId } : null;
}
