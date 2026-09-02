export type AuthTransitionLegacyIssuer =
  | 'password'
  | 'cf_access'
  | 'totp'
  | 'sms'
  | 'recovery'
  | 'passkey'
  | 'refresh'
  | 'registration'
  | 'invite'
  | 'cf_access_redirect';

export type AuthTransitionClientClass = 'web' | 'native';

export interface AuthTransitionMetricsRecorder {
  legacyIssuer(
    issuer: AuthTransitionLegacyIssuer,
    clientClass: AuthTransitionClientClass,
  ): void;
}

let recorder: AuthTransitionMetricsRecorder | null = null;

export function setAuthTransitionMetricsRecorder(
  next: AuthTransitionMetricsRecorder | null,
): void {
  recorder = next;
}

export function recordAuthTransitionLegacyIssuer(
  issuer: AuthTransitionLegacyIssuer,
  clientClass: AuthTransitionClientClass,
): void {
  recorder?.legacyIssuer(issuer, clientClass);
}
