import { and, eq, inArray } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { remoteSessions, devices } from '../db/schema';
import { revokeViewerSession } from './viewerTokenRevocation';
import { sendCommandToAgent } from '../routes/agentWs';
import { captureException } from './sentry';

// Live statuses a teardown may disconnect. Terminal rows (`disconnected`,
// `failed`) are intentionally excluded: matching them (e.g. via
// `ne(status,'disconnected')`) would also sweep historical `failed` rows and
// overwrite their `endedAt`, corrupting session history for no benefit.
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
 * The per-row viewer-revoke / agent-signal calls are best-effort: a failure on
 * one session does not prevent the others from being torn down, and an
 * unexpected throw is logged rather than swallowed bare.
 *
 * @returns the number of sessions marked disconnected (`0` = nothing to do),
 *   or {@link TEARDOWN_FAILED} (`-1`) when the bulk disconnect itself failed.
 *   A `-1` is reported to Sentry here and MUST be surfaced by callers.
 */
export async function terminateUserRemoteSessions(userId: string): Promise<number> {
  let disconnected: Array<{ id: string; type: string; deviceId: string }>;

  // Single statement: mark this user's active sessions disconnected and return
  // the rows we touched. Collapses the previous SELECT+innerJoin enumeration
  // followed by a second UPDATE that re-evaluated the same predicate.
  try {
    disconnected = await runOutsideDbContext(() =>
      withSystemDbAccessContext(async () => {
        return db
          .update(remoteSessions)
          .set({ status: 'disconnected', endedAt: new Date() })
          .where(
            and(
              eq(remoteSessions.userId, userId),
              inArray(remoteSessions.status, [...ACTIVE_REMOTE_SESSION_STATUSES])
            )
          )
          .returning({
            id: remoteSessions.id,
            type: remoteSessions.type,
            deviceId: remoteSessions.deviceId,
          });
      })
    );
  } catch (err) {
    // Hard failure: the suspend-time teardown did not run. Alert via Sentry so
    // it is not silently swallowed, and signal the caller (sentinel) so it can
    // surface a degraded/partial result instead of reporting a clean success
    // while the operator may retain live screen/input/clipboard control.
    console.error(
      `[remoteSessionTeardown] Failed to disconnect sessions for user ${userId}:`,
      err
    );
    captureException(err instanceof Error ? err : new Error(String(err)));
    return TEARDOWN_FAILED;
  }

  if (disconnected.length === 0) {
    return 0;
  }

  // Resolve the owning agent id for each affected device so we can signal the
  // OS-level desktop teardown. One targeted SELECT keyed on the device ids we
  // just disconnected (agentId lives on devices, not remoteSessions). A failure
  // here is non-fatal: the rows are already disconnected and viewer tokens are
  // revoked below regardless — we just can't push stop_desktop.
  const agentByDevice = new Map<string, string | null>();
  try {
    const deviceIds = Array.from(new Set(disconnected.map((s) => s.deviceId)));
    const deviceRows = await runOutsideDbContext(() =>
      withSystemDbAccessContext(async () => {
        return db
          .select({ id: devices.id, agentId: devices.agentId })
          .from(devices)
          .where(inArray(devices.id, deviceIds));
      })
    );
    for (const row of deviceRows) {
      agentByDevice.set(row.id, row.agentId ?? null);
    }
  } catch (err) {
    console.error(
      `[remoteSessionTeardown] Failed to resolve agents for user ${userId} (stop_desktop skipped):`,
      err
    );
    captureException(err instanceof Error ? err : new Error(String(err)));
  }

  // Best-effort viewer-token revocation per session. A rejection on one does
  // not block the rest; an unexpected throw is logged, never swallowed bare.
  await Promise.all(
    disconnected.map((row) =>
      revokeViewerSession(row.id).catch((err) =>
        console.error(
          `[remoteSessionTeardown] Failed to revoke viewer session ${row.id}:`,
          err
        )
      )
    )
  );

  // Signal each desktop session's agent to tear down the peer-to-peer stream.
  for (const row of disconnected) {
    const agentId = agentByDevice.get(row.deviceId);
    if (row.type === 'desktop' && agentId) {
      try {
        sendCommandToAgent(agentId, {
          id: `desk-stop-${row.id}`,
          type: 'stop_desktop',
          payload: { sessionId: row.id },
        });
      } catch (err) {
        console.error(
          `[remoteSessionTeardown] Failed to send stop_desktop for session ${row.id}:`,
          err
        );
      }
    }
  }

  return disconnected.length;
}
