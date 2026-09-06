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
