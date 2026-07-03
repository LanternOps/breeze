import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { partners, ssoProviders, partnerLoginBranding } from '../../db/schema';
import { getTrustedClientIp } from '../../services/clientIp';
import { getRedis, rateLimiter } from '../../services';

export const loginContextRoutes = new Hono();

// Public, unauthenticated. Single-partner (self-hosted) fast-path only: on a
// multi-partner instance this endpoint deliberately reveals NOTHING (#2183
// tenant-leakage constraint). The future /login/:partnerSlug variant returns
// the same shape resolved by slug.
loginContextRoutes.get('/login-context', async (c) => {
  const redis = getRedis();
  if (redis) {
    const check = await rateLimiter(redis, `login-context:${getTrustedClientIp(c)}`, 30, 60);
    if (!check.allowed) {
      return c.json({ error: 'Too many requests' }, 429);
    }
  }

  const context = await withSystemDbAccessContext(async () => {
    const partnerRows = await db.select({ id: partners.id }).from(partners).limit(2);
    if (partnerRows.length !== 1 || !partnerRows[0]) {
      return { branding: null, partnerSso: null };
    }
    const partnerId = partnerRows[0].id;

    const [brandingRow] = await db
      .select({
        logoUrl: partnerLoginBranding.logoUrl,
        accentColor: partnerLoginBranding.accentColor,
        headline: partnerLoginBranding.headline
      })
      .from(partnerLoginBranding)
      .where(eq(partnerLoginBranding.partnerId, partnerId))
      .limit(1);

    const [provider] = await db
      .select({ name: ssoProviders.name })
      .from(ssoProviders)
      .where(and(
        eq(ssoProviders.partnerId, partnerId),
        eq(ssoProviders.status, 'active')
      ))
      .limit(1);

    return {
      branding: brandingRow ?? null,
      partnerSso: provider
        ? {
            available: true as const,
            providerName: provider.name,
            loginUrl: `/api/v1/sso/login/partner/${partnerId}`
          }
        : null
    };
  });

  c.header('Cache-Control', 'public, max-age=60');
  return c.json(context);
});
