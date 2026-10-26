/**
 * The bounded rebind's two agent routes (#8318 wave 1b, spec §6.3, §6.4).
 * Services: services/deviceReattach/stage.ts and confirm.ts.
 *
 *  - `POST /:id/rebind` — phase 1, under agent auth with the SOURCE's own
 *    credentials (main role only; on the parked allow-list, since a parked
 *    device is the typical source). Self-managed DB context
 *    (SELF_MANAGED_DB_CONTEXT_ACTIONS): the rate limit and the certificate
 *    provider call run with no transaction held.
 *  - `POST /:id/rebind-confirm` — phase 2, OUTSIDE agent auth
 *    (AGENT_AUTH_SKIP_ACTIONS): it authenticates itself with the confirm-only
 *    bearer `brz_rbc_…`, compared in constant time with the hash stored on the
 *    intent (or the ledger once the intent is pruned). `:id` is the source
 *    agent id. Every attempt is rate-limited per client IP before any read;
 *    FAILED verifications are also counted per `:id` (never a correct one).
 *
 * Neither route creates an intent; that is the wave 2 human action (§8).
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '../../lib/validation';
import type { AgentAuthContext } from '../../middleware/agentAuth';
import { readAgentCertificateAssertion } from '../../services/agentCertificateBinding';
import { SHA256_HEX_DIGEST } from '../../services/agentCredentialHashes';
import { getTrustedClientIp, rateLimitIpKey } from '../../services/clientIp';
import { confirmRebindIntent } from '../../services/deviceReattach/confirm';
import { parseConfirmationBearer } from '../../services/deviceReattach/confirmationToken';
import { refusalBody } from '../../services/deviceReattach/errors';
import { stageRebindIntent } from '../../services/deviceReattach/stage';
import { rateLimiter } from '../../services/rate-limit';
import { getRedis } from '../../services/redis';

export const rebindRoutes = new Hono();

/** Phase 1: per source agent id. */
export const REBIND_RATE_LIMIT = { limit: 10, windowSeconds: 300 } as const;
/** Confirm: every attempt per client IP (IPv6 /64), checked first. */
export const REBIND_CONFIRM_IP_RATE_LIMIT = { limit: 30, windowSeconds: 300 } as const;
/** Confirm: FAILED token verifications per source agent id (`:id`), charged after the mismatch. */
export const REBIND_CONFIRM_FAILURE_LIMIT = { limit: 10, windowSeconds: 300 } as const;

const sha256HexDigest = z.string().regex(SHA256_HEX_DIGEST, 'must be a lowercase SHA-256 hex digest');

export const rebindStageSchema = z.object({
  intentId: z.string().uuid(),
  stagedTokenHash: sha256HexDigest,
  stagedWatchdogTokenHash: sha256HexDigest,
  stagedHelperTokenHash: sha256HexDigest,
  confirmationTokenHash: sha256HexDigest,
});

/** Agent ids are 64 hex characters; anything else can never match an intent. */
const AGENT_ID_SHAPE = /^[A-Za-z0-9_-]{1,64}$/;

function retryAfterSeconds(resetAt: Date): string {
  return String(Math.max(1, Math.ceil((resetAt.getTime() - Date.now()) / 1000)));
}

rebindRoutes.post('/:id/rebind', zValidator('json', rebindStageSchema), async (c) => {
  const agent = c.get('agent') as AgentAuthContext | undefined;
  if (!agent?.deviceId) {
    return c.json({ error: 'Agent context not found' }, 401);
  }
  // The main agent stages the reattach; never a watchdog or helper credential.
  if (agent.role !== 'agent') {
    return c.json({ error: 'This endpoint requires the agent credential', code: 'agent_role_required' }, 403);
  }

  const rate = await rateLimiter(
    getRedis(),
    `agent-rebind:${agent.agentId}`,
    REBIND_RATE_LIMIT.limit,
    REBIND_RATE_LIMIT.windowSeconds,
  );
  if (!rate.allowed) {
    c.header('Retry-After', retryAfterSeconds(rate.resetAt));
    return c.json({ error: 'Too many rebind requests; retry later', code: 'rate_limited' }, 429);
  }

  const body = c.req.valid('json');
  const result = await stageRebindIntent({
    caller: { deviceId: agent.deviceId, agentId: agent.agentId },
    intentId: body.intentId,
    stagedTokenHash: body.stagedTokenHash,
    stagedWatchdogTokenHash: body.stagedWatchdogTokenHash,
    stagedHelperTokenHash: body.stagedHelperTokenHash,
    confirmationTokenHash: body.confirmationTokenHash,
  });
  if (!result.ok) {
    return c.json(refusalBody(result), result.status);
  }
  return c.json({
    intentId: result.intentId,
    stagedAgentId: result.stagedAgentId,
    target: result.target,
    certificate: result.certificate,
    expiresAt: result.expiresAt.toISOString(),
  });
});

rebindRoutes.post('/:id/rebind-confirm', async (c) => {
  const sourceAgentId = c.req.param('id');
  const redis = getRedis();

  // Per client IP first: an unauthenticated caller can name any `:id`.
  const ip = getTrustedClientIp(c);
  const ipRate = await rateLimiter(
    redis,
    `agent-rebind-confirm:ip:${rateLimitIpKey(ip)}`,
    REBIND_CONFIRM_IP_RATE_LIMIT.limit,
    REBIND_CONFIRM_IP_RATE_LIMIT.windowSeconds,
  );
  if (!ipRate.allowed) {
    c.header('Retry-After', retryAfterSeconds(ipRate.resetAt));
    return c.json({ error: 'Too many confirmation attempts; retry later', code: 'rate_limited' }, 429);
  }
  if (!AGENT_ID_SHAPE.test(sourceAgentId)) {
    return c.json({ error: 'Invalid confirmation credentials', code: 'invalid_confirmation' }, 401);
  }

  // The per-`:id` budget counts FAILED verifications only, charged after the
  // mismatch: a stranger who knows an agent id can exhaust it, but that only
  // turns their own further failures into 429s; a correct token is never
  // consulted against it, so the genuine agent always gets through.
  const failedVerification = async () => {
    const failures = await rateLimiter(
      redis,
      `agent-rebind-confirm:fail:${sourceAgentId}`,
      REBIND_CONFIRM_FAILURE_LIMIT.limit,
      REBIND_CONFIRM_FAILURE_LIMIT.windowSeconds,
    );
    if (!failures.allowed) {
      c.header('Retry-After', retryAfterSeconds(failures.resetAt));
      return c.json({ error: 'Too many failed confirmation attempts; retry later', code: 'rate_limited' }, 429);
    }
    return c.json({ error: 'Invalid confirmation credentials', code: 'invalid_confirmation' }, 401);
  };

  const token = parseConfirmationBearer(c.req.header('authorization'));
  if (!token) return failedVerification();

  const result = await confirmRebindIntent({
    sourceAgentId,
    token,
    assertion: readAgentCertificateAssertion(c),
  });
  if (!result.ok) {
    if (result.code === 'invalid_confirmation') return failedVerification();
    return c.json(refusalBody(result), result.status);
  }
  return c.json(result.identity);
});
