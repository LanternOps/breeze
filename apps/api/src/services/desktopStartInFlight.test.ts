import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getRedisMock } = vi.hoisted(() => ({ getRedisMock: vi.fn() }));
vi.mock('./redis', () => ({ getRedis: getRedisMock }));

import {
  DESKTOP_START_IN_FLIGHT_REDIS_TIMEOUT_MS,
  desktopStartInFlightRedisKey,
  markDesktopStartInFlight,
  readDesktopStartInFlight,
  releaseDesktopStartInFlight,
} from './desktopStartInFlight';

const SESSION = '11111111-1111-4111-8111-111111111111';
const COMMAND = `desk-start-${SESSION}-22222222-2222-4222-8222-222222222222`;

function fakeRedis(overrides: Partial<Record<'get' | 'set' | 'eval', ReturnType<typeof vi.fn>>> = {}) {
  return {
    status: 'ready',
    get: vi.fn(async () => null),
    set: vi.fn(async () => 'OK'),
    eval: vi.fn(async () => 1),
    ...overrides,
  };
}

describe('desktopStartInFlight (#8947)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('marks a start in flight with its command id and a PX TTL', async () => {
    const redis = fakeRedis();
    getRedisMock.mockReturnValue(redis);

    await markDesktopStartInFlight(SESSION, COMMAND, 15_000);

    expect(redis.set).toHaveBeenCalledWith(desktopStartInFlightRedisKey(SESSION), COMMAND, 'PX', 15_000);
  });

  it('reads back the command id of the in-flight start', async () => {
    const redis = fakeRedis({ get: vi.fn(async () => COMMAND) });
    getRedisMock.mockReturnValue(redis);

    await expect(readDesktopStartInFlight(SESSION)).resolves.toBe(COMMAND);
    expect(redis.get).toHaveBeenCalledWith(desktopStartInFlightRedisKey(SESSION));
  });

  it('releases only its own marker (compare-and-delete)', async () => {
    const redis = fakeRedis();
    getRedisMock.mockReturnValue(redis);

    await releaseDesktopStartInFlight(SESSION, COMMAND);

    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('DEL'"),
      1,
      desktopStartInFlightRedisKey(SESSION),
      COMMAND,
    );
  });

  // Fail open everywhere: the marker only refuses duplicates. Losing it must
  // never block a start — it degrades to the pre-#8947 behaviour.
  describe('fails open', () => {
    it('reads nothing when Redis is not configured', async () => {
      getRedisMock.mockReturnValue(null);
      await expect(readDesktopStartInFlight(SESSION)).resolves.toBeNull();
      await expect(markDesktopStartInFlight(SESSION, COMMAND, 15_000)).resolves.toBeUndefined();
      await expect(releaseDesktopStartInFlight(SESSION, COMMAND)).resolves.toBeUndefined();
    });

    it('does not touch a client that is not ready (no offline-queue wait under the row lock)', async () => {
      const redis = { ...fakeRedis({ get: vi.fn(async () => COMMAND) }), status: 'reconnecting' };
      getRedisMock.mockReturnValue(redis);

      await expect(readDesktopStartInFlight(SESSION)).resolves.toBeNull();
      await markDesktopStartInFlight(SESSION, COMMAND, 15_000);
      expect(redis.get).not.toHaveBeenCalled();
      expect(redis.set).not.toHaveBeenCalled();
    });

    it('reads nothing when the Redis call throws', async () => {
      getRedisMock.mockReturnValue(fakeRedis({ get: vi.fn(async () => { throw new Error('boom'); }) }));
      await expect(readDesktopStartInFlight(SESSION)).resolves.toBeNull();
    });

    it('swallows a failed mark or release', async () => {
      getRedisMock.mockReturnValue(fakeRedis({
        set: vi.fn(async () => { throw new Error('boom'); }),
        eval: vi.fn(async () => { throw new Error('boom'); }),
      }));
      await expect(markDesktopStartInFlight(SESSION, COMMAND, 15_000)).resolves.toBeUndefined();
      await expect(releaseDesktopStartInFlight(SESSION, COMMAND)).resolves.toBeUndefined();
    });

    it('gives up on a slow Redis instead of holding the row lock', async () => {
      vi.useFakeTimers();
      getRedisMock.mockReturnValue(fakeRedis({ get: vi.fn(() => new Promise(() => {})) }));

      const pending = readDesktopStartInFlight(SESSION);
      await vi.advanceTimersByTimeAsync(DESKTOP_START_IN_FLIGHT_REDIS_TIMEOUT_MS + 1);

      await expect(pending).resolves.toBeNull();
    });
  });
});
