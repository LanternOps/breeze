import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { portalBranding } from '../../db/schema';
import { brandingParamSchema } from './schemas';
import { applyPortalCacheHeaders, buildWeakEtag, isEtagFresh } from './helpers';

export const brandingRoutes = new Hono();

async function resolveBrandingByDomain(domain: string) {
  const normalizedDomain = domain.trim().toLowerCase();
  if (!normalizedDomain) {
    return null;
  }

  // Public, pre-auth lookup by custom domain — no tenant context exists yet,
  // so run under system scope or portal_branding's org-forced RLS hides every
  // row under the unprivileged breeze_app pool.
  const [branding] = await withSystemDbAccessContext(() =>
    db
      .select({
        id: portalBranding.id,
        orgId: portalBranding.orgId,
        logoUrl: portalBranding.logoUrl,
        faviconUrl: portalBranding.faviconUrl,
        primaryColor: portalBranding.primaryColor,
        secondaryColor: portalBranding.secondaryColor,
        accentColor: portalBranding.accentColor,
        customDomain: portalBranding.customDomain,
        domainVerified: portalBranding.domainVerified,
        welcomeMessage: portalBranding.welcomeMessage,
        supportEmail: portalBranding.supportEmail,
        supportPhone: portalBranding.supportPhone,
        footerText: portalBranding.footerText,
        customCss: portalBranding.customCss,
        enableTickets: portalBranding.enableTickets,
        enableAssetCheckout: portalBranding.enableAssetCheckout,
        enableSelfService: portalBranding.enableSelfService,
        enablePasswordReset: portalBranding.enablePasswordReset
      })
      .from(portalBranding)
      .where(eq(portalBranding.customDomain, normalizedDomain))
      .limit(1)
  );

  if (!branding || !branding.domainVerified) {
    return null;
  }

  return branding;
}

brandingRoutes.get('/branding/:domain', zValidator('param', brandingParamSchema), async (c) => {
  const { domain } = c.req.valid('param');
  const branding = await resolveBrandingByDomain(domain);
  if (!branding) {
    return c.json({ error: 'Branding not found' }, 404);
  }

  const payload = { branding };
  applyPortalCacheHeaders(c, {
    scope: 'public',
    browserMaxAgeSeconds: 300,
    sharedMaxAgeSeconds: 3600,
    staleWhileRevalidateSeconds: 86400,
    vary: ['Host']
  });
  const etag = buildWeakEtag(payload);
  c.header('ETag', etag);

  if (isEtagFresh(c.req.header('if-none-match'), etag)) {
    return new Response(null, { status: 304, headers: c.res.headers });
  }

  return c.json(payload);
});

// Authenticated exact-route projection (Task 3.3, replaces the former
// host-derived public lookup). Distinct from resolveBrandingByDomain() above:
// this is org-scoped via portalAuth, includes the five W03 visibility flags,
// and is cached private/per-viewer rather than public/per-host. Mounted after
// portalAuthMiddleware on the exact `/branding` path in routes/portal/index.ts
// — `/branding/:domain` remains public because that middleware only matches
// the exact `/branding` path.
brandingRoutes.get('/branding', async (c) => {
  const auth = c.get('portalAuth');

  const [branding] = await db
    .select({
      id: portalBranding.id,
      orgId: portalBranding.orgId,
      logoUrl: portalBranding.logoUrl,
      faviconUrl: portalBranding.faviconUrl,
      primaryColor: portalBranding.primaryColor,
      secondaryColor: portalBranding.secondaryColor,
      accentColor: portalBranding.accentColor,
      customDomain: portalBranding.customDomain,
      domainVerified: portalBranding.domainVerified,
      welcomeMessage: portalBranding.welcomeMessage,
      supportEmail: portalBranding.supportEmail,
      supportPhone: portalBranding.supportPhone,
      footerText: portalBranding.footerText,
      customCss: portalBranding.customCss,
      enableTickets: portalBranding.enableTickets,
      enableAssetCheckout: portalBranding.enableAssetCheckout,
      enableSelfService: portalBranding.enableSelfService,
      enablePasswordReset: portalBranding.enablePasswordReset,
      enableDashboard: portalBranding.enableDashboard,
      enableSecurity: portalBranding.enableSecurity,
      enableBackups: portalBranding.enableBackups,
      enableReports: portalBranding.enableReports,
      enableSupportUsage: portalBranding.enableSupportUsage
    })
    .from(portalBranding)
    .where(eq(portalBranding.orgId, auth.user.orgId))
    .limit(1);

  if (!branding) {
    // No row means the MSP has never saved portal settings for this org — the
    // default state, not an error. Match the public /branding/:domain 404
    // contract so the portal falls into its documented 404 → defaultBranding
    // path (flags undefined → every gated surface fails closed).
    return c.json({ error: 'Branding not found' }, 404);
  }

  const payload = { branding };
  applyPortalCacheHeaders(c, {
    scope: 'private',
    browserMaxAgeSeconds: 30,
    staleWhileRevalidateSeconds: 60,
    vary: ['Authorization', 'Cookie']
  });
  const etag = buildWeakEtag(payload);
  c.header('ETag', etag);

  if (isEtagFresh(c.req.header('if-none-match'), etag)) {
    return new Response(null, { status: 304, headers: c.res.headers });
  }

  return c.json(payload);
});
