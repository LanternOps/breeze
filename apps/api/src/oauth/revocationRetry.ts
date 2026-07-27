import { eq, isNull, sql } from 'drizzle-orm';
import { db } from '../db';
import { oauthRevocationRetries } from '../db/schema';
import { revokeGrant, revokeJti } from './revocationCache';

export type DbTransaction = Pick<
  typeof db,
  'delete' | 'execute' | 'insert' | 'select' | 'update'
>;

export type OAuthRevocationMarkerType = 'grant' | 'jti';

export type OAuthRevocationMarkerInput = {
  userId: string;
  markerType: OAuthRevocationMarkerType;
  markerId: string;
  expiresAt: Date;
};

export type OAuthRevocationMarkerResult =
  | { status: 'written' }
  | {
      status: 'retry_queued';
      errorCode: 'redis_unavailable' | 'redis_write_failed';
    };

function markerErrorCode(error: unknown): 'redis_unavailable' | 'redis_write_failed' {
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  return message.includes('unavailable') || message.includes('redis is required')
    ? 'redis_unavailable'
    : 'redis_write_failed';
}

function remainingLifetimeSeconds(expiresAt: Date, now: Date): number {
  return Math.max(Math.ceil((expiresAt.getTime() - now.getTime()) / 1000), 1);
}

/**
 * Write one Redis defense-in-depth revocation marker. Redis failure is
 * converted into durable user-owned work in the caller's transaction. The
 * caller must let that transaction commit before translating retry_queued
 * into its public fail-closed response.
 */
export async function writeOAuthRevocationMarkerDurably(
  tx: DbTransaction,
  input: OAuthRevocationMarkerInput,
): Promise<OAuthRevocationMarkerResult> {
  const attemptedAt = new Date();
  const ttl = remainingLifetimeSeconds(input.expiresAt, attemptedAt);

  try {
    if (input.markerType === 'grant') {
      await revokeGrant(input.markerId, ttl);
    } else {
      await revokeJti(input.markerId, ttl);
    }
    return { status: 'written' };
  } catch (error) {
    const errorCode = markerErrorCode(error);
    const [queued] = await tx
      .insert(oauthRevocationRetries)
      .values({
        userId: input.userId,
        markerType: input.markerType,
        markerId: input.markerId,
        expiresAt: input.expiresAt,
        attempts: 1,
        nextAttemptAt: new Date(attemptedAt.getTime() + 1_000),
        lastErrorCode: errorCode,
        updatedAt: attemptedAt,
      })
      .onConflictDoUpdate({
        target: [
          oauthRevocationRetries.markerType,
          oauthRevocationRetries.markerId,
        ],
        targetWhere: isNull(oauthRevocationRetries.completedAt),
        set: {
          attempts: sql`${oauthRevocationRetries.attempts} + 1`,
          nextAttemptAt: sql`${attemptedAt} + (
            LEAST(300, POWER(2, ${oauthRevocationRetries.attempts})) * interval '1 second'
          )`,
          lastErrorCode: errorCode,
          expiresAt: sql`GREATEST(${oauthRevocationRetries.expiresAt}, ${input.expiresAt})`,
          updatedAt: attemptedAt,
        },
        setWhere: eq(oauthRevocationRetries.userId, input.userId),
      })
      .returning({ userId: oauthRevocationRetries.userId });

    if (!queued || queued.userId !== input.userId) {
      throw new Error('OAuth revocation retry marker owner conflict');
    }

    return { status: 'retry_queued', errorCode };
  }
}

export const __testOnly = {
  markerErrorCode,
  remainingLifetimeSeconds,
};
