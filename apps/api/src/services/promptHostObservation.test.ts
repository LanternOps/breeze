import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

const redis = vi.hoisted(() => ({ status: 'ready', get: vi.fn(), set: vi.fn(), del: vi.fn() }));
const redisState = vi.hoisted(() => ({ available: true, throws: false }));
vi.mock('./redis', () => ({
  getRedis: () => {
    if (redisState.throws) throw new Error('client construction failed');
    return redisState.available ? redis : null;
  },
}));

import {
  PROMPT_HOST_OBSERVATION_TTL_SECONDS,
  PROMPT_HOST_REDIS_TIMEOUT_MS,
  __resetPromptHostObservationLogThrottleForTests,
  notePromptHostReportDropped,
  promptHostObservationKey,
  readPromptHostObservation,
  recordPromptHostObservation,
} from './promptHostObservation';

const DEVICE = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-10-26T12:00:00.000Z');
const REPORT = { protocolVersion: 1, kinds: ['notice.info@1'], rendererVersion: '0.2.0' };

let error: MockInstance;
let warn: MockInstance;

beforeEach(() => {
  vi.resetAllMocks();
  redis.status = 'ready';
  redisState.available = true;
  redisState.throws = false;
  redis.set.mockResolvedValue('OK');
  redis.del.mockResolvedValue(1);
  redis.get.mockResolvedValue(null);
  __resetPromptHostObservationLogThrottleForTests();
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  error.mockRestore();
  warn.mockRestore();
});

describe('promptHostObservationKey', () => {
  it('is prompt-host:<deviceId>', () => {
    expect(promptHostObservationKey(DEVICE)).toBe(`prompt-host:${DEVICE}`);
  });
});

describe('recordPromptHostObservation', () => {
  it('stores the report with the server observation time and a 180 s TTL', async () => {
    await recordPromptHostObservation(DEVICE, REPORT, NOW);
    expect(PROMPT_HOST_OBSERVATION_TTL_SECONDS).toBe(180);
    expect(redis.set).toHaveBeenCalledTimes(1);
    const [key, value, mode, ttl] = redis.set.mock.calls[0]!;
    expect(key).toBe(`prompt-host:${DEVICE}`);
    expect(mode).toBe('EX');
    expect(ttl).toBe(180);
    expect(JSON.parse(value as string)).toEqual({ ...REPORT, observedAt: NOW.toISOString() });
    expect(redis.del).not.toHaveBeenCalled();
  });

  it('stores a renderer that advertises no kinds (W02 renderers)', async () => {
    await recordPromptHostObservation(DEVICE, { protocolVersion: 1, kinds: [], rendererVersion: '0.2.0' }, NOW);
    expect(JSON.parse(redis.set.mock.calls[0]![1] as string)).toEqual({
      protocolVersion: 1, kinds: [], rendererVersion: '0.2.0', observedAt: NOW.toISOString(),
    });
  });

  it('nothing reported this beat deletes the observation (no stale renderer lingers)', async () => {
    await recordPromptHostObservation(DEVICE, undefined, NOW);
    expect(redis.del).toHaveBeenCalledWith(`prompt-host:${DEVICE}`);
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('a write failure is logged and never throws', async () => {
    redis.set.mockRejectedValueOnce(new Error('down'));
    await expect(recordPromptHostObservation(DEVICE, REPORT, NOW)).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]![0])).toContain('prompt host observation write failed');
  });

  it('a delete failure is logged and never throws', async () => {
    redis.del.mockRejectedValueOnce(new Error('down'));
    await expect(recordPromptHostObservation(DEVICE, undefined, NOW)).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('write-fault logging is throttled (a fleet of beats cannot flood the log)', async () => {
    redis.set.mockRejectedValue(new Error('down'));
    for (let i = 0; i < 10; i += 1) await recordPromptHostObservation(DEVICE, REPORT, NOW);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('a slow store never holds the heartbeat past the cap', async () => {
    vi.useFakeTimers();
    redis.set.mockReturnValueOnce(new Promise(() => {}));
    const pending = recordPromptHostObservation(DEVICE, REPORT, NOW);
    await vi.advanceTimersByTimeAsync(PROMPT_HOST_REDIS_TIMEOUT_MS + 1);
    await expect(pending).resolves.toBeUndefined();
    expect(PROMPT_HOST_REDIS_TIMEOUT_MS).toBeLessThanOrEqual(250);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('no Redis client: a report is logged as lost, an absent report is a silent no-op', async () => {
    redisState.available = false;
    await expect(recordPromptHostObservation(DEVICE, undefined, NOW)).resolves.toBeUndefined();
    expect(error).not.toHaveBeenCalled();
    await expect(recordPromptHostObservation(DEVICE, REPORT, NOW)).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('a client that cannot even be obtained never throws into the heartbeat', async () => {
    redisState.throws = true;
    await expect(recordPromptHostObservation(DEVICE, REPORT, NOW)).resolves.toBeUndefined();
    await expect(recordPromptHostObservation(DEVICE, undefined, NOW)).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledTimes(1);
    expect(await readPromptHostObservation(DEVICE)).toBeNull();
  });

  it('a client that is not ready is skipped outright (its offline queue would stall the beat)', async () => {
    redis.status = 'reconnecting';
    await recordPromptHostObservation(DEVICE, REPORT, NOW);
    await recordPromptHostObservation(DEVICE, undefined, NOW);
    expect(redis.set).not.toHaveBeenCalled();
    expect(redis.del).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
  });
});

describe('readPromptHostObservation', () => {
  it('returns the stored observation', async () => {
    redis.get.mockResolvedValueOnce(JSON.stringify({ ...REPORT, observedAt: NOW.toISOString() }));
    expect(await readPromptHostObservation(DEVICE)).toEqual({ ...REPORT, observedAt: NOW.toISOString() });
    expect(redis.get).toHaveBeenCalledWith(`prompt-host:${DEVICE}`);
  });

  it('returns null when nothing was observed (no log)', async () => {
    redis.get.mockResolvedValueOnce(null);
    expect(await readPromptHostObservation(DEVICE)).toBeNull();
    expect(error).not.toHaveBeenCalled();
  });

  it('fails closed to null and logs when the store read fails', async () => {
    redis.get.mockRejectedValueOnce(new Error('down'));
    expect(await readPromptHostObservation(DEVICE)).toBeNull();
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]![0])).toContain('prompt host observation read failed');
  });

  it('read-fault logging is throttled (an outage does not log on every device-page view)', async () => {
    redis.get.mockRejectedValue(new Error('down'));
    for (let i = 0; i < 10; i += 1) expect(await readPromptHostObservation(DEVICE)).toBeNull();
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('read and write faults are throttled separately (one cannot hide the other)', async () => {
    redis.set.mockRejectedValue(new Error('down'));
    redis.get.mockRejectedValue(new Error('down'));
    await recordPromptHostObservation(DEVICE, REPORT, NOW);
    expect(await readPromptHostObservation(DEVICE)).toBeNull();
    expect(error).toHaveBeenCalledTimes(2);
  });

  it('fails closed to null and logs when there is no Redis client', async () => {
    redisState.available = false;
    expect(await readPromptHostObservation(DEVICE)).toBeNull();
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('fails closed to null and logs when the client is not ready', async () => {
    redis.status = 'connecting';
    expect(await readPromptHostObservation(DEVICE)).toBeNull();
    expect(redis.get).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('fails closed to null and logs when the read is slow', async () => {
    vi.useFakeTimers();
    redis.get.mockReturnValueOnce(new Promise(() => {}));
    const pending = readPromptHostObservation(DEVICE);
    await vi.advanceTimersByTimeAsync(PROMPT_HOST_REDIS_TIMEOUT_MS + 1);
    expect(await pending).toBeNull();
    expect(error).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['not JSON', '{oops'],
    ['wrong shape', JSON.stringify({ protocolVersion: 'one' })],
    ['a bad kind', JSON.stringify({ ...REPORT, kinds: ['Notice'], observedAt: NOW.toISOString() })],
    ['no observedAt', JSON.stringify(REPORT)],
  ])('a corrupt entry (%s) reads as null and is logged', async (_label, raw) => {
    redis.get.mockResolvedValueOnce(raw);
    expect(await readPromptHostObservation(DEVICE)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('round-trips what record stored', async () => {
    await recordPromptHostObservation(DEVICE, REPORT, NOW);
    redis.get.mockResolvedValueOnce(redis.set.mock.calls[0]![1]);
    expect(await readPromptHostObservation(DEVICE)).toEqual({ ...REPORT, observedAt: NOW.toISOString() });
  });
});

describe('notePromptHostReportDropped', () => {
  const rawWith = (promptHost: unknown) => ({ helperCapabilities: { callerVerify: true, usernames: [], promptHost } });

  it.each([
    ['a malformed object', { protocolVersion: 'one', kinds: [], rendererVersion: '0.2.0' }],
    ['a string', 'assist'],
    ['null', null],
  ])('warns (with the device id) when the beat carried a block validation dropped: %s', (_label, promptHost) => {
    expect(notePromptHostReportDropped(DEVICE, rawWith(promptHost), undefined)).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
    const message = String(warn.mock.calls[0]![0]);
    expect(message).toContain('helperCapabilities.promptHost');
    expect(message).toContain(DEVICE);
  });

  it.each([
    ['no helperCapabilities (old agent)', {}],
    ['helperCapabilities without promptHost', { helperCapabilities: { callerVerify: true, usernames: [] } }],
    ['a non-object body', 'garbage'],
    ['an undefined body', undefined],
  ])('is silent when nothing was reported: %s', (_label, raw) => {
    expect(notePromptHostReportDropped(DEVICE, raw, undefined)).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it('is silent when the block parsed', () => {
    expect(notePromptHostReportDropped(DEVICE, rawWith(REPORT), REPORT)).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it('is throttled to one warning a minute across devices', () => {
    for (let i = 0; i < 5; i += 1) notePromptHostReportDropped(`device-${i}`, rawWith('bad'), undefined);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
