import { setSigninLimiterTokens } from './metrics';

/**
 * Token bucket for /users?$select=signInActivity requests (spec §4.2).
 *
 * Graph throttles that select at 10 requests per minute PER APP ACROSS ALL
 * TENANTS, not per tenant, so the limit is a property of this process, not of
 * a connection. The default of 4/min leaves headroom under 10 and lets two
 * regions share one app registration at 4 + 4. With more than one replica the
 * operator divides the value.
 *
 * tryTake NEVER blocks: an empty bucket makes the caller stop paging and hand
 * back a continuation, which is strictly better than holding an executor slot
 * asleep for fifteen seconds.
 */
export interface SigninLimiter {
  tryTake(): boolean;
  tokens(): number;
}

const MS_PER_MINUTE = 60_000;

export function createSigninLimiter(config: {
  requestsPerMinute: number;
  now?: () => number;
}): SigninLimiter {
  const now = config.now ?? (() => Date.now());
  const capacity = config.requestsPerMinute;
  const refillPerMs = capacity / MS_PER_MINUTE;
  let available = capacity;
  let updatedAt = now();

  function refill(): void {
    const at = now();
    if (at > updatedAt) {
      available = Math.min(capacity, available + (at - updatedAt) * refillPerMs);
      updatedAt = at;
    }
    setSigninLimiterTokens(Math.floor(available));
  }

  return {
    tryTake() {
      refill();
      if (available < 1) return false;
      available -= 1;
      setSigninLimiterTokens(Math.floor(available));
      return true;
    },
    tokens() {
      refill();
      return Math.floor(available);
    },
  };
}
