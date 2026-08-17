import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { getRedis } from '../../services/redis';
import { rateLimiter } from '../../services/rate-limit';
import { getTrustedClientIp, rateLimitIpKey } from '../../services/clientIp';
import { writeAuditEvent, type RequestLike } from '../../services/auditEvents';
import { CLIENT_AI_ENTRA_CLIENT_ID } from '../../config/env';
import {
  verifyEntraIdToken,
  ClientAiEntraInvalidTokenError,
  ClientAiEntraJwksUnavailableError,
} from '../../services/clientAiEntraJwt';
import { resolveAndMintClientSession } from '../../services/clientAiExchange';
import { exchangeSchema, EXCHANGE_RATE_LIMIT } from './schemas';

/**
 * POST /client-ai/auth/exchange — Entra ID token → Breeze client-AI session.
 * Spec §3. Pre-auth route: tenant context comes FROM the verified token (tid →
 * client_ai_tenant_mappings), so DB work runs under system scope. Resolution
 * (tenant mapping, policy checks, JIT provisioning, session mint) lives in
 * `services/clientAiExchange.ts` — this handler is just gates + audit + wire shape.
 */

export const clientAiAuthRoutes = new Hono();

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
    `clientai-exchange-${rateLimitIpKey(ip)}`,
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

  const outcome = await resolveAndMintClientSession(claims, redis);

  if (outcome.kind === 'denied') {
    auditExchange(c, {
      orgId: outcome.audit.orgId,
      result: 'denied',
      details: outcome.audit.details,
    });
    return c.json(outcome.body, outcome.status);
  }

  auditExchange(c, {
    orgId: outcome.audit.orgId,
    result: 'success',
    actorId: outcome.audit.actorId,
    actorEmail: outcome.audit.actorEmail,
    details: outcome.audit.details,
  });

  return c.json(outcome.body);
});
