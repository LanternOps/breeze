import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { getRedis } from '../../services/redis';
import { rateLimiter } from '../../services/rate-limit';
import { getTrustedClientIp, rateLimitIpKey } from '../../services/clientIp';
import { writeAuditEvent, type RequestLike } from '../../services/auditEvents';
import { withSystemDbAccessContext } from '../../db';
import { CLIENT_AI_ENTRA_CLIENT_ID } from '../../config/env';
import {
  verifyEntraIdToken,
  ClientAiEntraInvalidTokenError,
  ClientAiEntraJwksUnavailableError,
} from '../../services/clientAiEntraJwt';
import {
  findActiveBinding,
  hasAnyBinding,
  revokeBinding,
  findUserForBind,
  createBinding,
  vetBinding,
  BindingConflictError,
  type BindingWithUser,
} from '../../services/officeAddin/officeAddinBindings';
import { assertActiveTenantContext, TenantInactiveError } from '../../services/tenantStatus';
import { mintTechSession } from '../../services/officeAddin/techSession';
import { resolveAndMintClientSession } from '../../services/clientAiExchange';
import { exchangeSchema, EXCHANGE_RATE_LIMIT, bindSchema, BIND_RATE_LIMIT } from './schemas';
import { verifyPassword, hashPassword } from '../../services/password';
import { consumeMFAToken } from '../../services/mfa';
import { decryptMfaSecretForMigration } from '../auth/helpers';
import { ENABLE_2FA } from '../auth/schemas';

/**
 * POST /office-addin/auth/exchange — neutral Entra ID token → persona
 * exchange for the Outlook tech add-in (spec §2.2, §9, Task 10).
 *
 * A verified Entra identity (tid/oid) is first checked against
 * office_addin_user_bindings (Breeze technician, partner-axis, MFA-bound). A
 * hit resolves the TECH persona and mints a techaddin: Redis session. No
 * ACTIVE binding but a REVOKED one hard-denies (`revoked_relink`) — a former
 * technician's identity must never JIT-provision as a client portal user
 * (spec §2.1 step 4). Only when no binding row exists at all does resolution
 * fall through to the unchanged client-AI path (`resolveAndMintClientSession`,
 * Task 7) for MSP-client end users.
 *
 * Pre-auth route: DB reads run under system scope (tenant context comes FROM
 * the verified token, not from a caller session).
 */

export const officeAddinAuthRoutes = new Hono();

function auditExchange(
  c: RequestLike,
  params: {
    result: 'success' | 'denied';
    actorId?: string | null;
    actorEmail?: string | null;
    details: Record<string, unknown>;
  }
): void {
  writeAuditEvent(c, {
    orgId: null,
    action: 'office_addin.auth.exchange',
    resourceType: 'office_addin_session',
    actorType: 'user',
    actorId: params.actorId ?? null,
    actorEmail: params.actorEmail ?? null,
    result: params.result,
    details: { principalType: 'user', ...params.details },
  });
}

// Lazily-computed dummy argon2id hash used to constant-time the
// user-not-found branch of /auth/bind — mirrors routes/auth/login.ts's
// getDummyPasswordHash (not exported there, so replicated minimally here
// rather than reaching into another route module's private state).
let dummyPasswordHashPromise: Promise<string> | null = null;
function getDummyPasswordHash(): Promise<string> {
  if (!dummyPasswordHashPromise) {
    dummyPasswordHashPromise = hashPassword('__office-addin-bind-timing-dummy-never-matches__');
  }
  return dummyPasswordHashPromise;
}

function auditBind(
  c: RequestLike,
  params: {
    result: 'success' | 'denied';
    actorId?: string | null;
    actorEmail?: string | null;
    details: Record<string, unknown>;
  }
): void {
  writeAuditEvent(c, {
    orgId: null,
    action: params.result === 'success' ? 'office_addin.binding.created' : 'office_addin.binding.denied',
    resourceType: 'office_addin_binding',
    actorType: 'user',
    actorId: params.actorId ?? null,
    actorEmail: params.actorEmail ?? null,
    result: params.result,
    details: { principalType: 'user', ...params.details },
  });
}

function deny(c: RequestLike, reason: string, bound: BindingWithUser) {
  auditExchange(c, {
    result: 'denied',
    actorId: bound.user.id,
    actorEmail: bound.user.email,
    details: { reason, bindingId: bound.binding.id },
  });
  return { error: 'binding_denied' as const, reason };
}

/**
 * Mirrors clientAi/auth.ts's `auditExchange` exactly (action, resourceType,
 * details shape) — the client passthrough path must be indistinguishable
 * from calling `/client-ai/auth/exchange` directly.
 */
function auditClientExchange(
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

// Registered as '/exchange' — the router is mounted under '/auth' in ./index.ts,
// so the external path stays POST /office-addin/auth/exchange.
officeAddinAuthRoutes.post('/exchange', zValidator('json', exchangeSchema), async (c) => {
  if (!CLIENT_AI_ENTRA_CLIENT_ID) {
    return c.json({ error: 'not_enabled' }, 404);
  }

  // Sessions (both personas) are Redis-only — no in-memory fallback.
  const redis = getRedis();
  if (!redis) {
    return c.json({ error: 'service_unavailable' }, 503);
  }

  const ip = getTrustedClientIp(c);
  const rate = await rateLimiter(
    redis,
    `officeaddin-exchange-${rateLimitIpKey(ip)}`,
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
      console.error(
        '[office-addin] Entra JWKS unavailable during exchange:',
        (err as Error).message
      );
      return c.json({ error: 'service_unavailable' }, 503);
    }
    if (err instanceof ClientAiEntraInvalidTokenError) {
      return c.json({ error: 'invalid_token' }, 401);
    }
    throw err;
  }

  const scopes = (claims.scp ?? '').split(' ').filter(Boolean);
  if (!scopes.includes('access_as_user')) {
    return c.json({ error: 'invalid_token' }, 401);
  }

  const bound = await withSystemDbAccessContext(() => findActiveBinding(claims.tid, claims.oid));

  if (!bound) {
    const revokedOnly = await withSystemDbAccessContext(() =>
      hasAnyBinding(claims.tid, claims.oid)
    );
    if (revokedOnly) {
      auditExchange(c, {
        result: 'denied',
        details: { reason: 'revoked_relink', tid: claims.tid, oid: claims.oid },
      });
      return c.json({ error: 'binding_denied', reason: 'revoked_relink' }, 403);
    }
  }

  if (bound) {
    const vet = vetBinding(bound);
    if (!vet.ok) {
      if (vet.reason === 'epoch_advanced') {
        await withSystemDbAccessContext(() => revokeBinding(bound.binding.id, null));
      }
      return c.json(deny(c, vet.reason, bound), 403);
    }

    // Tenant status: never mint a session for a technician at a suspended /
    // churned / soft-deleted partner. The middleware re-checks this on every
    // request (officeAddinTechAuth.ts) — this gate just refuses the mint too,
    // so a dead tenant's tech gets the same 403 here instead of a token that
    // fails one request later.
    try {
      await assertActiveTenantContext({ scope: 'partner', partnerId: bound.binding.partnerId, orgId: null });
    } catch (err) {
      if (err instanceof TenantInactiveError) {
        return c.json(deny(c, 'tenant_inactive', bound), 403);
      }
      throw err;
    }

    const { token, expiresInSeconds } = await mintTechSession(redis, {
      userId: bound.user.id,
      partnerId: bound.binding.partnerId,
      bindingId: bound.binding.id,
    });

    auditExchange(c, {
      result: 'success',
      actorId: bound.user.id,
      actorEmail: bound.user.email,
      details: { bindingId: bound.binding.id },
    });

    return c.json({
      persona: 'tech',
      accessToken: token,
      expiresInSeconds,
      user: { id: bound.user.id, email: bound.user.email, name: bound.user.name },
      partner: { id: bound.binding.partnerId },
    });
  }

  const outcome = await resolveAndMintClientSession(claims, redis);

  if (outcome.kind === 'denied') {
    auditClientExchange(c, {
      orgId: outcome.audit.orgId,
      result: 'denied',
      details: outcome.audit.details,
    });
    return c.json(outcome.body, outcome.status);
  }

  auditClientExchange(c, {
    orgId: outcome.audit.orgId,
    result: 'success',
    actorId: outcome.audit.actorId,
    actorEmail: outcome.audit.actorEmail,
    details: outcome.audit.details,
  });

  return c.json({ persona: 'client', ...outcome.body });
});

/**
 * POST /office-addin/auth/bind — establish the Entra identity → Breeze
 * technician binding (spec §2.2, §9, Task 11). The pane calls this once
 * (interactively, with password + MFA) to create the row; every subsequent
 * sign-in goes through the silent `/auth/exchange` path above.
 *
 * `email` here is only a LOGIN CREDENTIAL, paired with password + MFA to
 * prove control of the Breeze account being bound — it is never the
 * authorization identifier. The durable authorization key for this binding
 * is the verified Entra (tid, oid) pair, stored on the binding row and
 * checked on every future exchange; the email is not read again after bind.
 */
// '/bind' under the './index.ts' '/auth' mount -> POST /office-addin/auth/bind.
officeAddinAuthRoutes.post('/bind', zValidator('json', bindSchema), async (c) => {
  if (!CLIENT_AI_ENTRA_CLIENT_ID) {
    return c.json({ error: 'not_enabled' }, 404);
  }

  const redis = getRedis();
  if (!redis) {
    return c.json({ error: 'service_unavailable' }, 503);
  }

  const ip = getTrustedClientIp(c);
  const rate = await rateLimiter(
    redis,
    `officeaddin-bind-${rateLimitIpKey(ip)}`,
    BIND_RATE_LIMIT.limit,
    BIND_RATE_LIMIT.windowSeconds
  );
  if (!rate.allowed) {
    return c.json({ error: 'rate_limited' }, 429);
  }

  const { accessToken, email, password, mfaCode } = c.req.valid('json');

  let claims;
  try {
    claims = await verifyEntraIdToken(accessToken, { audience: CLIENT_AI_ENTRA_CLIENT_ID });
  } catch (err) {
    if (err instanceof ClientAiEntraJwksUnavailableError) {
      console.error(
        '[office-addin] Entra JWKS unavailable during bind:',
        (err as Error).message
      );
      return c.json({ error: 'service_unavailable' }, 503);
    }
    if (err instanceof ClientAiEntraInvalidTokenError) {
      return c.json({ error: 'invalid_token' }, 401);
    }
    throw err;
  }

  const scopes = (claims.scp ?? '').split(' ').filter(Boolean);
  if (!scopes.includes('access_as_user')) {
    return c.json({ error: 'invalid_token' }, 401);
  }

  type Outcome =
    | { deny: 401 | 403 | 409; error: string }
    | { bindingId: string; userId: string; userEmail: string; partnerId: string };

  const outcome: Outcome = await withSystemDbAccessContext(async (): Promise<Outcome> => {
    const user = await findUserForBind(email);

    if (!user || user.status !== 'active') {
      // Constant-time: run a real argon2 verify against a dummy hash so this
      // branch's latency matches the found-user path below, blunting email
      // enumeration via timing (mirrors routes/auth/login.ts:79-84).
      await verifyPassword(await getDummyPasswordHash(), password).catch(() => false);
      return { deny: 401, error: 'invalid_credentials' };
    }

    if (!user.passwordHash || !(await verifyPassword(user.passwordHash, password))) {
      return { deny: 401, error: 'invalid_credentials' };
    }

    if (!user.partnerId) {
      return { deny: 403, error: 'not_a_technician' };
    }

    // Tenant status (mirrors the exchange route and officeAddinTechAuth.ts): a
    // technician at a suspended/churned/soft-deleted partner must not be able
    // to establish a binding at all — without this, bind minted a row whose
    // every subsequent request merely 403'd in the middleware.
    try {
      await assertActiveTenantContext({ scope: 'partner', partnerId: user.partnerId, orgId: null });
    } catch (err) {
      if (err instanceof TenantInactiveError) {
        return { deny: 403, error: 'tenant_inactive' };
      }
      throw err;
    }

    if (ENABLE_2FA) {
      if (!user.mfaEnabled || !user.mfaSecret) {
        return { deny: 403, error: 'mfa_enrollment_required' };
      }
      const { plaintext: secret } = decryptMfaSecretForMigration(user.mfaSecret);
      if (!secret || !(await consumeMFAToken(secret, mfaCode, user.id))) {
        return { deny: 401, error: 'invalid_mfa' };
      }
    }

    const { id } = await createBinding({
      entraTenantId: claims.tid,
      entraOid: claims.oid,
      userId: user.id,
      partnerId: user.partnerId,
      boundAuthEpoch: user.authEpoch,
      mfaVerifiedAt: new Date(),
    });

    return { bindingId: id, userId: user.id, userEmail: user.email, partnerId: user.partnerId };
  }).catch((err) => {
    if (err instanceof BindingConflictError) {
      return { deny: 409 as const, error: 'identity_already_bound' };
    }
    throw err;
  });

  if ('deny' in outcome) {
    auditBind(c, {
      result: 'denied',
      details: { reason: outcome.error, tid: claims.tid, oid: claims.oid },
    });
    return c.json({ error: outcome.error }, outcome.deny);
  }

  auditBind(c, {
    result: 'success',
    actorId: outcome.userId,
    actorEmail: outcome.userEmail,
    details: { bindingId: outcome.bindingId, tid: claims.tid, oid: claims.oid },
  });

  return c.json({ bound: true });
});
