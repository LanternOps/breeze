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

/**
 * Issue #2894 — machine-readable conflict codes for the rotation routes.
 *
 * EVERY 409 these routes emit carries one of these, so the agent can tell a
 * conflict it should give up on from one it should retry. Before this the two
 * compare-and-swap conflicts returned a bare `{ error }`, the agent's client
 * collapsed them into a generic error, and the heartbeat retried the confirm on
 * every tick until the pending TTL expired.
 *
 * The split is deliberately conservative, and the asymmetry is the whole point:
 *
 *  - TERMINAL means the staged set can never be promoted AND is not the
 *    endpoint's current credential, so discarding it costs the agent nothing.
 *    An agent that acts on this drops the staged set immediately.
 *  - RETRYABLE means the staged token may still be live server-side (it is the
 *    pending hash, or it is the current hash). Discarding it there could strand
 *    the device — see #2772/#2773 — so the agent must keep it and retry.
 *
 * Anything an older agent does not recognise falls through to retry, which is
 * the safe default. `token.conflictCodes.test.ts` fails the build if a future
 * 409 in this file is added without a code.
 */
const ROTATION_CONFLICT_CODES = {
  /**
   * TERMINAL. The presented token is neither the server's staged token nor its
   * current one — a newer rotation, an admin token reset or a re-enrollment
   * moved past it. It can never be promoted and it is not the live credential.
   */
  UNRESOLVABLE: 'rotation_unresolvable',
  /**
   * RETRYABLE. The promotion could not be applied right now, but the presented
   * token is still the server's staged credential. Re-reading the row on the
   * next attempt yields a precise (possibly terminal) answer.
   */
  CONFLICT: 'rotation_conflict',
  /**
   * RETRYABLE. The presented token is the endpoint's CURRENT credential while a
   * different set is staged. Never terminal: the staged copy the agent holds on
   * disk under this token is the credential the server is authenticating it
   * with, so discarding it would strand the device. It resolves on its own once
   * the competing staged set clears, at which point confirm returns
   * `alreadyCurrent`.
   */
  PENDING_TOKEN_REQUIRED: 'pending_token_required',
  /** TERMINAL. The staged set aged out before the agent could confirm it. */
  PENDING_ROTATION_EXPIRED: 'pending_rotation_expired',
  /** RETRYABLE. A staged rotation must be confirmed before a new one starts. */
  PENDING_ROTATION_UNCONFIRMED: 'pending_rotation_unconfirmed',
} as const;

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
      {
        error: 'Confirm the pending rotation before starting a new one',
        code: ROTATION_CONFLICT_CODES.PENDING_ROTATION_UNCONFIRMED,
      },
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
    return c.json(
      {
        error: 'Token rotation conflict; re-authenticate with the current token',
        // Retryable: nothing was staged, so the agent has no staged set to
        // discard. It simply rotates again on its next trigger.
        code: ROTATION_CONFLICT_CODES.CONFLICT,
      },
      409
    );
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
    // Issue #2894 — the two sub-cases are NOT interchangeable, and conflating
    // them is how an error-signalling fix turns into a stranded endpoint.
    //
    // If the presented token is this device's CURRENT credential, the agent is
    // holding a live token under its pending_* keys: a newer rotation was staged
    // after this one was promoted. It must keep that copy and retry — the
    // conflict clears by itself when the competing staged set is confirmed or
    // expires, and the retry then lands on the `alreadyCurrent` branch above.
    //
    // Otherwise the presented token is neither staged nor current (it survives
    // only inside the previous-token grace window, if at all). Nothing can ever
    // promote it, so say so and let the agent stop asking.
    const presentedTokenIsCurrent = device.agentTokenHash === authTokenHash;
    return c.json(
      presentedTokenIsCurrent
        ? {
            error: 'Confirm must be sent with the pending rotation token',
            code: ROTATION_CONFLICT_CODES.PENDING_TOKEN_REQUIRED,
          }
        : {
            error: 'Staged rotation superseded; discard it and re-authenticate with the current token',
            code: ROTATION_CONFLICT_CODES.UNRESOLVABLE,
          },
      409
    );
  }

  if (!device.pendingTokenExpiresAt || device.pendingTokenExpiresAt <= new Date()) {
    return c.json(
      {
        error: 'Pending rotation has expired; request a new rotation',
        code: ROTATION_CONFLICT_CODES.PENDING_ROTATION_EXPIRED,
      },
      409
    );
  }

  const confirmedAt = new Date();

  if (!device.agentTokenHash) {
    // No current hash to compare-and-swap against, so the promotion cannot run.
    // Deliberately RETRYABLE, not terminal: we only get here because the
    // presented token IS the live staged hash, which means it is the one
    // credential this device can still authenticate with. Telling the agent to
    // discard it would take away the last working token.
    return c.json(
      {
        error: 'Rotation confirm conflict; re-authenticate and retry',
        code: ROTATION_CONFLICT_CODES.CONFLICT,
      },
      409
    );
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
    // RETRYABLE by construction. The SELECT above saw the staged hash and the
    // current hash the CAS bound to, so zero rows means the row moved between
    // the read and the write — a concurrent promotion, admin token reset or
    // re-enrollment. That is transient: the next attempt re-reads the row and
    // gets a precise answer (`alreadyCurrent`, `rotation_unresolvable`, or
    // `pending_rotation_expired`). Marking it terminal would let the agent
    // discard a staged set that a single retry would have promoted.
    return c.json(
      {
        error: 'Rotation confirm conflict; re-authenticate and retry',
        code: ROTATION_CONFLICT_CODES.CONFLICT,
      },
      409
    );
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
