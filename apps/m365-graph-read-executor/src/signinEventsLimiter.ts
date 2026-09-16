import { setSigninEventsLimiterTokens } from './metrics';

/**
 * Token bucket for /auditLogs/signIns requests (#5784 W05).
 *
 * Deliberately NOT `signinLimiter`. That bucket throttles
 * /users?$select=signInActivity, whose 10-req/min limit is a property of the
 * APP across every tenant; /auditLogs/signIns is a different Graph surface with
 * its own limits, so sharing one bucket would needlessly starve both. Same
 * shape, its own env-configurable rate.
 *
 * tryTake NEVER blocks: an empty bucket makes the caller stop paging and hand
 * back a continuation, which is strictly better than holding an executor slot
 * asleep.
 */
export interface SigninEventsLimiter {
  tryTake(): boolean;
  tokens(): number;
}

const MS_PER_MINUTE = 60_000;

export function createSigninEventsLimiter(config: {
  requestsPerMinute: number;
  now?: () => number;
}): SigninEventsLimiter {
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
    setSigninEventsLimiterTokens(Math.floor(available));
  }

  return {
    tryTake() {
      refill();
      if (available < 1) return false;
      available -= 1;
      setSigninEventsLimiterTokens(Math.floor(available));
      return true;
    },
    tokens() {
      refill();
      return Math.floor(available);
    },
  };
}
