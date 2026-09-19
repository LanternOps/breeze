import { Hono } from 'hono';
import { z } from 'zod';
import { and, eq, isNotNull } from 'drizzle-orm';
import type { SsoDiscoveryResult } from '@breeze/shared';
import { zValidator } from '../../lib/validation';
import { db, withSystemDbAccessContext } from '../../db';
import { ssoProviders, ssoVerifiedDomains } from '../../db/schema';
import { getRedis, rateLimiter } from '../../services';
import { captureException } from '../../services/sentry';
import { authResponseFloorPromise, getClientRateLimitKey } from './helpers';

export const ssoDiscoveryRoutes = new Hono();

// A login page fires at most one of these per address the user types. 20 per
// 5 minutes is far above any human's rate and far below what a scripted domain
// sweep needs. Keyed on the CLIENT, never on the submitted address.
const SSO_DISCOVERY_RATE_LIMIT = { limit: 20, windowSeconds: 300 };

const ssoDiscoverySchema = z.object({
  email: z.string().trim().email().max(320),
});

const NO_SSO: SsoDiscoveryResult = { sso: null };

function emailDomain(email: string): string | null {
  const at = email.lastIndexOf('@');
  if (at < 1 || at === email.length - 1) return null;
  // Strip the FQDN root dot: `user@example.com.` is a valid address whose
  // domain resolves identically to `example.com`, but sso_verified_domains
  // stores the normalized form (services/ssoDomainVerification.ts), so leaving
  // the dot on would silently miss a real match.
  const domain = email.slice(at + 1).toLowerCase().replace(/\.+$/, '');
  return domain || null;
}

/**
 * POST /auth/sso-discovery — public, unauthenticated home-realm discovery for
 * ORG-axis SSO (#3229).
 *
 * WHY THIS IS KEYED ON THE DOMAIN AND NOT THE ADDRESS.
 * The obvious implementation looks the address up in `users`, resolves that
 * user's tenant, and reports its enforcement. That endpoint would be a flat
 * account-existence oracle: a distinguishable answer for "this exact address is
 * registered here" is precisely the signal SR2-22 (forgot-password) and SR2-23
 * (the login lockout 429) were rewritten to destroy. Re-introducing it on a new
 * route to save the user a click is not a trade this codebase makes.
 *
 * So discovery never touches `users`. The answer is a pure function of
 *   (email domain) x (the tenant's own DNS-proven, admin-published config),
 * and is identical for a real address, a typo, and an address that has never
 * existed. `sso_verified_domains` is the right source because ownership there
 * is proven by a DNS TXT record (services/ssoDomainVerification.ts) — the
 * provider's free-text `allowed_domains` list is NOT, so on a shared instance a
 * hostile tenant could list someone else's domain and have this route point
 * their users at an attacker-controlled IdP. Only `verified_at IS NOT NULL`
 * rows count, for the same reason: an unverified row is an unproven claim.
 *
 * RESIDUAL DISCLOSURE, stated honestly: a positive answer confirms that the
 * domain the caller already typed is federated on this instance and names the
 * provider. That is domain-granular, it is configuration the tenant's own
 * admin deliberately published, and it enumerates nothing — the caller must
 * already know the domain to ask. It is the same disclosure every IdP
 * home-realm-discovery page makes.
 *
 * COVERAGE, stated honestly: an org that has NOT verified a domain gets the
 * negative answer and its users see the password form exactly as they do
 * today — server-side ssoPolicy still refuses the password, so this is the
 * pre-existing behaviour, not a regression this route introduces.
 */
ssoDiscoveryRoutes.post('/sso-discovery', zValidator('json', ssoDiscoverySchema), async (c) => {
  // Started before any branch and awaited before every return: the handler
  // below is NOT branch-free (unlike forgot-password it must actually read the
  // config it reports), so the shared floor is what keeps a fast negative and a
  // slow positive in the same latency class. Same equalizer as login/H-4 and
  // forgot-password/SR2-22 — deliberately not a second one.
  const floorPromise = authResponseFloorPromise();
  // Never cacheable: a shared cache in front of the API must not be able to
  // answer one tenant's discovery request out of another's stored response.
  c.header('Cache-Control', 'no-store');

  const { email } = c.req.valid('json');

  // Called unconditionally (no `if (redis)` guard) — rateLimiter fails CLOSED
  // when redis is null, so a missing Redis denies rather than silently serving
  // an unlimited discovery endpoint. Same posture as GET /auth/login-context.
  const check = await rateLimiter(
    getRedis(),
    `sso-discovery:${getClientRateLimitKey(c)}`,
    SSO_DISCOVERY_RATE_LIMIT.limit,
    SSO_DISCOVERY_RATE_LIMIT.windowSeconds
  );
  if (!check.allowed) {
    // A real 429, NOT a `{ sso: null }` 200. The bucket is keyed on the client
    // and can never be entered by naming a particular address, so it discloses
    // nothing about any account — while answering "no SSO here" to a throttled
    // SSO-only user would walk them into a password form the server always
    // rejects.
    await floorPromise;
    return c.json({
      error: 'Too many requests',
      retryAfter: Math.max(1, Math.ceil((check.resetAt.getTime() - Date.now()) / 1000)),
    }, 429);
  }

  const domain = emailDomain(email.trim().toLowerCase());
  if (!domain) {
    await floorPromise;
    return c.json(NO_SSO);
  }

  let result: SsoDiscoveryResult;
  try {
    result = await withSystemDbAccessContext(async () => {
      // Pre-auth: there is no request RLS context, so an org-scoped read under
      // `breeze_app` would return zero rows and silently disable the feature.
      const domainRows = await db
        .select({ orgId: ssoVerifiedDomains.orgId })
        .from(ssoVerifiedDomains)
        .where(and(
          eq(ssoVerifiedDomains.domain, domain),
          isNotNull(ssoVerifiedDomains.verifiedAt)
        ))
        .limit(2);

      // The unique index is (org_id, domain), not domain alone, so two orgs can
      // each prove the same domain. Picking either would be a guess, and a
      // wrong guess hands the user to a stranger's IdP — refuse to attribute.
      const [domainRow] = domainRows;
      if (domainRows.length !== 1 || !domainRow) return NO_SSO;
      const orgId = domainRow.orgId;

      // Mirrors isPasswordAuthDisabledBySso's org branch exactly (ssoPolicy.ts):
      // password login is refused if ANY active provider enforces SSO. Asking
      // the same question the login path asks is what keeps the UI and the
      // server from disagreeing.
      const [enforcing] = await db
        .select({ id: ssoProviders.id })
        .from(ssoProviders)
        .where(and(
          eq(ssoProviders.orgId, orgId),
          eq(ssoProviders.status, 'active'),
          eq(ssoProviders.enforceSSO, true)
        ))
        .limit(1);
      if (!enforcing) return NO_SSO;

      // WHICH provider gets named is a separate question from WHETHER SSO is
      // enforced, and the two can resolve to different rows. GET
      // /sso/login/:orgId launches the OLDEST ACTIVE provider and does not look
      // at enforce_sso at all (sso.ts), so naming the enforcing provider found
      // above would let the button say "Okta" and then start an Authentik flow.
      // Same ORDER BY as every other SSO-discovery surface (#2195).
      const [entry] = await db
        .select({ name: ssoProviders.name, type: ssoProviders.type })
        .from(ssoProviders)
        .where(and(
          eq(ssoProviders.orgId, orgId),
          eq(ssoProviders.status, 'active')
        ))
        .orderBy(ssoProviders.createdAt, ssoProviders.id)
        .limit(1);
      if (!entry) return NO_SSO;

      // The entry route rejects anything but OIDC with a 400. A tenant whose
      // oldest active provider is SAML is already in a locked-out state that
      // discovery cannot repair; advertising a button that is guaranteed to
      // fail would only make it harder to diagnose.
      if (entry.type !== 'oidc') return NO_SSO;

      return {
        sso: {
          providerName: entry.name,
          loginUrl: `/api/v1/sso/login/${orgId}`,
          enforceSSO: true as const,
        },
      };
    });
  } catch (err) {
    // This gates login-page RENDERING on a public route — a DB blip must
    // degrade to the password form, never surface a 500 (and never a distinct
    // status that would itself be observable). Same degrade as login-context.
    console.error('[auth] sso-discovery DB read failed, degrading to no-sso:', err);
    captureException(err, c);
    await floorPromise;
    return c.json(NO_SSO);
  }

  await floorPromise;
  return c.json(result);
});
