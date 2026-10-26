/**
 * Countdown announcements (spec section 3.2 "Accessibility"): a card announces
 * once when shown and the countdown only at 60, 30 and 10 seconds. A ticking
 * `aria-live` region would interrupt whatever the person is reading.
 */

export const ANNOUNCE_AT_SECONDS = [60, 30, 10] as const;

/**
 * True when the countdown moved from `prevS` to `nowS` across (onto or past)
 * one of the thresholds. A skipped tick still announces, once. No previous
 * reading, or the clock moving backwards, is silent.
 */
export function shouldAnnounce(prevS: number | null | undefined, nowS: number): boolean {
  if (prevS == null || !Number.isFinite(prevS) || !Number.isFinite(nowS) || nowS >= prevS) return false;
  return ANNOUNCE_AT_SECONDS.some((t) => prevS > t && nowS <= t);
}
