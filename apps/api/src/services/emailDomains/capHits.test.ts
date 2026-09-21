import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getRedisMock } = vi.hoisted(() => ({ getRedisMock: vi.fn() }));
vi.mock('../redis', () => ({ getRedis: getRedisMock }));

import { CAP_HIT_WINDOW_DAYS, capHitDayKey, loadCapHitWindow, recordCapHit } from './capHits';

const PARTNER = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-09-17T09:00:00.000Z');

function multiChain(execResult: unknown = [[null, 1], [null, 1]]) {
  const chain = {
    hincrby: vi.fn((_key: string, _field: string, _by: number) => chain),
    expire: vi.fn((_key: string, _ttl: number) => chain),
    exec: vi.fn(async () => execResult),
  };
  return chain;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('capHitDayKey', () => {
  it('namespaces by UTC day so one HGETALL covers the whole fleet for that day', () => {
    expect(capHitDayKey('2026-09-17')).toBe('email-domains:cap-hits:2026-09-17');
  });
});

describe('recordCapHit', () => {
  it('HINCRBYs the partner field on today\'s hash and sets an expiry past the window', () => {
    const chain = multiChain();
    getRedisMock.mockReturnValue({ multi: vi.fn(() => chain) });
    recordCapHit(PARTNER, NOW);
    expect(chain.hincrby).toHaveBeenCalledWith('email-domains:cap-hits:2026-09-17', PARTNER, 1);
    // 8 days: one clear day past the 7-day read window.
    expect(chain.expire).toHaveBeenCalledWith('email-domains:cap-hits:2026-09-17', 8 * 24 * 60 * 60);
  });

  // The send path calls this synchronously; it must never throw into a send.
  it('returns void and swallows a Redis constructor failure', () => {
    getRedisMock.mockImplementation(() => { throw new Error('ECONNRESET'); });
    expect(() => recordCapHit(PARTNER, NOW)).not.toThrow();
  });

  it('swallows a rejected exec without an unhandled rejection', async () => {
    const chain = multiChain();
    chain.exec.mockRejectedValue(new Error('down'));
    getRedisMock.mockReturnValue({ multi: vi.fn(() => chain) });
    expect(() => recordCapHit(PARTNER, NOW)).not.toThrow();
    await new Promise((resolve) => setImmediate(resolve));
  });

  it('is a silent no-op when Redis is unavailable', () => {
    getRedisMock.mockReturnValue(null);
    expect(() => recordCapHit(PARTNER, NOW)).not.toThrow();
  });
});

describe('loadCapHitWindow', () => {
  it('sums the trailing window across days, one HGETALL per day and no SCAN', async () => {
    const hgetall = vi.fn(async (key: string) => (
      key.endsWith('2026-09-17') ? { [PARTNER]: '2' }
        : key.endsWith('2026-09-15') ? { [PARTNER]: '3', other: '1' }
        : {}
    ));
    getRedisMock.mockReturnValue({ hgetall, scan: vi.fn(), keys: vi.fn() });
    const window = await loadCapHitWindow(NOW);
    expect(hgetall).toHaveBeenCalledTimes(CAP_HIT_WINDOW_DAYS);
    expect(window.get(PARTNER)).toBe(5);
    expect(window.get('other')).toBe(1);
  });

  it('reads exactly the same 7 UTC days the stats window covers', async () => {
    const hgetall = vi.fn(async (_key: string) => ({} as Record<string, string>));
    getRedisMock.mockReturnValue({ hgetall });
    await loadCapHitWindow(NOW);
    const keys = hgetall.mock.calls.map((call) => call[0]);
    expect(keys).toEqual([
      'email-domains:cap-hits:2026-09-11',
      'email-domains:cap-hits:2026-09-12',
      'email-domains:cap-hits:2026-09-13',
      'email-domains:cap-hits:2026-09-14',
      'email-domains:cap-hits:2026-09-15',
      'email-domains:cap-hits:2026-09-16',
      'email-domains:cap-hits:2026-09-17',
    ]);
  });

  it('returns an empty map when Redis is unavailable rather than throwing into the sweep', async () => {
    getRedisMock.mockReturnValue(null);
    await expect(loadCapHitWindow(NOW)).resolves.toEqual(new Map());
  });

  it('returns an empty map when a read throws', async () => {
    getRedisMock.mockReturnValue({ hgetall: vi.fn(async () => { throw new Error('down'); }) });
    await expect(loadCapHitWindow(NOW)).resolves.toEqual(new Map());
  });

  it('ignores a non-numeric field value', async () => {
    getRedisMock.mockReturnValue({ hgetall: vi.fn(async () => ({ [PARTNER]: 'NaN' })) });
    const window = await loadCapHitWindow(NOW);
    expect(window.get(PARTNER)).toBeUndefined();
  });
});
