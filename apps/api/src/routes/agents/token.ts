import { createHash } from 'crypto';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';

import { db } from '../../db';
import { devices } from '../../db/schema';
import type { AgentAuthContext } from '../../middleware/agentAuth';
import {
  PREVIOUS_TOKEN_GRACE_MS,
  promotePendingAgentCredentials,
} from '../../services/agentTokenPromotion';
import { writeAuditEvent } from '../../services/auditEvents';
import { generateApiKey } from './helpers';

export const tokenRoutes = new Hono();

/**
 * Issue #2621 — how long a staged (pending) credential set stays usable before
 * an unconfirmed rotation is abandoned. Generous on purpose: the window has to
 * cover an agent that persisted the new credentials and then lost connectivity
 * or crashed before it could confirm. Until it elapses BOTH the current and the
 * staged credentials authenticate, so no crash point can strand the endpoint.
 */
const PENDING_ROTATION_TTL_MS = 60 * 60 * 1000; // 1 hour

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

  // Issue #2621 — a caller holding only the STAGED credential of an unconfirmed
  // rotation must confirm that rotation rather than start a new one. Allowing a
  // chain of staged-on-staged rotations would let the durable, server-current
  // credential drift arbitrarily far from anything the endpoint has on disk,
  // which is precisely the divergence this design exists to prevent.
  if (c.get('agentPendingTokenPresented')) {
    return c.json(
      { error: 'Confirm the pending rotation before starting a new one', code: 'pending_rotation_unconfirmed' },
      409
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
  const pendingExpiresAt = new Date(rotatedAt.getTime() + PENDING_ROTATION_TTL_MS);
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

  // PART B — Issue #2621: STAGE the new credential set; do not commit it.
  //
  // The old code promoted these hashes to current here, before the endpoint had
  // written anything to disk. A failed config.Save then left the server holding
  // hashes the agent could not reproduce after a restart — a permanent 401 once
  // the previous-token grace expired, with no recovery path.
  //
  // Now agent_token_hash / watchdog_token_hash / helper_token_hash are left
  // untouched and fully authoritative. The new hashes land in the pending_*
  // columns, where auth accepts them but a restart does not depend on them.
  // Promotion happens only in /rotate-token/confirm, which requires the agent to
  // authenticate WITH the new token — proof it read the credential back off
  // disk. If that confirmation never arrives, the staged set simply expires and
  // the endpoint keeps working on the credentials it durably holds.
  //
  // The UPDATE is still a compare-and-swap on the CURRENT agent-token hash, so a
  // concurrent rotation or hash mismatch touches zero rows and stages nothing.
  // Re-staging over an existing pending set is deliberate and safe: it is how an
  // agent that lost the plaintext (crash before the disk write) retries.
  let rotatedRows: { id: string }[];
  try {
    rotatedRows = await db
      .update(devices)
      .set({
        pendingTokenHash: agentTokenHash,
        pendingWatchdogTokenHash: watchdogTokenHash,
        pendingHelperTokenHash: helperTokenHash,
        pendingTokenExpiresAt: pendingExpiresAt,
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
    console.error('[agents] token rotation staging DB update failed:', {
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
      action: 'agent.token.rotate.staged',
      resourceType: 'device',
      resourceId: device.id,
      resourceName: device.hostname,
      details: {
        stagedAt: rotatedAt.toISOString(),
        pendingExpiresAt: pendingExpiresAt.toISOString(),
      },
    });
  } catch (auditErr) {
    console.error('[agents] audit event write failed for token rotation staging:', auditErr);
  }

  return c.json(
    {
      authToken,
      watchdogAuthToken,
      helperAuthToken,
      rotatedAt: rotatedAt.toISOString(),
      // Signals a two-phase-capable server. Agents that see this MUST persist +
      // read back, then call /rotate-token/confirm. Older agents that ignore it
      // still work: their new credentials authenticate immediately as pending,
      // and the very next request they make carrying the new token is what a
      // confirm would have proven anyway.
      confirmationRequired: true,
      pendingExpiresAt: pendingExpiresAt.toISOString(),
    },
    200
  );
});

/**
 * Issue #2621 — phase two: promote a staged credential set to current.
 *
 * The caller MUST authenticate with the staged agent token itself. That is the
 * whole point: possession of the new token after the agent has written it to
 * disk and read it back is the endpoint's proof that the credential is durable.
 * Only then is it safe to demote the credential the endpoint was previously
 * relying on.
 */
tokenRoutes.post('/:id/rotate-token/confirm', async (c) => {
  const agentId = c.req.param('id');
  const agent = c.get('agent') as AgentAuthContext;
  if (agent.role !== 'agent') {
    return c.json({ error: 'Agent credential role mismatch' }, 403);
  }

  const authTokenHash = agent.authTokenHash;
  if (!authTokenHash) {
    return c.json({ error: 'Missing authenticated token binding' }, 401);
  }

  const [device] = await db
    .select({
      id: devices.id,
      hostname: devices.hostname,
      agentTokenHash: devices.agentTokenHash,
      watchdogTokenHash: devices.watchdogTokenHash,
      helperTokenHash: devices.helperTokenHash,
      pendingTokenHash: devices.pendingTokenHash,
      pendingWatchdogTokenHash: devices.pendingWatchdogTokenHash,
      pendingHelperTokenHash: devices.pendingHelperTokenHash,
      pendingTokenExpiresAt: devices.pendingTokenExpiresAt,
    })
    .from(devices)
    .where(and(eq(devices.id, agent.deviceId), eq(devices.agentId, agentId)))
    .limit(1);

  if (!device) {
    return c.json({ error: 'Device not found' }, 404);
  }

  // Idempotency: the agent retries confirmation until it succeeds, and a retry
  // whose predecessor actually landed arrives authenticated with what is now the
  // CURRENT token and finds no pending set. That is success, not a conflict —
  // returning an error here would drive an infinite retry loop on a healthy
  // device.
  if (!device.pendingTokenHash && device.agentTokenHash === authTokenHash) {
    return c.json({ confirmed: true, alreadyCurrent: true }, 200);
  }

  // The caller must be presenting the staged token, not the current one. A
  // confirm sent with the OLD token would promote a credential the endpoint has
  // given no evidence of holding — exactly the unverified commit that caused
  // this bug.
  if (!device.pendingTokenHash || device.pendingTokenHash !== authTokenHash) {
    return c.json(
      { error: 'Confirm must be sent with the pending rotation token', code: 'pending_token_required' },
      409
    );
  }

  if (!device.pendingTokenExpiresAt || device.pendingTokenExpiresAt <= new Date()) {
    return c.json(
      { error: 'Pending rotation has expired; request a new rotation', code: 'pending_rotation_expired' },
      409
    );
  }

  const confirmedAt = new Date();

  if (!device.agentTokenHash) {
    return c.json({ error: 'Rotation confirm conflict; re-authenticate and retry' }, 409);
  }

  let promoted: boolean;
  try {
    promoted = await promotePendingAgentCredentials({
      deviceId: device.id,
      pendingTokenHash: authTokenHash,
      expectedAgentTokenHash: device.agentTokenHash,
      pendingWatchdogTokenHash: device.pendingWatchdogTokenHash,
      pendingHelperTokenHash: device.pendingHelperTokenHash,
      watchdogTokenHash: device.watchdogTokenHash,
      helperTokenHash: device.helperTokenHash,
      now: confirmedAt,
    });
  } catch (error) {
    console.error('[agents] token rotation confirm DB update failed:', {
      agentId,
      deviceId: device.id,
      error,
    });
    return c.json({ error: 'Failed to confirm agent token rotation' }, 500);
  }

  if (!promoted) {
    console.warn('[agents] token rotation confirm compare-and-swap matched no rows:', {
      agentId,
      deviceId: device.id,
    });
    return c.json({ error: 'Rotation confirm conflict; re-authenticate and retry' }, 409);
  }

  try {
    writeAuditEvent(c, {
      orgId: agent.orgId,
      actorType: 'agent',
      actorId: agent.agentId,
      action: 'agent.token.rotate.confirmed',
      resourceType: 'device',
      resourceId: device.id,
      resourceName: device.hostname,
      details: {
        confirmedAt: confirmedAt.toISOString(),
        previousTokenGracePeriodSeconds: PREVIOUS_TOKEN_GRACE_MS / 1000,
      },
    });
  } catch (auditErr) {
    console.error('[agents] audit event write failed for token rotation confirm:', auditErr);
  }

  return c.json({ confirmed: true, confirmedAt: confirmedAt.toISOString() }, 200);
});
