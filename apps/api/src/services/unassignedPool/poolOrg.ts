import { and, eq, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { organizations, partners, sites } from '../../db/schema';
import { ensureDefaultProfile } from '../billingProfileService';
import { UNASSIGNED_POOL_ORG_TYPE } from './orgType';
import { holdingAreaLockSql } from './holdingAreaLock';

export const HOLDING_ORG_NAME = 'Unassigned devices';

/**
 * Resolve (creating on first use) the partner's hidden holding org and its one
 * site. Runs in a fresh system context — the holding org
 * is never in a human caller's accessibleOrgIds, and a just-created org is not
 * in anyone's yet.
 *
 * Concurrency: a transaction-scoped advisory lock keyed on the partner
 * serialises first-time provisioning, so both the org (also backed by
 * organizations_partner_unassigned_pool_uniq) and the site are created exactly
 * once.
 *
 * No production caller yet; deploy-key minting will be the first.
 */
export async function getOrCreateUnassignedPoolOrg(
  partnerId: string,
): Promise<{ orgId: string; siteId: string }> {
  return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    await db.execute(holdingAreaLockSql(partnerId));

    const findOrg = () => db
      .select({ id: organizations.id })
      .from(organizations)
      .where(and(eq(organizations.partnerId, partnerId), eq(organizations.type, UNASSIGNED_POOL_ORG_TYPE)))
      .limit(1);

    let [org] = await findOrg();
    if (!org) {
      const [partnerRow] = await db
        .select({ currencyCode: partners.currencyCode })
        .from(partners)
        .where(eq(partners.id, partnerId))
        .limit(1);
      if (!partnerRow) throw new Error('unassigned pool partner not found');

      await ensureDefaultProfile(partnerId, partnerRow.currencyCode, db);

      const slug = `unassigned-pool-${partnerId}`;
      await db.insert(organizations).values({
        partnerId,
        currencyCode: partnerRow.currencyCode,
        name: HOLDING_ORG_NAME,
        slug,
        type: UNASSIGNED_POOL_ORG_TYPE,
        status: 'active',
      }).onConflictDoNothing();

      [org] = await findOrg();
      if (!org) {
        // Same failure shape as getOrCreateQuickSupportOrg (#3967): the insert
        // conflicted on the per-partner slug index, so name the blocker.
        const [slugHolder] = await db
          .select({ id: organizations.id, name: organizations.name })
          .from(organizations)
          .where(and(eq(organizations.partnerId, partnerId), sql`lower(${organizations.slug}) = lower(${slug})`))
          .limit(1);
        throw new Error(slugHolder
          ? `unassigned pool org provisioning failed: slug ${slug} is already held by organization ${slugHolder.id} ("${slugHolder.name}")`
          : 'unassigned pool org provisioning failed');
      }
    }

    let [site] = await db.select({ id: sites.id }).from(sites).where(eq(sites.orgId, org.id)).limit(1);
    if (!site) {
      [site] = await db
        .insert(sites)
        .values({ orgId: org.id, name: HOLDING_ORG_NAME, timezone: 'UTC' })
        .returning({ id: sites.id });
    }
    if (!site) throw new Error('unassigned pool site provisioning failed');

    return { orgId: org.id, siteId: site.id };
  }));
}
