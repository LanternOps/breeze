import type { MfaChallenge, MfaMethod } from '../../services/api';

export type NativeMfaMethod = Exclude<MfaMethod, 'passkey'>;

export function getSupportedNativeMfaMethods(
  challenge: MfaChallenge | null | undefined,
): NativeMfaMethod[] {
  return (challenge?.methods ?? []).filter(
    (method): method is NativeMfaMethod => method !== 'passkey',
  );
}

export function getInitialNativeMfaMethod(
  challenge: MfaChallenge,
  supported = getSupportedNativeMfaMethods(challenge),
): NativeMfaMethod | null {
  return challenge.mfaMethod !== 'passkey'
    ? challenge.mfaMethod
    : supported[0] ?? null;
}

export function normalizeNativeMfaInput(method: NativeMfaMethod, value: string): string {
  return method === 'recovery' ? value : value.replace(/\D/g, '').slice(0, 6);
}

export function normalizeNativeMfaSubmission(method: NativeMfaMethod, value: string): string {
  return method === 'recovery' ? value.trim() : value;
}

/**
 * Whether a full authenticator code should trigger an automatic submit.
 *
 * Authenticator (`totp`) only — SMS is left as a manual tap (the code just
 * arrived and a stray 6th digit typo is easy) and recovery codes are
 * variable-length so "6 digits" isn't even a valid completion signal for
 * them. `alreadyAutoSubmitted` is the debounce: a paste or platform autofill
 * can deliver all 6 digits in one `onChangeText` call, and without it every
 * character of a SLOWER manual paste that still lands as one change event
 * would otherwise be indistinguishable from a second complete code — the
 * caller sets it once a submit has fired for the current code and clears it
 * when the code changes.
 */
export function shouldAutoSubmitMfa(input: {
  method: NativeMfaMethod;
  codeLength: number;
  alreadyAutoSubmitted: boolean;
}): boolean {
  return input.method === 'totp' && input.codeLength === 6 && !input.alreadyAutoSubmitted;
}
