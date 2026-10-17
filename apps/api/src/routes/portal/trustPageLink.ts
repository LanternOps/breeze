// apps/api/src/routes/portal/trustPageLink.ts
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { organizations, partners, trustPages } from '../../db/schema';
import { trustPublishDecision } from '../../services/trustPage/publication';
import { parseTrustSlugs } from '../../services/trustPage/resolve';
import { applyPortalCacheHeaders } from './helpers';

/**
 * Amendment 24 (§11): the customer dashboard links to the org's public trust page while it is live.
 * Mounted under the `/dashboard` prefix (routes/portal/index.ts), so it inherits portal auth and the
 * enableDashboard gate. Read-only: it never creates the draft page.
 *
 * `publicPath` is PORTAL-RELATIVE (`/trust/<partner>/<org>`, or `/trust/<partner>` for the partner home):
 * the portal serves the trust page and owns its base path, so it applies `withBase` itself.
 */
export const portalTrustPageLinkRoutes = new Hono();

async function trustPathForOrg(orgId: string): Promise<string | null> {
  // Org-scoped read under the portal's own request context (RLS fences it to this org).
  const [page] = await db.select({
    publishedAt: trustPages.publishedAt, isPartnerHome: trustPages.isPartnerHome, partnerId: trustPages.partnerId,
    orgSlug: organizations.slug,
  })
    .from(trustPages)
    .innerJoin(organizations, eq(organizations.id, trustPages.orgId))
    .where(eq(trustPages.orgId, orgId))
    .limit(1);
  if (!page || !page.publishedAt) return null;

  // The partner row is not readable under the portal's org scope (0 rows, no error), so its slug and trust
  // state read under system scope, as portal invoices/quotes read the partner name.
  const [partner] = await runOutsideDbContext(() => withSystemDbAccessContext(() =>
    db.select({ slug: partners.slug, trustState: partners.trustState }).from(partners).where(eq(partners.id, page.partnerId)).limit(1)));
  if (!partner) return null;
  // The public page 404s for a partner that may not publish (restricted, or probation under enforcement).
  if (!trustPublishDecision(partner.trustState).allowed) return null;
  const slugs = parseTrustSlugs(partner.slug, page.orgSlug);
  if (!slugs) return null;
  return page.isPartnerHome ? `/trust/${slugs.partnerSlug}` : `/trust/${slugs.partnerSlug}/${slugs.orgSlug}`;
}

portalTrustPageLinkRoutes.get('/trust-page', async (c) => {
  const auth = c.get('portalAuth');
  const publicPath = await trustPathForOrg(auth.user.orgId);
  applyPortalCacheHeaders(c, { scope: 'private', browserMaxAgeSeconds: 30, staleWhileRevalidateSeconds: 0, vary: ['Authorization', 'Cookie'] });
  return c.json({ data: { publicPath } });
});
