import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import type { LoginContext } from '@breeze/shared';
import { db, withSystemDbAccessContext } from '../../db';
import { partners, ssoProviders, partnerLoginBranding } from '../../db/schema';
import { getTrustedClientIp } from '../../services/clientIp';
import { getRedis, rateLimiter } from '../../services';
import { captureException } from '../../services/sentry';
import { envFlag } from '../../utils/envFlag';

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

  // Hosted guard (#2195): the single-partner fast-path is a self-hosted
  // convenience. A hosted region that happened to shrink to exactly one
  // partner must not publicly serve that partner's branding/SSO entry —
  // hosted discovery is the v2 slug path (#2183). envFlag (not a bare
  // === 'true') so every hosted spelling the production config validator
  // accepts (1/yes/on) trips the guard; production refuses to boot with
  // IS_HOSTED unset, so unset here means a self-hosted dev instance.
  if (envFlag('IS_HOSTED', false)) {
    c.header('Cache-Control', 'public, max-age=60');
    return c.json({ branding: null, partnerSso: null } satisfies LoginContext);
  }

  let context: LoginContext;
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

      // Deterministic pick when several providers are active (#2195): oldest
      // first, id as tiebreak — the same ORDER BY the SSO entry routes use,
      // so the button on the login page always names the provider the entry
      // route will actually start a flow with.
      const [provider] = await db
        .select({ name: ssoProviders.name, enforceSSO: ssoProviders.enforceSSO })
        .from(ssoProviders)
        .where(and(
          eq(ssoProviders.partnerId, partnerId),
          eq(ssoProviders.status, 'active')
        ))
        .orderBy(ssoProviders.createdAt, ssoProviders.id)
        .limit(1);

      return {
        branding: brandingRow ?? null,
        partnerSso: provider
          ? {
              providerName: provider.name,
              loginUrl: `/api/v1/sso/login/partner/${partnerId}`,
              enforceSSO: Boolean(provider.enforceSSO)
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
