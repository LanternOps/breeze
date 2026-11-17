/**
 * Shared by the #12084 approval-wait integration suites
 * (aiApprovalPollRls, aiApprovalCloseOutClicks).
 */
import { vi } from 'vitest';

/**
 * #12084: a decision that lands between the wait's LAST poll and its close-out.
 *
 * The real poll sleeps between reads (500 ms, then up to 3 s). `inLastSleep`
 * swaps that first sleep for: run `decide` (the click), then sleep past the
 * wait's timeout. The first read saw 'pending' and no read follows, so the next
 * thing the wait does is its close-out: exactly the window in the issue. Only
 * the wait's own 500 ms sleep is intercepted (its callback is a native promise
 * resolver, which no driver or pool timer is); every other timer runs as
 * normal. If the sleep is never intercepted, `decided` never settles and the
 * test times out instead of passing vacuously.
 */
export function inLastSleep(decide: () => Promise<void>, sleepMs: number): { decided: Promise<void> } {
  const realSetTimeout = globalThis.setTimeout;
  let armed = true;
  let markDecided!: () => void;
  let failDecided!: (err: unknown) => void;
  const decided = new Promise<void>((resolve, reject) => {
    markDecided = resolve;
    failDecided = reject;
  });
  // Rethrown where the test awaits it; this only stops an early rejection
  // from surfacing as an unhandled rejection against another test.
  decided.catch(() => undefined);
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
    fn: (...args: unknown[]) => void,
    ms?: number,
    ...rest: unknown[]
  ) => {
    if (armed && ms === 500 && Function.prototype.toString.call(fn).includes('[native code]')) {
      armed = false;
      decide().then(
        () => { markDecided(); realSetTimeout(fn, sleepMs); },
        (err) => { failDecided(err); realSetTimeout(fn, sleepMs); },
      );
      return realSetTimeout(() => undefined, 0);
    }
    return realSetTimeout(fn, ms, ...rest);
  }) as typeof setTimeout);
  return { decided };
}
