import { and, eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { organizations, partners, sites } from '../db/schema';

/**
 * Resolve (creating on first use) the hidden 'quick_support' organization for a
 * partner, plus its default site.
 *
 * Quick Support devices are ephemeral and must not land in a real customer org,
 * so every partner gets exactly one hidden org — enforced by the partial unique
 * index `organizations_partner_quick_support_uniq`. It stays inside the tech's
 * accessibleOrgIds (so RLS lets them read their own support_sessions) but is
 * filtered out of every user-facing org enumeration and device/billing count.
 *
 * Runs in a fresh system context: a just-created org id is not in the caller's
 * accessible_org_ids yet, so RLS would reject both the INSERT and its RETURNING
 * under the request context. Same pattern as POST /organizations.
 */
export async function getOrCreateQuickSupportOrg(
  partnerId: string,
): Promise<{ orgId: string; siteId: string }> {
  return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const findOrg = () => db
      .select({ id: organizations.id })
      .from(organizations)
      .where(and(
        eq(organizations.partnerId, partnerId),
        eq(organizations.type, 'quick_support'),
      ))
      .limit(1);

    let [org] = await findOrg();
    if (!org) {
      const [partnerRow] = await db
        .select({ currencyCode: partners.currencyCode })
        .from(partners)
        .where(eq(partners.id, partnerId))
        .limit(1);
      if (!partnerRow) throw new Error('quick support partner not found');

      // onConflictDoNothing + re-select rather than catching a 23505: postgres.js
      // rethrows errors handled inside begin(), so relying on transaction-abort
      // recovery would surface as a 500 under concurrent creation.
      await db.insert(organizations).values({
        partnerId,
        currencyCode: partnerRow.currencyCode,
        name: 'Quick Support',
        // Full uuid, not an 8-char prefix: org slugs are globally unique, and a
        // truncated prefix could collide across partners and make provisioning
        // throw for whichever partner arrived second.
        slug: `quick-support-${partnerId}`,
        type: 'quick_support',
        status: 'active',
      }).onConflictDoNothing();

      [org] = await findOrg();
      if (!org) throw new Error('quick support org provisioning failed');
    }

    // Enrollment keys require a site_id, so the hidden org needs one.
    let [site] = await db
      .select({ id: sites.id })
      .from(sites)
      .where(eq(sites.orgId, org.id))
      .limit(1);

    if (!site) {
      [site] = await db
        .insert(sites)
        .values({ orgId: org.id, name: 'Quick Support', timezone: 'UTC' })
        .returning({ id: sites.id });
    }
    // Enrollment keys require a site_id, so a missing site here would surface
    // much later as an opaque redeem failure. Fail at the source instead.
    if (!site) throw new Error('quick support site provisioning failed');

    return { orgId: org.id, siteId: site.id };
  }));
}
