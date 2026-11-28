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

/**
 * Whether the approve screen shows the re-auth entry: always for a critical
 * request, and for any request the server answered with MFA_REQUIRED (the
 * authenticator code then stands in for the session's second factor).
 */
export function needsReauthEntry(tier: RiskTier, secondFactorRequested: boolean): boolean {
  return secondFactorRequested || requiresCriticalReauth(tier);
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
    case 'MFA_REQUIRED':
      return 'This request needs a second factor. Enter the code from your authenticator app below and approve again, or sign out and sign in again with your second factor.';
    case 'STEP_UP_REQUIRED':
      return 'Your organization requires a verified approver device for this request. Register this phone as an approver device, then try again.';
    default:
      return undefined;
  }
}

/**
 * Whether a second-factor refusal opens code entry: only when the server takes
 * an authenticator-app code from this account (services/authenticatorCodeUsable).
 * Otherwise every code would be refused and count against the attempt limit.
 */
export function offersCodeEntry(codeUsable: boolean | undefined): boolean {
  return codeUsable === true;
}

/** Copy for a second-factor refusal, by whether this account can use a code. */
export function secondFactorRefusalMessage(codeUsable: boolean | undefined): string {
  if (offersCodeEntry(codeUsable)) return reauthErrorMessage('MFA_REQUIRED')!;
  return 'This request needs a second factor. Sign out and sign in again with your second factor, or set up an authenticator app in your profile and approve again with a code from it.';
}

/**
 * Copy for a request the server asked a second factor for. A password does not
 * count as one, so a refused authenticator code never points at the password.
 */
export function secondFactorErrorMessage(code: string): string | undefined {
  if (code === 'REAUTH_INVALID') {
    return 'That code was not accepted. Each code works once, so wait for the next code from your authenticator app and try again.';
  }
  if (code === 'REAUTH_METHOD_NOT_PERMITTED') {
    return "Your organization doesn't allow authenticator codes for this. Sign out and sign in again with your second factor, then approve.";
  }
  return reauthErrorMessage(code);
}
