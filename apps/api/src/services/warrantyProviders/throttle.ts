// Per-provider request rate limiter for the third-party warranty lookups (HP's
// unofficial support endpoint, Lenovo's pcsupport API).
//
// Warranty sync makes ONE single-serial `lookup()` call PER DEVICE (see
// warrantySync.ts), across up to 3 concurrent worker jobs in this process, so
// spacing serials *within* a lookup() call throttles nothing — every real call
// has exactly one serial. The limit must be enforced ACROSS calls at the
// vendor-request boundary. `acquire()` serializes and spaces every fetch to at
// least `minIntervalMs` apart, coordinating all lookup() calls and concurrent
// jobs in THIS process (#3201). It is not cross-process (that would need a
// shared store), but it stops a single API instance from bursting a whole
// fleet's serials at the vendor and getting the source IP throttled/banned.
//
// Neither vendor documents a rate limit, so the default is deliberately
// conservative (~4 req/s); tune it if a vendor publishes a specific ceiling.

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export interface WarrantyRateLimiter {
  acquire(): Promise<void>;
}

export function createWarrantyRateLimiter(minIntervalMs: number): WarrantyRateLimiter {
  // A serialized queue: each acquire() chains off the previous one and only
  // resolves once at least `minIntervalMs` has passed since the last release.
  let tail: Promise<void> = Promise.resolve();
  let lastReleaseAt = 0;
  return {
    acquire(): Promise<void> {
      const gated = tail.then(async () => {
        const wait = lastReleaseAt + minIntervalMs - Date.now();
        if (wait > 0) await sleep(wait);
        lastReleaseAt = Date.now();
      });
      // Keep the queue alive even if the gate ever rejects (defensive — the body
      // only awaits a timer, so in practice it can't).
      tail = gated.catch(() => undefined);
      return gated;
    },
  };
}

export const WARRANTY_LOOKUP_MIN_INTERVAL_MS = 250;

// One limiter per provider — they hit different vendors, so their rate limits
// are independent.
export const hpRateLimiter = createWarrantyRateLimiter(WARRANTY_LOOKUP_MIN_INTERVAL_MS);
export const lenovoRateLimiter = createWarrantyRateLimiter(WARRANTY_LOOKUP_MIN_INTERVAL_MS);
