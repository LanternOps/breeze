import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { nextWebhookRetryAt, WEBHOOK_MAX_ATTEMPTS, WEBHOOK_RETRY_DELAYS_MS, WEBHOOK_RETRY_JITTER } from './webhookRetrySchedule';

const now = new Date('2027-01-12T00:00:00Z');
describe('fixed webhook retry schedule', () => {
  it.each([1, 2, 3, 4, 5, 6])('jitter boundaries and midpoint after attempt %i', (attempt) => {
    const base = [60_000, 300_000, 1_800_000, 7_200_000, 21_600_000, 43_200_000][attempt - 1]!;
    for (const [random, multiplier] of [[0, 0.8], [1, 1.2], [0.5, 1]]) {
      expect(nextWebhookRetryAt(attempt, now, () => random!)?.getTime()).toBe(now.getTime() + base * multiplier!);
    }
  });
  it.each([7, 8])('ends after attempt %i', (attempt) => expect(nextWebhookRetryAt(attempt, now)).toBeNull());
  it.each([0, -1, 1.5])('rejects invalid attempts %s', (attempt) => expect(() => nextWebhookRetryAt(attempt, now)).toThrow(RangeError));
  it('pins the total duration, attempt budget and jitter', () => {
    expect(WEBHOOK_RETRY_DELAYS_MS.reduce((sum, value) => sum + value, 0)).toBe(74_160_000);
    expect(WEBHOOK_MAX_ATTEMPTS).toBe(7);
    expect(WEBHOOK_RETRY_JITTER).toBe(0.2);
  });
  it('never reads a per-webhook retry policy', () => {
    expect(readFileSync(new URL('./webhookRetrySchedule.ts', import.meta.url), 'utf8')).not.toMatch(/retryPolicy|retry_policy/);
  });
});
