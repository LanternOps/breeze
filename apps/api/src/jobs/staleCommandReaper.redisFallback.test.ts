// #7105 item 4 — the stale reaper must not silently stop when Redis is
// unavailable: at boot (index.ts skips every BullMQ worker) or when scheduling
// its repeatable job fails. It falls back to an in-process interval that runs
// the same domains, and says so loudly.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { withSystemMock, captureExceptionMock, getRepeatableJobsMock } = vi.hoisted(() => ({
  withSystemMock: vi.fn(),
  captureExceptionMock: vi.fn(),
  getRepeatableJobsMock: vi.fn(),
}));

vi.mock('bullmq', () => ({
  Queue: class {
    getRepeatableJobs = getRepeatableJobsMock;
    removeRepeatableByKey = vi.fn();
    add = vi.fn();
    close = vi.fn(async () => {});
  },
  Worker: class {
    on = vi.fn();
    close = vi.fn(async () => {});
  },
  Job: class {},
}));

vi.mock('../db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db')>();
  return { ...actual, withSystemDbAccessContext: withSystemMock };
});

vi.mock('../services/redis', () => ({
  getRedisConnection: vi.fn(() => ({})),
  getBullMQConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })),
  isBullMQAvailable: vi.fn(() => false),
}));

vi.mock('../services/sentry', () => ({
  captureException: (...args: unknown[]) => captureExceptionMock(...(args as [])),
}));

vi.mock('./workerObservability', () => ({ attachWorkerObservability: vi.fn() }));

import {
  REAPER_DOMAINS,
  STALE_REAPER_INLINE_INTERVAL_MS,
  STALE_REAPER_INLINE_STUCK_MS,
  initializeStaleCommandReaper,
  shutdownStaleCommandReaper,
  startStaleCommandReaperWithoutRedis,
} from './staleCommandReaper';

// withSystemDbAccessContext wraps each domain; resolving it WITHOUT calling the
// domain lets the test count cycles without touching a database.
function cyclesRun(): number {
  return withSystemMock.mock.calls.length / REAPER_DOMAINS.length;
}

describe('stale command reaper without Redis (#7105)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetAllMocks();
    withSystemMock.mockResolvedValue(0);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(async () => {
    await shutdownStaleCommandReaper();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('runs every reaper domain on an interval and reports the degraded mode to Sentry', async () => {
    startStaleCommandReaperWithoutRedis();

    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    expect(String(captureExceptionMock.mock.calls[0]![0])).toMatch(/Redis/);

    await vi.advanceTimersByTimeAsync(STALE_REAPER_INLINE_INTERVAL_MS);
    expect(cyclesRun()).toBe(1);
    await vi.advanceTimersByTimeAsync(STALE_REAPER_INLINE_INTERVAL_MS);
    expect(cyclesRun()).toBe(2);
  });

  it('is idempotent: a second start neither doubles the cadence nor re-alerts', async () => {
    startStaleCommandReaperWithoutRedis();
    startStaleCommandReaperWithoutRedis();

    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(STALE_REAPER_INLINE_INTERVAL_MS);
    expect(cyclesRun()).toBe(1);
  });

  it('never overlaps two cycles', async () => {
    let release!: () => void;
    withSystemMock.mockImplementationOnce(() => new Promise<number>((resolve) => { release = () => resolve(0); }));
    startStaleCommandReaperWithoutRedis();

    await vi.advanceTimersByTimeAsync(STALE_REAPER_INLINE_INTERVAL_MS); // cycle 1 starts, blocks on domain 1
    await vi.advanceTimersByTimeAsync(STALE_REAPER_INLINE_INTERVAL_MS); // tick while cycle 1 is running
    expect(withSystemMock).toHaveBeenCalledTimes(1);

    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(withSystemMock).toHaveBeenCalledTimes(REAPER_DOMAINS.length);
  });

  it('reports a cycle that never settles, once', async () => {
    withSystemMock.mockImplementationOnce(() => new Promise<number>(() => {}));
    startStaleCommandReaperWithoutRedis();
    captureExceptionMock.mockClear();

    await vi.advanceTimersByTimeAsync(STALE_REAPER_INLINE_INTERVAL_MS); // hangs
    await vi.advanceTimersByTimeAsync(STALE_REAPER_INLINE_STUCK_MS);
    await vi.advanceTimersByTimeAsync(STALE_REAPER_INLINE_STUCK_MS);

    const stuck = captureExceptionMock.mock.calls.filter((c) => /still running after/.test(String(c[0])));
    expect(stuck).toHaveLength(1);
  });

  it('reports a cycle in which every domain failed', async () => {
    withSystemMock.mockRejectedValue(new Error('db unavailable'));
    startStaleCommandReaperWithoutRedis();
    captureExceptionMock.mockClear();

    await vi.advanceTimersByTimeAsync(STALE_REAPER_INLINE_INTERVAL_MS);

    const messages = captureExceptionMock.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => /All reaper domains failed/.test(m))).toBe(true);
  });

  it('stops on shutdown', async () => {
    startStaleCommandReaperWithoutRedis();
    await shutdownStaleCommandReaper();

    await vi.advanceTimersByTimeAsync(STALE_REAPER_INLINE_INTERVAL_MS * 3);
    expect(withSystemMock).not.toHaveBeenCalled();
  });

  it('falls back when scheduling the repeatable job fails, and still fails init loudly', async () => {
    getRepeatableJobsMock.mockRejectedValue(new Error('connect ECONNREFUSED'));

    await expect(initializeStaleCommandReaper()).rejects.toThrow('ECONNREFUSED');

    await vi.advanceTimersByTimeAsync(STALE_REAPER_INLINE_INTERVAL_MS);
    expect(cyclesRun()).toBe(1);
  });
});
