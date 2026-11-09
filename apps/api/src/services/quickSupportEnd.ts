import { and, eq, notInArray } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { devices, supportSessions } from '../db/schema';
import { dispatchCommandToAgent, dispatchDisposition } from './agentCommandRelay';
import { evictAgentSockets, type EvictOutcome } from './agentCommandRelayEvict';

export type SupportSessionEndReason = 'tech' | 'end_user' | 'expired' | 'error';

export interface EndSupportSessionResult {
  ended: boolean;
  /**
   * How the agent's live socket was dealt with; null when there was no device.
   * `unconfirmed`: the close was handed to the instance holding the socket (or
   * could not be) and no answer confirmed it. Recorded as such, never as a
   * success.
   */
  disconnect: 'closed' | 'close-failed' | 'not-connected' | 'unconfirmed' | null;
  /** False when the self-destruct command could not be handed to a live socket. */
  commandDelivered: boolean;
}

const TERMINAL_SESSION_STATUSES = ['ended', 'expired'] as const;

/**
 * Tear down a Quick Support session: tell the client to self-destruct, revoke
 * its credentials, and drop its socket, on whichever API instance holds it.
 *
 * Ordering is load-bearing, and runs as three phases (#4142):
 *   1. send `support_end` FIRST, while the socket is still authenticated — this
 *      is the cooperative path that makes the client delete itself immediately.
 *      It goes through the relay facade OUTSIDE any DB context (the relay
 *      refuses to wait on Redis inside one), after a short read transaction.
 *   2. in one transaction, end the session with a compare-and-set on its
 *      non-terminal status, then revoke all three token hashes and
 *      decommission the device, so nothing can re-authenticate with what it
 *      already holds. Losing the CAS (another end won) stops here.
 *   3. once that commits, force-close the socket (a fenced relay eviction).
 *      Without this a client whose `support_end` was lost stays happily
 *      connected until the 8h hard cap, because it is online and its own
 *      offline dead-man never fires. Closing forces a reconnect, the reconnect
 *      fails re-auth (the revocation is committed by then), and the client's
 *      dead-man converges in <=10 minutes.
 *
 * Shared by the tech-initiated end route, the AI tool and the reaper, so every
 * path revokes identically. Idempotent: a session already in a terminal state
 * returns ended:false rather than re-running the teardown.
 */
export async function endSupportSession(
  sessionId: string,
  reason: SupportSessionEndReason,
): Promise<EndSupportSessionResult> {
  return runOutsideDbContext(async () => {
    const target = await withSystemDbAccessContext(async () => {
      const [session] = await db
        .select()
        .from(supportSessions)
        .where(eq(supportSessions.id, sessionId))
        .limit(1);
      if (!session || session.status === 'ended' || session.status === 'expired') return null;
      if (!session.deviceId) return { deviceId: null, agentId: null };
      const [device] = await db
        .select({ agentId: devices.agentId })
        .from(devices)
        .where(eq(devices.id, session.deviceId))
        .limit(1);
      return { deviceId: device ? session.deviceId : null, agentId: device?.agentId ?? null };
    });
    if (!target) return { ended: false, disconnect: null, commandDelivered: false };

    // 1. Outside any context: the relay may wait up to its transport deadline.
    let commandDelivered = false;
    if (target.agentId) {
      const outcome = await dispatchCommandToAgent(target.agentId, {
        id: `support-end-${sessionId}`,
        type: 'support_end',
        payload: { sessionId },
      });
      commandDelivered = dispatchDisposition(outcome) === 'delivered';
    }

    // 2. One transaction: the CAS decides who ends the session.
    const ended = await withSystemDbAccessContext(async () => {
      const won = await db.update(supportSessions).set({
        // 'expired' is its own terminal state so the reaper's hard-cap kills are
        // distinguishable from a deliberate end in the session list.
        status: reason === 'expired' ? 'expired' : 'ended',
        endedAt: new Date(),
        endedReason: reason,
      })
        .where(and(eq(supportSessions.id, sessionId), notInArray(supportSessions.status, [...TERMINAL_SESSION_STATUSES])))
        .returning({ id: supportSessions.id });
      if (won.length === 0) return false;

      if (target.deviceId) {
        // own-device-row-allowlisted: support-session-end-decommission
        await db.update(devices).set({
          agentTokenHash: null,
          watchdogTokenHash: null,
          helperTokenHash: null,
          status: 'decommissioned',
          // #2787 item 4 — same removal stamp every other decommission path
          // writes, so an ephemeral support device is subject to the org's
          // retention policy rather than living forever.
          decommissionedAt: new Date(),
        }).where(eq(devices.id, target.deviceId));
      }
      return true;
    });
    if (!ended) return { ended: false, disconnect: null, commandDelivered };

    // 3. After the commit: a reconnect the close forces meets revoked tokens.
    if (!target.agentId) return { ended: true, disconnect: null, commandDelivered };
    const evicted = await evictAgentSockets([
      { agentId: target.agentId, code: 4041, reason: 'quick support session ended' },
    ]);
    return { ended: true, disconnect: disconnectResult(evicted.get(target.agentId)), commandDelivered };
  });
}

function disconnectResult(outcome: EvictOutcome | undefined): NonNullable<EndSupportSessionResult['disconnect']> {
  switch (outcome?.status) {
    case 'closed':
      return 'closed';
    case 'close_failed':
      return 'close-failed';
    case 'not_connected':
      return 'not-connected';
    default:
      return 'unconfirmed';
  }
}
