import { MigrationWindowError } from '../migrationWindows';
import { rateLimiter } from '../rate-limit';
import { getRedis } from '../redis';

/**
 * The import throughput bucket (#8313; spec §4.7): a third hourly bucket,
 * `migration_window_rate:{windowId}`, limited to the window's
 * writes_per_hour. It is independent of the Partner API buckets, so an
 * import never consumes a live integration's 1200/6000 and a live
 * integration cannot starve an import.
 *
 * The writer charges it BEFORE each transaction with the transaction's cost,
 * one unit per service write. `refundOnReject`: a rejected attempt costs
 * nothing, so a writer that waits for `retryAfterSeconds` is admitted. Fails
 * closed like every limiter here: no Redis, no import.
 */
export const MIGRATION_WINDOW_RATE_BUCKET = 'migration_window_rate';

export function migrationWindowRateKey(windowId: string): string {
  return `${MIGRATION_WINDOW_RATE_BUCKET}:${windowId}`;
}

export async function chargeWindowThroughput(
  window: { id: string; writesPerHour: number },
  cost: number,
): Promise<void> {
  if (cost <= 0) return;
  const result = await rateLimiter(getRedis(), migrationWindowRateKey(window.id), window.writesPerHour, 3600, cost, {
    refundOnReject: true,
  });
  if (!result.allowed) {
    throw new MigrationWindowError(
      'MIGRATION_WINDOW_RATE_LIMITED',
      'The migration window throughput limit is reached',
      429,
      {
        writesPerHour: window.writesPerHour,
        retryAfterSeconds: Math.max(1, Math.ceil((result.resetAt.getTime() - Date.now()) / 1000)),
      },
    );
  }
}
