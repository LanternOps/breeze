import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { portalBranding } from '../../db/schema';
import { brandingParamSchema } from './schemas';
import { applyPortalCacheHeaders, buildWeakEtag, isEtagFresh } from './helpers';
import { resolvePortalCapabilities } from './featureFlags';
import { combinePortalCustomCss, loadPartnerPortalDefaults, type PartnerPortalDefaults } from './portalCustomCss';
import { resolveDocumentBrand } from '../../services/partnerDocumentBrand';
import { ERROR_CODES } from '@breeze/shared';

export const brandingRoutes = new Hono();

/**
 * Layer the partner's defaults over an org's portal_branding row. #9674: the
 * partner's Custom CSS applies ahead of the org's own. #9673: the logo and
 * colours resolve through resolveDocumentBrand, so the portal shows what the
 * org's quotes and invoices show (partner default, org override).
 */
function withPartnerDefaults<T extends {
  logoUrl: string | null;
  primaryColor: string | null;
  secondaryColor: string | null;
  customCss: string | null;
}>(branding: T, partner: PartnerPortalDefaults) {
  return {
    ...branding,
    ...resolveDocumentBrand(branding, partner.settings),
    customCss: combinePortalCustomCss(partner.customCss, branding.customCss),
  };
}

/**
 * The branding of an org with no portal_branding row: only what its partner
 * set. Null when the partner has set nothing either.
 */
function partnerOnlyBranding(partner: PartnerPortalDefaults): Record<string, string> | null {
  const brand = resolveDocumentBrand(undefined, partner.settings);
  const entries = Object.entries({ customCss: partner.customCss, ...brand })
    .filter((entry): entry is [string, string] => entry[1] !== null);
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

/**
 * The portal_branding row whose VERIFIED custom domain is `domain`, or null.
 * The one custom-domain lookup: the public branding route layers the partner's
 * defaults over it, and the Microsoft sign-in host binding (W4 D5) reads only
 * its org.
 */
async function findVerifiedBrandingByDomain(domain: string) {
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
        chromeAccent: portalBranding.chromeAccent,
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

async function resolveBrandingByDomain(domain: string) {
  const branding = await findVerifiedBrandingByDomain(domain);
  if (!branding) {
    return null;
  }

  const partner = await loadPartnerPortalDefaults(branding.orgId);
  return { branding: withPartnerDefaults(branding, partner), degraded: partner.degraded };
}

/**
 * The org whose verified custom domain is `host`, or null (the shared portal
 * host, an unverified or unknown domain). Portal registration W4, plan D5: a
 * Microsoft sign-in started on an org's custom domain may only end in that
 * org.
 *
 * `host` MUST be the request's `Host` header (port stripped, lowercased) —
 * never a body or query value, which the browser controls. Opens its own
 * system context; a caller inside a request transaction wraps it in
 * `runOutsideDbContext`, or the read runs under that request's org scope and
 * misses every other org's row.
 */
export async function resolvePortalHostOrgId(host: string): Promise<string | null> {
  const branding = await findVerifiedBrandingByDomain(host);
  return branding?.orgId ?? null;
}

brandingRoutes.get('/branding/:domain', zValidator('param', brandingParamSchema), async (c) => {
  const { domain } = c.req.valid('param');
  const resolved = await resolveBrandingByDomain(domain);
  if (!resolved) {
    return c.json({ error: 'Branding not found', code: ERROR_CODES.NOT_FOUND }, 404);
  }

  const payload = { branding: resolved.branding };
  // Built without the partner's defaults (lookup failed): serve it, but never
  // let a shared cache pin it for an hour.
  if (resolved.degraded) {
    c.header('Cache-Control', 'no-store');
    return c.json(payload);
  }
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
      chromeAccent: portalBranding.chromeAccent,
      customDomain: portalBranding.customDomain,
      domainVerified: portalBranding.domainVerified,
      welcomeMessage: portalBranding.welcomeMessage,
      supportEmail: portalBranding.supportEmail,
      supportPhone: portalBranding.supportPhone,
      footerText: portalBranding.footerText,
      customCss: portalBranding.customCss,
      enableTickets: portalBranding.enableTickets,
      enableAssetCheckout: portalBranding.enableAssetCheckout,
      enableDevices: portalBranding.enableDevices,
      enableSelfService: portalBranding.enableSelfService,
      enablePasswordReset: portalBranding.enablePasswordReset,
      enableDashboard: portalBranding.enableDashboard,
      enableSecurity: portalBranding.enableSecurity,
      enableBackups: portalBranding.enableBackups,
      enableReports: portalBranding.enableReports,
      enableSupportUsage: portalBranding.enableSupportUsage,
      enableService: portalBranding.enableService,
      enableDocuments: portalBranding.enableDocuments,
      enableLifecycle: portalBranding.enableLifecycle,
      enableHardwareHealth: portalBranding.enableHardwareHealth,
      enableHardwareInventory: portalBranding.enableHardwareInventory,
      enablePerformanceMetrics: portalBranding.enablePerformanceMetrics,
      enableSoftwareInventory: portalBranding.enableSoftwareInventory,
      enableNetworkVisibility: portalBranding.enableNetworkVisibility,
      enableEdrVisibility: portalBranding.enableEdrVisibility,
      enableHourBlock: portalBranding.enableHourBlock,
      enablePatchDetail: portalBranding.enablePatchDetail,
      enableVulnerabilityDetail: portalBranding.enableVulnerabilityDetail,
      enablePhysicalPlacement: portalBranding.enablePhysicalPlacement
    })
    .from(portalBranding)
    .where(eq(portalBranding.orgId, auth.user.orgId))
    .limit(1);

  // Part of the ETag below, so a partner change is never answered 304.
  const partner = await loadPartnerPortalDefaults(auth.user.orgId);

  let payload: { branding: Record<string, unknown> };
  if (!branding) {
    // No row means the MSP has never saved portal settings for this org — the
    // default state, not an error. Match the public /branding/:domain 404
    // contract so the portal falls into its documented 404 → defaultBranding
    // path (flags undefined → every gated surface fails closed).
    const partnerOnly = partnerOnlyBranding(partner);
    if (!partnerOnly) {
      return c.json({ error: 'Branding not found', code: ERROR_CODES.NOT_FOUND }, 404);
    }
    // The partner's brand and CSS still apply. Return them alone: no visibility
    // flags, so the portal's merge over defaultBranding fails every gated
    // surface closed exactly as the 404 path does.
    payload = { branding: partnerOnly };
  } else {
    // Trust Center W3d: a per-USER capability (org flag + org-scoped admin contact), read fresh like the
    // flags; the trust-page routes re-check it on every request. Part of the ETag, so a change is never a 304.
    const { canEditTrustPage } = await resolvePortalCapabilities({ id: auth.user.id, orgId: auth.user.orgId });
    payload = { branding: { ...withPartnerDefaults(branding, partner), canEditTrustPage } };
  }
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
