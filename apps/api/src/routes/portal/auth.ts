import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { zValidator } from '../../lib/validation';
import { and, eq, sql } from 'drizzle-orm';
import { createHash } from 'crypto';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { organizations, partners, portalBranding, portalUsers } from '../../db/schema';
import { getDummyPasswordHash, hashPassword, isPasswordStrong, verifyPassword } from '../../services/password';
import { getEmailService } from '../../services/email';
import { getRedis } from '../../services/redis';
import { getActiveOrgTenant } from '../../services/tenantStatus';
import { rateLimitIpKey } from '../../services/clientIp';
import { portalAccountRateLimitKey } from '../../services/portal/rateLimit';
import { resolveOrgTimezone } from '../../services/portal/timezone';
import {
  loginSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  acceptInviteSchema,
  SESSION_TTL_MS,
  SESSION_TTL_SECONDS,
  PORTAL_SESSION_COOKIE_NAME,
  PORTAL_USE_REDIS,
  PORTAL_REDIS_KEYS,
  LOGIN_RATE_LIMIT,
  FORGOT_PASSWORD_RATE_LIMIT,
  RESET_PASSWORD_RATE_LIMIT,
} from './schemas';
import {
  portalSessions,
  normalizeEmail,
  getClientIp,
  setPortalSessionCookies,
  clearPortalSessionCookies,
  getCookieValue,
  sweepPortalState,
  checkRateLimit,
  clearRateLimitKeys,
  buildPortalUserPayload,
  validatePortalCookieCsrfRequest,
  buildPortalUrl,
  purgePortalSessionsForUsers,
} from './helpers';
import {
  consumePortalCapabilityToken,
  issuePortalCapabilityToken,
  validatePortalCapability,
} from './capabilityTokens';
import { PortalAccountTransitionError, isPasswordEligible, planPortalAccountTransition } from '../../services/portalAccountState';
import { PortalAccessPolicyOrgNotFoundError, resolvePortalAccessPolicy } from '../../services/portalAccessPolicy';
import {
  PortalSessionStoreUnavailableError,
  isBrowserSessionAllowed,
  isPasswordSignInAllowedForOrg,
  mintPortalBrowserSession,
  parseStoredPortalSession,
  type StoredPortalSession,
} from './browserSession';
import { PORTAL_LOGIN_CANDIDATE_CAP, resolveLoginCandidate } from './loginCandidates';
import { isSelfManagedDbContextRoute } from '../../middleware/selfManagedDbContextRoutes';
import { portalOrgDbAccessContext } from './portalDbContext';
import { purgeClientAiSessionsForUsers } from '../../services/clientAiSessionStore';
import { portalSessionRevokedSql, revokePortalSessionDurably } from '../../services/portal/sessionRevocation';
import { ANONYMOUS_ACTOR_ID, writeAuditEventAsync } from '../../services/auditEvents';

export const authRoutes = new Hono();
const ALLOW_IN_MEMORY_PORTAL_STATE = !PORTAL_USE_REDIS;

/** `code` on the account-status 403 (sweep 2026-09-08 G5-6) — see the gate
 *  below and apps/portal/src/lib/accountStatus.ts, which mirrors this string. */
export const PORTAL_ACCOUNT_INACTIVE_CODE = 'PORTAL_ACCOUNT_INACTIVE';

/** Login-time refusal for a portal user whose organization is no longer active
 *  (churned, archived, suspended, merging, or owning partner inactive — #10934).
 *  The login form renders `error` verbatim. */
export const PORTAL_ORG_UNAVAILABLE_CODE = 'PORTAL_ORG_UNAVAILABLE';
const PORTAL_ORG_UNAVAILABLE_MESSAGE =
  'This portal is no longer active. Contact your IT provider if you think this is a mistake.';

/**
 * Paths a disabled portal user is still permitted to hit despite failing the
 * account-status gate. Kept intentionally tight — pure session teardown only.
 * `c.req.path` is the absolute request path (e.g. `/api/v1/portal/auth/logout`),
 * so match on suffix rather than assuming any particular mount prefix.
 */
/**
 * Drop one refused session from the Redis cache: `del` on the session key,
 * `srem` on the user's session index, in one MULTI. Shared by the stale-epoch,
 * signed-out and policy-refused branches of the session middleware. Cleanup
 * only: a Redis error is logged as a warning and never changes the caller's
 * 401, because the durable checks refuse the same session again on every request.
 */
async function purgeCachedPortalSession(token: string, userId: string, reason: string): Promise<void> {
  if (!PORTAL_USE_REDIS) return;
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis
      .multi()
      .del(PORTAL_REDIS_KEYS.session(token))
      .srem(PORTAL_REDIS_KEYS.userSessions(userId), token)
      .exec();
  } catch (error) {
    console.warn(`[portal] Failed to drop a ${reason} session from the cache:`, error instanceof Error ? error.message : error);
  }
}

function isPortalAuthGateExemptPath(path: string): boolean {
  return path.endsWith('/auth/logout');
}

const PORTAL_AUTH_AUDIT_ACTIONS = new Map<string, string>([
  ['/auth/login', 'portal.auth.login'],
  ['/auth/forgot-password', 'portal.auth.password_reset.request'],
  ['/auth/reset-password', 'portal.auth.password_reset.complete'],
  ['/auth/accept-invite', 'portal.auth.invite.accept'],
  ['/auth/logout', 'portal.auth.logout'],
]);

function setPortalAuthAuditIdentity(
  c: Context,
  user: { id: string; orgId: string; email: string },
): void {
  c.set('portalAuthAuditIdentity', { userId: user.id, orgId: user.orgId, email: user.email });
}

// These public/session-auth endpoints sit outside the staff mutation fallback.
// Wrap validation and the handler so every terminal response (including a
// validator rejection or thrown failure) receives one secret-safe event.
authRoutes.use('/auth/*', async (c, next) => {
  const action = PORTAL_AUTH_AUDIT_ACTIONS.get(c.req.path.replace(/^\/api\/v1\/portal/, ''));
  if (!action || c.req.method !== 'POST') return next();

  let threw = false;
  try {
    await next();
  } catch (error) {
    threw = true;
    throw error;
  } finally {
    const portalAuth = c.get('portalAuth');
    const identity = c.get('portalAuthAuditIdentity') ?? (portalAuth ? {
      userId: portalAuth.user.id,
      orgId: portalAuth.user.orgId,
      email: portalAuth.user.email,
    } : undefined);
    const status = threw ? 500 : c.res.status;
    await writeAuditEventAsync(c, {
      orgId: identity?.orgId,
      actorType: identity ? 'user' : 'system',
      actorId: identity?.userId ?? ANONYMOUS_ACTOR_ID,
      actorEmail: identity?.email,
      initiatedBy: 'manual',
      action,
      resourceType: 'portal_auth',
      resourceId: identity?.userId,
      result: threw || status >= 500 ? 'failure' : status >= 400 ? 'denied' : 'success',
      details: { httpStatus: status },
    });
  }
});

async function isPortalPasswordResetEnabled(orgId: string): Promise<boolean> {
  const [row] = await withSystemDbAccessContext(() =>
    db
      .select({ enablePasswordReset: portalBranding.enablePasswordReset })
      .from(portalBranding)
      .where(eq(portalBranding.orgId, orgId))
      .limit(1)
  );
  return row?.enablePasswordReset !== false;
}

// ============================================
// Auth middleware
// ============================================

/**
 * Scalar subquery for the organization's display name, folded into the portal
 * user selects so login, session hydration and invite-accept all carry it
 * without an extra round trip. A genuinely missing org yields null and
 * buildPortalUserPayload falls back to the generic label.
 */
const portalOrgNameSql = () => sql<string | null>`(select o.name from organizations o where o.id = ${portalUsers.orgId})`;

export async function portalAuthMiddleware(c: Context, next: Next) {
  sweepPortalState();

  const authHeader = c.req.header('Authorization');
  const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const cookieToken = getCookieValue(c.req.header('cookie'), PORTAL_SESSION_COOKIE_NAME);
  const token = bearerToken || cookieToken;
  const authMethod = bearerToken ? 'bearer' : 'cookie';

  if (!token) {
    return c.json({ error: 'Missing or invalid authorization header' }, 401);
  }

  // Both stores go through one parser (W3, plan D6): a payload without
  // `method` is a pre-W3 password session; an unknown method or a bad shape
  // (including a missing or non-integer auth epoch) is no session at all.
  let sessionData: StoredPortalSession | null = null;

  if (PORTAL_USE_REDIS) {
    const redis = getRedis();
    if (!redis) {
      if (process.env.NODE_ENV === 'production') {
        return c.json({ error: 'Service temporarily unavailable' }, 503);
      }
    } else {
      const raw = await redis.get(PORTAL_REDIS_KEYS.session(token));
      if (raw) {
        try {
          sessionData = parseStoredPortalSession(JSON.parse(raw));
        } catch (err) {
          console.error('[portal] Failed to parse Redis session data:', (err as Error).message);
        }
      }
    }
  }

  if (!sessionData && ALLOW_IN_MEMORY_PORTAL_STATE) {
    const session = portalSessions.get(token);
    if (session && session.expiresAt.getTime() > Date.now()) {
      sessionData = parseStoredPortalSession(session);
      // An unusable in-memory entry can never become valid: drop it.
      if (!sessionData) portalSessions.delete(token);
    } else if (session) {
      portalSessions.delete(token);
    }
  }

  if (!sessionData) {
    if (cookieToken) {
      clearPortalSessionCookies(c);
    }
    return c.json({ error: 'Invalid or expired session' }, 401);
  }

  // Pre-auth hydration: the session is already validated (Redis/in-memory),
  // but the portal_users row lives behind org-forced RLS. Run this lookup
  // under system scope so it resolves under the unprivileged breeze_app pool —
  // the same pattern authMiddleware uses for its pre-auth users lookup.
  const user = await withSystemDbAccessContext(async () => {
    const [user] = await db
      .select({
        id: portalUsers.id,
        orgId: portalUsers.orgId,
        email: portalUsers.email,
        name: portalUsers.name,
        // #3258 W03: the CONTACT this login belongs to. Portal ticket
        // ownership is `submitted_by = me OR requester_contact_id = my
        // contact` — without this hydration a customer who emailed support
        // and then logged in would see none of their own tickets, because an
        // emailed ticket has no `submitted_by` at all.
        contactId: portalUsers.contactId,
        authMethod: portalUsers.authMethod,
        // Browser portal access (W2, spec §6 invariant 9), re-checked per request.
        browserAccess: portalUsers.browserAccess,
        receiveNotifications: portalUsers.receiveNotifications,
        status: portalUsers.status,
        authEpoch: portalUsers.authEpoch,
        orgName: portalOrgNameSql(),
        // Signed out at logout (durable record, see sessionRevocation.ts).
        sessionRevoked: portalSessionRevokedSql(token),
      })
      .from(portalUsers)
      .where(and(eq(portalUsers.id, sessionData.portalUserId), eq(portalUsers.orgId, sessionData.orgId)))
      .limit(1);
    return user;
  });

  // `browser_access` (W2) is the explicit grant: an account without it never
  // holds a browser session, whatever its method. A PASSWORD session also needs
  // a password-eligible account: the add-in's Entra JIT login uses a separate
  // Client-AI session and must never inherit browser access merely because a
  // historical recovery/invite path populated password_hash. (W3 mints only
  // password sessions, so this is the pre-W3 gate by construction; the
  // entra/google sessions of W4/W7 are gated by method in the policy gate
  // below.) A session that fails this check is purged right here, so logout
  // needs no separate path for it.
  if (!user || user.browserAccess !== 'granted' || (sessionData.method === 'password' && !isPasswordEligible(user))) {
    if (PORTAL_USE_REDIS) {
      const redis = getRedis();
      if (redis) {
        if (user) {
          await redis
            .multi()
            .del(PORTAL_REDIS_KEYS.session(token))
            .srem(PORTAL_REDIS_KEYS.userSessions(user.id), token)
            .exec();
        } else {
          await redis.del(PORTAL_REDIS_KEYS.session(token));
        }
      }
    }
    if (ALLOW_IN_MEMORY_PORTAL_STATE) {
      portalSessions.delete(token);
    }
    if (cookieToken) {
      clearPortalSessionCookies(c);
    }
    return c.json({ error: 'Portal user not found' }, 401);
  }

  if (user.authEpoch !== sessionData.authEpoch) {
    await purgeCachedPortalSession(token, user.id, 'stale-epoch');
    if (ALLOW_IN_MEMORY_PORTAL_STATE) portalSessions.delete(token);
    if (cookieToken) clearPortalSessionCookies(c);
    return c.json({ error: 'Invalid or expired session' }, 401);
  }

  // A token signed out at logout stays refused even if the cache still holds
  // it (failed delete, lagging replica, Redis restored from an older
  // snapshot). Checked before the account/org gates, the sliding-expiry write
  // and any route work. Cache removal here is cleanup only.
  if (user.sessionRevoked === true) {
    await purgeCachedPortalSession(token, user.id, 'signed-out');
    if (ALLOW_IN_MEMORY_PORTAL_STATE) portalSessions.delete(token);
    if (cookieToken) clearPortalSessionCookies(c);
    return c.json({ error: 'Invalid or expired session' }, 401);
  }

  if (user.status !== 'active') {
    // `/auth/logout` is exempt: a disabled portal user must still be able to
    // sign out and clear their session cookie (sweep 2026-09-08 G5-6). Without
    // this, a disabled user was trapped logged-in-but-blocked — every request
    // (including logout) 403'd, the cookie never cleared, and `/login` bounced
    // them straight back to a page that 403'd the same way. Sign-out is pure
    // teardown with no DB reads, so we skip the org-status gate and the
    // request-transaction wrapper below entirely rather than special-casing
    // them too.
    if (!isPortalAuthGateExemptPath(c.req.path)) {
      // `code` lets the portal app distinguish a deliberate account-disable
      // from a generic load failure (e.g. an outage) and route to its own
      // "access disabled" page instead of rendering the outage copy.
      return c.json({ error: 'Account is not active', code: PORTAL_ACCOUNT_INACTIVE_CODE }, 403);
    }
    // Timezone is resolved further down, only after the durable session/org
    // checks pass (see the comment there) — this exempt path returns before
    // that point by design (pure teardown, no DB reads), and logout is the
    // only handler reachable here, which never consumes `auth.timezone`.
    c.set('portalAuth', { user, token, authMethod, timezone: 'UTC' });
    if (authMethod === 'cookie') {
      setPortalSessionCookies(c, token);
    }
    return next();
  }

  // Org-status gate. Portal sessions live in Redis and were validated against
  // the portal_users row only — nothing here ever consulted the ORG's
  // lifecycle state, so a portal user kept full read/write access to an org
  // that had been suspended, offboarded, archived, or (org-lifecycle Wave 2)
  // fenced into `merging` for a merge. During a merge that is not merely a
  // stale read: a portal write landing under the loser org after the fence is
  // either stranded by the re-tenant or destroyed by the erasure that follows.
  //
  // `getActiveOrgTenant` is the same machinery the agent and API ingress paths
  // use — it applies `isUsableOrgStatus`, the `deleted_at` check and the owning
  // partner's status in one system-context read, so this gate cannot drift
  // from theirs.
  const activeOrg = await getActiveOrgTenant(user.orgId);
  if (!activeOrg) {
    if (PORTAL_USE_REDIS) {
      const redis = getRedis();
      if (redis) await redis.del(PORTAL_REDIS_KEYS.session(token));
    }
    if (ALLOW_IN_MEMORY_PORTAL_STATE) {
      portalSessions.delete(token);
    }
    if (cookieToken) {
      clearPortalSessionCookies(c);
    }
    return c.json({ error: 'Organization is not available' }, 403);
  }

  // Access-policy gate (portal registration W3, inv. 9 / 11). Re-resolved on
  // every request with no cache (plan D1), so an org override or an inherited
  // partner default that switches password sign-in off ends a live password
  // session on its very next request, on every API instance. The same check
  // ends an SSO session at the current `ssoSessionMaxHours` from its mint, and
  // an entra session whose tenant is no longer the org's proven one (W4, D9).
  // Logout is exempt so a refused session can still sign out.
  //
  // No DB context is held here: the request transaction is opened only at the
  // end of this middleware, and every read above ran in its own short system
  // context, so the resolver opens one of its own. The only error caught is
  // PortalAccessPolicyOrgNotFoundError, which is thrown in JS after a
  // successful read and so can never poison a transaction; anything else
  // propagates and fails the request closed.
  if (!isPortalAuthGateExemptPath(c.req.path)) {
    let allowed: boolean;
    try {
      allowed = isBrowserSessionAllowed(sessionData, user, await resolvePortalAccessPolicy(user.orgId), Date.now());
    } catch (error) {
      if (!(error instanceof PortalAccessPolicyOrgNotFoundError)) throw error;
      allowed = false;
    }
    if (!allowed) {
      await purgeCachedPortalSession(token, user.id, 'policy-refused');
      if (ALLOW_IN_MEMORY_PORTAL_STATE) portalSessions.delete(token);
      if (cookieToken) clearPortalSessionCookies(c);
      return c.json({ error: 'Invalid or expired session' }, 401);
    }
  }

  // Resolve only after the durable session checks. A stale/legacy generation
  // must not trigger even a secondary tenant read, much less route work.
  const timezone = await withSystemDbAccessContext(() => resolveOrgTimezone(sessionData.orgId));

  // Sliding session timeout: any authenticated activity pushes expiry forward.
  if (PORTAL_USE_REDIS) {
    const redis = getRedis();
    if (redis) {
      try {
        await redis
          .multi()
          .expire(PORTAL_REDIS_KEYS.session(token), SESSION_TTL_SECONDS)
          .expire(PORTAL_REDIS_KEYS.userSessions(user.id), SESSION_TTL_SECONDS * 2)
          .exec();
      } catch (error) {
        console.error('[portal] Failed to extend Redis session TTL:', error);
      }
    }
  }

  if (ALLOW_IN_MEMORY_PORTAL_STATE) {
    const session = portalSessions.get(token);
    if (session) {
      session.expiresAt = new Date(Date.now() + SESSION_TTL_MS);
      portalSessions.set(token, session);
    }
  }

  if (authMethod === 'cookie') {
    setPortalSessionCookies(c, token);
  }

  c.set('portalAuth', {
    user,
    token,
    authMethod,
    partnerId: activeOrg.partnerId,
    timezone: timezone ?? 'UTC',
  });

  // #1448 — a small set of routes (the Stripe pay route) opt OUT of the auto
  // request-transaction so a slow outbound HTTP call (Checkout sessions.create)
  // isn't made inside a held transaction (pinning a pooled connection
  // idle-in-transaction, the #1105 class). They run with NO ambient context and
  // manage their own short DB access contexts; portalAuth is still set above so
  // the handler can read the authenticated org.
  if (isSelfManagedDbContextRoute(c.req.method, c.req.path)) {
    return next();
  }

  // Run the protected request under the portal user's organization scope so
  // RLS on every portal-facing table (tickets, devices, assets, profile, ...)
  // is satisfied — and enforced — under the unprivileged breeze_app pool.
  // Session/Redis work above stays OUTSIDE this context so the wrapping
  // transaction is not held open across slow I/O (#1105).
  //
  // Handlers run INSIDE this transaction, so a nested withSystemDbAccessContext()
  // is a no-op for scope (db/index.ts short-circuits when a context is already
  // active) — it still runs under org scope. A handler that genuinely needs a
  // system-scoped sub-query must do runOutsideDbContext(() =>
  // withSystemDbAccessContext(...)) explicitly. Likewise, any un-awaited db.*
  // side effect must not capture this txn (mirror auditService's pattern).
  return withDbAccessContext(portalOrgDbAccessContext(user.orgId), () => next());
}

// ============================================
// Auth routes
// ============================================

/**
 * A password session through the shared mint (W4: the OIDC callback mints its
 * entra sessions through the same function). Null when the session store is
 * unavailable, which the password routes answer with 503.
 */
async function mintPasswordSession(
  c: Context,
  input: { portalUserId: string; orgId: string; authEpoch: number },
): Promise<{ token: string; expiresAt: Date } | null> {
  try {
    return await mintPortalBrowserSession(c, { ...input, method: 'password' });
  } catch (error) {
    if (error instanceof PortalSessionStoreUnavailableError) return null;
    throw error;
  }
}

authRoutes.post('/auth/login', zValidator('json', loginSchema), async (c) => {
  sweepPortalState();

  const { email, password, orgId } = c.req.valid('json');
  const normalizedEmail = normalizeEmail(email);
  const clientIp = getClientIp(c);
  const ipRateKey = `portal:login:ip:${rateLimitIpKey(clientIp)}`;
  const accountRateKey = portalAccountRateLimitKey('login', normalizedEmail);

  for (const rateKey of [ipRateKey, accountRateKey]) {
    const rate = await checkRateLimit(rateKey, LOGIN_RATE_LIMIT);
    if (!rate.allowed) {
      c.header('Retry-After', String(rate.retryAfterSeconds));
      return c.json({ error: 'Too many login attempts. Please try again later.' }, 429);
    }
  }

  // Pre-auth credential lookup resolves a portal user by email (optionally
  // scoped by orgId) before any tenant context exists — run under system scope
  // so org-forced RLS doesn't hide the row under the breeze_app pool.
  //
  // An address may hold a password account in several orgs. Every candidate
  // is verified and the login succeeds only when exactly ONE verifies; any
  // other outcome is the ordinary 401 below (W2, spec §6 invariant 8 — the
  // response never reveals that an address has more than one account). Only
  // password logins WITH browser access are candidates.
  const userRows = await withSystemDbAccessContext(() =>
    db
      .select({
        id: portalUsers.id,
        orgId: portalUsers.orgId,
        email: portalUsers.email,
        name: portalUsers.name,
        passwordHash: portalUsers.passwordHash,
        authMethod: portalUsers.authMethod,
        receiveNotifications: portalUsers.receiveNotifications,
        status: portalUsers.status,
        authEpoch: portalUsers.authEpoch,
        orgName: portalOrgNameSql(),
      })
      .from(portalUsers)
      .where(and(
        ...(orgId ? [eq(portalUsers.orgId, orgId)] : []),
        eq(portalUsers.email, normalizedEmail),
        eq(portalUsers.authMethod, 'password'),
        eq(portalUsers.browserAccess, 'granted'),
      ))
      .limit(PORTAL_LOGIN_CANDIDATE_CAP + 1)
  );

  // Attribute the attempt to an account only when the address names exactly
  // one; several candidates with no winner audit like an unknown address.
  if (userRows.length === 1) setPortalAuthAuditIdentity(c, userRows[0]!);

  const user = await resolveLoginCandidate(userRows, password, verifyPassword, getDummyPasswordHash);
  if (!user) {
    return c.json({ error: 'Invalid email or password' }, 401);
  }
  setPortalAuthAuditIdentity(c, user);

  // Access policy (W3, inv. 8 / 11): an org whose effective policy has
  // switched password sign-in off answers exactly like a wrong password — the
  // same 401 body, the same two rate-limit buckets already counted above, and
  // no clear. Checked before the org/status 403s so a refusal never reveals
  // org or account state either. No DB context is held on this public route.
  if (!await isPasswordSignInAllowedForOrg(user.orgId)) {
    return c.json({ error: 'Invalid email or password' }, 401);
  }

  // Refuse a churned/archived/suspended org here, with a reason, instead of
  // minting a session the very next request would 403 and purge (#10934: the
  // customer was silently bounced back to /login). Placed AFTER the password
  // check on purpose: only someone holding valid credentials can see this
  // message, so it never reveals whether an email exists.
  const activeOrg = await getActiveOrgTenant(user.orgId);
  if (!activeOrg) {
    return c.json({ error: PORTAL_ORG_UNAVAILABLE_MESSAGE, code: PORTAL_ORG_UNAVAILABLE_CODE }, 403);
  }

  if (user.status !== 'active') {
    return c.json({ error: 'Account is not active' }, 403);
  }

  const now = new Date();
  const minted = await mintPasswordSession(c, { portalUserId: user.id, orgId: user.orgId, authEpoch: user.authEpoch });
  if (!minted) return c.json({ error: 'Service temporarily unavailable' }, 503);
  const { token, expiresAt } = minted;

  await withSystemDbAccessContext(() =>
    db
      .update(portalUsers)
      .set({ lastLoginAt: now, updatedAt: now })
      .where(eq(portalUsers.id, user.id))
  );

  // accountRateKey is now keyed on email alone, so it already covers every
  // org this address might belong to — nothing further to resolve/clear here.
  await clearRateLimitKeys([ipRateKey, accountRateKey]);

  return c.json({
    user: buildPortalUserPayload(user),
    accessToken: token,
    expiresAt,
    tokens: {
      accessToken: token,
      expiresInSeconds: Math.floor(SESSION_TTL_MS / 1000)
    }
  });
});

authRoutes.post('/auth/forgot-password', zValidator('json', forgotPasswordSchema), async (c) => {
  sweepPortalState();

  const { email, orgId } = c.req.valid('json');
  const normalizedEmail = normalizeEmail(email);
  const clientIp = getClientIp(c);
  const ipRateKey = `portal:forgot:ip:${rateLimitIpKey(clientIp)}`;
  const accountRateKey = portalAccountRateLimitKey('forgot', normalizedEmail);

  for (const rateKey of [ipRateKey, accountRateKey]) {
    const rate = await checkRateLimit(rateKey, FORGOT_PASSWORD_RATE_LIMIT);
    if (!rate.allowed) {
      c.header('Retry-After', String(rate.retryAfterSeconds));
      return c.json({ error: 'Too many password reset attempts. Please try again later.' }, 429);
    }
  }

  if (PORTAL_USE_REDIS && !getRedis()) {
    return c.json({ error: 'Service temporarily unavailable' }, 503);
  }

  const [user] = await withSystemDbAccessContext(() =>
    db
      .select({
        id: portalUsers.id,
        email: portalUsers.email,
        orgId: portalUsers.orgId,
        authMethod: portalUsers.authMethod,
        // W3: no browser access, no self-service reset (the token's only use
        // is a browser password sign-in).
        browserAccess: portalUsers.browserAccess,
        // The reset token is bound to this generation (W2): a password change
        // or disable after issue invalidates it.
        authEpoch: portalUsers.authEpoch,
        // The partner that owns this customer's org — the `support` stream's
        // sender (spec §8.2). PUBLIC, UNAUTHENTICATED ROUTE: the id is derived
        // from the org the portal_users row points at, never from the request
        // body, whose only tenant input (`orgId`) is already constrained by the
        // WHERE below. portal_users.org_id is NOT NULL with an FK to
        // organizations, so the inner join never drops a row that the old query
        // would have returned.
        //
        // This read MUST stay inside withSystemDbAccessContext. An
        // unauthenticated request carries no DB access context, and
        // organizations is org-axis: outside a context the query matches zero
        // rows SILENTLY under forced RLS rather than raising, so a mocked-DB
        // test cannot see the breakage. The live proof drives THIS route with
        // no auth context and asserts the envelope that reaches the transport:
        // __tests__/integration/portalPasswordResetPartnerLane.integration.test.ts.
        partnerId: organizations.partnerId,
        partnerName: partners.name,
      })
      .from(portalUsers)
      .innerJoin(organizations, eq(organizations.id, portalUsers.orgId))
      .leftJoin(partners, eq(partners.id, organizations.partnerId))
      .where(
        orgId
          ? and(eq(portalUsers.orgId, orgId), eq(portalUsers.email, normalizedEmail), eq(portalUsers.authMethod, 'password'))
          : and(eq(portalUsers.email, normalizedEmail), eq(portalUsers.authMethod, 'password'))
      )
      .limit(1)
  );

  if (user) setPortalAuthAuditIdentity(c, user);

  // Every leg must hold, the access policy last (W3): an org whose effective
  // policy has switched password sign-in off gets no token. The response below
  // is the same uniform 200 whatever the outcome (inv. 8).
  const resetEligible = user !== undefined
    && isPasswordEligible(user)
    && user.browserAccess === 'granted'
    && await isPortalPasswordResetEnabled(user.orgId)
    && await isPasswordSignInAllowedForOrg(user.orgId);
  const resetToken = user && resetEligible
    ? await issuePortalCapabilityToken({ purpose: 'reset', portalUserId: user.id, orgId: user.orgId, email: user.email, authEpoch: user.authEpoch })
    : null;
  if (user && resetEligible && !resetToken) {
    // Redis went away after the pre-check. The response stays the uniform
    // success (no enumeration), so record that no email went out.
    console.error('[portal] password reset token not issued (state backend unavailable)', { orgId: user.orgId });
  }
  if (user && resetToken) {
    const orgQuery = orgId ? `&orgId=${encodeURIComponent(orgId)}` : '';
    const resetUrl = buildPortalUrl(`/reset-password?token=${encodeURIComponent(resetToken)}${orgQuery}`);
    const emailService = getEmailService();

    if (emailService) {
      try {
        await emailService.sendPasswordReset({
          to: user.email,
          resetUrl,
          purpose: 'portal.password_reset',
          partnerId: user.partnerId ?? null,
          partnerName: user.partnerName ?? null,
        });
      } catch (error) {
        console.error('[portal] Failed to send password reset email:', error);
      }
    } else {
      console.warn('[PortalAuth] Email service not configured; password reset email was not sent');
    }
  }

  return c.json({ success: true, message: 'If this email exists, a reset link will be sent.' });
});

authRoutes.post('/auth/reset-password', zValidator('json', resetPasswordSchema), async (c) => {
  sweepPortalState();

  const { token, password } = c.req.valid('json');
  const clientIp = getClientIp(c);
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const ipRateKey = `portal:reset:ip:${rateLimitIpKey(clientIp)}`;
  const tokenRateKey = `portal:reset:token:${tokenHash}`;

  for (const rateKey of [ipRateKey, tokenRateKey]) {
    const rate = await checkRateLimit(rateKey, RESET_PASSWORD_RATE_LIMIT);
    if (!rate.allowed) {
      c.header('Retry-After', String(rate.retryAfterSeconds));
      return c.json({ error: 'Too many password reset attempts. Please try again later.' }, 429);
    }
  }

  const passwordCheck = isPasswordStrong(password);
  if (!passwordCheck.valid) {
    return c.json({ error: passwordCheck.errors[0] }, 400);
  }

  if (PORTAL_USE_REDIS && !getRedis()) {
    return c.json({ error: 'Service temporarily unavailable' }, 503);
  }

  // Consumed atomically, then re-checked against the row (W2): same org, same
  // address, same auth_epoch (a password change or disable since issue
  // invalidates it), a password login, not disabled. A legacy {userId} token
  // from before W2 is refused here with the same generic 400.
  const consumed = await consumePortalCapabilityToken('reset', token);
  if (!consumed) {
    return c.json({ error: 'Invalid or expired reset token' }, 400);
  }
  const check = await validatePortalCapability('reset', consumed);
  if (!check.ok) {
    if (check.reason === 'org_unavailable') {
      return c.json({ error: PORTAL_ORG_UNAVAILABLE_MESSAGE, code: PORTAL_ORG_UNAVAILABLE_CODE }, 403);
    }
    return c.json({ error: 'Invalid or expired reset token' }, 400);
  }
  const resetUser = check.user;
  const storedUserId = resetUser.id;
  setPortalAuthAuditIdentity(c, resetUser);
  if (!await isPortalPasswordResetEnabled(resetUser.orgId)) {
    return c.json({ error: 'Password reset is not enabled for this portal' }, 403);
  }

  const passwordHash = await hashPassword(password);
  const now = new Date();

  const updated = await withSystemDbAccessContext(() =>
    db
      .update(portalUsers)
      .set({ passwordHash, authEpoch: sql`${portalUsers.authEpoch} + 1`, updatedAt: now })
      // The generation the token was validated against: a concurrent password
      // change or disable advances it, and this reset must lose.
      .where(and(eq(portalUsers.id, storedUserId), eq(portalUsers.authMethod, 'password'), eq(portalUsers.authEpoch, resetUser.authEpoch)))
      .returning({ id: portalUsers.id })
  );
  if (updated.length !== 1) {
    return c.json({ error: 'Invalid or expired reset token' }, 400);
  }

  await clearRateLimitKeys([ipRateKey, tokenRateKey]);

  if (PORTAL_USE_REDIS) {
    const redis = getRedis();
    if (redis) {
      const indexKey = PORTAL_REDIS_KEYS.userSessions(storedUserId);
      const tokens = await redis.smembers(indexKey);
      if (tokens.length > 0) {
        await redis.del(...tokens.map((t) => PORTAL_REDIS_KEYS.session(t)));
      }
      await redis.del(indexKey);
    }
  }

  if (ALLOW_IN_MEMORY_PORTAL_STATE) {
    for (const [sessionToken, session] of portalSessions.entries()) {
      if (session.portalUserId === storedUserId) {
        portalSessions.delete(sessionToken);
      }
    }
  }

  const resetRedis = getRedis();
  if (resetRedis) await purgeClientAiSessionsForUsers(resetRedis, [storedUserId]);

  return c.json({ success: true, message: 'Password reset successfully' });
});

authRoutes.post('/auth/accept-invite', zValidator('json', acceptInviteSchema), async (c) => {
  sweepPortalState();

  const { token, password, name } = c.req.valid('json');
  const clientIp = getClientIp(c);
  const tokenHash = createHash('sha256').update(token).digest('hex');

  for (const rateKey of [`portal:accept:ip:${rateLimitIpKey(clientIp)}`, `portal:accept:token:${tokenHash}`]) {
    const rate = await checkRateLimit(rateKey, RESET_PASSWORD_RATE_LIMIT);
    if (!rate.allowed) {
      c.header('Retry-After', String(rate.retryAfterSeconds));
      return c.json({ error: 'Too many attempts. Please try again later.' }, 429);
    }
  }

  const strength = isPasswordStrong(password);
  if (!strength.valid) {
    return c.json({ error: strength.errors[0] }, 400);
  }

  if (PORTAL_USE_REDIS && !getRedis()) {
    return c.json({ error: 'Service temporarily unavailable' }, 503);
  }

  // Consumed atomically (a double-click or a second tab gets nothing), then
  // re-checked against the row (W2): same org, same address, same auth_epoch
  // (any disable or re-invite since issue invalidates it), still invited,
  // password-eligible, browser access granted, org active. Every refusal is
  // the generic invite 400 except an unavailable org, which only a holder of
  // an otherwise valid token can see.
  const consumed = await consumePortalCapabilityToken('invite', token);
  if (!consumed) {
    return c.json({ error: 'Invalid or expired invite' }, 400);
  }
  const check = await validatePortalCapability('invite', consumed);
  if (!check.ok) {
    if (check.reason === 'org_unavailable') {
      return c.json({ error: PORTAL_ORG_UNAVAILABLE_MESSAGE, code: PORTAL_ORG_UNAVAILABLE_CODE }, 403);
    }
    return c.json({ error: 'Invalid or expired invite' }, 400);
  }
  const user = check.user;
  setPortalAuthAuditIdentity(c, user);

  let target;
  try {
    target = planPortalAccountTransition({
      status: user.status,
      browserAccess: user.browserAccess,
      authMethod: user.authMethod,
      hasPasswordHash: Boolean(user.passwordHash),
      hasExternalIdentity: user.hasExternalIdentity,
    }, 'accept_invite');
  } catch (error) {
    if (error instanceof PortalAccountTransitionError) {
      return c.json({ error: 'Invalid or expired invite' }, 400);
    }
    throw error;
  }

  const now = new Date();
  const passwordHash = await hashPassword(password);
  const resolvedName = user.name ?? (name ?? null);

  const [activated] = await withSystemDbAccessContext(() =>
    db
      .update(portalUsers)
      .set({ passwordHash, name: resolvedName, status: target.status, browserAccess: target.browserAccess, authEpoch: sql`${portalUsers.authEpoch} + 1`, lastLoginAt: now, updatedAt: now })
      // The invite was checked against this exact durable generation. A
      // concurrent disable/status or credential transition advances it, so
      // this activation must lose instead of resurrecting the account.
      .where(and(eq(portalUsers.id, user.id), eq(portalUsers.authEpoch, user.authEpoch), eq(portalUsers.authMethod, 'password')))
      .returning({ authEpoch: portalUsers.authEpoch })
  );
  if (!activated) return c.json({ error: 'Invalid or expired invite' }, 400);

  await purgePortalSessionsForUsers([user.id]);
  const inviteRedis = getRedis();
  if (inviteRedis) await purgeClientAiSessionsForUsers(inviteRedis, [user.id]);

  // Never answer 200 with a session that was not stored.
  const minted = await mintPasswordSession(c, { portalUserId: user.id, orgId: user.orgId, authEpoch: activated.authEpoch });
  if (!minted) return c.json({ error: 'Service temporarily unavailable' }, 503);
  const { token: sessionToken, expiresAt } = minted;

  return c.json({
    user: buildPortalUserPayload({ ...user, name: resolvedName, status: 'active' }),
    accessToken: sessionToken,
    expiresAt,
    tokens: { accessToken: sessionToken, expiresInSeconds: Math.floor(SESSION_TTL_MS / 1000) }
  });
});

// Logout ends the presented session, and only that one: other sessions of the
// same portal user keep working. The durable record is written first and is
// what refuses the token from now on; deleting the cache entry afterwards is
// cleanup, so a Redis fault after that point cannot reopen the session.
// Runs outside the portal request transaction (selfManagedDbContextRoutes.ts):
// the record commits in its own short system transaction.
authRoutes.post('/auth/logout', portalAuthMiddleware, async (c) => {
  const csrfError = validatePortalCookieCsrfRequest(c);
  if (csrfError) {
    return c.json({ error: csrfError }, 403);
  }

  const auth = c.get('portalAuth');

  // The browser drops its credential whatever happens next.
  clearPortalSessionCookies(c);

  let recorded = true;
  try {
    await revokePortalSessionDurably(auth.token, auth.user.id);
  } catch (error) {
    recorded = false;
    console.error('[portal] Logout could not record the session as signed out:', error instanceof Error ? error.message : error);
  }

  // Cache cleanup runs even when the record failed: it still ends the session
  // for every reader of this cache, it just is not durable on its own.
  if (ALLOW_IN_MEMORY_PORTAL_STATE) {
    portalSessions.delete(auth.token);
  }

  if (PORTAL_USE_REDIS) {
    const redis = getRedis();
    if (!redis) {
      console.warn('[portal] Redis unavailable during logout; only the durable record ends the session');
    } else {
      try {
        await redis
          .multi()
          .del(PORTAL_REDIS_KEYS.session(auth.token))
          .srem(PORTAL_REDIS_KEYS.userSessions(auth.user.id), auth.token)
          .exec();
      } catch (error) {
        console.warn('[portal] Failed to drop a signed-out session from the cache:', error instanceof Error ? error.message : error);
      }
    }
  }

  if (!recorded) {
    return c.json({ error: 'Logout could not be fully completed. Please try again.' }, 500);
  }
  return c.json({ success: true });
});
