import { SESSION_ENDED_DEFAULT_MESSAGE } from './webrtc';

/**
 * #10421: why a remote session ended, and how the viewer shows it.
 *
 * The agent ends a desktop session on purpose (idle timeout, maximum length,
 * a revoked or lapsed revocation lease) and, from the agent build that ships
 * with this change, says why on the control channel just before it closes the
 * peer (agent/internal/remote/desktop/session_ending.go). An older agent sends
 * nothing; the viewer then learns the session ended from the 401 on its
 * reconnect attempt and shows the server-side reason when the API has one.
 *
 * Either way the session is terminal: the viewer holds a single-session token
 * and cannot reconnect it, so the card offers Close, never Retry.
 */

/** The agent's `session_ending` control message, validated. */
export interface SessionEndingNotice {
  reason: string;
  idleTimeoutMinutes?: number;
  maxDurationMinutes?: number;
  /** For reason `revoked`: the control plane's revocation reason. */
  detail?: string;
}

/** Shown after every session-ended reason. */
export const RELAUNCH_HINT = 'Relaunch it from the Breeze dashboard.';

const LOST_CONTACT_TEXT = 'The device lost contact with the Breeze server, so the session ended.';
const REVOKED_FALLBACK_TEXT = 'Your access to this session was revoked.';

// The API's RevocationReason values (apps/api/src/services/remoteRevocationLease.ts).
// An unknown value falls back to REVOKED_FALLBACK_TEXT, so a new server reason
// never breaks an older viewer.
const REVOCATION_TEXT: Record<string, string> = {
  session_ended: 'The session was ended from the Breeze dashboard.',
  hard_deadline: 'The session reached its maximum length.',
  permissions_changed: 'Your remote access permissions changed, so the session was ended.',
  membership_removed: 'Your access to this organization was removed, so the session was ended.',
  site_scope_lost: 'You no longer have access to this device\'s site, so the session was ended.',
  user_inactive: 'Your Breeze account is no longer active, so the session was ended.',
  mfa_required: 'Your account now requires multi-factor authentication, so the session was ended.',
  policy_denied: 'A remote access policy no longer allows this session, so it was ended.',
  org_suspended: 'This organization was suspended, so the session was ended.',
  partner_suspended: 'This account was suspended, so the session was ended.',
};

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

export function parseSessionEndingMessage(msg: unknown): SessionEndingNotice | null {
  if (!msg || typeof msg !== 'object') return null;
  const m = msg as Record<string, unknown>;
  if (m.type !== 'session_ending') return null;
  if (typeof m.reason !== 'string' || m.reason.length === 0) return null;
  const notice: SessionEndingNotice = { reason: m.reason };
  const idle = positiveNumber(m.idleTimeoutMinutes);
  if (idle !== undefined) notice.idleTimeoutMinutes = idle;
  const max = positiveNumber(m.maxDurationMinutes);
  if (max !== undefined) notice.maxDurationMinutes = max;
  if (typeof m.detail === 'string' && m.detail.length > 0) notice.detail = m.detail;
  return notice;
}

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

function durationText(minutes: number): string {
  if (minutes % 60 === 0) return plural(minutes / 60, 'hour');
  return plural(minutes, 'minute');
}

function revocationText(detail: string | undefined): string {
  return (detail && REVOCATION_TEXT[detail]) || REVOKED_FALLBACK_TEXT;
}

export function sessionEndingText(notice: SessionEndingNotice): string {
  switch (notice.reason) {
    case 'idle_timeout_exceeded':
      return notice.idleTimeoutMinutes
        ? `The session ended after ${plural(notice.idleTimeoutMinutes, 'minute')} of inactivity.`
        : 'The session ended after a period of inactivity.';
    case 'max_session_duration_exceeded':
      return notice.maxDurationMinutes
        ? `The session reached its maximum length of ${durationText(notice.maxDurationMinutes)}.`
        : 'The session reached its maximum length.';
    case 'revoked':
      return revocationText(notice.detail);
    case 'lease_expired':
    case 'lease_unavailable_at_start':
      return LOST_CONTACT_TEXT;
    default:
      return SESSION_ENDED_DEFAULT_MESSAGE;
  }
}

/**
 * The session row's errorMessage as read back after a 401. The API stores a
 * revocation as `revoked:<reason>` (remoteRevocationLease.markRevoked); every
 * other value is already free text and passes through unchanged.
 */
export function serverEndReasonText(raw: string): string {
  const match = /^revoked:([a-z_]+)$/.exec(raw.trim());
  return match ? revocationText(match[1]) : raw;
}

export function sessionEndedCardMessage(reasonText: string): string {
  return `${reasonText} ${RELAUNCH_HINT}`;
}

export type ErrorCardKind = 'error' | 'session_ended';

/**
 * The full-screen error card's title and whether it offers Retry. Retry
 * re-enters the reconnect loop against the same session id; that recovers a
 * transient failure (a refused handshake mints a fresh ticket) but can never
 * revive an ended session, so an ended session gets Close only.
 */
export function errorCardFor(kind: ErrorCardKind): { title: string; showRetry: boolean } {
  return kind === 'session_ended'
    ? { title: 'Session ended', showRetry: false }
    : { title: 'Connection Error', showRetry: true };
}
