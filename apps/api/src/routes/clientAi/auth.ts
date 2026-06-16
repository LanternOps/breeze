import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { db, withSystemDbAccessContext } from '../../db';
import { portalUsers } from '../../db/schema';
import { clientAiTenantMappings } from '../../db/schema/clientAi';
import { organizations, partners } from '../../db/schema/orgs';
import { getRedis } from '../../services/redis';
import { rateLimiter } from '../../services/rate-limit';
import { getTrustedClientIp } from '../../services/clientIp';
import { writeAuditEvent, type RequestLike } from '../../services/auditEvents';
import { CLIENT_AI_ENTRA_CLIENT_ID } from '../../config/env';
import {
  verifyEntraIdToken,
  ClientAiEntraInvalidTokenError,
  ClientAiEntraJwksUnavailableError,
} from '../../services/clientAiEntraJwt';
import { getOrgPolicy, isClientUserPermitted } from '../../services/clientAiPolicy';
import {
  exchangeSchema,
  CLIENT_AI_REDIS_KEYS,
  CLIENT_AI_SESSION_TTL_SECONDS,
  EXCHANGE_RATE_LIMIT,
} from './schemas';

/**
 * POST /client-ai/auth/exchange — Entra ID token → Breeze client-AI session.
 * Spec §3. Pre-auth route: tenant context comes FROM the verified token (tid →
 * client_ai_tenant_mappings), so DB work runs under system scope. One fast DB
 * block; Redis work stays outside it (#1105).
 */

export const clientAiAuthRoutes = new Hono();

type ExchangeUser = {
  id: string;
  orgId: string;
  email: string;
  name: string | null;
  status: string;
};

type Denied = {
  denied: {
    status: 403 | 404;
    error: string;
    orgId: string | null;
    details: Record<string, unknown>;
  };
};
/** White-label footer fields (spec §11), sourced from the org policy's branding JSONB. */
type ExchangeBranding = { displayName: string | null; logoUrl: string | null };
type Resolved = { user: ExchangeUser; provisioned: boolean; branding: ExchangeBranding };

/** policy.branding is free-form JSONB — pull only the two known string fields, coercing anything else to null. */
function brandingFromPolicy(branding: Record<string, unknown> | null | undefined): ExchangeBranding {
  const asString = (v: unknown): string | null => (typeof v === 'string' ? v : null);
  return {
    displayName: asString(branding?.displayName),
    logoUrl: asString(branding?.logoUrl),
  };
}

const USER_COLUMNS = {
  id: portalUsers.id,
  orgId: portalUsers.orgId,
  email: portalUsers.email,
  name: portalUsers.name,
  status: portalUsers.status,
};

function auditExchange(
  c: RequestLike,
  params: {
    orgId: string | null;
    result: 'success' | 'denied';
    actorId?: string | null;
    actorEmail?: string | null;
    details: Record<string, unknown>;
  }
): void {
  writeAuditEvent(c, {
    orgId: params.orgId,
    action: 'client_ai.auth.exchange',
    resourceType: 'client_ai_session',
    actorType: 'user',
    actorId: params.actorId ?? null,
    actorEmail: params.actorEmail ?? null,
    result: params.result,
    details: { principalType: 'portal_user', ...params.details },
  });
}

clientAiAuthRoutes.post('/auth/exchange', zValidator('json', exchangeSchema), async (c) => {
  if (!CLIENT_AI_ENTRA_CLIENT_ID) {
    return c.json({ error: 'not_enabled' }, 404);
  }

  // Client-AI sessions are Redis-only (no in-memory fallback — new surface,
  // every compose mode ships Redis).
  const redis = getRedis();
  if (!redis) {
    return c.json({ error: 'service_unavailable' }, 503);
  }

  const ip = getTrustedClientIp(c);
  const rate = await rateLimiter(
    redis,
    `clientai-exchange-${ip}`,
    EXCHANGE_RATE_LIMIT.limit,
    EXCHANGE_RATE_LIMIT.windowSeconds
  );
  if (!rate.allowed) {
    return c.json({ error: 'rate_limited' }, 429);
  }

  const { accessToken } = c.req.valid('json');

  let claims;
  try {
    claims = await verifyEntraIdToken(accessToken, { audience: CLIENT_AI_ENTRA_CLIENT_ID });
  } catch (err) {
    if (err instanceof ClientAiEntraJwksUnavailableError) {
      console.error('[client-ai] Entra JWKS unavailable during exchange:', (err as Error).message);
      return c.json({ error: 'service_unavailable' }, 503);
    }
    if (err instanceof ClientAiEntraInvalidTokenError) {
      return c.json({ error: 'invalid_token' }, 401);
    }
    throw err;
  }

  const resolution = await withSystemDbAccessContext(async (): Promise<Denied | Resolved> => {
    const [mapping] = await db
      .select({
        orgId: clientAiTenantMappings.orgId,
        partnerEnabled: partners.aiForOfficeEnabled,
      })
      .from(clientAiTenantMappings)
      .innerJoin(organizations, eq(organizations.id, clientAiTenantMappings.orgId))
      .innerJoin(partners, eq(partners.id, organizations.partnerId))
      .where(eq(clientAiTenantMappings.entraTenantId, claims.tid))
      .limit(1);

    if (!mapping) {
      return {
        denied: {
          status: 404,
          error: 'tenant_not_provisioned',
          orgId: null,
          details: { reason: 'tenant_not_provisioned', tid: claims.tid },
        },
      };
    }

    // Per-partner entitlement gate (the cost gate): no enabled partner ⇒ no
    // session ⇒ no AI spend. Sits above the per-org policy.enabled check below.
    if (!mapping.partnerEnabled) {
      return {
        denied: {
          status: 403,
          error: 'disabled',
          orgId: mapping.orgId,
          details: { reason: 'partner_not_enabled', tid: claims.tid, oid: claims.oid },
        },
      };
    }

    const policy = await getOrgPolicy(mapping.orgId);
    if (!policy.enabled) {
      return {
        denied: {
          status: 403,
          error: 'disabled',
          orgId: mapping.orgId,
          details: { reason: 'disabled', tid: claims.tid, oid: claims.oid },
        },
      };
    }

    const now = new Date();
    let provisioned = false;
    let [user] = await db
      .select(USER_COLUMNS)
      .from(portalUsers)
      .where(
        and(eq(portalUsers.entraTenantId, claims.tid), eq(portalUsers.entraOid, claims.oid))
      )
      .limit(1);

    if (!user) {
      // portal_users.email is NOT NULL; some Entra token shapes carry no usable
      // address — fall back to a synthetic, non-routable one.
      const email = claims.email ?? `${claims.oid}@${claims.tid}.entra.invalid`;
      try {
        const inserted = await db
          .insert(portalUsers)
          .values({
            orgId: mapping.orgId,
            email,
            name: claims.name,
            passwordHash: null,
            entraOid: claims.oid,
            entraTenantId: claims.tid,
            authMethod: 'entra',
            lastLoginAt: now,
          })
          .returning(USER_COLUMNS);
        user = inserted[0];
        provisioned = true;
      } catch (err) {
        // Concurrent first-exchange race: portal_users_entra_identity_uniq
        // makes the loser 23505 — re-select the winner's row.
        if ((err as { cause?: { code?: string } }).cause?.code !== '23505') throw err;
        [user] = await db
          .select(USER_COLUMNS)
          .from(portalUsers)
          .where(
            and(eq(portalUsers.entraTenantId, claims.tid), eq(portalUsers.entraOid, claims.oid))
          )
          .limit(1);
      }
    } else {
      await db
        .update(portalUsers)
        .set({ lastLoginAt: now, updatedAt: now, ...(claims.name ? { name: claims.name } : {}) })
        .where(eq(portalUsers.id, user.id));
    }

    if (!user) {
      return {
        denied: {
          status: 403,
          error: 'provisioning_failed',
          orgId: mapping.orgId,
          details: { reason: 'provisioning_failed', tid: claims.tid, oid: claims.oid },
        },
      };
    }

    if (user.status !== 'active') {
      return {
        denied: {
          status: 403,
          error: 'account_inactive',
          orgId: mapping.orgId,
          details: { reason: 'account_inactive', portalUserId: user.id },
        },
      };
    }

    if (!isClientUserPermitted(policy, user.id)) {
      return {
        denied: {
          status: 403,
          error: 'user_not_permitted',
          orgId: mapping.orgId,
          details: { reason: 'user_not_permitted', portalUserId: user.id },
        },
      };
    }

    return { user, provisioned, branding: brandingFromPolicy(policy.branding) };
  });

  if ('denied' in resolution) {
    auditExchange(c, {
      orgId: resolution.denied.orgId,
      result: 'denied',
      details: resolution.denied.details,
    });
    return c.json({ error: resolution.denied.error }, resolution.denied.status);
  }

  const { user, provisioned, branding } = resolution;
  const token = nanoid(48);
  await redis.setex(
    CLIENT_AI_REDIS_KEYS.session(token),
    CLIENT_AI_SESSION_TTL_SECONDS,
    JSON.stringify({ portalUserId: user.id, orgId: user.orgId, createdAt: new Date().toISOString() })
  );
  await redis.sadd(CLIENT_AI_REDIS_KEYS.userSessions(user.id), token);
  await redis.expire(CLIENT_AI_REDIS_KEYS.userSessions(user.id), CLIENT_AI_SESSION_TTL_SECONDS * 2);

  auditExchange(c, {
    orgId: user.orgId,
    result: 'success',
    actorId: user.id,
    actorEmail: user.email,
    details: { tid: claims.tid, oid: claims.oid, provisioned },
  });

  return c.json({
    accessToken: token,
    expiresInSeconds: CLIENT_AI_SESSION_TTL_SECONDS,
    user: { id: user.id, email: user.email, name: user.name },
    org: { id: user.orgId },
    branding,
  });
});
