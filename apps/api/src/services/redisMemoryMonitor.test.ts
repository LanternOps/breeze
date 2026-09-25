import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const captureMessage = vi.fn();
vi.mock('./sentry', () => ({
  captureMessage: (...args: unknown[]) => captureMessage(...args),
}));

import {
  __resetRedisMemoryMonitorForTests,
  assessRedisMemory,
  claimRedisMemoryCaptureSlot,
  getLastRedisMemoryAssessment,
  getRedisMemoryCheckFailures,
  parseRedisMemoryInfo,
  runRedisMemoryCheck,
  startRedisMemoryMonitor,
  stopRedisMemoryMonitor,
} from './redisMemoryMonitor';

describe('redisMemoryMonitor (#6452)', () => {
  beforeEach(() => {
    captureMessage.mockClear();
    __resetRedisMemoryMonitorForTests();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    __resetRedisMemoryMonitorForTests();
    vi.restoreAllMocks();
    delete process.env.REDIS_MEMORY_MONITOR_DISABLED;
    delete process.env.REDIS_MEMORY_MONITOR_INTERVAL_MS;
    delete process.env.REDIS_MEMORY_WARN_RATIO;
    delete process.env.REDIS_MEMORY_CAPTURE_THROTTLE_MS;
  });

  describe('parseRedisMemoryInfo', () => {
    it('extracts used_memory and maxmemory from an INFO memory reply', () => {
      const info = [
        '# Memory',
        'used_memory:1048576',
        'used_memory_human:1.00M',
        'maxmemory:4194304',
        'maxmemory_human:4.00M',
        'maxmemory_policy:noeviction',
        '',
      ].join('\r\n');

      expect(parseRedisMemoryInfo(info)).toEqual({
        usedMemoryBytes: 1048576,
        maxMemoryBytes: 4194304,
      });
    });

    it('returns null when used_memory is missing (malformed reply)', () => {
      expect(parseRedisMemoryInfo('maxmemory:4194304\r\n')).toBeNull();
    });
  });

  describe('assessRedisMemory', () => {
    it('computes the ratio and does not warn below the threshold', async () => {
      const result = await assessRedisMemory({
        readInfo: async () => 'used_memory:1000000\r\nmaxmemory:4000000\r\n',
        thresholdRatio: 0.8,
      });

      expect(result.ratio).toBeCloseTo(0.25);
      expect(result.warn).toBe(false);
    });

    it('warns at or above the threshold ratio', async () => {
      const result = await assessRedisMemory({
        readInfo: async () => 'used_memory:3200000\r\nmaxmemory:4000000\r\n',
        thresholdRatio: 0.8,
      });

      expect(result.ratio).toBeCloseTo(0.8);
      expect(result.warn).toBe(true);
      expect(result.message).toContain('80');
    });

    it('reports ratio null and never warns when maxmemory is unbounded (0)', async () => {
      // noeviction with maxmemory=0 means Redis will happily grow until the OS
      // kills it — there is no ratio to compute, and reporting 0 would read as
      // "plenty of headroom" instead of "not configured to be observed".
      const result = await assessRedisMemory({
        readInfo: async () => 'used_memory:3200000\r\nmaxmemory:0\r\n',
        thresholdRatio: 0.8,
      });

      expect(result.ratio).toBeNull();
      expect(result.warn).toBe(false);
    });
  });

  describe('runRedisMemoryCheck', () => {
    it('records a successful assessment and does not increment failures', async () => {
      const assessment = await runRedisMemoryCheck({
        readInfo: async () => 'used_memory:1000\r\nmaxmemory:10000\r\n',
        thresholdRatio: 0.8,
      });

      expect(assessment?.ratio).toBeCloseTo(0.1);
      expect(getLastRedisMemoryAssessment()).toEqual(assessment);
      expect(getRedisMemoryCheckFailures()).toBe(0);
    });

    it('clears the last assessment and counts a failure when the read throws', async () => {
      await runRedisMemoryCheck({
        readInfo: async () => 'used_memory:1000\r\nmaxmemory:10000\r\n',
        thresholdRatio: 0.8,
      });
      expect(getLastRedisMemoryAssessment()).not.toBeNull();

      const result = await runRedisMemoryCheck({
        readInfo: async () => {
          throw new Error('ECONNREFUSED');
        },
        thresholdRatio: 0.8,
      });

      expect(result).toBeNull();
      // A stale "healthy" reading must not survive a failed check — see #3214's
      // dbPoolHealthMonitor for the same rule.
      expect(getLastRedisMemoryAssessment()).toBeNull();
      expect(getRedisMemoryCheckFailures()).toBe(1);
    });

    it('reports to Sentry (throttled) when crossing the warn threshold', async () => {
      await runRedisMemoryCheck({
        readInfo: async () => 'used_memory:3200000\r\nmaxmemory:4000000\r\n',
        thresholdRatio: 0.8,
      });

      expect(captureMessage).toHaveBeenCalledTimes(1);
    });
  });

  describe('claimRedisMemoryCaptureSlot', () => {
    it('allows exactly one claim per throttle window', () => {
      expect(claimRedisMemoryCaptureSlot('k', 0, 1000)).toBe(true);
      expect(claimRedisMemoryCaptureSlot('k', 500, 1000)).toBe(false);
      expect(claimRedisMemoryCaptureSlot('k', 1000, 1000)).toBe(true);
    });
  });

  describe('start/stop', () => {
    it('is idempotent and returns the interval, or null when disabled', () => {
      process.env.REDIS_MEMORY_MONITOR_DISABLED = 'true';
      expect(startRedisMemoryMonitor()).toBeNull();
      delete process.env.REDIS_MEMORY_MONITOR_DISABLED;

      const first = startRedisMemoryMonitor();
      const second = startRedisMemoryMonitor();
      expect(first).not.toBeNull();
      expect(second).toBe(first);
      stopRedisMemoryMonitor();
    });
  });
});
