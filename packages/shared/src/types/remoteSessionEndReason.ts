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
  /** A technician ended it (End button / viewer hang-up, POST /remote/sessions/:id/end). */
  'operator_ended',
  /** The viewer's socket closed normally (desktop WebSocket fallback, terminal). */
  'viewer_closed',
  /** The viewer's transport failed: socket error, missed heartbeat, or the API lost the connection. */
  'connection_lost',
  /** The device reported that the WebRTC peer dropped, and the viewer did not reconnect. */
  'peer_disconnected',
  /** The session timed out while pending/connecting and never became active. */
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
  /** A live access recheck failed: the technician's account, role, MFA or policy changed. */
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
