import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { IntervalHistogram } from 'node:perf_hooks';
import {
  EventLoopLagMonitor,
  bucketEventLoopLag,
  getEventLoopLagStats,
  getEventLoopStarvationThresholdMs,
  readEventLoopLag,
  startEventLoopMonitor,
  stopEventLoopMonitor,
  __setEventLoopMonitorForTests,
} from './eventLoopMonitor';

const NS_PER_MS = 1e6;

/**
 * Minimal stand-in for the native histogram. Only the four members the monitor
 * touches are implemented; everything else is absent by design so a future
 * dependency on another member fails loudly in the type checker rather than
 * silently reading undefined.
 */
class FakeHistogram {
  max = 0;
  mean = 0;
  enabled = false;
  resetCount = 0;

  enable(): boolean {
    this.enabled = true;
    return true;
  }

  disable(): boolean {
    this.enabled = false;
    return true;
  }

  reset(): void {
    this.resetCount += 1;
    this.max = 0;
    this.mean = 0;
  }

  /** Set the values the next sample will read, in milliseconds. */
  setLagMs(maxMs: number, meanMs = maxMs): void {
    this.max = maxMs * NS_PER_MS;
    this.mean = meanMs * NS_PER_MS;
  }

  asIntervalHistogram(): IntervalHistogram {
    return this as unknown as IntervalHistogram;
  }
}

interface Harness {
  monitor: EventLoopLagMonitor;
  histogram: FakeHistogram;
  setNow: (ms: number) => void;
}

/**
 * Every monitor built here is stopped in afterEach. start() arms a real
 * setInterval, and vitest shares one worker process across test files — a
 * leaked sampler keeps firing under whatever runs next, which is exactly how a
 * suite becomes flaky for files that never touched this module.
 */
const activeMonitors: EventLoopLagMonitor[] = [];

function stopActiveMonitors(): void {
  while (activeMonitors.length > 0) {
    activeMonitors.pop()!.stop();
  }
}

function makeMonitor(options: { sampleIntervalMs?: number; retentionMs?: number } = {}): Harness {
  const histogram = new FakeHistogram();
  let now = 1_000_000;
  const monitor = new EventLoopLagMonitor({
    sampleIntervalMs: options.sampleIntervalMs ?? 1_000,
    retentionMs: options.retentionMs ?? 120_000,
    now: () => now,
    createHistogram: () => histogram.asIntervalHistogram(),
  });
  activeMonitors.push(monitor);
  return { monitor, histogram, setNow: (ms) => { now = ms; } };
}

describe('EventLoopLagMonitor', () => {
  afterEach(() => {
    stopActiveMonitors();
    stopEventLoopMonitor();
    __setEventLoopMonitorForTests(null);
    delete process.env.EVENT_LOOP_STARVATION_WARN_MS;
    delete process.env.EVENT_LOOP_MONITOR_DISABLED;
  });

  it('reports unmonitored until started, and never reports a stopped monitor as healthy', () => {
    const { monitor } = makeMonitor();

    const before = monitor.read(10_000);
    expect(before.monitored).toBe(false);
    expect(before.worstLagMs).toBe(0);

    monitor.start();
    expect(monitor.read(10_000).monitored).toBe(true);

    monitor.stop();
    // The distinction that matters: lag 0 + monitored false means "no evidence",
    // and every consumer must branch on `monitored`, not on the zero.
    expect(monitor.read(10_000).monitored).toBe(false);
  });

  it('converts histogram nanoseconds to milliseconds and resets between samples', () => {
    const { monitor, histogram, setNow } = makeMonitor();
    monitor.start();

    histogram.setLagMs(2_500, 40);
    setNow(1_001_000);
    const sample = monitor.sampleNow();

    expect(sample).toEqual({ atMs: 1_001_000, maxLagMs: 2_500, meanLagMs: 40 });
    // Reset is what makes each sample cover only its own interval; without it a
    // single early spike would pin `max` high forever and every later window
    // would falsely read as starved.
    expect(histogram.resetCount).toBe(1);
    expect(histogram.max).toBe(0);
  });

  it('normalises the empty-histogram sentinels (Infinity max, NaN mean) to zero', () => {
    const { monitor, histogram, setNow } = makeMonitor();
    monitor.start();

    // What a native histogram that recorded nothing actually returns.
    histogram.max = Infinity;
    histogram.mean = Number.NaN;
    setNow(1_001_000);

    const sample = monitor.sampleNow();
    expect(sample?.maxLagMs).toBe(0);
    expect(sample?.meanLagMs).toBe(0);
    // NaN >= threshold is false, so an unnormalised value would read as
    // "healthy" by accident. Assert the normalisation is deliberate.
    expect(Number.isFinite(sample!.maxLagMs)).toBe(true);
  });

  it('returns the worst sampled lag inside the window and ignores older samples', () => {
    const { monitor, histogram, setNow } = makeMonitor();
    monitor.start();

    histogram.setLagMs(8_000);
    setNow(1_001_000);
    monitor.sampleNow();

    for (let i = 2; i <= 20; i += 1) {
      // Re-arm each interval: sampleNow() resets the histogram, so a single
      // setLagMs before the loop would only reach the first iteration.
      histogram.setLagMs(30);
      setNow(1_000_000 + i * 1_000);
      monitor.sampleNow();
    }

    // t=1_020_000. The 8s spike landed at t=1_001_000, i.e. 19s ago.
    setNow(1_020_000);
    expect(monitor.read(30_000).sampledMaxLagMs).toBe(8_000);
    expect(monitor.read(10_000).sampledMaxLagMs).toBe(30);
  });

  it('surfaces an in-flight stall that has not been sampled yet', () => {
    const { monitor, histogram, setNow } = makeMonitor({ sampleIntervalMs: 1_000 });
    monitor.start();

    histogram.setLagMs(5);
    setNow(1_001_000);
    monitor.sampleNow();

    // The loop blocks for 8s. The sampler cannot run — it is a timer, and
    // timers are exactly what a blocked loop does not deliver. This is the
    // ordering that matters: postgres.js's connect timer may fire before ours,
    // in which case the stall has not been recorded as a sample yet and only
    // the in-flight figure can reveal it.
    setNow(1_009_000);
    const reading = monitor.read(10_000);

    expect(reading.sampledMaxLagMs).toBe(5);
    // 8s elapsed since the last sample, 1s of which was the scheduled interval.
    expect(reading.inFlightLagMs).toBe(7_000);
    expect(reading.worstLagMs).toBe(7_000);
  });

  it('does not report in-flight lag while the sampler is keeping up', () => {
    const { monitor, histogram, setNow } = makeMonitor({ sampleIntervalMs: 1_000 });
    monitor.start();
    histogram.setLagMs(3);
    setNow(1_001_000);
    monitor.sampleNow();

    setNow(1_001_600);
    expect(monitor.read(10_000).inFlightLagMs).toBe(0);
  });

  it('coversWindow is false until the monitor has run for the full window', () => {
    // The bug this guards: `monitored: true` with a lag of 0 during the first
    // 10s after boot means "not observed", not "did not happen". Reading it as
    // health produces a confident, WRONG connectivity verdict.
    const { monitor, setNow } = makeMonitor({ sampleIntervalMs: 1_000 });
    monitor.start(); // t = 1_000_000

    setNow(1_009_999);
    expect(monitor.read(10_000).coversWindow).toBe(false);

    setNow(1_010_000);
    expect(monitor.read(10_000).coversWindow).toBe(true);
  });

  it('coversWindow is false when sampling is coarser than the window', () => {
    // A 12s stall under a 30s interval is invisible: no sample records it, and
    // inFlightLagMs subtracts a full 30s interval and reads 0.
    const { monitor, setNow } = makeMonitor({ sampleIntervalMs: 30_000 });
    monitor.start();

    setNow(1_600_000); // long uptime — only the interval width disqualifies it
    const reading = monitor.read(10_000);
    expect(reading.monitored).toBe(true);
    expect(reading.coversWindow).toBe(false);
  });

  it('latest() reports the last completed interval, not the retained high-water mark', () => {
    const { monitor, histogram, setNow } = makeMonitor({ sampleIntervalMs: 1_000 });
    monitor.start();

    histogram.setLagMs(9_000);
    setNow(1_001_000);
    monitor.sampleNow();

    histogram.setLagMs(4);
    setNow(1_002_000);
    monitor.sampleNow();

    setNow(1_002_500);
    // The 9s spike is still the window high-water mark...
    expect(monitor.stats().worstLagMs).toBe(9_000);
    // ...but the loop has recovered, and the instantaneous gauge must say so.
    expect(monitor.latest().worstLagMs).toBe(4);
  });

  it('prunes samples beyond the retention window', () => {
    const { monitor, histogram, setNow } = makeMonitor({ retentionMs: 5_000 });
    monitor.start();
    histogram.setLagMs(100);

    for (let i = 1; i <= 30; i += 1) {
      setNow(1_000_000 + i * 1_000);
      monitor.sampleNow();
    }

    // Bounded memory is the point: an always-on sampler must not accumulate
    // forever in a long-lived API process.
    expect(monitor.stats().sampleCount).toBeLessThanOrEqual(6);
  });

  it('flags starvation in stats() once lag reaches the configured threshold', () => {
    process.env.EVENT_LOOP_STARVATION_WARN_MS = '1000';
    const { monitor, histogram, setNow } = makeMonitor();
    monitor.start();

    histogram.setLagMs(999);
    setNow(1_001_000);
    monitor.sampleNow();
    setNow(1_001_500);
    expect(monitor.stats().starved).toBe(false);

    histogram.setLagMs(1_000);
    setNow(1_002_000);
    monitor.sampleNow();
    setNow(1_002_500);
    const stats = monitor.stats();
    expect(stats.starved).toBe(true);
    expect(stats.maxLagMs).toBe(1_000);
    expect(stats.starvationThresholdMs).toBe(1_000);
  });

  it('invokes onSample for every completed sample', () => {
    const histogram = new FakeHistogram();
    let now = 1_000_000;
    const seen: number[] = [];
    const monitor = new EventLoopLagMonitor({
      sampleIntervalMs: 1_000,
      now: () => now,
      createHistogram: () => histogram.asIntervalHistogram(),
      onSample: (s) => seen.push(s.maxLagMs),
    });
    monitor.start();

    histogram.setLagMs(42);
    now = 1_001_000;
    monitor.sampleNow();
    histogram.setLagMs(7);
    now = 1_002_000;
    monitor.sampleNow();

    expect(seen).toEqual([42, 7]);
    monitor.stop();
  });

  it('keeps sampling when the onSample consumer throws', () => {
    const histogram = new FakeHistogram();
    let now = 1_000_000;
    const monitor = new EventLoopLagMonitor({
      sampleIntervalMs: 1_000,
      now: () => now,
      createHistogram: () => histogram.asIntervalHistogram(),
      onSample: () => { throw new Error('sentry transport exploded'); },
    });
    monitor.start();

    histogram.setLagMs(5_000);
    now = 1_001_000;
    // A throwing reporter must not kill the interval callback — the monitor
    // would go silent at exactly the moment it is needed.
    expect(() => monitor.sampleNow()).not.toThrow();
    expect(monitor.read(10_000).sampledMaxLagMs).toBe(5_000);
    monitor.stop();
  });

  it('start() is idempotent and does not build a second histogram', () => {
    // The factory MUST mint a fresh instance per call. Returning one shared fake
    // makes this test vacuous: `histogram.max` survives a rebuild, so deleting
    // the idempotence guard still passes while production silently discards
    // recorded data and leaks a second setInterval that stop() never clears.
    const built: FakeHistogram[] = [];
    let now = 1_000_000;
    const monitor = new EventLoopLagMonitor({
      sampleIntervalMs: 1_000,
      now: () => now,
      createHistogram: () => {
        const h = new FakeHistogram();
        built.push(h);
        return h.asIntervalHistogram();
      },
    });
    activeMonitors.push(monitor);

    monitor.start();
    built[0]!.setLagMs(1_234);
    monitor.start();
    monitor.start();

    expect(built).toHaveLength(1);
    expect(built[0]!.max).toBe(1_234 * NS_PER_MS);
    expect(monitor.running).toBe(true);
  });

  it('stats() reports starvation from an in-flight stall alone', () => {
    // The path the Prometheus gauge and /health/ready both take. read() has its
    // own in-flight coverage; stats() computes its own max independently, and a
    // scrape landing mid-stall is exactly the one that must not read healthy.
    process.env.EVENT_LOOP_STARVATION_WARN_MS = '1000';
    const { monitor, histogram, setNow } = makeMonitor({ sampleIntervalMs: 1_000 });
    monitor.start();

    histogram.setLagMs(5);
    setNow(1_001_000);
    monitor.sampleNow();
    expect(monitor.stats().starved).toBe(false);

    // Loop blocks; no further sample can be recorded.
    setNow(1_009_000);
    const stats = monitor.stats();
    expect(stats.maxLagMs).toBe(5);
    expect(stats.inFlightLagMs).toBe(7_000);
    expect(stats.worstLagMs).toBe(7_000);
    expect(stats.starved).toBe(true);
  });

  it.each([
    [1_000, 0],
    [1_001, 1],
    [1_600, 600],
  ])('in-flight lag at exactly %ims since the last sample is %ims', (elapsed, expected) => {
    // Boundary: inFlight must be 0 at exactly one interval and 1 at one ms past.
    // An off-by-one skews every mid-stall reading in the same direction.
    const { monitor, histogram, setNow } = makeMonitor({ sampleIntervalMs: 1_000 });
    monitor.start();
    histogram.setLagMs(0);
    setNow(1_001_000);
    monitor.sampleNow();
    setNow(1_001_000 + elapsed);
    expect(monitor.read(10_000).inFlightLagMs).toBe(expected);
  });
});

describe('EventLoopLagMonitor against a real blocked loop', () => {
  afterEach(() => {
    stopActiveMonitors();
    stopEventLoopMonitor();
    __setEventLoopMonitorForTests(null);
  });

  it('records a genuine synchronous stall via the native histogram', async () => {
    // The load-bearing assumption of this whole module: perf_hooks'
    // monitorEventLoopDelay is a libuv-level timer, so it keeps accumulating
    // while JS is blocked and reports the full delay on the first tick after
    // the loop frees up. If that were not true, nothing here could observe the
    // starvation it exists to detect — so prove it against a real stall rather
    // than only against the fake histogram used everywhere else in this file.
    const monitor = new EventLoopLagMonitor({ sampleIntervalMs: 10_000, resolutionMs: 10 });
    monitor.start();

    // Let the histogram arm itself before blocking.
    await new Promise((resolve) => setTimeout(resolve, 30));

    const blockUntil = Date.now() + 250;
    while (Date.now() < blockUntil) {
      // Busy-wait: a real pegged main thread, not a fake clock.
    }

    // Yield once so the libuv timer gets its post-stall tick in.
    await new Promise((resolve) => setTimeout(resolve, 30));

    const sample = monitor.sampleNow();
    expect(sample).not.toBeNull();
    // Allow generous slack for CI scheduling noise; the assertion is that a
    // 250ms block is visible at all, not its precise magnitude.
    expect(sample!.maxLagMs).toBeGreaterThan(100);

    monitor.stop();
  });
});

describe('bucketEventLoopLag', () => {
  it.each([
    [0, 'under-1s'],
    [999, 'under-1s'],
    [1_000, '1s-5s'],
    [4_999, '1s-5s'],
    [5_000, '5s-10s'],
    [9_999, '5s-10s'],
    [10_000, 'over-10s'],
    [60_000, 'over-10s'],
  ])('buckets %ims as %s', (lagMs, expected) => {
    expect(bucketEventLoopLag(lagMs)).toBe(expected);
  });

  it('returns "unknown" when nothing was monitored', () => {
    expect(bucketEventLoopLag(50_000, false)).toBe('unknown');
  });
});

describe('module singleton', () => {
  beforeEach(() => {
    stopEventLoopMonitor();
    __setEventLoopMonitorForTests(null);
  });

  afterEach(() => {
    stopEventLoopMonitor();
    __setEventLoopMonitorForTests(null);
    delete process.env.EVENT_LOOP_MONITOR_DISABLED;
    delete process.env.EVENT_LOOP_STARVATION_WARN_MS;
  });

  it('reports unmonitored readings when no monitor is installed', () => {
    expect(readEventLoopLag(10_000).monitored).toBe(false);
    expect(getEventLoopLagStats().monitored).toBe(false);
  });

  it('EVENT_LOOP_MONITOR_DISABLED opts out without pretending the loop is healthy', () => {
    process.env.EVENT_LOOP_MONITOR_DISABLED = 'true';
    expect(startEventLoopMonitor()).toBeNull();
    expect(readEventLoopLag(10_000).monitored).toBe(false);
  });

  it('starts a real monitor and reads through the singleton accessors', () => {
    const started = startEventLoopMonitor({ sampleIntervalMs: 50 });
    expect(started).not.toBeNull();
    expect(readEventLoopLag(10_000).monitored).toBe(true);
    expect(getEventLoopLagStats().monitored).toBe(true);
  });

  it('EVENT_LOOP_MONITOR_DISABLED accepts every documented truthy spelling', () => {
    for (const value of ['1', 'true', 'YES', ' on ']) {
      process.env.EVENT_LOOP_MONITOR_DISABLED = value;
      expect(startEventLoopMonitor(), `value ${value}`).toBeNull();
    }
    process.env.EVENT_LOOP_MONITOR_DISABLED = 'false';
    expect(startEventLoopMonitor()).not.toBeNull();
  });

  it('startEventLoopMonitor is idempotent across calls', () => {
    const first = startEventLoopMonitor({ sampleIntervalMs: 50 });
    const second = startEventLoopMonitor({ sampleIntervalMs: 50 });
    expect(second).toBe(first);
  });

  it('honours EVENT_LOOP_STARVATION_WARN_MS and falls back on a bad value', () => {
    process.env.EVENT_LOOP_STARVATION_WARN_MS = '250';
    expect(getEventLoopStarvationThresholdMs()).toBe(250);

    process.env.EVENT_LOOP_STARVATION_WARN_MS = 'not-a-number';
    expect(getEventLoopStarvationThresholdMs()).toBe(1_000);

    process.env.EVENT_LOOP_STARVATION_WARN_MS = '0';
    expect(getEventLoopStarvationThresholdMs()).toBe(1_000);
  });
});
