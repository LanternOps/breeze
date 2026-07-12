import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type GenerateAuthenticationOptionsOpts,
  type GenerateRegistrationOptionsOpts,
  type VerifyAuthenticationResponseOpts,
  type VerifyRegistrationResponseOpts
} from '@simplewebauthn/server';
import { getRedis } from './redis';

const DEFAULT_RP_NAME = 'Breeze RMM';
const DEFAULT_DEV_ORIGIN = 'http://localhost:4321';
const CHALLENGE_TTL_SECONDS = 5 * 60;

export type PasskeyPurpose = 'registration' | 'authentication' | 'step-up-authentication';
export type PasskeyStepUpPurpose = 'passkey.register' | 'totp.replace' | 'sms.replace' | 'email.change';
export type PasskeyRegistrationAuthorization =
  | { kind: 'initial-password' }
  | { kind: 'mfa-step-up'; purpose: PasskeyStepUpPurpose; grantHash: string };
type PasskeyChallengeBinding =
  | PasskeyRegistrationAuthorization
  | { kind: 'step-up-proof'; stepUpPurpose: PasskeyStepUpPurpose };
export type PasskeyTransport = 'ble' | 'cable' | 'hybrid' | 'internal' | 'nfc' | 'smart-card' | 'usb';
export type PasskeyDeviceType = 'singleDevice' | 'multiDevice';

export type WebAuthnConfig = {
  rpID: string;
  rpName: string;
  origin: string;
};

export type PasskeyUser = {
  id: string;
  email: string;
  name?: string | null;
};

export type StoredPasskeyCredential = {
  credentialId: string;
  publicKey: string;
  counter: number;
  transports?: PasskeyTransport[] | null;
};

export type PasskeyRegistrationStoreFields = {
  credentialId: string;
  publicKey: string;
  counter: number;
  deviceType: PasskeyDeviceType;
  backedUp: boolean;
  transports: PasskeyTransport[] | null;
  aaguid: string | null;
};

export type PasskeyAuthenticationUpdateFields = {
  counter: number;
  deviceType: PasskeyDeviceType;
  backedUp: boolean;
  lastUsedAt: Date;
};

type ChallengeRecord = {
  version: 1;
  purpose: PasskeyPurpose;
  userId: string;
  challenge: string;
  createdAt: string;
  binding: PasskeyChallengeBinding | null;
};

export class PasskeyChallengeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PasskeyChallengeError';
  }
}

export function resolveWebAuthnConfig(): WebAuthnConfig {
  const origin = trimTrailingSlash(
    envString('WEBAUTHN_ORIGIN')
      || envString('PUBLIC_APP_URL')
      || envString('DASHBOARD_URL')
      || DEFAULT_DEV_ORIGIN
  );

  return {
    rpID: envString('WEBAUTHN_RP_ID') || new URL(origin).hostname,
    rpName: envString('WEBAUTHN_RP_NAME') || DEFAULT_RP_NAME,
    origin
  };
}

export async function generatePasskeyRegistrationOptions(input: {
  user: PasskeyUser;
  existingPasskeys?: StoredPasskeyCredential[];
  timeout?: number;
  authorization: PasskeyRegistrationAuthorization;
}): Promise<Awaited<ReturnType<typeof generateRegistrationOptions>>> {
  const config = resolveWebAuthnConfig();
  const options = await generateRegistrationOptions({
    rpName: config.rpName,
    rpID: config.rpID,
    userID: Buffer.from(input.user.id),
    userName: input.user.email,
    userDisplayName: input.user.name || input.user.email,
    timeout: input.timeout,
    attestationType: 'none',
    excludeCredentials: (input.existingPasskeys ?? []).map((passkey) => ({
      id: passkey.credentialId,
      transports: passkey.transports ?? undefined
    })),
    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: 'required'
    }
  } satisfies GenerateRegistrationOptionsOpts);

  await storePasskeyChallenge(
    'registration',
    input.user.id,
    options.challenge,
    input.authorization,
  );
  return options;
}

export async function verifyPasskeyRegistration(input: {
  userId: string;
  response: VerifyRegistrationResponseOpts['response'];
  authorization: PasskeyRegistrationAuthorization;
}): Promise<Awaited<ReturnType<typeof verifyRegistrationResponse>>> {
  const config = resolveWebAuthnConfig();
  const challenge = await consumePasskeyChallenge(
    'registration',
    input.userId,
    input.authorization,
  );

  return verifyRegistrationResponse({
    response: input.response,
    expectedChallenge: challenge,
    expectedOrigin: config.origin,
    expectedRPID: config.rpID,
    requireUserVerification: true
  });
}

export function registrationInfoToPasskeyFields(
  verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>,
  response?: VerifyRegistrationResponseOpts['response']
): PasskeyRegistrationStoreFields {
  if (!verification.verified) {
    throw new Error('Cannot build passkey fields from an unverified registration response');
  }

  const info = verification.registrationInfo;

  return {
    credentialId: info.credential.id,
    publicKey: encodeBase64Url(info.credential.publicKey),
    counter: info.credential.counter,
    deviceType: info.credentialDeviceType,
    backedUp: info.credentialBackedUp,
    transports: response?.response.transports ?? null,
    aaguid: info.aaguid || null
  };
}

export async function generatePasskeyAuthenticationOptions(input: {
  userId: string;
  passkeys?: StoredPasskeyCredential[];
  timeout?: number;
  challengePurpose?: 'authentication' | 'step-up-authentication';
  stepUpPurpose?: PasskeyStepUpPurpose;
}): Promise<Awaited<ReturnType<typeof generateAuthenticationOptions>>> {
  const config = resolveWebAuthnConfig();
  const allowCredentials = input.passkeys?.map((passkey) => ({
    id: passkey.credentialId,
    transports: passkey.transports ?? undefined
  }));

  const options = await generateAuthenticationOptions({
    rpID: config.rpID,
    timeout: input.timeout,
    userVerification: 'required',
    allowCredentials: allowCredentials && allowCredentials.length > 0 ? allowCredentials : undefined
  } satisfies GenerateAuthenticationOptionsOpts);

  const purpose = input.challengePurpose ?? 'authentication';
  const binding = challengeBindingForAuthentication(purpose, input.stepUpPurpose);
  await storePasskeyChallenge(purpose, input.userId, options.challenge, binding);
  return options;
}

export async function verifyPasskeyAuthentication(input: {
  userId: string;
  response: VerifyAuthenticationResponseOpts['response'];
  passkey: StoredPasskeyCredential;
  challengePurpose?: 'authentication' | 'step-up-authentication';
  stepUpPurpose?: PasskeyStepUpPurpose;
}): Promise<Awaited<ReturnType<typeof verifyAuthenticationResponse>>> {
  const config = resolveWebAuthnConfig();
  const purpose = input.challengePurpose ?? 'authentication';
  const challenge = await consumePasskeyChallenge(
    purpose,
    input.userId,
    challengeBindingForAuthentication(purpose, input.stepUpPurpose),
  );

  return verifyAuthenticationResponse({
    response: input.response,
    expectedChallenge: challenge,
    expectedOrigin: config.origin,
    expectedRPID: config.rpID,
    credential: passkeyToWebAuthnCredential(input.passkey),
    requireUserVerification: true,
    advancedFIDOConfig: {
      userVerification: 'required'
    }
  });
}

export function authenticationInfoToPasskeyUpdateFields(
  verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>
): PasskeyAuthenticationUpdateFields {
  if (!verification.verified) {
    throw new Error('Cannot build passkey update fields from an unverified authentication response');
  }

  return {
    counter: verification.authenticationInfo.newCounter,
    deviceType: verification.authenticationInfo.credentialDeviceType,
    backedUp: verification.authenticationInfo.credentialBackedUp,
    lastUsedAt: new Date()
  };
}

export function passkeyToWebAuthnCredential(
  passkey: StoredPasskeyCredential
): VerifyAuthenticationResponseOpts['credential'] {
  return {
    id: passkey.credentialId,
    publicKey: decodeBase64Url(passkey.publicKey),
    counter: passkey.counter,
    transports: passkey.transports ?? undefined
  };
}

async function storePasskeyChallenge(
  purpose: PasskeyPurpose,
  userId: string,
  challenge: string,
  binding: PasskeyChallengeBinding | null,
): Promise<void> {
  const redis = getRedis();
  if (!redis) {
    throw new PasskeyChallengeError('Redis unavailable while storing passkey challenge');
  }

  const record: ChallengeRecord = {
    version: 1,
    purpose,
    userId,
    challenge,
    createdAt: new Date().toISOString(),
    binding,
  };

  await redis.setex(passkeyChallengeKey(purpose, userId), CHALLENGE_TTL_SECONDS, JSON.stringify(record));
}

async function consumePasskeyChallenge(
  purpose: PasskeyPurpose,
  userId: string,
  expectedBinding: PasskeyChallengeBinding | null,
): Promise<string> {
  const redis = getRedis();
  if (!redis) {
    throw new PasskeyChallengeError('Redis unavailable while reading passkey challenge');
  }

  const key = passkeyChallengeKey(purpose, userId);
  // Atomic read-and-delete: prevents a TOCTOU race where two concurrent
  // verifies could both read the same challenge before either deletes it.
  const raw = await redis.getdel(key);

  if (!raw) {
    throw new PasskeyChallengeError('Passkey challenge is missing or expired');
  }

  try {
    const record = JSON.parse(raw) as ChallengeRecord;
    if (record.version !== 1
      || record.purpose !== purpose
      || record.userId !== userId
      || typeof record.challenge !== 'string'
      || record.challenge.length === 0
      || JSON.stringify(record.binding) !== JSON.stringify(expectedBinding)) {
      throw new Error('mismatched challenge record');
    }
    return record.challenge;
  } catch (err) {
    throw new PasskeyChallengeError(
      `Invalid passkey challenge record: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

function challengeBindingForAuthentication(
  purpose: 'authentication' | 'step-up-authentication',
  stepUpPurpose: PasskeyStepUpPurpose | undefined,
): PasskeyChallengeBinding | null {
  if (purpose === 'authentication') {
    if (stepUpPurpose !== undefined) {
      throw new PasskeyChallengeError('Authentication challenge cannot carry a step-up purpose');
    }
    return null;
  }
  if (!stepUpPurpose) {
    throw new PasskeyChallengeError('Step-up authentication requires a purpose');
  }
  return { kind: 'step-up-proof', stepUpPurpose };
}

function passkeyChallengeKey(purpose: PasskeyPurpose, userId: string): string {
  return `passkey:challenge:${purpose}:${userId}`;
}

function encodeBase64Url(value: Uint8Array): string {
  return Buffer.from(value).toString('base64url');
}

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const bytes = Buffer.from(value, 'base64url');
  const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  copy.set(bytes);
  return copy;
}

function envString(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}
