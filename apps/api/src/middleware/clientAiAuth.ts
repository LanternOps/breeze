import type { Context, Next } from 'hono';
import { and, eq } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../db';
import { portalUsers, organizations, partners } from '../db/schema';
import { getRedis } from '../services/redis';
import { getOrgPolicy, isClientUserPermitted } from '../services/clientAiPolicy';
import { getActiveOrgTenant } from '../services/tenantStatus';
import {
  CLIENT_AI_REDIS_KEYS,
  CLIENT_AI_SESSION_TTL_SECONDS,
  type ClientAiSessionPayload,
} from '../routes/clientAi/schemas';

/**
 * Auth middleware for the /client-ai surface (Excel add-in end-users).
 *
 * Mirrors portalAuthMiddleware (routes/portal/auth.ts): bearer token →
 * Redis session → system-scope portal_users hydration (the row sits behind
 * org-forced RLS, pre-auth) → sliding TTL → handlers run inside an org-scoped
 * withDbAccessContext so RLS on every table is satisfied AND enforced under
 * the unprivileged breeze_app pool. Differences from the portal: bearer-only
 * (no cookies/CSRF — the add-in task pane is not a cookie surface) and
 * Redis-only (no in-memory dev fallback).
 *
 * Redis/session work happens BEFORE the DB context opens so the wrapping
 * transaction is never held across slow I/O (#1105).
 */
export async function clientAiAuthMiddleware(c: Context, next: Next) {
  const authHeader = c.req.header('Authorization');
  let token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token && c.req.method === 'GET') {
    // EventSource cannot set request headers, so GET endpoints (the SSE
    // stream) accept ?token= as a fallback. Header always wins; non-GET
    // requests are header-only. Prefer fetch-based SSE with the Authorization
    // header (Plan 5's client) — query tokens can land in proxy access logs.
    token = c.req.query('token') || null;
  }
  if (!token) {
    return c.json({ error: 'Missing or invalid authorization header' }, 401);
  }

  const redis = getRedis();
  if (!redis) {
    return c.json({ error: 'Service temporarily unavailable' }, 503);
  }

  const raw = await redis.get(CLIENT_AI_REDIS_KEYS.session(token));
  if (!raw) {
    return c.json({ error: 'Invalid or expired session' }, 401);
  }

  let session: ClientAiSessionPayload;
  try {
    session = JSON.parse(raw) as ClientAiSessionPayload;
  } catch {
    return c.json({ error: 'Invalid or expired session' }, 401);
  }
  if (!session?.portalUserId || !session?.orgId) {
    return c.json({ error: 'Invalid or expired session' }, 401);
  }

  const [user] = await withSystemDbAccessContext(() =>
    db
      .select({
        id: portalUsers.id,
        orgId: portalUsers.orgId,
        email: portalUsers.email,
        name: portalUsers.name,
        status: portalUsers.status,
        partnerAiForOfficeEnabled: partners.aiForOfficeEnabled,
      })
      .from(portalUsers)
      .innerJoin(organizations, eq(organizations.id, portalUsers.orgId))
      .innerJoin(partners, eq(partners.id, organizations.partnerId))
      .where(and(eq(portalUsers.id, session.portalUserId), eq(portalUsers.orgId, session.orgId)))
      .limit(1)
  );

  if (!user) {
    await redis.del(CLIENT_AI_REDIS_KEYS.session(token));
    return c.json({ error: 'Invalid or expired session' }, 401);
  }

  if (user.status !== 'active') {
    return c.json({ error: 'Account is not active' }, 403);
  }

  // Org-status gate — the same one portalAuthMiddleware carries, because this
  // is the SECOND portal_users ingress and it opens an org-scoped WRITE context
  // below. Without it an add-in user of a suspended, offboarding, archived or
  // (org-lifecycle Wave 2) `merging` org keeps inserting ai_messages and
  // updating ai_sessions; during a merge those rows land under the loser after
  // the fence and are stranded by the re-tenant, then destroyed by the erasure.
  //
  // Deliberately NOT wrapped in try/catch: `getActiveOrgTenant` throwing means
  // we could not establish that the org is usable, and the correct response to
  // that is to fail the request, not to admit it. An unhandled rejection here
  // surfaces as a 500 — closed, which is the only safe direction for a gate.
  const activeOrg = await getActiveOrgTenant(user.orgId);
  if (!activeOrg) {
    // Drop the session and its index entry so the add-in re-exchanges (and is
    // refused at the exchange) rather than retrying this token every poll.
    try {
      await redis.del(CLIENT_AI_REDIS_KEYS.session(token));
      await redis.srem(CLIENT_AI_REDIS_KEYS.userSessions(user.id), token);
    } catch (error) {
      console.error('[client-ai] Failed to purge session for an unavailable org:', error);
    }
    return c.json({ error: 'Organization is not available' }, 403);
  }

  // Sliding session timeout: any authenticated activity pushes expiry forward.
  try {
    await redis.expire(CLIENT_AI_REDIS_KEYS.session(token), CLIENT_AI_SESSION_TTL_SECONDS);
  } catch (error) {
    console.error('[client-ai] Failed to extend session TTL:', error);
  }

  c.set('clientAiAuth', {
    clientUserId: user.id,
    orgId: user.orgId,
    email: user.email,
    name: user.name,
    token,
    partnerAiForOfficeEnabled: user.partnerAiForOfficeEnabled === true,
  });

  return withDbAccessContext(
    {
      scope: 'organization',
      orgId: user.orgId,
      accessibleOrgIds: [user.orgId],
      accessiblePartnerIds: [],
      userId: null,
    },
    () => next()
  );
}

/**
 * Policy gate for /client-ai feature routes (everything beyond /auth/exchange).
 * Re-checks enabled + selected-list on EVERY request so disabling the org or
 * de-selecting a user takes effect immediately, not at next token mint.
 * Runs inside the org context opened by clientAiAuthMiddleware; caches the
 * policy on the context for handlers (c.get('clientAiPolicy')).
 */
export async function requireClientAiEnabledMiddleware(c: Context, next: Next) {
  const auth = c.get('clientAiAuth');
  if (!auth) {
    return c.json({ error: 'Not authenticated' }, 401);
  }

  // Per-partner entitlement, re-checked every request so disabling a partner
  // cuts live sessions immediately (not just at next token mint).
  if (!auth.partnerAiForOfficeEnabled) {
    return c.json({ error: 'disabled' }, 403);
  }

  const policy = await getOrgPolicy(auth.orgId);
  if (!policy.enabled) {
    return c.json({ error: 'disabled' }, 403);
  }
  if (!isClientUserPermitted(policy, auth.clientUserId)) {
    return c.json({ error: 'user_not_permitted' }, 403);
  }

  c.set('clientAiPolicy', policy);
  await next();
}
