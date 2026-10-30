/**
 * The one webhook retry schedule (spec OD4, #10528 W1-B): after attempts 1..6
 * wait 1 m, 5 m, 30 m, 2 h, 6 h, 12 h (about 21 h in all), each ±20 % so a
 * fleet-wide outage does not retry in lockstep; the 7th failure is terminal.
 * Deliberately not per-webhook: the legacy per-webhook policy column is ignored.
 */
export const WEBHOOK_RETRY_DELAYS_MS = [60_000, 300_000, 1_800_000, 7_200_000, 21_600_000, 43_200_000] as const;
export const WEBHOOK_MAX_ATTEMPTS = WEBHOOK_RETRY_DELAYS_MS.length + 1;
export const WEBHOOK_RETRY_JITTER = 0.2;

export function nextWebhookRetryAt(attemptsMade: number, now: Date, random: () => number = Math.random): Date | null {
  if (!Number.isInteger(attemptsMade) || attemptsMade <= 0) {
    throw new RangeError('attemptsMade must be a positive integer');
  }
  if (attemptsMade >= WEBHOOK_MAX_ATTEMPTS) return null;
  const delay = WEBHOOK_RETRY_DELAYS_MS[attemptsMade - 1]!;
  return new Date(now.getTime() + Math.round(delay * (1 + WEBHOOK_RETRY_JITTER * (2 * random() - 1))));
}
