import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const captureMessage = vi.fn();
vi.mock('../services/sentry', () => ({
  captureMessage: (...args: unknown[]) => captureMessage(...args),
}));

import {
  __resetDbPoolHealthMonitorForTests,
  assessDbPoolHealth,
  getDbPoolHealthMinTimeouts,
  getDbPoolHealthWindowMs,
  getLastDbPoolHealthAssessment,
  isDbPoolHealthMonitorDisabled,
  runDbPoolHealthCheck,
  shouldCaptureDbPoolHealth,
  startDbPoolHealthMonitor,
  stopDbPoolHealthMonitor,
  DbPoolProbeUnavailableError,
} from './dbPoolHealthMonitor';
import type { DbConnectTimeoutWindowStats } from '../services/dbConnectTimeoutStats';

function stats(timeouts: number, windowMs = 300_000): DbConnectTimeoutWindowStats {
  return {
    timeouts,
    byCause: { 'event-loop-starvation': 0, connectivity: timeouts, unknown: 0 },
    windowMs,
    ratePerMin: (timeouts * 60_000) / windowMs,
    totalSinceStart: timeouts,
  };
}

describe('dbPoolHealthMonitor (#3214)', () => {
  beforeEach(() => {
    captureMessage.mockClear();
    __resetDbPoolHealthMonitorForTests();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    __resetDbPoolHealthMonitorForTests();
    vi.restoreAllMocks();
    delete process.env.DB_POOL_HEALTH_DISABLED;
    delete process.env.DB_POOL_HEALTH_INTERVAL_MS;
    delete process.env.DB_POOL_HEALTH_WINDOW_MS;
    delete process.env.DB_POOL_HEALTH_MIN_TIMEOUTS;
  });

  describe('assessDbPoolHealth', () => {
    it('reports healthy and does NOT probe below the threshold', async () => {
      // The probe opens a real socket. It must stay off the steady-state path,
      // otherwise a fleet of instances adds a permanent connection every tick.
      const probe = vi.fn(async () => {});
      const result = await assessDbPoolHealth({
        readStats: () => stats(3),
        probe,
        thresholdTimeouts: 10,
      });

      expect(result.verdict).toBe('healthy');
      expect(probe).not.toHaveBeenCalled();
      expect(result.probeMs).toBeNull();
    });

    it('diagnoses pool-degraded when timeouts are sustained but a fresh connection succeeds', async () => {
      // This is the #3214 signature and the whole point of the module: the DB is
      // reachable, so the fault is in the process's own pool.
      const result = await assessDbPoolHealth({
        readStats: () => stats(40),
        probe: async () => {},
        thresholdTimeouts: 10,
      });

      expect(result.verdict).toBe('pool-degraded');
      expect(result.probeError).toBeNull();
      expect(result.message).toContain('POOL DEGRADED');
      expect(result.message).toContain('restart the API process');
      expect(result.message).toContain('#3214');
    });

    it('diagnoses database-unreachable when the fresh connection also fails', async () => {
      const result = await assessDbPoolHealth({
        readStats: () => stats(40),
        probe: async () => {
          throw new Error('ECONNREFUSED 10.0.0.5:5432');
        },
        thresholdTimeouts: 10,
      });

      expect(result.verdict).toBe('database-unreachable');
      expect(result.probeError).toContain('ECONNREFUSED');
      expect(result.message).toContain('DATABASE UNREACHABLE');
      // Naming the wrong remedy is the failure this module exists to prevent.
      expect(result.message).toContain('Restarting the API will not help');
      expect(result.message).not.toContain('POOL DEGRADED');
    });

    it('probes exactly at the threshold, not one above it', async () => {
      const probe = vi.fn(async () => {});
      const result = await assessDbPoolHealth({
        readStats: () => stats(10),
        probe,
        thresholdTimeouts: 10,
      });

      expect(probe).toHaveBeenCalledTimes(1);
      expect(result.verdict).toBe('pool-degraded');
    });

    it('reports unknown — never database-unreachable — when the probe could not be attempted', async () => {
      // A probe that never ran is evidence of nothing. Reporting it as
      // `database-unreachable` would send an operator hunting a DB incident that
      // this module has no evidence for, with more authority than the raw error.
      const result = await assessDbPoolHealth({
        readStats: () => stats(40),
        probe: async () => {
          throw new DbPoolProbeUnavailableError('could not construct a probe client: bad URL');
        },
        thresholdTimeouts: 10,
      });

      expect(result.verdict).toBe('unknown');
      expect(result.message).toContain('nothing may be concluded');
      expect(result.message).not.toContain('DATABASE UNREACHABLE');
      expect(result.message).not.toContain('POOL DEGRADED');
    });

    it('surfaces a non-Error probe rejection as a string', async () => {
      const result = await assessDbPoolHealth({
        readStats: () => stats(40),
        probe: async () => {
          throw 'plain string rejection';
        },
        thresholdTimeouts: 10,
      });

      expect(result.verdict).toBe('database-unreachable');
      expect(result.probeError).toBe('plain string rejection');
    });

    it('states the measured rate, not just the verdict', async () => {
      const result = await assessDbPoolHealth({
        readStats: () => stats(60, 300_000),
        probe: async () => {},
        thresholdTimeouts: 10,
        windowMs: 300_000,
      });

      expect(result.message).toContain('60 CONNECT_TIMEOUT(s)');
      expect(result.message).toContain('12.0/min');
    });
  });

  describe('runDbPoolHealthCheck', () => {
    it('stores the assessment and stays silent when healthy', async () => {
      await runDbPoolHealthCheck({
        readStats: () => stats(0),
        probe: async () => {},
        thresholdTimeouts: 10,
      });

      expect(getLastDbPoolHealthAssessment()?.verdict).toBe('healthy');
      expect(captureMessage).not.toHaveBeenCalled();
      expect(console.warn).not.toHaveBeenCalled();
    });

    it('warns and captures on a degraded verdict', async () => {
      await runDbPoolHealthCheck({
        readStats: () => stats(40),
        probe: async () => {},
        thresholdTimeouts: 10,
      });

      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('POOL DEGRADED'));
      expect(captureMessage).toHaveBeenCalledTimes(1);
      expect(captureMessage).toHaveBeenCalledWith(
        expect.stringContaining('POOL DEGRADED'),
        'warning',
        expect.objectContaining({ verdict: 'pool-degraded', timeouts: 40 }),
        { dbPoolHealthVerdict: 'pool-degraded' },
      );
    });

    it('never throws when the stats read itself fails', async () => {
      // A watchdog that can crash the tick it runs on is worse than none.
      const result = await runDbPoolHealthCheck({
        readStats: () => {
          throw new Error('stats exploded');
        },
      });

      expect(result).toBeNull();
      expect(console.error).toHaveBeenCalledWith(
        '[db-pool-health] check failed:',
        expect.any(Error),
      );
    });
  });

  describe('shouldCaptureDbPoolHealth', () => {
    it('throttles a repeated verdict inside the window', () => {
      // A degraded pool stays degraded until a restart, so every tick would
      // report it. Unthrottled, that has twice exhausted the org Sentry quota.
      expect(shouldCaptureDbPoolHealth('pool-degraded', 0, 60_000)).toBe(true);
      expect(shouldCaptureDbPoolHealth('pool-degraded', 30_000, 60_000)).toBe(false);
      expect(shouldCaptureDbPoolHealth('pool-degraded', 60_000, 60_000)).toBe(true);
    });

    it('throttles each verdict independently', () => {
      // A pool-degraded -> database-unreachable transition is a material change
      // of remedy and must not be swallowed by the other verdict's throttle.
      expect(shouldCaptureDbPoolHealth('pool-degraded', 0, 60_000)).toBe(true);
      expect(shouldCaptureDbPoolHealth('database-unreachable', 0, 60_000)).toBe(true);
    });

    it('disables throttling at 0', () => {
      expect(shouldCaptureDbPoolHealth('pool-degraded', 0, 0)).toBe(true);
      expect(shouldCaptureDbPoolHealth('pool-degraded', 0, 0)).toBe(true);
    });
  });

  describe('lifecycle', () => {
    it('returns null and starts nothing when disabled', () => {
      process.env.DB_POOL_HEALTH_DISABLED = 'true';
      expect(isDbPoolHealthMonitorDisabled()).toBe(true);
      expect(startDbPoolHealthMonitor()).toBeNull();
    });

    it('is idempotent and stoppable', () => {
      process.env.DB_POOL_HEALTH_INTERVAL_MS = '5000';
      expect(startDbPoolHealthMonitor()).toBe(5_000);
      expect(startDbPoolHealthMonitor()).toBe(5_000);
      expect(() => stopDbPoolHealthMonitor()).not.toThrow();
      expect(() => stopDbPoolHealthMonitor()).not.toThrow();
    });

    it('reports the interval the armed timer actually uses, not a re-read of the env', () => {
      // The boot log states this interval as fact. A second call after an env
      // change must not claim a cadence the running timer does not have.
      process.env.DB_POOL_HEALTH_INTERVAL_MS = '5000';
      expect(startDbPoolHealthMonitor()).toBe(5_000);
      process.env.DB_POOL_HEALTH_INTERVAL_MS = '30000';
      expect(startDbPoolHealthMonitor()).toBe(5_000);

      // After a stop, a fresh start picks up the new value.
      stopDbPoolHealthMonitor();
      expect(startDbPoolHealthMonitor()).toBe(30_000);
    });

    it('publishes no verdict before the first evaluation', () => {
      // Consumers must render this as "not observed". Collapsing it into
      // "healthy" is how a blind instance looks fine on a dashboard.
      expect(getLastDbPoolHealthAssessment()).toBeNull();
    });
  });

  describe('configuration', () => {
    it('floors the interval so it cannot be tuned into a hot loop', () => {
      process.env.DB_POOL_HEALTH_INTERVAL_MS = '1';
      expect(startDbPoolHealthMonitor()).toBe(60_000);
    });

    it('ignores unparseable values and uses defaults', () => {
      process.env.DB_POOL_HEALTH_WINDOW_MS = 'five minutes';
      process.env.DB_POOL_HEALTH_MIN_TIMEOUTS = '';
      expect(getDbPoolHealthWindowMs()).toBe(5 * 60_000);
      expect(getDbPoolHealthMinTimeouts()).toBe(10);
    });

    it('accepts a valid override', () => {
      process.env.DB_POOL_HEALTH_MIN_TIMEOUTS = '25';
      expect(getDbPoolHealthMinTimeouts()).toBe(25);
    });
  });
});
