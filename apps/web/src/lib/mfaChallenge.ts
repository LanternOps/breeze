export type MfaMethod = 'totp' | 'sms' | 'passkey' | 'recovery';
export type MfaPrimaryMethod = Exclude<MfaMethod, 'recovery'>;

export interface MfaAllowedMethods {
  totp: boolean;
  sms: boolean;
  passkey: boolean;
}

export interface MfaChallenge {
  tempToken: string;
  primary: MfaMethod;
  methods: MfaMethod[];
  allowedMethods: MfaAllowedMethods;
  recoveryAvailable: boolean;
  phoneLast4: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPrimaryMethod(value: unknown): value is MfaPrimaryMethod {
  return value === 'totp' || value === 'sms' || value === 'passkey';
}

function parsePhoneLast4(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  return typeof value === 'string' ? value : undefined;
}

export function parseMfaChallengeResponse(value: unknown): MfaChallenge | null {
  if (!isRecord(value) || value.mfaRequired !== true || typeof value.tempToken !== 'string' || !value.tempToken) {
    return null;
  }
  if (!isPrimaryMethod(value.mfaMethod)) return null;
  const phoneLast4 = parsePhoneLast4(value.phoneLast4);
  if (phoneLast4 === undefined) return null;

  const hasAllowedMethods = Object.prototype.hasOwnProperty.call(value, 'allowedMethods');
  const hasRecoveryAvailable = Object.prototype.hasOwnProperty.call(value, 'recoveryAvailable');
  if (hasAllowedMethods !== hasRecoveryAvailable) return null;

  if (!hasAllowedMethods) {
    if (value.passkeyAvailable !== undefined && typeof value.passkeyAvailable !== 'boolean') return null;
    const allowedMethods: MfaAllowedMethods = {
      totp: value.mfaMethod === 'totp',
      sms: value.mfaMethod === 'sms',
      passkey: value.mfaMethod === 'passkey' || value.passkeyAvailable === true,
    };
    const methods: MfaMethod[] = [
      ...(allowedMethods.totp ? ['totp' as const] : []),
      ...(allowedMethods.sms ? ['sms' as const] : []),
      ...(allowedMethods.passkey ? ['passkey' as const] : []),
    ];
    return {
      tempToken: value.tempToken,
      primary: value.mfaMethod,
      methods,
      allowedMethods,
      recoveryAvailable: false,
      phoneLast4,
    };
  }

  const allowed = value.allowedMethods;
  if (
    !isRecord(allowed)
    || typeof allowed.totp !== 'boolean'
    || typeof allowed.sms !== 'boolean'
    || typeof allowed.passkey !== 'boolean'
    || typeof value.recoveryAvailable !== 'boolean'
    || typeof value.passkeyAvailable !== 'boolean'
    || value.passkeyAvailable !== allowed.passkey
  ) {
    return null;
  }

  const allowedMethods: MfaAllowedMethods = {
    totp: allowed.totp,
    sms: allowed.sms,
    passkey: allowed.passkey,
  };
  const methods: MfaMethod[] = [
    ...(allowedMethods.totp ? ['totp' as const] : []),
    ...(allowedMethods.sms ? ['sms' as const] : []),
    ...(allowedMethods.passkey ? ['passkey' as const] : []),
    ...(value.recoveryAvailable ? ['recovery' as const] : []),
  ];
  if (methods.length === 0) return null;

  const primary = allowedMethods[value.mfaMethod]
    ? value.mfaMethod
    : methods[0];
  if (!primary) return null;

  return {
    tempToken: value.tempToken,
    primary,
    methods,
    allowedMethods,
    recoveryAvailable: value.recoveryAvailable,
    phoneLast4,
  };
}
