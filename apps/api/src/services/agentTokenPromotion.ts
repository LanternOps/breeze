import { and, eq } from 'drizzle-orm';

import { db } from '../db';
import { devices } from '../db/schema';

/** Grace window the superseded credential keeps after a confirmed promotion. */
export const PREVIOUS_TOKEN_GRACE_MS = 5 * 60 * 1000;

/**
 * Issue #2621 — promote a staged (pending) credential set to current.
 *
 * Shared by two callers with the same safety requirement:
 *
 *  - `POST /agents/:id/rotate-token/confirm` — a #2621-aware agent explicitly
 *    confirming that it durably persisted the staged credentials.
 *  - the heartbeat path — an agent that is *authenticating with* the staged
 *    token but never confirmed. That covers pre-#2621 agents, which overwrite
 *    their own token file and never call confirm; without this implicit
 *    promotion they would authenticate on the pending hash until it expired and
 *    then be locked out permanently. It also backstops a newer agent whose
 *    confirm response was lost in flight.
 *
 * In both cases the trigger is identical and is the only evidence that matters:
 * the endpoint presented the staged token, so it demonstrably holds it.
 *
 * The UPDATE is a compare-and-swap on BOTH the staged hash and the current hash
 * the caller observed. Binding to the staged hash alone is not enough — if the
 * current credential moved in between (admin token rotation, re-enrollment), a
 * staged token minted before that revocation could promote itself over the
 * replacement and roll the revocation back, and `previousTokenHash` would be
 * written from a stale read, re-arming an already-dead credential.
 *
 * Returns true when exactly one row was promoted.
 */
export async function promotePendingAgentCredentials(params: {
  deviceId: string;
  /** Hash of the token the caller authenticated with — must be the staged one. */
  pendingTokenHash: string;
  /** Current-token hash as observed by the caller; part of the CAS. */
  expectedAgentTokenHash: string;
  pendingWatchdogTokenHash: string | null;
  pendingHelperTokenHash: string | null;
  watchdogTokenHash: string | null;
  helperTokenHash: string | null;
  now?: Date;
}): Promise<boolean> {
  const {
    deviceId,
    pendingTokenHash,
    expectedAgentTokenHash,
    pendingWatchdogTokenHash,
    pendingHelperTokenHash,
    watchdogTokenHash,
    helperTokenHash,
    now = new Date(),
  } = params;

  const previousTokenExpiresAt = new Date(now.getTime() + PREVIOUS_TOKEN_GRACE_MS);

  const promotedRows = await db
    .update(devices)
    .set({
      previousTokenHash: expectedAgentTokenHash,
      previousTokenExpiresAt,
      agentTokenHash: pendingTokenHash,
      tokenIssuedAt: now,
      previousWatchdogTokenHash: watchdogTokenHash,
      previousWatchdogTokenExpiresAt: previousTokenExpiresAt,
      watchdogTokenHash: pendingWatchdogTokenHash,
      watchdogTokenIssuedAt: now,
      previousHelperTokenHash: helperTokenHash,
      previousHelperTokenExpiresAt: previousTokenExpiresAt,
      helperTokenHash: pendingHelperTokenHash,
      helperTokenIssuedAt: now,
      pendingTokenHash: null,
      pendingWatchdogTokenHash: null,
      pendingHelperTokenHash: null,
      pendingTokenExpiresAt: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(devices.id, deviceId),
        eq(devices.pendingTokenHash, pendingTokenHash),
        eq(devices.agentTokenHash, expectedAgentTokenHash)
      )
    )
    .returning({ id: devices.id });

  return promotedRows.length === 1;
}
