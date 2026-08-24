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
  getDbPoolHealthCheckFailures,
  getDbPoolHealthProbeTimeoutMs,
  getLastDbPoolHealthAssessment,
  isDbPoolHealthMonitorDisabled,
  probeFreshDatabaseConnection,
  runDbPoolHealthCheck,
  claimDbPoolHealthCaptureSlot,
  startDbPoolHealthMonitor,
  stopDbPoolHealthMonitor,
  DbPoolProbeTimedOutError,
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
    delete process.env.DB_POOL_HEALTH_PROBE_TIMEOUT_MS;
    delete process.env.DB_POOL_HEALTH_CAPTURE_THROTTLE_MS;
    delete process.env.DATABASE_URL_APP;
  });

  describe('assessDbPoolHealth', () => {
    it('reports below-threshold and does NOT probe below the threshold', async () => {
      // The probe opens a real socket. It must stay off the steady-state path,
      // otherwise a fleet of instances adds a permanent connection every tick.
      const probe = vi.fn(async () => {});
      const result = await assessDbPoolHealth({
        readStats: () => stats(3),
        probe,
        thresholdTimeouts: 10,
      });

      expect(result.verdict).toBe('below-threshold');
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

    it('reports unknown when the probe times out under event-loop starvation', async () => {
      // The probe's budget is an in-process setTimeout, so it expires when the
      // main thread is pegged just as readily as when the DB is unreachable —
      // the #3022 ambiguity, one layer up. Calling this `database-unreachable`
      // would send the operator after a DB incident AND tell them a restart
      // won't help, while the real fault is a blocked loop.
      const result = await assessDbPoolHealth({
        readStats: () => ({
          timeouts: 40,
          byCause: { 'event-loop-starvation': 30, connectivity: 10, unknown: 0 },
          windowMs: 300_000,
          ratePerMin: 8,
          totalSinceStart: 40,
        }),
        probe: async () => {
          throw new DbPoolProbeTimedOutError('pool-health probe exceeded 5000ms');
        },
        thresholdTimeouts: 10,
      });

      expect(result.verdict).toBe('unknown');
      expect(result.message).toContain('starvation');
      expect(result.message).not.toContain('DATABASE UNREACHABLE');
    });

    it('reports unknown on a probe timeout when NO cause could be measured at all', async () => {
      // With EVENT_LOOP_MONITOR_DISABLED (or the monitor still warming up) every
      // timeout is classified `unknown`. A "does starvation dominate?" test would
      // see a starvation count of 0, find no dominance, and emit the confident
      // `database-unreachable` in exactly the configuration where this module has
      // the LEAST evidence. The verdict must require positive evidence FOR a
      // connectivity fault, not merely the absence of evidence against one.
      const result = await assessDbPoolHealth({
        readStats: () => ({
          timeouts: 40,
          byCause: { 'event-loop-starvation': 0, connectivity: 0, unknown: 40 },
          windowMs: 300_000,
          ratePerMin: 8,
          totalSinceStart: 40,
        }),
        probe: async () => {
          throw new DbPoolProbeTimedOutError('pool-health probe exceeded 5000ms');
        },
        thresholdTimeouts: 10,
      });

      expect(result.verdict).toBe('unknown');
      expect(result.message).not.toContain('DATABASE UNREACHABLE');
      expect(result.message).not.toContain('Restarting the API will not help');
    });

    it('still reports database-unreachable on a probe timeout when connectivity dominates', async () => {
      // A genuinely unreachable database also makes the probe time out, and here
      // the timeouts themselves were measured as connectivity faults on a healthy
      // loop — that IS positive evidence, so the confident verdict is warranted.
      const result = await assessDbPoolHealth({
        readStats: () => ({
          timeouts: 40,
          byCause: { 'event-loop-starvation': 2, connectivity: 38, unknown: 0 },
          windowMs: 300_000,
          ratePerMin: 8,
          totalSinceStart: 40,
        }),
        probe: async () => {
          throw new DbPoolProbeTimedOutError('pool-health probe exceeded 5000ms');
        },
        thresholdTimeouts: 10,
      });

      expect(result.verdict).toBe('database-unreachable');
    });

    it('a driver-reported failure is database-unreachable regardless of cause mix', async () => {
      // Only a TIMEOUT is ambiguous. An ECONNREFUSED came from the network stack,
      // not from an in-process timer, so it stands on its own even when every
      // timeout was classified `unknown`.
      const result = await assessDbPoolHealth({
        readStats: () => ({
          timeouts: 40,
          byCause: { 'event-loop-starvation': 0, connectivity: 0, unknown: 40 },
          windowMs: 300_000,
          ratePerMin: 8,
          totalSinceStart: 40,
        }),
        probe: async () => {
          throw new Error('connect ECONNREFUSED 10.0.0.5:5432');
        },
        thresholdTimeouts: 10,
      });

      expect(result.verdict).toBe('database-unreachable');
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
    it('stores the assessment and stays silent below the threshold', async () => {
      await runDbPoolHealthCheck({
        readStats: () => stats(0),
        probe: async () => {},
        thresholdTimeouts: 10,
      });

      expect(getLastDbPoolHealthAssessment()?.verdict).toBe('below-threshold');
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
        expect.objectContaining({
          eventCode: 'db_pool_health_degraded',
          tags: { db_pool_health_verdict: 'pool-degraded' },
        }),
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
      expect(getDbPoolHealthCheckFailures()).toBe(1);
    });

    it('CLEARS the previous verdict when a check fails, rather than leaving it standing', async () => {
      // lastAssessment drives the Prometheus verdict series. Leaving a stale
      // value would republish an old below-threshold reading on every scrape for
      // hours, about a watchdog that has been dead the whole time — an
      // affirmative wrong answer, worse than the "not observed" null produces.
      await runDbPoolHealthCheck({
        readStats: () => stats(0),
        probe: async () => {},
        thresholdTimeouts: 10,
      });
      expect(getLastDbPoolHealthAssessment()).not.toBeNull();

      await runDbPoolHealthCheck({
        readStats: () => {
          throw new Error('stats exploded');
        },
      });

      expect(getLastDbPoolHealthAssessment()).toBeNull();
    });

    it('keeps a valid verdict when the Sentry report itself throws', async () => {
      // The outer catch now CLEARS lastAssessment. A reporter fault must not
      // reach it — that would erase a real pool-degraded verdict from /metrics
      // at the exact moment it fired, and show a reporting error instead.
      captureMessage.mockImplementationOnce(() => {
        throw new Error('sentry transport exploded');
      });

      const result = await runDbPoolHealthCheck({
        readStats: () => stats(40),
        probe: async () => {},
        thresholdTimeouts: 10,
      });

      expect(result?.verdict).toBe('pool-degraded');
      expect(getLastDbPoolHealthAssessment()?.verdict).toBe('pool-degraded');
      expect(getDbPoolHealthCheckFailures()).toBe(0);
      expect(console.error).toHaveBeenCalledWith(
        '[db-pool-health] failed to report verdict to Sentry:',
        expect.any(Error),
      );
    });

    it('reports its own failure to Sentry, not only to the console', async () => {
      // A watchdog failing every tick is otherwise console-only, which is
      // exactly the invisibility this module exists to remove.
      await runDbPoolHealthCheck({
        readStats: () => {
          throw new Error('stats exploded');
        },
      });

      expect(captureMessage).toHaveBeenCalledWith(
        '[db-pool-health] watchdog evaluation failed',
        expect.objectContaining({
          eventCode: 'db_pool_health_check_failed',
          tags: { db_pool_health_verdict: 'check-failed' },
        }),
      );
    });

    it('throttles the Sentry capture across repeated degraded ticks', async () => {
      // The unit test for the gate proves the arithmetic; this proves the gate is
      // actually CONSULTED here. Without it, a condition that persists until
      // restart captures every 60s — the flood that has twice blacked out the
      // org's Sentry quota.
      process.env.DB_POOL_HEALTH_CAPTURE_THROTTLE_MS = '900000';
      const deps = {
        readStats: () => stats(40),
        probe: async () => {},
        thresholdTimeouts: 10,
      };

      await runDbPoolHealthCheck(deps);
      await runDbPoolHealthCheck(deps);
      await runDbPoolHealthCheck(deps);

      expect(captureMessage).toHaveBeenCalledTimes(1);
      // Console is deliberately NOT throttled — logs stay complete.
      expect(console.warn).toHaveBeenCalledTimes(3);
    });

    it('captures every tick when the throttle is disabled', async () => {
      process.env.DB_POOL_HEALTH_CAPTURE_THROTTLE_MS = '0';
      const deps = {
        readStats: () => stats(40),
        probe: async () => {},
        thresholdTimeouts: 10,
      };

      await runDbPoolHealthCheck(deps);
      await runDbPoolHealthCheck(deps);

      expect(captureMessage).toHaveBeenCalledTimes(2);
    });

    it('uses a STABLE Sentry title so the alert does not fragment per rate', async () => {
      // Sentry groups by message text. Interpolating the rate into the title
      // mints a fresh issue on every capture, so an alert bound to an issue can
      // never fire twice and "Resolve" never sticks.
      process.env.DB_POOL_HEALTH_CAPTURE_THROTTLE_MS = '0';
      await runDbPoolHealthCheck({
        readStats: () => stats(40),
        probe: async () => {},
        thresholdTimeouts: 10,
      });
      await runDbPoolHealthCheck({
        readStats: () => stats(97),
        probe: async () => {},
        thresholdTimeouts: 10,
      });

      const titles = captureMessage.mock.calls.map((call) => call[0] as string);
      // Identical across two very different measurements — one Sentry issue.
      expect(titles).toHaveLength(2);
      expect(new Set(titles).size).toBe(1);
      // A stable issue reference is fine; the varying MEASUREMENTS are not.
      expect(titles[0]).not.toContain('40');
      expect(titles[0]).not.toContain('97');
      expect(titles[0]).not.toContain('/min');
      // The numbers still reach the console line in full.
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('97 CONNECT_TIMEOUT(s)'));
    });

    it('states how many captures the throttle suppressed', async () => {
      // Without this the one event that lands implies a single occurrence.
      process.env.DB_POOL_HEALTH_CAPTURE_THROTTLE_MS = '900000';
      const deps = {
        readStats: () => stats(40),
        probe: async () => {},
        thresholdTimeouts: 10,
      };
      await runDbPoolHealthCheck(deps); // captured
      await runDbPoolHealthCheck(deps); // suppressed
      await runDbPoolHealthCheck(deps); // suppressed

      process.env.DB_POOL_HEALTH_CAPTURE_THROTTLE_MS = '0';
      await runDbPoolHealthCheck(deps); // captured again

      // BREEZE-18: this used to assert on the `extra` bag, which was never
      // attached to the event and was deleted by scrubEvent before send — so it
      // proved only that the object was BUILT, never that an operator could see
      // the count. It now goes to the console, and that is what is asserted.
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('2 capture(s) suppressed by the throttle'),
      );
    });
  });

  describe('claimDbPoolHealthCaptureSlot', () => {
    it('throttles a repeated verdict inside the window', () => {
      // A degraded pool stays degraded until a restart, so every tick would
      // report it. Unthrottled, that has twice exhausted the org Sentry quota.
      expect(claimDbPoolHealthCaptureSlot('pool-degraded', 0, 60_000)).toBe(true);
      expect(claimDbPoolHealthCaptureSlot('pool-degraded', 30_000, 60_000)).toBe(false);
      expect(claimDbPoolHealthCaptureSlot('pool-degraded', 60_000, 60_000)).toBe(true);
    });

    it('throttles each verdict independently', () => {
      // A pool-degraded -> database-unreachable transition is a material change
      // of remedy and must not be swallowed by the other verdict's throttle.
      expect(claimDbPoolHealthCaptureSlot('pool-degraded', 0, 60_000)).toBe(true);
      expect(claimDbPoolHealthCaptureSlot('database-unreachable', 0, 60_000)).toBe(true);
    });

    it('disables throttling at 0', () => {
      expect(claimDbPoolHealthCaptureSlot('pool-degraded', 0, 0)).toBe(true);
      expect(claimDbPoolHealthCaptureSlot('pool-degraded', 0, 0)).toBe(true);
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

    it('clamps the probe budget to half the interval so a probe cannot outlive its tick', () => {
      // These two knobs are independently settable and the probe has no natural
      // ceiling, so without the clamp `INTERVAL=5000, PROBE=30000` is legal and
      // every tick overlaps — each opening another connection to a database that
      // is, in the degraded case, already the scarce resource.
      process.env.DB_POOL_HEALTH_INTERVAL_MS = '5000';
      process.env.DB_POOL_HEALTH_PROBE_TIMEOUT_MS = '30000';
      expect(getDbPoolHealthProbeTimeoutMs()).toBe(2_500);
    });

    it('leaves the probe budget alone when it already fits the interval', () => {
      process.env.DB_POOL_HEALTH_INTERVAL_MS = '60000';
      process.env.DB_POOL_HEALTH_PROBE_TIMEOUT_MS = '5000';
      expect(getDbPoolHealthProbeTimeoutMs()).toBe(5_000);
    });
  });

  describe('the armed timer', () => {
    it('actually runs a check when it fires', async () => {
      // Without this, emptying the interval body is invisible: the watchdog
      // never evaluates, every gauge stays 0, and no test goes red.
      vi.useFakeTimers();
      try {
        process.env.DB_POOL_HEALTH_INTERVAL_MS = '5000';
        expect(startDbPoolHealthMonitor()).toBe(5_000);
        expect(getLastDbPoolHealthAssessment()).toBeNull();

        await vi.advanceTimersByTimeAsync(5_000);

        // The real probe is never reached: a default evaluation reads the real
        // (empty) stats window, falls below threshold, and returns without one.
        expect(getLastDbPoolHealthAssessment()?.verdict).toBe('below-threshold');
      } finally {
        vi.useRealTimers();
      }
    });

    it('skips a tick while the previous check is still in flight', async () => {
      vi.useFakeTimers();
      try {
        process.env.DB_POOL_HEALTH_INTERVAL_MS = '5000';
        startDbPoolHealthMonitor();

        // The default evaluation returns synchronously enough that overlapping
        // requires a stalled check; assert the guard's observable signal instead.
        await vi.advanceTimersByTimeAsync(5_000);
        await vi.advanceTimersByTimeAsync(5_000);

        // Two clean ticks, so nothing was skipped.
        expect(console.warn).not.toHaveBeenCalledWith(
          expect.stringContaining('skipping tick'),
        );
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('probeFreshDatabaseConnection (real driver, no database)', () => {
    it('throws DbPoolProbeUnavailableError when the URL cannot be parsed', async () => {
      // This is the only production source of that class, and the class is what
      // separates `unknown` from `database-unreachable`. Untested, a config fault
      // could surface as a plain Error and be reported as an unreachable
      // database the probe never even tried to contact.
      process.env.DATABASE_URL_APP = 'not a url at all';
      await expect(probeFreshDatabaseConnection(1_000)).rejects.toBeInstanceOf(
        DbPoolProbeUnavailableError,
      );
    });

    it('throws a plain error — NOT DbPoolProbeUnavailableError — when the connection is refused', async () => {
      // A refused connection is real evidence about the database, so it must not
      // be laundered into the inconclusive verdict.
      process.env.DATABASE_URL_APP = 'postgresql://u:p@127.0.0.1:1/db';
      const err = await probeFreshDatabaseConnection(2_000).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(DbPoolProbeUnavailableError);
      expect(err).not.toBeInstanceOf(DbPoolProbeTimedOutError);
    }, 10_000);
  });
});
