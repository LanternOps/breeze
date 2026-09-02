import { getRedis } from './redis';
import { rateLimiter, type RateLimitResult } from './rate-limit';

const PAM_RECONCILIATION_RATE_LIMIT = 120;
const PAM_RECONCILIATION_RATE_WINDOW_SECONDS = 60;

export async function consumePamReconciliationRateLimit(
  deviceId: string,
): Promise<RateLimitResult> {
  return rateLimiter(
    getRedis(),
    `pam:reconciliation:device:${deviceId}`,
    PAM_RECONCILIATION_RATE_LIMIT,
    PAM_RECONCILIATION_RATE_WINDOW_SECONDS,
    1,
    { refundOnReject: true },
  );
}
