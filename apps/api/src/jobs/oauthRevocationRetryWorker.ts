import { and, asc, eq, isNull, lte } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { oauthRevocationRetries } from '../db/schema';
import { writeOAuthRevocationMarkerDurably } from '../oauth/revocationRetry';

const RETRY_INTERVAL_MS = 30_000;
const RETRY_BATCH_SIZE = 50;

let retryTimer: NodeJS.Timeout | null = null;
let activeDrain: Promise<number> | null = null;

export async function drainOAuthRevocationRetries(limit: number): Promise<number> {
  const boundedLimit = Math.max(1, Math.min(Math.trunc(limit), 500));

  return runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const now = new Date();
      const due = await db
        .select()
        .from(oauthRevocationRetries)
        .where(and(
          isNull(oauthRevocationRetries.completedAt),
          lte(oauthRevocationRetries.nextAttemptAt, now),
        ))
        .orderBy(asc(oauthRevocationRetries.nextAttemptAt))
        .limit(boundedLimit)
        .for('update', { skipLocked: true });

      let completed = 0;
      for (const row of due) {
        if (row.expiresAt.getTime() <= now.getTime()) {
          await db
            .update(oauthRevocationRetries)
            .set({ completedAt: now, updatedAt: now })
            .where(eq(oauthRevocationRetries.id, row.id));
          completed += 1;
          continue;
        }

        const result = await writeOAuthRevocationMarkerDurably(db, {
          userId: row.userId,
          markerType: row.markerType as 'grant' | 'jti',
          markerId: row.markerId,
          expiresAt: row.expiresAt,
        });
        if (result.status === 'written') {
          const completedAt = new Date();
          await db
            .update(oauthRevocationRetries)
            .set({ completedAt, updatedAt: completedAt })
            .where(eq(oauthRevocationRetries.id, row.id));
          completed += 1;
        }
      }

      return completed;
    }),
  );
}

function runScheduledDrain(): void {
  if (activeDrain) return;
  activeDrain = drainOAuthRevocationRetries(RETRY_BATCH_SIZE)
    .catch((error) => {
      console.error('[OAuthRevocationRetryWorker] bounded drain failed', {
        errorCode: error instanceof Error ? error.name : 'unknown_error',
      });
      return 0;
    })
    .finally(() => {
      activeDrain = null;
    });
}

export function initializeOAuthRevocationRetryWorker(): void {
  if (retryTimer) return;
  retryTimer = setInterval(runScheduledDrain, RETRY_INTERVAL_MS);
  retryTimer.unref?.();
}

export async function shutdownOAuthRevocationRetryWorker(): Promise<void> {
  if (retryTimer) {
    clearInterval(retryTimer);
    retryTimer = null;
  }
  await activeDrain;
}

export const __testOnly = {
  RETRY_BATCH_SIZE,
  RETRY_INTERVAL_MS,
};
