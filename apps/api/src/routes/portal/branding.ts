import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { portalBranding } from '../../db/schema';
import { brandingParamSchema } from './schemas';

export const brandingRoutes = new Hono();

async function resolveBrandingByDomain(domain: string) {
  const normalizedDomain = domain.trim().toLowerCase();
  if (!normalizedDomain) {
    return null;
  }

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
      enablePasswordReset: portalBranding.enablePasswordReset
    })
    .from(portalBranding)
    .where(eq(portalBranding.customDomain, normalizedDomain))
    .limit(1);

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

  return c.json({ branding });
});

brandingRoutes.get('/branding', async (c) => {
  const host = c.req.header('x-forwarded-host')
    || c.req.header('host')
    || '';
  const domain = host.split(':')[0] || '';

  const branding = await resolveBrandingByDomain(domain);
  if (!branding) {
    return c.json({ error: 'Branding not found' }, 404);
  }

  return c.json({ branding });
});
