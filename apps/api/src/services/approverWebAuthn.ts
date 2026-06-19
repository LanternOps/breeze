import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type GenerateAuthenticationOptionsOpts,
  type GenerateRegistrationOptionsOpts,
  type VerifiedAuthenticationResponse,
  type VerifyAuthenticationResponseOpts,
  type VerifyRegistrationResponseOpts
} from '@simplewebauthn/server';
import {
  PasskeyChallengeError,
  passkeyToWebAuthnCredential,
  registrationInfoToPasskeyFields,
  resolveWebAuthnConfig,
  type PasskeyRegistrationStoreFields,
  type PasskeyTransport,
  type StoredPasskeyCredential
} from './passkeys';
import { getRedis } from './redis';

// spec §6.5 — the approval decision window is intentionally short, so an
// assertion challenge that is not consumed quickly must expire on its own.
const ASSERTION_TTL_SECONDS = 120;
const REG_TTL_SECONDS = 5 * 60;

const regKey = (userId: string): string => `approver-reg:${userId}`;
const assertionKey = (approvalId: string, userId: string): string =>
  `approval-assertion:${approvalId}:${userId}`;

export type ApproverDevice = {
  credentialId: string;
  transports?: PasskeyTransport[] | string[] | null;
};

export type ApproverRegistrationStoreFields = PasskeyRegistrationStoreFields & {
  // spec §6.1 / §12 — only a non-syncable, single-device platform credential
  // is L4-eligible. A synced/multi-device credential can roam to other
  // machines, so it cannot prove possession of a specific device.
  isPlatformBound: boolean;
};

// The assertion challenge value carries the epoch-ms it was ISSUED (`<ms>:<chal>`)
// so the L3/L4 recency gate has an exact server-side age. Registration
// challenges keep the bare value (no recency gate on registration).
function encodeChallenge(challenge: string, issuedAt: number): string {
  return `${issuedAt}:${challenge}`;
}
function decodeChallenge(stored: string): { challenge: string; issuedAt: number } {
  const sep = stored.indexOf(':');
  // Legacy/raw value (no issued-at prefix): treat as issued "now" — it was alive
  // in Redis so it is within TTL; this keeps pre-change challenges verifiable.
  if (sep === -1) return { challenge: stored, issuedAt: Date.now() };
  const issuedAt = Number(stored.slice(0, sep));
  return {
    challenge: stored.slice(sep + 1),
    issuedAt: Number.isFinite(issuedAt) ? issuedAt : Date.now(),
  };
}

async function storeChallenge(key: string, challenge: string, ttlSeconds: number): Promise<void> {
  const redis = getRedis();
  if (!redis) {
    throw new PasskeyChallengeError('Redis unavailable while storing approver challenge');
  }
  await redis.setex(key, ttlSeconds, challenge);
}

async function storeAssertionChallenge(key: string, challenge: string, ttlSeconds: number): Promise<void> {
  const redis = getRedis();
  if (!redis) {
    throw new PasskeyChallengeError('Redis unavailable while storing approver challenge');
  }
  await redis.setex(key, ttlSeconds, encodeChallenge(challenge, Date.now()));
}

async function consumeChallenge(key: string): Promise<string | null> {
  const redis = getRedis();
  if (!redis) {
    throw new PasskeyChallengeError('Redis unavailable while reading approver challenge');
  }
  // Atomic read-and-delete (mirrors services/passkeys.ts): a single-use
  // challenge prevents replay and a TOCTOU race between concurrent verifies.
  return redis.getdel(key);
}

async function consumeAssertionChallenge(
  key: string,
): Promise<{ challenge: string; issuedAt: number } | null> {
  const stored = await consumeChallenge(key);
  return stored == null ? null : decodeChallenge(stored);
}

export async function generateApproverRegistrationOptions(input: {
  user: { id: string; name: string; displayName: string };
  existing?: ApproverDevice[];
}): Promise<Awaited<ReturnType<typeof generateRegistrationOptions>>> {
  const cfg = resolveWebAuthnConfig();
  const options = await generateRegistrationOptions({
    rpName: cfg.rpName,
    rpID: cfg.rpID,
    userID: Buffer.from(input.user.id),
    userName: input.user.name,
    userDisplayName: input.user.displayName,
    attestationType: 'none',
    excludeCredentials: (input.existing ?? []).map((c) => ({
      id: c.credentialId,
      transports: (c.transports ?? undefined) as PasskeyTransport[] | undefined
    })),
    authenticatorSelection: {
      // spec §7.2 — Windows Hello / Touch ID, device-bound.
      authenticatorAttachment: 'platform',
      residentKey: 'preferred',
      userVerification: 'required'
    }
  } satisfies GenerateRegistrationOptionsOpts);

  await storeChallenge(regKey(input.user.id), options.challenge, REG_TTL_SECONDS);
  return options;
}

export async function verifyApproverRegistration(input: {
  userId: string;
  response: VerifyRegistrationResponseOpts['response'];
}): Promise<ApproverRegistrationStoreFields> {
  const cfg = resolveWebAuthnConfig();
  const expectedChallenge = await consumeChallenge(regKey(input.userId));
  if (!expectedChallenge) {
    throw new Error('approver registration challenge expired');
  }

  const verification = await verifyRegistrationResponse({
    response: input.response,
    expectedChallenge,
    expectedOrigin: cfg.origin,
    expectedRPID: cfg.rpID,
    requireUserVerification: true
  });

  if (!verification.verified || !verification.registrationInfo) {
    throw new Error('approver registration not verified');
  }

  const fields = registrationInfoToPasskeyFields(verification, input.response);
  const isPlatformBound = fields.deviceType === 'singleDevice' && !fields.backedUp;
  return { ...fields, isPlatformBound };
}

export async function generateApprovalAssertionOptions(input: {
  approvalId: string;
  userId: string;
  devices: ApproverDevice[];
}): Promise<Awaited<ReturnType<typeof generateAuthenticationOptions>>> {
  const cfg = resolveWebAuthnConfig();
  const allowCredentials = input.devices.map((d) => ({
    id: d.credentialId,
    transports: (d.transports ?? undefined) as PasskeyTransport[] | undefined
  }));

  const options = await generateAuthenticationOptions({
    rpID: cfg.rpID,
    userVerification: 'required',
    allowCredentials: allowCredentials.length > 0 ? allowCredentials : undefined
  } satisfies GenerateAuthenticationOptionsOpts);

  await storeAssertionChallenge(assertionKey(input.approvalId, input.userId), options.challenge, ASSERTION_TTL_SECONDS);
  return options;
}

export async function verifyApprovalAssertion(input: {
  approvalId: string;
  userId: string;
  response: VerifyAuthenticationResponseOpts['response'];
  device: StoredPasskeyCredential;
}): Promise<{ verified: boolean; newSignCount: number; challengeIssuedAt: number }> {
  const cfg = resolveWebAuthnConfig();
  const consumed = await consumeAssertionChallenge(assertionKey(input.approvalId, input.userId));
  if (!consumed) {
    throw new Error('approval assertion challenge expired or already used');
  }

  const verification: VerifiedAuthenticationResponse = await verifyAuthenticationResponse({
    response: input.response,
    expectedChallenge: consumed.challenge,
    expectedOrigin: cfg.origin,
    expectedRPID: cfg.rpID,
    credential: passkeyToWebAuthnCredential(input.device),
    requireUserVerification: true,
    advancedFIDOConfig: {
      userVerification: 'required'
    }
  });

  // @simplewebauthn enforces the signCount anti-clone check internally
  // (rejects newCounter <= oldCounter for non-zero counters).
  return {
    verified: verification.verified,
    newSignCount: verification.authenticationInfo.newCounter,
    // Epoch-ms the assertion challenge was issued — the L3/L4 recency clock.
    challengeIssuedAt: consumed.issuedAt
  };
}
