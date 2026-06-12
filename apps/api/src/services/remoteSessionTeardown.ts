import { and, eq, inArray, type SQL } from 'drizzle-orm';
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

/** A session row a teardown has just marked `disconnected`. */
type DisconnectedSession = { id: string; type: string; deviceId: string };

// Lazy import of the terminal WS module to break the import cycle
// (terminalWs → agentWs → terminalWs already exists; routing this through a
// dynamic import keeps remoteSessionTeardown out of that static cluster).
let _terminalWs: typeof import('../routes/terminalWs') | null = null;
async function getTerminalWs() {
  if (!_terminalWs) _terminalWs = await import('../routes/terminalWs');
  return _terminalWs;
}

/**
 * Given session rows already marked `disconnected`, push the per-session
 * teardown that the DB UPDATE alone does NOT achieve: revoke the viewer token,
 * signal the owning agent to stop the OS-level stream, and close any live
 * terminal socket on this instance.
 *
 * Shared by every teardown trigger — user suspension, device
 * quarantine/decommission, and the admin `/stale` sweep — so all of them tear
 * down the peer-to-peer stream identically. Before this existed, callers only
 * marked the row + revoked the viewer token, which blocks reconnect but leaves
 * the live WebRTC desktop (Flow-B) and the live terminal PTY running with the
 * API server out of the loop.
 *
 * Per-session calls are best-effort: a failure on one session is logged and
 * does not prevent the others from being torn down.
 *   - desktop → `stop_desktop` to the agent (handles direct + SYSTEM-helper).
 *   - terminal → `terminal_stop` to the agent (kills the PTY, also across
 *     instances) AND `closeTerminalSession` to drop any live socket held on
 *     this instance.
 *   - file_transfer → viewer-token revoke only (no streaming channel to stop).
 */
export async function teardownDisconnectedSessions(
  disconnected: DisconnectedSession[]
): Promise<void> {
  if (disconnected.length === 0) return;

  // Resolve the owning agent id for each affected device so we can signal the
  // OS-level teardown. One targeted SELECT keyed on the device ids we just
  // disconnected (agentId lives on devices, not remoteSessions). A failure here
  // is non-fatal: the rows are already disconnected and viewer tokens are
  // revoked below regardless — we just can't push stop_desktop/terminal_stop.
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
      `[remoteSessionTeardown] Failed to resolve agents (stop signals skipped):`,
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

  // Signal each session's agent to tear down its stream / PTY, and drop any
  // live terminal socket held locally.
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
    } else if (row.type === 'terminal') {
      // Close the live terminal socket on THIS instance if present;
      // closeTerminalSession also sends `terminal_stop` to the agent and
      // returns true when it closed a local socket. When the socket is NOT
      // local (false — e.g. it lives on another API instance), fall back to
      // signalling the agent directly so the PTY still dies. Exactly one
      // `terminal_stop` reaches the agent either way.
      let closedLocally = false;
      try {
        const { closeTerminalSession } = await getTerminalWs();
        closedLocally = closeTerminalSession(row.id);
      } catch (err) {
        console.error(
          `[remoteSessionTeardown] Failed to close terminal socket for session ${row.id}:`,
          err
        );
      }
      if (!closedLocally && agentId) {
        try {
          sendCommandToAgent(agentId, {
            id: `term-stop-${row.id}`,
            type: 'terminal_stop',
            payload: { sessionId: row.id },
          });
        } catch (err) {
          console.error(
            `[remoteSessionTeardown] Failed to send terminal_stop for session ${row.id}:`,
            err
          );
        }
      }
    }
  }
}

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
 *   2. revokes the viewer token — blocks reconnect, and the WS ping loop
 *      closes any live legacy (Flow-A) socket within one interval (#4),
 *   3. signals the owning agent to tear down the live stream immediately via
 *      {@link teardownDisconnectedSessions}: `stop_desktop` for desktop
 *      (peer-to-peer Flow-B WebRTC) and `terminal_stop` + local-socket close
 *      for terminal (the live PTY). Without this a suspended operator keeps
 *      screen/input or a live shell after being cut off.
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
  return disconnectAndTeardown(
    eq(remoteSessions.userId, userId),
    `user ${userId}`
  );
}

/**
 * Force-terminate every live remote session targeting a device. Called when a
 * device is quarantined (mTLS cert expiry / compromise) or decommissioned so an
 * isolated/offboarded device cannot keep a live remote-control session open.
 * Device-keyed analog of {@link terminateUserRemoteSessions}: same
 * disconnect → viewer-revoke → agent-stop teardown, scoped by `deviceId`
 * instead of `userId`.
 *
 * @returns the number of sessions marked disconnected (`0` = nothing to do),
 *   or {@link TEARDOWN_FAILED} (`-1`) when the bulk disconnect itself failed.
 */
export async function terminateDeviceRemoteSessions(deviceId: string): Promise<number> {
  return disconnectAndTeardown(
    eq(remoteSessions.deviceId, deviceId),
    `device ${deviceId}`
  );
}

/**
 * Mark every active session matching `scopePredicate` as `disconnected`
 * (returning the touched rows) and run {@link teardownDisconnectedSessions} on
 * them. Shared core of the user- and device-keyed terminate functions.
 *
 * Runs in a fresh system DB scope so it is safe to call from a request handler
 * or a background/admin context: `runOutsideDbContext` first breaks out of any
 * caller transaction/RLS context, then `withSystemDbAccessContext` establishes
 * system scope on a separate connection.
 */
async function disconnectAndTeardown(
  scopePredicate: SQL,
  label: string
): Promise<number> {
  let disconnected: DisconnectedSession[];

  try {
    disconnected = await runOutsideDbContext(() =>
      withSystemDbAccessContext(async () => {
        return db
          .update(remoteSessions)
          .set({ status: 'disconnected', endedAt: new Date() })
          .where(
            and(
              scopePredicate,
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
    // Hard failure: the teardown did not run. Alert via Sentry so it is not
    // silently swallowed, and signal the caller (sentinel) so it can surface a
    // degraded/partial result instead of reporting a clean success while an
    // operator may retain live screen/input/clipboard control.
    console.error(
      `[remoteSessionTeardown] Failed to disconnect sessions for ${label}:`,
      err
    );
    captureException(err instanceof Error ? err : new Error(String(err)));
    return TEARDOWN_FAILED;
  }

  if (disconnected.length === 0) {
    return 0;
  }

  await teardownDisconnectedSessions(disconnected);
  return disconnected.length;
}
