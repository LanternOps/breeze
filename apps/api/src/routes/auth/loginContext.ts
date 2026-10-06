import { Hono } from 'hono';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { LoginContext } from '@breeze/shared';
import { zValidator } from '../../lib/validation';
import { db, withSystemDbAccessContext } from '../../db';
import { partners, ssoProviders, partnerLoginBranding } from '../../db/schema';
import { getTrustedClientIp, rateLimitIpKey } from '../../services/clientIp';
import { getRedis, rateLimiter } from '../../services';
import { captureException } from '../../services/sentry';
import { envFlag } from '../../utils/envFlag';
import { authResponseFloorPromise } from './helpers';

export const loginContextRoutes = new Hono();

const NULL_CONTEXT: LoginContext = { branding: null, partnerSso: null };

// Shared by both entry points below so the branding/provider pick can never
// drift between them (#4017). Deterministic pick when several providers are
// active (#2195): oldest first, id as tiebreak — the same ORDER BY the SSO
// entry routes use, so the button on the login page always names the
// provider the entry route will actually start a flow with.
async function resolvePartnerLoginContext(partnerId: string): Promise<LoginContext> {
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
}

// Public, unauthenticated. Single-partner (self-hosted) fast-path only: on a
// multi-partner instance this endpoint deliberately reveals NOTHING (#2183
// tenant-leakage constraint). Hosted partners use the slug-scoped variant
// below (#4017).
loginContextRoutes.get('/login-context', async (c) => {
  const redis = getRedis();
  // Call unconditionally (no `if (redis)` guard) — mirrors the partner SSO
  // entry route (GET /sso/login/partner/:partnerId): rateLimiter fails
  // CLOSED (allowed: false) when redis is null, so a missing Redis denies
  // the request rather than silently skipping the limit.
  const check = await rateLimiter(redis, `login-context:${rateLimitIpKey(getTrustedClientIp(c))}`, 30, 60);
  if (!check.allowed) {
    return c.json({ error: 'Too many requests' }, 429);
  }

  // Hosted guard (#2195): the single-partner fast-path is a self-hosted
  // convenience. A hosted region that happened to shrink to exactly one
  // partner must not publicly serve that partner's branding/SSO entry —
  // hosted discovery is the slug path below (#4017). envFlag (not a bare
  // === 'true') so every hosted spelling the production config validator
  // accepts (1/yes/on) trips the guard; production refuses to boot with
  // IS_HOSTED unset, so unset here means a self-hosted dev instance.
  if (envFlag('IS_HOSTED', false)) {
    c.header('Cache-Control', 'public, max-age=60');
    return c.json(NULL_CONTEXT);
  }

  let context: LoginContext;
  try {
    context = await withSystemDbAccessContext(async () => {
      const partnerRows = await db.select({ id: partners.id }).from(partners).limit(2);
      if (partnerRows.length !== 1 || !partnerRows[0]) {
        return NULL_CONTEXT;
      }
      return resolvePartnerLoginContext(partnerRows[0].id);
    });
  } catch (err) {
    // This endpoint gates login-page RENDERING on a public, unauthenticated
    // route — a DB blip must degrade to the stock login page, never surface
    // a 500. Never cache the degraded response as if it were a real result.
    console.error('[auth] login-context DB read failed, degrading to stock page:', err);
    captureException(err, c);
    c.header('Cache-Control', 'no-store');
    return c.json(NULL_CONTEXT);
  }

  c.header('Cache-Control', 'public, max-age=60');
  return c.json(context);
});

const slugParamSchema = z.object({ slug: z.string().min(1).max(100) });

/**
 * GET /auth/login-context/partner/:slug — the slug-scoped login context behind
 * the web's /login/<partner-slug> page (#4017).
 *
 * Unlike the singleton route above this runs on hosted deployments too: the
 * visitor SUPPLIES the tenant in the URL, so the page shows nothing the
 * visitor did not already name. What it must not become is a lookup that
 * tells "this slug belongs to a real partner" apart from "it does not":
 *
 *  - An unknown slug, an inactive / soft-deleted partner's slug, and an active
 *    partner with nothing configured all return the same 200 null-shape body
 *    with the same headers. No 404 anywhere.
 *  - Every response waits for the shared auth response floor (the same
 *    equalizer login and sso-discovery use), so the extra branding/provider
 *    reads on a hit do not show up as latency.
 *  - `no-store` on every path: the success, null and degraded responses carry
 *    identical headers, and a shared cache never holds one.
 *  - Its own rate-limit bucket (separately namespaced) so slug guessing from
 *    one address cannot also exhaust the singleton route's budget.
 *
 * Residual disclosure, stated plainly: a partner that HAS configured branding
 * or SSO is identifiable by its rendered login page. That is the feature —
 * the partner published that page — and it enumerates nothing on its own.
 */
loginContextRoutes.get('/login-context/partner/:slug', zValidator('param', slugParamSchema), async (c) => {
  const floorPromise = authResponseFloorPromise();
  c.header('Cache-Control', 'no-store');

  const { slug } = c.req.valid('param');
  const check = await rateLimiter(
    getRedis(),
    `login-context:slug:${rateLimitIpKey(getTrustedClientIp(c))}`,
    30,
    60
  );
  if (!check.allowed) {
    // A real 429: the bucket is keyed on the client, never on the slug, so it
    // says nothing about any partner.
    await floorPromise;
    return c.json({ error: 'Too many requests' }, 429);
  }

  let context: LoginContext;
  try {
    context = await withSystemDbAccessContext(async () => {
      // Case-insensitive match: the self-service signup path lowercases
      // slugs, but the platform-admin partner create/update path does not, and
      // the UNIQUE constraint on partners.slug is case-sensitive. Two partners
      // whose slugs differ only by case resolve by exact match or not at all —
      // never a guess between tenants.
      const rows = await db
        .select({ id: partners.id, slug: partners.slug })
        .from(partners)
        .where(and(
          sql`lower(${partners.slug}) = ${slug.toLowerCase()}`,
          eq(partners.status, 'active'),
          isNull(partners.deletedAt)
        ))
        // Exact-case row first, so it is inside the limit even when more than
        // two case variants exist.
        .orderBy(sql`(${partners.slug} = ${slug}) desc`)
        .limit(2);

      const match = rows.find((row) => row.slug === slug) ?? (rows.length === 1 ? rows[0] : undefined);
      if (!match) return NULL_CONTEXT;
      return resolvePartnerLoginContext(match.id);
    });
  } catch (err) {
    console.error('[auth] login-context (slug) DB read failed, degrading to stock page:', err);
    captureException(err, c);
    await floorPromise;
    return c.json(NULL_CONTEXT);
  }

  await floorPromise;
  return c.json(context);
});
