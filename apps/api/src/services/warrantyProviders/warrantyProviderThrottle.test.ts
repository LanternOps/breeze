import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Spy on the per-provider limiter INSTANCES so we can prove the providers
// acquire once per vendor fetch, while keeping the real createWarrantyRateLimiter
// for the spacing unit test below.
const { hpAcquire, lenovoAcquire } = vi.hoisted(() => ({
  hpAcquire: vi.fn().mockResolvedValue(undefined),
  lenovoAcquire: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./throttle', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./throttle')>();
  return {
    ...actual,
    hpRateLimiter: { acquire: hpAcquire },
    lenovoRateLimiter: { acquire: lenovoAcquire },
  };
});

import { hpProvider } from './hpProvider';
import { lenovoProvider } from './lenovoProvider';
import { createWarrantyRateLimiter } from './throttle';

const okJson = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

beforeEach(() => {
  hpAcquire.mockClear();
  lenovoAcquire.mockClear();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okJson({})));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('warranty provider request throttling (#3201)', () => {
  // The bug this guards: production calls lookup([oneSerial]) once per device, so
  // the limiter MUST fire per fetch across separate calls — not just within one
  // multi-serial call.
  it('HP: acquires the limiter on every request, even across single-serial calls', async () => {
    await hpProvider.lookup(['a']);
    await hpProvider.lookup(['b']);
    await hpProvider.lookup(['c']);
    expect(hpAcquire).toHaveBeenCalledTimes(3);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('HP: acquires once per serial within a multi-serial call too', async () => {
    await hpProvider.lookup(['a', 'b']);
    expect(hpAcquire).toHaveBeenCalledTimes(2);
  });

  it('HP: no serials → no acquire', async () => {
    await hpProvider.lookup([]);
    expect(hpAcquire).not.toHaveBeenCalled();
  });

  it('Lenovo: acquires the limiter on every request when configured', async () => {
    vi.stubEnv('LENOVO_API_KEY', 'test-client-id');
    await lenovoProvider.lookup(['a']);
    await lenovoProvider.lookup(['b']);
    expect(lenovoAcquire).toHaveBeenCalledTimes(2);
  });

  it('Lenovo: no API key → no vendor calls and no acquire', async () => {
    vi.stubEnv('LENOVO_API_KEY', '');
    await lenovoProvider.lookup(['a', 'b', 'c']);
    expect(lenovoAcquire).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('createWarrantyRateLimiter', () => {
  it('lets the first acquire through immediately but spaces the next by the interval', async () => {
    vi.useFakeTimers();
    // A realistic clock so the initial lastReleaseAt=0 makes the first wait
    // negative (immediate), as in production.
    vi.setSystemTime(1_700_000_000_000);
    try {
      const limiter = createWarrantyRateLimiter(250);

      let firstDone = false;
      limiter.acquire().then(() => {
        firstDone = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(firstDone).toBe(true);

      let secondDone = false;
      limiter.acquire().then(() => {
        secondDone = true;
      });
      // Not yet — must wait out the interval.
      await vi.advanceTimersByTimeAsync(100);
      expect(secondDone).toBe(false);
      await vi.advanceTimersByTimeAsync(200);
      expect(secondDone).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
