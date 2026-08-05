import { eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { devices, supportSessions } from '../db/schema';
import { disconnectAgent, sendCommandToAgent } from '../routes/agentWs';

export type SupportSessionEndReason = 'tech' | 'end_user' | 'expired' | 'error';

export interface EndSupportSessionResult {
  ended: boolean;
  /** How the agent's live socket was dealt with; null when there was no device. */
  disconnect: 'closed' | 'close-failed' | 'not-connected' | null;
  /** False when the self-destruct command could not be handed to a live socket. */
  commandDelivered: boolean;
}

/**
 * Tear down a Quick Support session: tell the client to self-destruct, revoke
 * its credentials, and drop its socket.
 *
 * Ordering is load-bearing:
 *   1. send `support_end` FIRST, while the socket is still authenticated — this
 *      is the cooperative path that makes the client delete itself immediately.
 *   2. revoke all three token hashes and decommission the device, so nothing
 *      can re-authenticate with what it already holds.
 *   3. force-close the socket. Without this a client whose `support_end` was
 *      lost stays happily connected until the 8h hard cap, because it is
 *      online and its own offline dead-man never fires. Closing forces a
 *      reconnect, the reconnect fails re-auth, and the client's dead-man
 *      converges in <=10 minutes.
 *
 * Shared by the tech-initiated end route and the reaper, so both paths revoke
 * identically. Idempotent: a session already in a terminal state returns
 * ended:false rather than re-running the teardown.
 */
export async function endSupportSession(
  sessionId: string,
  reason: SupportSessionEndReason,
): Promise<EndSupportSessionResult> {
  return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const [session] = await db
      .select()
      .from(supportSessions)
      .where(eq(supportSessions.id, sessionId))
      .limit(1);

    if (!session || session.status === 'ended' || session.status === 'expired') {
      return { ended: false, disconnect: null, commandDelivered: false };
    }

    let disconnect: EndSupportSessionResult['disconnect'] = null;
    let commandDelivered = false;

    if (session.deviceId) {
      const [device] = await db
        .select({ agentId: devices.agentId })
        .from(devices)
        .where(eq(devices.id, session.deviceId))
        .limit(1);

      if (device) {
        commandDelivered = sendCommandToAgent(device.agentId, {
          id: `support-end-${sessionId}`,
          type: 'support_end',
          payload: { sessionId },
        });

        await db.update(devices).set({
          agentTokenHash: null,
          watchdogTokenHash: null,
          helperTokenHash: null,
          status: 'decommissioned',
        }).where(eq(devices.id, session.deviceId));

        disconnect = disconnectAgent(device.agentId, 4041, 'quick support session ended');
      }
    }

    await db.update(supportSessions).set({
      // 'expired' is its own terminal state so the reaper's hard-cap kills are
      // distinguishable from a deliberate end in the session list.
      status: reason === 'expired' ? 'expired' : 'ended',
      endedAt: new Date(),
      endedReason: reason,
    }).where(eq(supportSessions.id, sessionId));

    return { ended: true, disconnect, commandDelivered };
  }));
}
