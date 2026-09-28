import type { ReauthFactor, RiskTier } from '../../services/approvals';

/**
 * #4052: a critical-tier (L4) approval needs fresh account re-authentication
 * (password, or the login authenticator-app code for a passwordless SSO
 * account) on top of the hardware-key step-up. The server rule is unchanged;
 * this is the client half that collects what it already requires.
 */
export type ReauthMode = ReauthFactor['kind'];

export function requiresCriticalReauth(tier: RiskTier): boolean {
  return tier === 'critical';
}

/** The factor to send, or undefined when nothing usable was entered. */
export function buildReauthFactor(mode: ReauthMode, raw: string): ReauthFactor | undefined {
  const value = raw.trim();
  return value ? { kind: mode, value } : undefined;
}

/** Approver-facing copy for the re-auth decision errors from services/approvals. */
export function reauthErrorMessage(code: string): string | undefined {
  switch (code) {
    case 'REAUTH_REQUIRED':
      return 'Critical request. Enter your password or authenticator code, then approve again.';
    case 'REAUTH_INVALID':
      return 'That password or code was not accepted. Check it and try again.';
    case 'REAUTH_THROTTLED':
      return 'Too many attempts. Wait a few minutes and try again.';
    case 'REAUTH_UNAVAILABLE':
      return 'Re-authentication is temporarily unavailable. Try again in a moment.';
    case 'REAUTH_METHOD_NOT_PERMITTED':
      return "Your organization doesn't allow authenticator codes for this. Use your password instead.";
    case 'STEP_UP_REQUIRED':
      return 'Your organization requires a verified approver device for this request. Register this phone as an approver device, then try again.';
    default:
      return undefined;
  }
}
