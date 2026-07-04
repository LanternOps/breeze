import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { partners, ssoProviders, partnerLoginBranding } from '../../db/schema';
import { getTrustedClientIp } from '../../services/clientIp';
import { getRedis, rateLimiter } from '../../services';
import { captureException } from '../../services/sentry';

export const loginContextRoutes = new Hono();

// Public, unauthenticated. Single-partner (self-hosted) fast-path only: on a
// multi-partner instance this endpoint deliberately reveals NOTHING (#2183
// tenant-leakage constraint). The future /login/:partnerSlug variant returns
// the same shape resolved by slug.
loginContextRoutes.get('/login-context', async (c) => {
  const redis = getRedis();
  // Call unconditionally (no `if (redis)` guard) — mirrors the partner SSO
  // entry route (GET /sso/login/partner/:partnerId): rateLimiter fails
  // CLOSED (allowed: false) when redis is null, so a missing Redis denies
  // the request rather than silently skipping the limit.
  const check = await rateLimiter(redis, `login-context:${getTrustedClientIp(c)}`, 30, 60);
  if (!check.allowed) {
    return c.json({ error: 'Too many requests' }, 429);
  }

  let context: { branding: unknown; partnerSso: unknown };
  try {
    context = await withSystemDbAccessContext(async () => {
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
  } catch (err) {
    // This endpoint gates login-page RENDERING on a public, unauthenticated
    // route — a DB blip must degrade to the stock login page, never surface
    // a 500. Never cache the degraded response as if it were a real result.
    console.error('[auth] login-context DB read failed, degrading to stock page:', err);
    captureException(err, c);
    c.header('Cache-Control', 'no-store');
    return c.json({ branding: null, partnerSso: null });
  }

  c.header('Cache-Control', 'public, max-age=60');
  return c.json(context);
});
