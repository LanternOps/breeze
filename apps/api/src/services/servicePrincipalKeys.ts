import { createHash, randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { Database } from '../db';
import { servicePrincipalKeys, servicePrincipals } from '../db/schema';

export type ServicePrincipalKeyErrorCode =
  | 'not_found'
  | 'disabled'
  | 'expired'
  | 'revoked'
  | 'invalid_expiry'
  | 'conflict';

export class ServicePrincipalKeyError extends Error {
  constructor(
    public readonly code: ServicePrincipalKeyErrorCode,
    message: string,
    public readonly status = code === 'not_found' ? 404 : code === 'conflict' ? 409 : 400,
  ) {
    super(message);
    this.name = 'ServicePrincipalKeyError';
  }
}

function generateServicePrincipalKey(): {
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
  servicePrincipalId: string,
  partnerId: string,
): Promise<void> {
  const [principal] = await tx
    .select({
      id: servicePrincipals.id,
      status: servicePrincipals.status,
      expiresAt: servicePrincipals.expiresAt,
    })
    .from(servicePrincipals)
    .where(and(
      eq(servicePrincipals.id, servicePrincipalId),
      eq(servicePrincipals.partnerId, partnerId),
    ))
    .limit(1);

  if (!principal) {
    throw new ServicePrincipalKeyError('not_found', 'Service principal not found');
  }
  if (principal.status !== 'active') {
    throw new ServicePrincipalKeyError('disabled', 'Service principal is disabled');
  }
  if (principal.expiresAt && principal.expiresAt.getTime() <= Date.now()) {
    throw new ServicePrincipalKeyError('expired', 'Service principal has expired');
  }
}

function validateExpiry(expiresAt: Date | null | undefined): void {
  if (expiresAt && expiresAt.getTime() <= Date.now()) {
    throw new ServicePrincipalKeyError('invalid_expiry', 'Key expiry must be in the future');
  }
}

async function insertKey(
  tx: Database,
  input: {
    servicePrincipalId: string;
    partnerId: string;
    name: string;
    actorId: string;
    expiresAt?: Date | null;
    rateLimit?: number;
    rotatedFromId?: string;
  },
): Promise<{ keyId: string; rawKey: string; keyPrefix: string }> {
  const generated = generateServicePrincipalKey();
  const [created] = await tx
    .insert(servicePrincipalKeys)
    .values({
      servicePrincipalId: input.servicePrincipalId,
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
    .returning({ id: servicePrincipalKeys.id });

  if (!created) {
    throw new ServicePrincipalKeyError('conflict', 'Failed to issue service principal key');
  }
  return { keyId: created.id, rawKey: generated.rawKey, keyPrefix: generated.keyPrefix };
}

export async function issueServicePrincipalKey(
  tx: Database,
  input: {
    servicePrincipalId: string;
    partnerId: string;
    name: string;
    actorId: string;
    expiresAt?: Date | null;
    rateLimit?: number;
  },
): Promise<{ keyId: string; rawKey: string; keyPrefix: string }> {
  validateExpiry(input.expiresAt);
  await assertPrincipalCanIssue(tx, input.servicePrincipalId, input.partnerId);
  return insertKey(tx, input);
}

export async function rotateServicePrincipalKey(
  tx: Database,
  input: {
    servicePrincipalId: string;
    keyId: string;
    partnerId: string;
    actorId: string;
  },
): Promise<{ keyId: string; rawKey: string; keyPrefix: string }> {
  await assertPrincipalCanIssue(tx, input.servicePrincipalId, input.partnerId);

  const [predecessor] = await tx
    .select({
      id: servicePrincipalKeys.id,
      name: servicePrincipalKeys.name,
      status: servicePrincipalKeys.status,
      expiresAt: servicePrincipalKeys.expiresAt,
      rateLimit: servicePrincipalKeys.rateLimit,
    })
    .from(servicePrincipalKeys)
    .where(and(
      eq(servicePrincipalKeys.id, input.keyId),
      eq(servicePrincipalKeys.servicePrincipalId, input.servicePrincipalId),
      eq(servicePrincipalKeys.partnerId, input.partnerId),
    ))
    .limit(1);

  if (!predecessor) {
    throw new ServicePrincipalKeyError('not_found', 'Service principal key not found');
  }
  if (predecessor.status !== 'active') {
    throw new ServicePrincipalKeyError('revoked', 'Service principal key is already revoked');
  }
  if (predecessor.expiresAt && predecessor.expiresAt.getTime() <= Date.now()) {
    throw new ServicePrincipalKeyError('expired', 'Service principal key has expired');
  }

  const successor = await insertKey(tx, {
    servicePrincipalId: input.servicePrincipalId,
    partnerId: input.partnerId,
    name: predecessor.name,
    actorId: input.actorId,
    expiresAt: predecessor.expiresAt,
    rateLimit: predecessor.rateLimit,
    rotatedFromId: predecessor.id,
  });

  const [revoked] = await tx
    .update(servicePrincipalKeys)
    .set({ status: 'revoked', revokedAt: new Date() })
    .where(and(
      eq(servicePrincipalKeys.id, input.keyId),
      eq(servicePrincipalKeys.servicePrincipalId, input.servicePrincipalId),
      eq(servicePrincipalKeys.partnerId, input.partnerId),
      eq(servicePrincipalKeys.status, 'active'),
    ))
    .returning({ id: servicePrincipalKeys.id });

  if (!revoked) {
    throw new ServicePrincipalKeyError('conflict', 'Service principal key was rotated concurrently');
  }
  return successor;
}
