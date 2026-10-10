import { createHash, randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { Database } from '../db';
import { partnerServicePrincipalKeys, partnerServicePrincipals, users } from '../db/schema';
import { PARTNER_SERVICE_PRINCIPAL_OWNER_REQUIRED_MESSAGE } from './partnerServicePrincipalDelegation';

export type PartnerServicePrincipalKeyErrorCode =
  | 'not_found'
  | 'disabled'
  | 'expired'
  | 'revoked'
  | 'invalid_expiry'
  | 'conflict'
  | 'not_owner'
  | 'session_stale';

const ERROR_STATUS: Record<PartnerServicePrincipalKeyErrorCode, 400 | 401 | 403 | 404 | 409> = {
  not_found: 404,
  disabled: 400,
  expired: 400,
  revoked: 400,
  invalid_expiry: 400,
  conflict: 409,
  not_owner: 403,
  session_stale: 401,
};

/**
 * The session epochs (`aep` / `mep`) of the access token that asked for a key.
 * Used to read the owner's credential state without ever stamping a value
 * newer than that session.
 */
export interface ActorSessionEpochs {
  authEpoch: number;
  mfaEpoch: number;
}

export class PartnerServicePrincipalKeyError extends Error {
  constructor(
    public readonly code: PartnerServicePrincipalKeyErrorCode,
    message: string,
    public readonly status: 400 | 401 | 403 | 404 | 409 = ERROR_STATUS[code],
  ) {
    super(message);
    this.name = 'PartnerServicePrincipalKeyError';
  }
}

function generatePartnerServicePrincipalKey(): {
  rawKey: string;
  keyHash: string;
  keyPrefix: string;
} {
  const rawKey = `brz_sp_${randomBytes(32).toString('base64url')}`;
  return {
    rawKey,
    keyHash: createHash('sha256').update(rawKey).digest('hex'),
    keyPrefix: rawKey.slice(0, 18),
  };
}

/**
 * Keys are issued only by the principal's owner (`created_by`), for an active,
 * unexpired principal. The owner is the identity whose live partner role
 * bounds the key on the MCP endpoint and whose credential state the key is
 * bound to, so a key minted by anyone else would carry authority they may not
 * hold. Other admins can still revoke keys and disable the principal.
 */
async function assertPrincipalCanIssue(
  tx: Database,
  partnerServicePrincipalId: string,
  partnerId: string,
  actorId: string,
): Promise<void> {
  const [principal] = await tx
    .select({
      id: partnerServicePrincipals.id,
      status: partnerServicePrincipals.status,
      expiresAt: partnerServicePrincipals.expiresAt,
      createdBy: partnerServicePrincipals.createdBy,
    })
    .from(partnerServicePrincipals)
    .where(and(
      eq(partnerServicePrincipals.id, partnerServicePrincipalId),
      eq(partnerServicePrincipals.partnerId, partnerId),
    ))
    .limit(1);

  if (!principal) {
    throw new PartnerServicePrincipalKeyError('not_found', 'Service principal not found');
  }
  if (principal.createdBy !== actorId) {
    throw new PartnerServicePrincipalKeyError('not_owner', PARTNER_SERVICE_PRINCIPAL_OWNER_REQUIRED_MESSAGE);
  }
  if (principal.status !== 'active') {
    throw new PartnerServicePrincipalKeyError('disabled', 'Service principal is disabled');
  }
  if (principal.expiresAt && principal.expiresAt.getTime() <= Date.now()) {
    throw new PartnerServicePrincipalKeyError('expired', 'Service principal has expired');
  }
}

/**
 * The owner's credential and MFA epochs, read from the live users row only
 * while it still matches the issuing session (the same guard POST /api-keys
 * uses). A password change/reset, invite acceptance or admin status change
 * advances credential_epoch and an MFA factor change advances mfa_epoch
 * (services/authLifecycle.ts); each also advances auth_epoch. So a change
 * committed before this read fails the guard, and one committed after it
 * leaves the key with the old value, which the credential loader rejects.
 */
async function readOwnerCredentialEpochs(
  tx: Database,
  actorId: string,
  session: ActorSessionEpochs,
): Promise<{ credentialEpoch: number; mfaEpoch: number }> {
  const [row] = await tx
    .select({ credentialEpoch: users.credentialEpoch, mfaEpoch: users.mfaEpoch })
    .from(users)
    .where(and(
      eq(users.id, actorId),
      eq(users.status, 'active'),
      eq(users.authEpoch, session.authEpoch),
      eq(users.mfaEpoch, session.mfaEpoch),
    ))
    .limit(1);
  if (!row) {
    throw new PartnerServicePrincipalKeyError('session_stale', 'Session is no longer valid. Sign in again.');
  }
  return row;
}

function validateExpiry(expiresAt: Date | null | undefined): void {
  if (expiresAt && expiresAt.getTime() <= Date.now()) {
    throw new PartnerServicePrincipalKeyError('invalid_expiry', 'Key expiry must be in the future');
  }
}

async function insertKey(
  tx: Database,
  input: {
    partnerServicePrincipalId: string;
    partnerId: string;
    name: string;
    actorId: string;
    actorSessionEpochs: ActorSessionEpochs;
    expiresAt?: Date | null;
    rateLimit?: number;
    rotatedFromId?: string;
  },
): Promise<{ keyId: string; rawKey: string; keyPrefix: string }> {
  const ownerEpochs = await readOwnerCredentialEpochs(tx, input.actorId, input.actorSessionEpochs);
  const generated = generatePartnerServicePrincipalKey();
  const [created] = await tx
    .insert(partnerServicePrincipalKeys)
    .values({
      partnerServicePrincipalId: input.partnerServicePrincipalId,
      partnerId: input.partnerId,
      name: input.name,
      keyHash: generated.keyHash,
      keyPrefix: generated.keyPrefix,
      expiresAt: input.expiresAt ?? null,
      rateLimit: input.rateLimit ?? 600,
      rotatedFromId: input.rotatedFromId ?? null,
      createdBy: input.actorId,
      ownerCredentialEpoch: ownerEpochs.credentialEpoch,
      ownerMfaEpoch: ownerEpochs.mfaEpoch,
      status: 'active',
    })
    .returning({ id: partnerServicePrincipalKeys.id });

  if (!created) {
    throw new PartnerServicePrincipalKeyError('conflict', 'Failed to issue service principal key');
  }
  return { keyId: created.id, rawKey: generated.rawKey, keyPrefix: generated.keyPrefix };
}

export async function issuePartnerServicePrincipalKey(
  tx: Database,
  input: {
    partnerServicePrincipalId: string;
    partnerId: string;
    name: string;
    /** Must be the principal's owner. */
    actorId: string;
    actorSessionEpochs: ActorSessionEpochs;
    expiresAt?: Date | null;
    rateLimit?: number;
  },
): Promise<{ keyId: string; rawKey: string; keyPrefix: string }> {
  validateExpiry(input.expiresAt);
  await assertPrincipalCanIssue(tx, input.partnerServicePrincipalId, input.partnerId, input.actorId);
  return insertKey(tx, input);
}

export async function rotatePartnerServicePrincipalKey(
  tx: Database,
  input: {
    partnerServicePrincipalId: string;
    keyId: string;
    partnerId: string;
    /** Must be the principal's owner. */
    actorId: string;
    actorSessionEpochs: ActorSessionEpochs;
  },
): Promise<{ keyId: string; rawKey: string; keyPrefix: string }> {
  await assertPrincipalCanIssue(tx, input.partnerServicePrincipalId, input.partnerId, input.actorId);

  const [predecessor] = await tx
    .select({
      id: partnerServicePrincipalKeys.id,
      name: partnerServicePrincipalKeys.name,
      status: partnerServicePrincipalKeys.status,
      expiresAt: partnerServicePrincipalKeys.expiresAt,
      rateLimit: partnerServicePrincipalKeys.rateLimit,
    })
    .from(partnerServicePrincipalKeys)
    .where(and(
      eq(partnerServicePrincipalKeys.id, input.keyId),
      eq(partnerServicePrincipalKeys.partnerServicePrincipalId, input.partnerServicePrincipalId),
      eq(partnerServicePrincipalKeys.partnerId, input.partnerId),
    ))
    .limit(1);

  if (!predecessor) {
    throw new PartnerServicePrincipalKeyError('not_found', 'Service principal key not found');
  }
  if (predecessor.status !== 'active') {
    throw new PartnerServicePrincipalKeyError('revoked', 'Service principal key is already revoked');
  }
  if (predecessor.expiresAt && predecessor.expiresAt.getTime() <= Date.now()) {
    throw new PartnerServicePrincipalKeyError('expired', 'Service principal key has expired');
  }

  const successor = await insertKey(tx, {
    partnerServicePrincipalId: input.partnerServicePrincipalId,
    partnerId: input.partnerId,
    name: predecessor.name,
    actorId: input.actorId,
    actorSessionEpochs: input.actorSessionEpochs,
    expiresAt: predecessor.expiresAt,
    rateLimit: predecessor.rateLimit,
    rotatedFromId: predecessor.id,
  });

  const [revoked] = await tx
    .update(partnerServicePrincipalKeys)
    .set({ status: 'revoked', revokedAt: new Date() })
    .where(and(
      eq(partnerServicePrincipalKeys.id, input.keyId),
      eq(partnerServicePrincipalKeys.partnerServicePrincipalId, input.partnerServicePrincipalId),
      eq(partnerServicePrincipalKeys.partnerId, input.partnerId),
      eq(partnerServicePrincipalKeys.status, 'active'),
    ))
    .returning({ id: partnerServicePrincipalKeys.id });

  if (!revoked) {
    throw new PartnerServicePrincipalKeyError('conflict', 'Service principal key was rotated concurrently');
  }
  return successor;
}
