import { createHash, randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { Database } from '../db';
import { partnerServicePrincipalKeys, partnerServicePrincipals } from '../db/schema';

export type PartnerServicePrincipalKeyErrorCode =
  | 'not_found'
  | 'disabled'
  | 'expired'
  | 'revoked'
  | 'invalid_expiry'
  | 'conflict';

export class PartnerServicePrincipalKeyError extends Error {
  constructor(
    public readonly code: PartnerServicePrincipalKeyErrorCode,
    message: string,
    public readonly status = code === 'not_found' ? 404 : code === 'conflict' ? 409 : 400,
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

async function assertPrincipalCanIssue(
  tx: Database,
  partnerServicePrincipalId: string,
  partnerId: string,
): Promise<void> {
  const [principal] = await tx
    .select({
      id: partnerServicePrincipals.id,
      status: partnerServicePrincipals.status,
      expiresAt: partnerServicePrincipals.expiresAt,
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
  if (principal.status !== 'active') {
    throw new PartnerServicePrincipalKeyError('disabled', 'Service principal is disabled');
  }
  if (principal.expiresAt && principal.expiresAt.getTime() <= Date.now()) {
    throw new PartnerServicePrincipalKeyError('expired', 'Service principal has expired');
  }
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
    expiresAt?: Date | null;
    rateLimit?: number;
    rotatedFromId?: string;
  },
): Promise<{ keyId: string; rawKey: string; keyPrefix: string }> {
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
    actorId: string;
    expiresAt?: Date | null;
    rateLimit?: number;
  },
): Promise<{ keyId: string; rawKey: string; keyPrefix: string }> {
  validateExpiry(input.expiresAt);
  await assertPrincipalCanIssue(tx, input.partnerServicePrincipalId, input.partnerId);
  return insertKey(tx, input);
}

export async function rotatePartnerServicePrincipalKey(
  tx: Database,
  input: {
    partnerServicePrincipalId: string;
    keyId: string;
    partnerId: string;
    actorId: string;
  },
): Promise<{ keyId: string; rawKey: string; keyPrefix: string }> {
  await assertPrincipalCanIssue(tx, input.partnerServicePrincipalId, input.partnerId);

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
