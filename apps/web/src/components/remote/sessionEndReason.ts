import { isRemoteSessionEndReason, type RemoteSessionEndReason } from '@breeze/shared';

/**
 * #11839: the `remote` namespace label for each recorded end reason. A Record
 * over the shared closed set, so a reason added to REMOTE_SESSION_END_REASONS
 * fails the web typecheck until it has a label here (and, by locale parity, in
 * every locale's `remote.json`).
 */
const END_REASON_LABEL_KEYS: Record<RemoteSessionEndReason, string> = {
  ended_by_user: 'sessionHistory.endReasons.endedByUser',
  operator_ended: 'sessionHistory.endReasons.operatorEnded',
  viewer_closed: 'sessionHistory.endReasons.viewerClosed',
  connection_lost: 'sessionHistory.endReasons.connectionLost',
  peer_disconnected: 'sessionHistory.endReasons.peerDisconnected',
  never_connected: 'sessionHistory.endReasons.neverConnected',
  superseded: 'sessionHistory.endReasons.superseded',
  capture_failed: 'sessionHistory.endReasons.captureFailed',
  start_failed: 'sessionHistory.endReasons.startFailed',
  consent_denied: 'sessionHistory.endReasons.consentDenied',
  access_revoked: 'sessionHistory.endReasons.accessRevoked',
  max_duration: 'sessionHistory.endReasons.maxDuration',
  device_removed: 'sessionHistory.endReasons.deviceRemoved',
};

/**
 * The label key for a session's end reason, or null when there is none to
 * show: no reason recorded (rows that predate #11839), or a value from an API
 * newer than this bundle.
 */
export function endReasonLabelKey(reason: unknown): string | null {
  return isRemoteSessionEndReason(reason) ? END_REASON_LABEL_KEYS[reason] : null;
}
