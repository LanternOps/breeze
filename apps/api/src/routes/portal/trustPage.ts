import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { eq, sql } from 'drizzle-orm';
import { zValidator } from '../../lib/validation';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { organizations, partners, trustPages, type TrustPageRow } from '../../db/schema';
import { resolveTrustPageSettings, TrustPageError } from '../../services/trustPage/publication';
import { applyTrustPageDraftPatch, trustPagePortalDraftPatchSchema } from '../../services/trustPage/draftPatch';
import { createTrustPreviewToken, TRUST_PREVIEW_TTL_SECONDS } from '../../services/trustPage/previewToken';
import { scheduleServingRefreshForPartner } from '../../services/trustPage/servingSet';
import { captureException } from '../../services/sentry';
import { requirePortalTrustPageEditor } from './featureFlags';
import { validatePortalCookieCsrfRequest, writePortalAudit } from './helpers';

/**
 * Customer portal: the org's own trust page draft (Trust Center W3d, #8771;
 * spec §18.9, plan Open Decisions 1–2).
 *
 * Mounted at /portal/trust-page. Portal auth is applied in routes/portal/index.ts
 * (it must run before the router-wide POST guard of the earlier '/' mounts);
 * this router carries the editor gate (requirePortalTrustPageEditor:
 * portal_branding flag + an org-scoped admin contact, re-checked on every
 * request), and answers 401 itself if ever mounted without auth.
 *
 * What a customer admin can do: edit five draft fields, mint a W1 preview
 * token, and unpublish (withdraw consent). Never publish: publishing needs MFA,
 * the partner trust capability and the customer attestation, none of which the
 * portal has. Edits reach the public page only through the MSP's next publish
 * (Ruling 20); every write bumps publication_revision so that publish 409s if
 * the MSP loaded an older revision.
 *
 * Org is always the session org; the page is looked up by it, never by a
 * request field. The portal never creates the trust_pages row. The partner-home
 * page is the MSP's own page and is refused. Responses never carry the frozen
 * published config, the publication authorization, user ids or the page id.
 */
export const portalTrustPageRoutes = new Hono();
portalTrustPageRoutes.use('*', requirePortalTrustPageEditor);

const NOT_FOUND = { error: 'Not found', code: 'NOT_FOUND' } as const;
const PARTNER_HOME_REFUSED = { error: 'Only your provider can edit this page.', code: 'PORTAL_TRUST_EDITOR_REQUIRED' } as const;

const unpublishSchema = z.strictObject({ confirm: z.literal(true) });

/** CSRF for cookie sessions, then a JSON content type — both before any body is parsed. */
const mutationGuard: MiddlewareHandler = async (c, next) => {
  const csrfError = validatePortalCookieCsrfRequest(c);
  if (csrfError) return c.json({ error: csrfError }, 403);
  const contentType = c.req.header('content-type')?.toLowerCase() ?? '';
  if (!contentType.startsWith('application/json')) {
    return c.json({ error: 'Content-Type must be application/json' }, 415);
  }
  await next();
};

async function loadOrgPage(orgId: string): Promise<TrustPageRow | null> {
  const [page] = await db.select().from(trustPages).where(eq(trustPages.orgId, orgId)).limit(1);
  return page ?? null;
}

function handleError(c: Context, err: unknown): Response {
  if (err instanceof TrustPageError) return c.json({ error: err.message, code: err.code }, err.status);
  captureException(err);
  throw err;
}

/** The customer-facing projection: five fields (effective values for the inheritable three), status, public path. */
async function toPortalView(page: TrustPageRow, orgId: string) {
  // Partner slug and the partner template live on the partner axis; read them in a system context keyed only
  // by the session org and the page's own partner, never by request input.
  const { effective, slugs } = await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const { effective: eff } = await resolveTrustPageSettings(page);
    const [row] = await db.select({ orgSlug: organizations.slug, partnerSlug: partners.slug })
      .from(organizations).innerJoin(partners, eq(partners.id, organizations.partnerId))
      .where(eq(organizations.id, orgId)).limit(1);
    return { effective: eff, slugs: row ?? null };
  }));
  return {
    securityContactEmail: page.securityContactEmail ?? null,
    websiteUrl: page.websiteUrl ?? null,
    hiddenControlIds: [...effective.values.hiddenControlIds],
    showPercentages: effective.values.showPercentages,
    showDeviceCount: effective.values.showDeviceCount,
    publishedAt: page.publishedAt ? page.publishedAt.toISOString() : null,
    publicationRevision: page.publicationRevision,
    // Portal-relative (the portal prefixes its base path).
    publicPath: slugs ? `/trust/${slugs.partnerSlug}/${slugs.orgSlug.toLowerCase()}` : null,
  };
}

portalTrustPageRoutes.get('/', async (c) => {
  const auth = c.get('portalAuth');
  try {
    const page = await loadOrgPage(auth.user.orgId);
    if (!page) return c.json({ data: { page: null } });
    if (page.isPartnerHome) return c.json(PARTNER_HOME_REFUSED, 403);
    return c.json({ data: { page: await toPortalView(page, auth.user.orgId) } });
  } catch (err) { return handleError(c, err); }
});

portalTrustPageRoutes.put('/', mutationGuard, zValidator('json', trustPagePortalDraftPatchSchema), async (c) => {
  const auth = c.get('portalAuth');
  const body = c.req.valid('json');
  try {
    const page = await loadOrgPage(auth.user.orgId);
    if (!page) return c.json(NOT_FOUND, 404);
    if (page.isPartnerHome) return c.json(PARTNER_HOME_REFUSED, 403);
    const updated = await applyTrustPageDraftPatch(page.id, body, { kind: 'portal_user', id: auth.user.id });
    writePortalAudit(c, {
      orgId: auth.user.orgId,
      actorType: 'user',
      actorId: auth.user.id,
      actorEmail: auth.user.email,
      action: 'portal.trust_page.update',
      resourceType: 'trust_page',
      resourceId: page.id,
      details: { fields: Object.keys(body).filter((k) => k !== 'expectedRevision'), publicationRevision: updated.publicationRevision },
    });
    return c.json({ data: { page: await toPortalView(updated, auth.user.orgId) } });
  } catch (err) { return handleError(c, err); }
});

portalTrustPageRoutes.post('/preview-token', mutationGuard, async (c) => {
  const auth = c.get('portalAuth');
  try {
    const page = await loadOrgPage(auth.user.orgId);
    if (!page) return c.json(NOT_FOUND, 404);
    if (page.isPartnerHome) return c.json(PARTNER_HOME_REFUSED, 403);
    const token = await createTrustPreviewToken({ pageId: page.id, orgId: auth.user.orgId });
    return c.json({ data: { token, expiresInSeconds: TRUST_PREVIEW_TTL_SECONDS, previewPath: `/trust/preview/${token}` } });
  } catch (err) { return handleError(c, err); }
});

// Withdrawal of consent. Same effect as the staff unpublish (W1 unpublishTrustPage), done locally because that
// helper stamps updated_by_user_id with a users.id and a portal user is not one (follow-up: let it take a
// portal actor). The serving-set removal runs only after the request transaction commits (W1 Ruling 28).
portalTrustPageRoutes.post('/unpublish', mutationGuard, zValidator('json', unpublishSchema), async (c) => {
  const auth = c.get('portalAuth');
  try {
    const page = await loadOrgPage(auth.user.orgId);
    if (!page) return c.json(NOT_FOUND, 404);
    if (page.isPartnerHome) return c.json(PARTNER_HOME_REFUSED, 403);
    const result = await db.transaction(async (tx) => {
      const [locked] = await tx.select({
        rev: trustPages.publicationRevision, isPartnerHome: trustPages.isPartnerHome,
        partnerId: trustPages.partnerId, publishedAt: trustPages.publishedAt,
      }).from(trustPages).where(eq(trustPages.id, page.id)).for('update');
      if (!locked) throw new TrustPageError('Not found', 404, 'NOT_FOUND');
      if (locked.isPartnerHome) throw new TrustPageError(PARTNER_HOME_REFUSED.error, 403, PARTNER_HOME_REFUSED.code);
      if (!locked.publishedAt) return { changed: false as const, row: page };
      const [row] = await tx.update(trustPages).set({
        publishedAt: null, publicationRevision: sql`${trustPages.publicationRevision} + 1`, updatedAt: new Date(),
      }).where(eq(trustPages.id, page.id)).returning();
      if (!row) throw new TrustPageError('Not found', 404, 'NOT_FOUND');
      return { changed: true as const, row, partnerId: locked.partnerId };
    });
    if (result.changed) {
      scheduleServingRefreshForPartner(result.partnerId, 'trust_page.portal_unpublish');
      writePortalAudit(c, {
        orgId: auth.user.orgId,
        actorType: 'user',
        actorId: auth.user.id,
        actorEmail: auth.user.email,
        action: 'portal.trust_page.unpublish',
        resourceType: 'trust_page',
        resourceId: page.id,
        details: { publicationRevision: result.row.publicationRevision },
      });
    }
    return c.json({ data: { page: await toPortalView(result.row, auth.user.orgId) } });
  } catch (err) { return handleError(c, err); }
});
