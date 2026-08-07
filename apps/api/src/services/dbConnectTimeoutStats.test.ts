import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetDbConnectTimeoutStatsForTests,
  getDbConnectTimeoutStats,
  recordDbConnectTimeout,
  setDbConnectTimeoutMetricsRecorder,
} from './dbConnectTimeoutStats';

describe('dbConnectTimeoutStats (#3214)', () => {
  beforeEach(() => {
    __resetDbConnectTimeoutStatsForTests();
  });

  it('counts timeouts and reports a per-minute rate over the window', () => {
    const now = 1_000_000;
    for (let i = 0; i < 12; i += 1) {
      recordDbConnectTimeout(new Error(`t${i}`), 'connectivity', now);
    }

    const stats = getDbConnectTimeoutStats(60_000, now);
    expect(stats.timeouts).toBe(12);
    expect(stats.ratePerMin).toBe(12);
    expect(stats.byCause.connectivity).toBe(12);
    expect(stats.totalSinceStart).toBe(12);
  });

  it('normalises the rate to per-minute for windows other than a minute', () => {
    const now = 1_000_000;
    for (let i = 0; i < 10; i += 1) {
      recordDbConnectTimeout(new Error(`t${i}`), 'unknown', now);
    }

    // 10 timeouts over 5 minutes is 2/min, not 10.
    expect(getDbConnectTimeoutStats(5 * 60_000, now).ratePerMin).toBe(2);
  });

  it('drops samples that fall outside the window', () => {
    const start = 1_000_000;
    recordDbConnectTimeout(new Error('old'), 'connectivity', start);
    recordDbConnectTimeout(new Error('recent'), 'connectivity', start + 90_000);

    const stats = getDbConnectTimeoutStats(60_000, start + 100_000);
    expect(stats.timeouts).toBe(1);
    // The lifetime total is deliberately NOT trimmed — it is the only way to
    // tell "quiet now" apart from "never happened".
    expect(stats.totalSinceStart).toBe(2);
  });

  it('counts the same error object only once', () => {
    // Both production call sites (app.onError, then captureException) classify
    // the SAME error. Without dedupe the rate would be silently 2x on the
    // request path and 1x on the worker path, making any threshold meaningless.
    const err = new Error('write CONNECT_TIMEOUT');
    const now = 1_000_000;

    recordDbConnectTimeout(err, 'connectivity', now);
    recordDbConnectTimeout(err, 'connectivity', now);
    recordDbConnectTimeout(err, 'event-loop-starvation', now);

    expect(getDbConnectTimeoutStats(60_000, now).timeouts).toBe(1);
  });

  it('counts distinct error objects separately', () => {
    const now = 1_000_000;
    recordDbConnectTimeout(new Error('a'), 'connectivity', now);
    recordDbConnectTimeout(new Error('b'), 'connectivity', now);

    expect(getDbConnectTimeoutStats(60_000, now).timeouts).toBe(2);
  });

  it('breaks counts down by diagnosed cause', () => {
    const now = 1_000_000;
    recordDbConnectTimeout(new Error('a'), 'event-loop-starvation', now);
    recordDbConnectTimeout(new Error('b'), 'event-loop-starvation', now);
    recordDbConnectTimeout(new Error('c'), 'connectivity', now);
    recordDbConnectTimeout(new Error('d'), 'unknown', now);

    const stats = getDbConnectTimeoutStats(60_000, now);
    expect(stats.byCause).toEqual({
      'event-loop-starvation': 2,
      connectivity: 1,
      unknown: 1,
    });
  });

  it('notifies the metrics recorder once per counted timeout', () => {
    const onConnectTimeout = vi.fn();
    setDbConnectTimeoutMetricsRecorder({ onConnectTimeout });

    const err = new Error('dup');
    recordDbConnectTimeout(err, 'connectivity', 1);
    recordDbConnectTimeout(err, 'connectivity', 1); // deduped
    recordDbConnectTimeout(new Error('other'), 'unknown', 1);

    expect(onConnectTimeout).toHaveBeenCalledTimes(2);
    expect(onConnectTimeout).toHaveBeenNthCalledWith(1, 'connectivity');
    expect(onConnectTimeout).toHaveBeenNthCalledWith(2, 'unknown');
  });

  it('never throws when the recorder throws', () => {
    // This runs on an error path; a throw here would displace the real failure.
    setDbConnectTimeoutMetricsRecorder({
      onConnectTimeout: () => {
        throw new Error('prom-client exploded');
      },
    });

    expect(() => recordDbConnectTimeout(new Error('x'), 'connectivity', 1)).not.toThrow();
    // The sample is still recorded — the recorder fires last, after the push.
    expect(getDbConnectTimeoutStats(60_000, 1).timeouts).toBe(1);
  });

  it('never throws on a frozen error object', () => {
    const frozen = Object.freeze(new Error('frozen'));
    expect(() => recordDbConnectTimeout(frozen, 'connectivity', 1)).not.toThrow();
    expect(getDbConnectTimeoutStats(60_000, 1).timeouts).toBe(1);
  });

  it('records non-object throwables without a dedupe marker', () => {
    // Primitives cannot carry the symbol. Under-counting is the accepted
    // failure mode, so they are counted rather than dropped.
    expect(() => recordDbConnectTimeout('CONNECT_TIMEOUT', 'unknown', 1)).not.toThrow();
    expect(getDbConnectTimeoutStats(60_000, 1).timeouts).toBe(1);
  });

  it('does not leave an enumerable marker on the error', () => {
    // A marker that serialized into an error body would leak internals into API
    // responses and log payloads.
    const err = new Error('boom');
    recordDbConnectTimeout(err, 'connectivity', 1);
    expect(Object.keys(err)).toEqual([]);
    expect(JSON.stringify({ ...err })).toBe('{}');
  });

  it('falls back to the default window for a non-positive window', () => {
    const stats = getDbConnectTimeoutStats(0, 1);
    expect(stats.windowMs).toBe(5 * 60_000);
  });

  it('a narrow reader does not destroy a wider reader’s evidence', () => {
    // Samples are shared module state. Trimming to the caller's own window would
    // let a future 60s /health readout silently truncate the watchdog's 5-minute
    // window, drop its count below threshold, and produce a below-threshold
    // verdict during a live storm — with nothing going red.
    const start = 1_000_000;
    for (let i = 0; i < 20; i += 1) {
      recordDbConnectTimeout(new Error(`t${i}`), 'connectivity', start);
    }
    const now = start + 120_000; // 2 minutes later

    // A narrow (60s) reader sees none of them...
    expect(getDbConnectTimeoutStats(60_000, now).timeouts).toBe(0);
    // ...and must not have discarded them for the 5-minute reader.
    expect(getDbConnectTimeoutStats(5 * 60_000, now).timeouts).toBe(20);
  });

  it('drops the OLDEST samples when the retention cap is hit', () => {
    // Inverting this trim would keep the oldest and discard the newest, zeroing
    // the rate during exactly the storm the cap exists for — while the
    // totalSinceStart assertions elsewhere kept passing.
    const now = 1_000_000;
    for (let i = 0; i < 10_050; i += 1) {
      recordDbConnectTimeout(new Error(`t${i}`), 'connectivity', now - 10_050 + i);
    }

    const stats = getDbConnectTimeoutStats(5 * 60_000, now);
    expect(stats.timeouts).toBe(10_000);
    expect(stats.totalSinceStart).toBe(10_050);
  });

  it('logs once — not on every call — when the recorder keeps throwing', () => {
    // The recorder is a stable closure, so one throw means the Prometheus
    // counter is dead for the process. Say so once: silence hides a flatlined
    // chart during a storm, and logging every time floods.
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      setDbConnectTimeoutMetricsRecorder({
        onConnectTimeout: () => {
          throw new Error('prom-client exploded');
        },
      });

      recordDbConnectTimeout(new Error('a'), 'connectivity', 1);
      recordDbConnectTimeout(new Error('b'), 'connectivity', 1);
      recordDbConnectTimeout(new Error('c'), 'connectivity', 1);

      expect(error).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('breeze_db_connect_timeouts_total will not advance'),
        expect.any(Error),
      );
      // The internal window is unaffected — the recorder fires after the push.
      expect(getDbConnectTimeoutStats(60_000, 1).timeouts).toBe(3);
    } finally {
      error.mockRestore();
    }
  });
});
