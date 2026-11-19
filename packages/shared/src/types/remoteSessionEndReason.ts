/**
 * Why a remote session ended (#11839).
 *
 * `remote_sessions.status` only says *that* a session ended ('disconnected',
 * 'failed', 'denied'). Before #11839 a lease revocation, a session that never
 * connected and a normal hang-up all read as plain 'disconnected'. Every
 * server-side terminal writer now records one of these reasons in
 * `remote_sessions.end_reason`, through the terminal-intent contract
 * (`apps/api/src/services/remoteDesktopTerminalIntent.ts`).
 *
 * This list is a closed set mirrored by the `remote_sessions_end_reason_check`
 * CHECK constraint. Adding a value needs a migration that widens the CHECK, a
 * label in every web locale (`remote.json` → `sessionHistory.endReasons`), and
 * an update to `REMOTE_SESSION_END_REASONS` below.
 *
 * NULL in the column means "not recorded": rows written before #11839.
 */
export const REMOTE_SESSION_END_REASONS = [
  /** The person at the keyboard ended it from the on-screen indicator (#10190). */
  'ended_by_user',
  /**
   * A technician ended it on purpose: POST /remote/sessions/:id/end (the web
   * terminal's Disconnect, the web launcher dismissing a session the viewer
   * never opened), or the desktop viewer app's hang-up through its
   * viewer-token POST /desktop-ws/:id/viewer/end (closing the session window,
   * or cancelling a reconnect; #11931).
   */
  'operator_ended',
  /** The viewer's socket closed normally (desktop WebSocket fallback, terminal). */
  'viewer_closed',
  /**
   * The viewer's transport failed: socket error, missed heartbeat, the API
   * instance holding it went away, or it lost its connection ownership lease.
   */
  'connection_lost',
  /**
   * The device reported that the WebRTC peer closed (after the reconnect
   * grace, when the viewer was reconnecting). This does NOT mean the device
   * dropped: a real network drop lands here, as do the device's own idle,
   * lifetime and lease stops (the agent reports them with no reason), and a
   * viewer that closed without sending End first: the app was quit or
   * crashed, End did not reach the API in time, or the viewer is older than
   * #11931. Hence the neutral label ("Connection closed"). A later
   * `ended_by_user` report replaces it (desktopUserEnd.ts).
   */
  'peer_disconnected',
  /** The session was still pending/connecting when a stale sweep or the reaper timed it out. */
  'never_connected',
  /** A newer session for the same device replaced it. */
  'superseded',
  /**
   * Screen capture stopped producing video mid-session and the device ended it
   * (a peer drop that carries the agent's no-video watchdog `stopReason`, #5300).
   */
  'capture_failed',
  /** The device or the API failed to start the session. */
  'start_failed',
  /** The person at the device declined the consent prompt. */
  'consent_denied',
  /**
   * The technician's access ended: a live revocation-lease recheck failed, or
   * their account changed (password/MFA reset, deactivation, role or membership).
   */
  'access_revoked',
  /** The session reached its maximum allowed duration. */
  'max_duration',
  /** The device was decommissioned, reinstalled, or had its credentials revoked. */
  'device_removed',
] as const;

export type RemoteSessionEndReason = (typeof REMOTE_SESSION_END_REASONS)[number];

export function isRemoteSessionEndReason(value: unknown): value is RemoteSessionEndReason {
  return typeof value === 'string'
    && (REMOTE_SESSION_END_REASONS as readonly string[]).includes(value);
}
