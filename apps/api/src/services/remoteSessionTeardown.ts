import { and, eq, inArray } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { remoteSessions, devices } from '../db/schema';
import { revokeViewerSession } from './viewerTokenRevocation';
import { sendCommandToAgent } from '../routes/agentWs';
import { captureException } from './sentry';

const ACTIVE_REMOTE_SESSION_STATUSES = ['pending', 'connecting', 'active'] as const;

/**
 * Sentinel returned by {@link terminateUserRemoteSessions} when teardown
 * FAILED (enumeration / bulk-disconnect threw). Distinct from `0`, which
 * means "nothing to do". Callers MUST surface this — a silent `0` on failure
 * would let a suspended operator keep live remote control with no alert.
 */
export const TEARDOWN_FAILED = -1;

/**
 * Force-terminate every live remote session owned by a user. Called from
 * account-suspension / deactivation and partner-abuse-suspend paths so a
 * disabled or rogue operator cannot keep live remote-desktop control after
 * being cut off. Finding #3.
 *
 * Revoking the user's JWT / OAuth artifacts does NOT touch remote sessions:
 * the viewer token is an independent JWT and the WebRTC media/input/clipboard
 * flow peer-to-peer to the agent with the API server out of the loop. So for
 * each active session this:
 *   1. marks the row `disconnected` (session list reflects reality),
 *   2. revokes the viewer token — blocks reconnect, and the desktop-WS ping
 *      loop closes any live legacy (Flow-A) socket within one interval (#4),
 *   3. sends `stop_desktop` to the owning agent so the peer-to-peer WebRTC
 *      (Flow-B) stream is torn down immediately (#2); the agent's
 *      `handleStopDesktop` handles both direct and SYSTEM-helper sessions.
 *
 * Runs in a fresh system DB scope so it is safe to call from a request handler
 * (PATCH /users/:id) or a background/admin context: `runOutsideDbContext`
 * first breaks out of any caller transaction/RLS context, then
 * `withSystemDbAccessContext` establishes system scope on a separate
 * connection (same pattern as `logSessionAudit`).
 *
 * Per-row viewer-token revocation and stop_desktop commands are best-effort:
 * individual failures are logged and do not throw to the caller. A hard
 * enumerate / bulk-disconnect failure returns TEARDOWN_FAILED (and is reported
 * to Sentry); callers MUST surface that sentinel because teardown did not run.
 * On success, returns the number of sessions it tore down.
 */
export async function terminateUserRemoteSessions(userId: string): Promise<number> {
  let active: Array<{ id: string; type: string; agentId: string | null }> = [];
  try {
    active = await runOutsideDbContext(() =>
      withSystemDbAccessContext(async () => {
        const rows = await db
          .select({
            id: remoteSessions.id,
            type: remoteSessions.type,
            agentId: devices.agentId,
          })
          .from(remoteSessions)
          .innerJoin(devices, eq(remoteSessions.deviceId, devices.id))
          .where(
            and(
              eq(remoteSessions.userId, userId),
              inArray(remoteSessions.status, [...ACTIVE_REMOTE_SESSION_STATUSES])
            )
          );

        if (rows.length > 0) {
          await db
            .update(remoteSessions)
            .set({ status: 'disconnected', endedAt: new Date() })
            .where(
              and(
                eq(remoteSessions.userId, userId),
                inArray(remoteSessions.status, [...ACTIVE_REMOTE_SESSION_STATUSES])
              )
            );
        }
        return rows;
      })
    );
  } catch (err) {
    // Hard failure: the suspend-time teardown did not run. Alert via Sentry so
    // it is not silently swallowed, and signal the caller (sentinel) so it can
    // surface a degraded/partial result instead of reporting a clean success
    // while the operator may retain live screen/input/clipboard control.
    console.error(`[remoteSessionTeardown] Failed to enumerate/disconnect sessions for user ${userId}:`, err);
    captureException(err instanceof Error ? err : new Error(String(err)));
    return TEARDOWN_FAILED;
  }

  await Promise.all(
    active.map((row) =>
      revokeViewerSession(row.id).catch((err) =>
        console.error(`[remoteSessionTeardown] Failed to revoke viewer session ${row.id}:`, err)
      )
    )
  );

  for (const row of active) {
    if (row.type === 'desktop' && row.agentId) {
      try {
        sendCommandToAgent(row.agentId, {
          id: `desk-stop-${row.id}`,
          type: 'stop_desktop',
          payload: { sessionId: row.id },
        });
      } catch (err) {
        console.error(`[remoteSessionTeardown] Failed to send stop_desktop for session ${row.id}:`, err);
      }
    }
  }

  return active.length;
}
