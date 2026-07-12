import { createHash } from 'crypto';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';

import { db } from '../../db';
import { devices } from '../../db/schema';
import type { AgentAuthContext } from '../../middleware/agentAuth';
import { writeAuditEvent } from '../../services/auditEvents';
import { generateApiKey } from './helpers';

export const tokenRoutes = new Hono();

tokenRoutes.post('/:id/rotate-token', async (c) => {
  const agentId = c.req.param('id');
  const agent = c.get('agent') as AgentAuthContext;
  if (agent.role !== 'agent') {
    return c.json({ error: 'Agent credential role mismatch' }, 403);
  }

  // PART A — superseded (previous-token) credentials must not renew themselves.
  // agentAuthMiddleware still lets a previous-token match through during the
  // ~5-min grace window (flagged for the agent to re-provision), but a stolen
  // superseded token must never be able to mint durable new agent/watchdog/
  // helper credentials and demote the legitimate current token. Rotation must
  // be driven by the CURRENT token only.
  if (c.get('agentTokenRotationRequired')) {
    return c.json(
      { error: 'Rotate using the current token; superseded tokens cannot rotate' },
      401
    );
  }

  // The authenticating-token hash is required for the compare-and-swap below.
  // The real agentAuthMiddleware always sets it; fail closed if it is ever
  // absent rather than running an UPDATE that isn't bound to the caller's token.
  const authTokenHash = agent.authTokenHash;
  if (!authTokenHash) {
    return c.json({ error: 'Missing authenticated token binding' }, 401);
  }

  const [device] = await db
    .select({
      id: devices.id,
      orgId: devices.orgId,
      hostname: devices.hostname,
      agentTokenHash: devices.agentTokenHash,
      watchdogTokenHash: devices.watchdogTokenHash,
      helperTokenHash: devices.helperTokenHash,
    })
    .from(devices)
    .where(
      and(
        eq(devices.id, agent.deviceId),
        eq(devices.agentId, agentId)
      )
    )
    .limit(1);

  if (!device) {
    return c.json({ error: 'Device not found' }, 404);
  }

  const rotatedAt = new Date();
  const previousTokenExpiresAt = new Date(rotatedAt.getTime() + 5 * 60 * 1000);
  const authToken = generateApiKey();
  const watchdogAuthToken = generateApiKey();
  const helperAuthToken = generateApiKey();
  // Agent bearer tokens are high-entropy random values; we store only a SHA-256 hash and never persist
  // the plaintext token.
  // lgtm[js/insufficient-password-hash]
  const agentTokenHash = createHash('sha256').update(authToken).digest('hex');
  // lgtm[js/insufficient-password-hash]
  const watchdogTokenHash = createHash('sha256').update(watchdogAuthToken).digest('hex');
  // lgtm[js/insufficient-password-hash]
  const helperTokenHash = createHash('sha256').update(helperAuthToken).digest('hex');

  // PART B — bind the rotation atomically to the hash that actually
  // authenticated this request. The UPDATE is a compare-and-swap on the
  // CURRENT agent-token hash (the value the middleware matched), so a race
  // (someone else rotated first) or any hash mismatch touches zero rows and
  // mints nothing. previousTokenHash becomes the authenticating hash — the
  // token that was current at rotation time.
  let rotatedRows: { id: string }[];
  try {
    rotatedRows = await db
      .update(devices)
      .set({
        previousTokenHash: authTokenHash,
        previousTokenExpiresAt,
        agentTokenHash,
        tokenIssuedAt: rotatedAt,
        previousWatchdogTokenHash: device.watchdogTokenHash,
        previousWatchdogTokenExpiresAt: previousTokenExpiresAt,
        watchdogTokenHash,
        watchdogTokenIssuedAt: rotatedAt,
        previousHelperTokenHash: device.helperTokenHash,
        previousHelperTokenExpiresAt: previousTokenExpiresAt,
        helperTokenHash,
        helperTokenIssuedAt: rotatedAt,
        updatedAt: rotatedAt,
      })
      .where(
        and(
          eq(devices.id, device.id),
          eq(devices.agentTokenHash, authTokenHash)
        )
      )
      .returning({ id: devices.id });
  } catch (error) {
    console.error('[agents] token rotation DB update failed:', {
      agentId,
      deviceId: device.id,
      error,
    });
    return c.json({ error: 'Failed to rotate agent token' }, 500);
  }

  // Zero rows => the current-token hash moved out from under us (concurrent
  // rotation / stale token). Do NOT return any freshly-minted plaintext tokens;
  // they were never persisted because the CAS matched nothing.
  if (rotatedRows.length !== 1) {
    console.warn('[agents] token rotation compare-and-swap matched no rows:', {
      agentId,
      deviceId: device.id,
    });
    return c.json({ error: 'Token rotation conflict; re-authenticate with the current token' }, 409);
  }

  try {
    writeAuditEvent(c, {
      orgId: agent.orgId,
      actorType: 'agent',
      actorId: agent.agentId,
      action: 'agent.token.rotate',
      resourceType: 'device',
      resourceId: device.id,
      resourceName: device.hostname,
      details: {
        rotatedAt: rotatedAt.toISOString(),
        previousTokenGracePeriodSeconds: 300,
      },
    });
  } catch (auditErr) {
    console.error('[agents] audit event write failed for token rotation:', auditErr);
  }

  return c.json(
    {
      authToken,
      watchdogAuthToken,
      helperAuthToken,
      rotatedAt: rotatedAt.toISOString(),
    },
    200
  );
});
