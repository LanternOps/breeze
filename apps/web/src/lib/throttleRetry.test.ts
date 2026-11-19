import { afterEach, describe, expect, it, vi } from 'vitest';

import { MAX_THROTTLE_RETRY_MS, throttleRetryDelayMs } from './throttleRetry';

const res = (headers: Record<string, string> = {}, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status: 429, headers });

afterEach(() => vi.restoreAllMocks());

describe('throttleRetryDelayMs', () => {
  it('honours the Retry-After header (seconds) and only adds jitter', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    expect(await throttleRetryDelayMs(res({ 'Retry-After': '3' }))).toBe(3000);
    vi.spyOn(Math, 'random').mockReturnValue(0.999);
    const d = await throttleRetryDelayMs(res({ 'Retry-After': '4' }));
    expect(d).toBeGreaterThan(4000);
    expect(d).toBeLessThanOrEqual(5000);
  });

  it('falls back to body retryAfterSeconds, then retryAfter', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    expect(await throttleRetryDelayMs(res({}, { retryAfterSeconds: 2 }))).toBe(2000);
    expect(await throttleRetryDelayMs(res({}, { retryAfter: 5 }))).toBe(5000);
  });

  it('returns null (do not retry) when no usable wait is advertised', async () => {
    expect(await throttleRetryDelayMs(res())).toBeNull();
    expect(await throttleRetryDelayMs(res({ 'Retry-After': '0' }))).toBeNull();
    expect(await throttleRetryDelayMs(res({ 'Retry-After': 'soon' }))).toBeNull();
  });

  it('returns null when the advertised wait exceeds the cap', async () => {
    const over = Math.ceil(MAX_THROTTLE_RETRY_MS / 1000) + 1;
    expect(await throttleRetryDelayMs(res({ 'Retry-After': String(over) }))).toBeNull();
  });

  it('does not consume the caller-visible body', async () => {
    const r = res({}, { retryAfterSeconds: 1 });
    await throttleRetryDelayMs(r);
    expect(r.bodyUsed).toBe(false);
  });
});
