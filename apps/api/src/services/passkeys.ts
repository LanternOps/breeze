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

export type PasskeyPurpose = 'registration' | 'authentication';
/**
 * WebAuthn `AuthenticatorTransport` values, widened to `string`. `@simplewebauthn/server`
 * 14 already types every relevant input/output surface as plain `string[]`, not the
 * old 7-value literal union: `generateRegistrationOptions`'s
 * `excludeCredentials[].transports`, `generateAuthenticationOptions`'s
 * `allowCredentials[].transports`, and `verifyRegistrationResponse`'s input
 * `response.response.transports` (`AuthenticatorAttestationResponseJSON.transports` —
 * the authentication/assertion counterpart, `AuthenticatorAssertionResponseJSON`, has
 * no `transports` field at all in 14.0.2). Narrowing here bought nothing but data
 * loss. The spec (WebAuthn §5.8.3) asks relying parties to round-trip transport
 * values they don't recognize rather than discard them, and this jsonb-backed column
 * (`db/schema/userPasskeys.ts`) has no reason to reject one.
 */
export type PasskeyTransport = string;
export type PasskeyDeviceType = 'singleDevice' | 'multiDevice';

/**
 * Pass transports through unchanged — no allowlist filtering (see `PasskeyTransport`
 * above). `undefined` (no transports reported) becomes `null` to match the stored
 * field's `PasskeyTransport[] | null` type; an explicit `[]` stays `[]`, it is not
 * normalized to `null`.
 */
function toPasskeyTransports(transports: string[] | undefined): PasskeyTransport[] | null {
  return transports ?? null;
}

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
  purpose: PasskeyPurpose;
  userId: string;
  challenge: string;
  createdAt: string;
  authEpoch?: number;
  mfaEpoch?: number;
};

type RegistrationEpochs = { authEpoch: number; mfaEpoch: number };

export class PasskeyChallengeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PasskeyChallengeError';
  }
}

/**
 * #6499: `@simplewebauthn/server` REJECTS (rather than returning
 * `verified: false`) when the attestation/assertion fails a structural check —
 * origin mismatch, RP ID mismatch, challenge mismatch, bad signature. Its
 * messages embed the RELYING PARTY's configured expectations verbatim, e.g.
 * `Unexpected registration response origin "http://x", expected "http://y"`.
 * Those escaped the passkey routes as a 500 whose body handed the caller the
 * server's `WEBAUTHN_ORIGIN` / `WEBAUTHN_RP_ID`.
 *
 * Every such rejection is normalized here into this error: a fixed, generic
 * `message` safe to return to a client, with the library's text kept on
 * `detail` (and the original on `cause`) for server-side logging only. Routes
 * map it onto their existing rejected-proof response — it is a rejected proof,
 * not an infrastructure failure, so it must never be a 5xx.
 *
 * NOTE: this deliberately does NOT weaken verification. The wrap happens
 * strictly around the verify call, after the single-use challenge has already
 * been consumed, and a wrapped rejection is still a rejection.
 */
export class PasskeyVerificationError extends Error {
  /** The library's own message. Server-side logging ONLY — never returned to a client. */
  readonly detail: string;
  readonly purpose: PasskeyPurpose;

  constructor(purpose: PasskeyPurpose, cause: unknown) {
    super('Passkey verification failed');
    this.name = 'PasskeyVerificationError';
    this.purpose = purpose;
    this.cause = cause;
    this.detail = cause instanceof Error ? cause.message : String(cause);
  }
}

/**
 * Run a `@simplewebauthn` verify call, converting any rejection into a
 * {@link PasskeyVerificationError} and logging the library detail server-side.
 */
async function runVerification<T>(purpose: PasskeyPurpose, verify: () => Promise<T>): Promise<T> {
  try {
    return await verify();
  } catch (err) {
    const wrapped = new PasskeyVerificationError(purpose, err);
    // Log the ORIGINAL error object, not just its message: an expected
    // mismatch is self-describing, but an unexpected throw (a decode failure
    // on a corrupt stored credential, a library bug) is often uninformative
    // without its stack — and self-hosted instances have no Sentry DSN, so
    // stdout is the only place that detail can land.
    console.warn('[passkeys] %s verification rejected:', purpose, err);
    throw wrapped;
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
  epochs: RegistrationEpochs;
  existingPasskeys?: StoredPasskeyCredential[];
  timeout?: number;
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

  await storePasskeyChallenge('registration', input.user.id, options.challenge, input.epochs);
  return options;
}

export async function verifyPasskeyRegistration(input: {
  userId: string;
  epochs: RegistrationEpochs;
  response: VerifyRegistrationResponseOpts['response'];
}): Promise<Awaited<ReturnType<typeof verifyRegistrationResponse>>> {
  const config = resolveWebAuthnConfig();
  const challenge = await consumePasskeyChallenge('registration', input.userId, input.epochs);

  return runVerification('registration', () => verifyRegistrationResponse({
    response: input.response,
    expectedChallenge: challenge,
    expectedOrigin: config.origin,
    expectedRPID: config.rpID,
    requireUserVerification: true
  }));
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
    transports: toPasskeyTransports(response?.response.transports),
    aaguid: info.aaguid || null
  };
}

export async function generatePasskeyAuthenticationOptions(input: {
  userId: string;
  passkeys?: StoredPasskeyCredential[];
  timeout?: number;
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

  await storePasskeyChallenge('authentication', input.userId, options.challenge);
  return options;
}

export async function verifyPasskeyAuthentication(input: {
  userId: string;
  response: VerifyAuthenticationResponseOpts['response'];
  passkey: StoredPasskeyCredential;
}): Promise<Awaited<ReturnType<typeof verifyAuthenticationResponse>>> {
  const config = resolveWebAuthnConfig();
  const challenge = await consumePasskeyChallenge('authentication', input.userId);

  return runVerification('authentication', () => verifyAuthenticationResponse({
    response: input.response,
    expectedChallenge: challenge,
    expectedOrigin: config.origin,
    expectedRPID: config.rpID,
    credential: passkeyToWebAuthnCredential(input.passkey),
    requireUserVerification: true,
    advancedFIDOConfig: {
      userVerification: 'required'
    }
  }));
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
  epochs?: RegistrationEpochs,
): Promise<void> {
  const redis = getRedis();
  if (!redis) {
    throw new PasskeyChallengeError('Redis unavailable while storing passkey challenge');
  }

  const record: ChallengeRecord = {
    purpose,
    userId,
    challenge,
    createdAt: new Date().toISOString(),
    ...epochs,
  };

  await redis.setex(passkeyChallengeKey(purpose, userId), CHALLENGE_TTL_SECONDS, JSON.stringify(record));
}

async function consumePasskeyChallenge(purpose: PasskeyPurpose, userId: string, epochs?: RegistrationEpochs): Promise<string> {
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
    if (record.purpose !== purpose || record.userId !== userId || typeof record.challenge !== 'string') {
      throw new Error('mismatched challenge record');
    }
    // Registration carries password proof from /options. A reset invalidates
    // that proof even when Redis cleanup fails or a delayed writer restores it.
    if (purpose === 'registration' && (!epochs
      || !Number.isSafeInteger(record.authEpoch) || !Number.isSafeInteger(record.mfaEpoch)
      || record.authEpoch !== epochs.authEpoch || record.mfaEpoch !== epochs.mfaEpoch)) {
      throw new Error('registration challenge expired after an authentication change');
    }
    return record.challenge;
  } catch (err) {
    throw new PasskeyChallengeError(
      `Invalid passkey challenge record: ${err instanceof Error ? err.message : String(err)}`
    );
  }
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
