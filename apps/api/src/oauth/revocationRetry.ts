import { eq, isNull, sql } from 'drizzle-orm';
import { db } from '../db';
import { sqlTimestamptz } from '../db/sqlValues';
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
 * The `ON CONFLICT ... DO UPDATE` assignment list for an existing, still-open
 * retry row: bump the attempt count, push `next_attempt_at` out by an
 * exponential backoff capped at 300s, and never shorten the marker's lifetime.
 *
 * Extracted so the SQL can be rendered and asserted on without a database.
 *
 * Both timestamps are bound via `sqlTimestamptz` rather than interpolated bare
 * (#3369). A raw `Date` inside a `sql` template is wrapped in a `Param` with
 * the noop encoder and reaches postgres.js as a JS object, whose Bind step
 * throws `ERR_INVALID_ARG_TYPE`. This branch runs only when a retry row already
 * exists — i.e. exactly when a prior Redis write failed — so the throw rolled
 * back the entire `withSystemDbAccessContext` batch in
 * `jobs/oauthRevocationRetryWorker.ts` and was then swallowed by the generic
 * `.catch` in `runScheduledDrain`, which logs and returns 0. Net effect: the
 * OAuth revocation retry queue could never drain or heal during a Redis
 * outage, and failed silently rather than per-row.
 *
 * The explicit `::timestamptz` casts are load-bearing, not decoration: an
 * untyped parameter has no unique operator resolution against `interval`, and
 * inside `GREATEST` it would resolve off the other argument's type.
 */
export function buildRetryConflictUpdate(args: {
  attemptedAt: Date;
  expiresAt: Date;
  errorCode: 'redis_unavailable' | 'redis_write_failed';
}) {
  return {
    attempts: sql`${oauthRevocationRetries.attempts} + 1`,
    nextAttemptAt: sql`${sqlTimestamptz(args.attemptedAt)} + (
      LEAST(300, POWER(2, ${oauthRevocationRetries.attempts})) * interval '1 second'
    )`,
    lastErrorCode: args.errorCode,
    expiresAt: sql`GREATEST(${oauthRevocationRetries.expiresAt}, ${sqlTimestamptz(args.expiresAt)})`,
    updatedAt: args.attemptedAt,
  };
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
        set: buildRetryConflictUpdate({
          attemptedAt,
          expiresAt: input.expiresAt,
          errorCode,
        }),
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
