import { Hono, type Context, type Next } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { zValidator } from '../../lib/validation';
import type { AgentAuthContext } from '../../middleware/agentAuth';
import { staleAgentCredentialRejection } from '../../middleware/agentAuthRejection';
import { buildAuditLogParams, writeAuditEvent } from '../../services/auditEvents';
import { rateLimiter } from '../../services/rate-limit';
import { getRedis } from '../../services/redis';
import { tpmAttestationEnabled } from './heartbeatSettingsDecision';
import {
  CHALLENGES_PER_HOUR,
  challengeRateKey,
  completeAttestation,
  issueAttestationChallenge,
  TpmAttestationError,
} from '../../services/tpmAttestation';

/**
 * TPM EK collection (#8318 wave T1; spec 2026-10-12 §12.2), device-token
 * authenticated through the parent router's `/:id/*` agentAuthMiddleware.
 * Both routes key off the token's device and agent, never the `:id` segment.
 * Main agent only: the watchdog and the helper never attest. Refused for a
 * parked device until wave T2 adds them to the parked allow-list.
 *
 * Self-managed DB context (agentAuth SELF_MANAGED_DB_CONTEXT_TWO_SEGMENT_ACTIONS):
 * no request-long transaction is held, so the rate limit and the challenge's
 * Redis round-trips hold no pooled connection, and the completion opens its
 * own org-scoped transaction (services/tpmAttestation).
 *
 * Off unless TPM_ATTESTATION_ENABLED=true (the same switch the heartbeat
 * pushes to agents): while off both routes answer 403 TPM_ATTESTATION_DISABLED
 * before reading anything.
 *
 * Nothing here is logged beyond the outcome: no challenge, secret or EK.
 */
export const attestationRoutes = new Hono();

const base64 = (max: number) => z.string().min(1).max(max).regex(/^[A-Za-z0-9+/]+={0,2}$/);

// A TPMT_PUBLIC of an RSA-2048 key is about 300 bytes; 2 KiB of base64 is ample.
const challengeSchema = z.object({ ekPublic: base64(2048), akPublic: base64(2048) }).strict();
const completeSchema = z.object({ challengeId: z.string().uuid(), secret: base64(64) }).strict();

const limit = bodyLimit({ maxSize: 16 * 1024, onError: (c) => c.json({ error: 'Request body too large' }, 413) });

function mainAgent(agent: AgentAuthContext | undefined): AgentAuthContext | 'missing' | 'role' {
  if (!agent?.deviceId) return 'missing';
  return agent.role === 'agent' ? agent : 'role';
}

async function switchedOn(c: Context, next: Next) {
  if (!tpmAttestationEnabled()) {
    return c.json({ error: 'TPM attestation is turned off on this server', code: 'TPM_ATTESTATION_DISABLED' }, 403);
  }
  await next();
}

function refused(c: Context, error: TpmAttestationError) {
  // An invalid challenge reads the same however it failed (the reason is for the audit only).
  const reason = error.code === 'TPM_CHALLENGE_INVALID' ? undefined : error.reason;
  return c.json({ error: error.message, code: error.code, ...(reason ? { reason } : {}) }, error.status);
}

attestationRoutes.post('/:id/attestation/challenge', switchedOn, limit, zValidator('json', challengeSchema), async (c) => {
  const agent = mainAgent(c.get('agent') as AgentAuthContext | undefined);
  if (agent === 'missing') return c.json({ error: 'Agent context not found' }, 401);
  if (agent === 'role') return c.json({ error: 'This endpoint requires the agent credential' }, 403);

  const rate = await rateLimiter(getRedis(), challengeRateKey(agent.deviceId), CHALLENGES_PER_HOUR, 3600);
  if (!rate.allowed) return c.json({ error: 'Too many attestation challenges' }, 429);

  try {
    return c.json(await issueAttestationChallenge(agent, c.req.valid('json')));
  } catch (error) {
    if (error instanceof TpmAttestationError) return refused(c, error);
    throw error;
  }
});

attestationRoutes.post('/:id/attestation/complete', switchedOn, limit, zValidator('json', completeSchema), async (c) => {
  const agent = mainAgent(c.get('agent') as AgentAuthContext | undefined);
  if (agent === 'missing') return c.json({ error: 'Agent context not found' }, 401);
  if (agent === 'role') return c.json({ error: 'This endpoint requires the agent credential' }, 403);

  let result;
  try {
    result = await completeAttestation(agent, c.req.valid('json'), (action, orgId) => buildAuditLogParams(c, {
      orgId,
      action,
      resourceType: 'device',
      resourceId: agent.deviceId,
      actorType: 'agent',
      actorId: agent.agentId,
      result: 'success',
      details: {},
    }));
  } catch (error) {
    if (error instanceof TpmAttestationError) {
      // The agent's own live challenge answered wrongly: no TPM holding that
      // EK would, so it is recorded as a failed activation for review.
      if (error.reason === 'wrong_secret') {
        writeAuditEvent(c, {
          orgId: agent.orgId,
          action: 'device.tpm_attestation.failed',
          resourceType: 'device',
          resourceId: agent.deviceId,
          actorType: 'agent',
          actorId: agent.agentId,
          result: 'failure',
          details: { reason: 'wrong_secret' },
        });
      }
      return refused(c, error);
    }
    throw error;
  }
  if (result === 'stale') throw staleAgentCredentialRejection();
  if (result === 'not_found') return c.json({ error: 'Device not found' }, 404);
  return c.json({ attested: true, baseline: result.outcome });
});
