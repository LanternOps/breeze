/**
 * Event-loop lag instrumentation (#3022).
 *
 * Why this exists: the API is a single-threaded Node process, so every timer it
 * arms is really a promise about *scheduling*, not about elapsed wall-clock
 * work. postgres.js arms `connect_timeout` with a plain `setTimeout`
 * (`connection.js:1042-1054`, started in `connect()` and cancelled only on
 * ReadyForQuery), which means the 10s budget covers socket create → TCP → SSL →
 * auth → ReadyForQuery *and* every socket callback in between. When the main
 * thread is pegged, none of those callbacks get scheduled and the driver reports
 * `write CONNECT_TIMEOUT <host>:<port>` — a connection fault that never
 * happened. The database and the network are healthy the whole time.
 *
 * That misattribution is the expensive part: the incident in #3022 presented as
 * three unrelated Sentry signatures (CONNECT_TIMEOUT, a `nextWrite` TypeError
 * from the teardown race, and a patch-scheduler sweep failure) with no way to
 * tell from telemetry alone that they were one starvation event. This module
 * makes the loop's own health a first-class, queryable signal so the next
 * occurrence is diagnosable from metrics instead of by hand.
 *
 * Measurement source is `perf_hooks.monitorEventLoopDelay`, a libuv-level timer
 * that records the delta between when it was due and when it actually ran. It
 * keeps accumulating while JS is blocked, so a 12s stall shows up as a ~12s
 * `max` on the first tick after the loop frees up. Overhead is a native
 * histogram update every `resolution` ms — negligible next to request work.
 *
 * NOTE ON DELIBERATE NON-GOALS: this module measures and reports. It does not
 * raise `connect_timeout` (per #3022 that lengthens the failing request without
 * fixing anything) and it does not retry, shed load, or otherwise change request
 * behaviour. Reducing the per-request main-thread work that causes the stall is
 * separate work.
 */

import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';

const NS_PER_MS = 1e6;

/** How often the histogram is snapshotted into the retained window. */
const DEFAULT_SAMPLE_INTERVAL_MS = 1_000;
/** How much sample history to retain for window queries. */
const DEFAULT_RETENTION_MS = 120_000;
/**
 * Resolution of the underlying libuv sampling timer. 20ms keeps the histogram
 * meaningful for ordinary request latency without the monitor itself becoming
 * loop pressure.
 */
const DEFAULT_RESOLUTION_MS = 20;
/**
 * Lag at or above which the loop is considered starved. A whole second of
 * blocked loop is already pathological for an API that answers agent traffic in
 * tens of milliseconds; below that, a spike is more likely GC or a chunky-but-
 * bounded handler. This is a "the loop is definitely unhealthy" marker, not a
 * proof that any particular timeout was caused by it — callers should report the
 * measured lag alongside the verdict rather than asserting causation.
 */
const DEFAULT_STARVATION_MS = 1_000;

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = Number.parseInt(process.env[name] ?? '', 10);
  if (!Number.isFinite(raw) || raw <= 0) {
    return fallback;
  }
  return raw;
}

/**
 * Lag at or above which a reading is treated as event-loop starvation.
 * Tunable via `EVENT_LOOP_STARVATION_WARN_MS`.
 */
export function getEventLoopStarvationThresholdMs(): number {
  return readPositiveIntEnv('EVENT_LOOP_STARVATION_WARN_MS', DEFAULT_STARVATION_MS);
}

/**
 * Bounded lag bands. Used wherever the lag becomes a Sentry tag: a tag carrying
 * raw milliseconds takes a distinct value on every event, which fills the tag
 * index with singletons and is useless for Sentry's "break down by". The exact
 * figure always travels in the log line instead.
 */
export type EventLoopLagBucket = 'unknown' | 'under-1s' | '1s-5s' | '5s-10s' | 'over-10s';

export function bucketEventLoopLag(lagMs: number, monitored = true): EventLoopLagBucket {
  if (!monitored) return 'unknown';
  if (lagMs >= 10_000) return 'over-10s';
  if (lagMs >= 5_000) return '5s-10s';
  if (lagMs >= 1_000) return '1s-5s';
  return 'under-1s';
}

/** One snapshot of the delay histogram, covering the interval since the previous sample. */
export interface EventLoopLagSample {
  /** `Date.now()` at which the sample was taken. */
  atMs: number;
  /** Worst delay observed during this sample's interval, in ms. */
  maxLagMs: number;
  /** Mean delay observed during this sample's interval, in ms. */
  meanLagMs: number;
}

/** Answer to "how badly was the loop blocked over the last N ms?". */
export interface EventLoopLagReading {
  /**
   * False when no monitor is running (monitor disabled, or a unit test that
   * never started one). Callers MUST treat this as "unknown" and must not
   * conclude anything from the zeroed lag fields — failing open to "not
   * starved" would silently re-create the misattribution this module exists to
   * remove.
   */
  monitored: boolean;
  /**
   * False when a monitor IS running but cannot vouch for the whole window, so a
   * lag of 0 means "not observed" rather than "did not happen". Two reachable
   * cases, and `monitored` alone catches neither:
   *
   *   1. The monitor has been up for less than `windowMs` — every diagnosis in
   *      the first 10s after boot or after a restart of the singleton.
   *   2. `sampleIntervalMs > windowMs`. Sampling coarser than the window leaves
   *      a blind spot exactly one interval wide: a stall that ends before the
   *      next sample is not recorded, and `inFlightLagMs` (which subtracts a
   *      full interval) still reads 0. A 12s stall under a 30s interval is
   *      invisible.
   *
   * Treat false the same as `monitored: false` — unknown, never healthy.
   */
  coversWindow: boolean;
  /** Worst lag recorded by a completed sample inside the window, in ms. */
  sampledMaxLagMs: number;
  /**
   * Lag that has accrued since the last completed sample and has therefore not
   * been recorded yet, in ms. This is what catches a stall that is still in
   * progress — or one that just ended, when the timer being diagnosed happened
   * to fire before the monitor's own sampling timer got its turn.
   */
  inFlightLagMs: number;
  /** `max(sampledMaxLagMs, inFlightLagMs)` — the figure to reason about. */
  worstLagMs: number;
  /** How many completed samples fell inside the window. */
  sampleCount: number;
}

export interface EventLoopLagStats {
  monitored: boolean;
  /** Width of the retained history actually summarised here, in ms. */
  windowMs: number;
  sampleCount: number;
  /** Worst single delay across the retained window, in ms. */
  maxLagMs: number;
  /** Mean of the per-sample means across the retained window, in ms. */
  meanLagMs: number;
  inFlightLagMs: number;
  worstLagMs: number;
  /** True when `worstLagMs` is at or above the starvation threshold. */
  starved: boolean;
  starvationThresholdMs: number;
}

const UNMONITORED_READING: EventLoopLagReading = Object.freeze({
  monitored: false,
  coversWindow: false,
  sampledMaxLagMs: 0,
  inFlightLagMs: 0,
  worstLagMs: 0,
  sampleCount: 0,
});

export interface EventLoopLagMonitorOptions {
  sampleIntervalMs?: number;
  retentionMs?: number;
  resolutionMs?: number;
  /** Injected for tests. Defaults to `Date.now`. */
  now?: () => number;
  /** Injected for tests. Defaults to `perf_hooks.monitorEventLoopDelay`. */
  createHistogram?: (opts: { resolution: number }) => IntervalHistogram;
  /**
   * Called with every completed sample. The production wiring uses this to emit
   * a throttled warning; tests use it to assert without real timers.
   */
  onSample?: (sample: EventLoopLagSample) => void;
}

/**
 * Records event-loop delay into a bounded ring of per-interval samples and
 * answers windowed "worst lag" questions about them.
 *
 * Timers and the clock are injectable so the window arithmetic is unit-testable
 * without blocking a real event loop for seconds at a time. `sampleNow()` is
 * public for exactly that reason — production drives it from an interval.
 */
export class EventLoopLagMonitor {
  private readonly sampleIntervalMs: number;
  private readonly retentionMs: number;
  private readonly resolutionMs: number;
  private readonly now: () => number;
  private readonly createHistogram: (opts: { resolution: number }) => IntervalHistogram;
  private readonly onSample?: (sample: EventLoopLagSample) => void;

  private histogram: IntervalHistogram | null = null;
  private timer: NodeJS.Timeout | null = null;
  private samples: EventLoopLagSample[] = [];
  /** Wall clock at start(), so read() can tell how much window it can vouch for. */
  private startedAtMs = 0;
  /**
   * When the current (not yet recorded) sampling interval began. Seeded at
   * `start()` so in-flight lag is meaningful before the first sample lands.
   */
  private intervalStartedAtMs = 0;

  constructor(options: EventLoopLagMonitorOptions = {}) {
    this.sampleIntervalMs = options.sampleIntervalMs
      ?? readPositiveIntEnv('EVENT_LOOP_MONITOR_INTERVAL_MS', DEFAULT_SAMPLE_INTERVAL_MS);
    this.retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
    this.resolutionMs = options.resolutionMs ?? DEFAULT_RESOLUTION_MS;
    this.now = options.now ?? Date.now;
    this.createHistogram = options.createHistogram ?? monitorEventLoopDelay;
    this.onSample = options.onSample;
  }

  get running(): boolean {
    return this.histogram !== null;
  }

  /** Effective sampling interval, for the boot log. */
  get intervalMs(): number {
    return this.sampleIntervalMs;
  }

  /** Idempotent. Safe to call from a boot path that may run twice. */
  start(): void {
    if (this.histogram) return;
    this.histogram = this.createHistogram({ resolution: this.resolutionMs });
    this.histogram.enable();
    this.intervalStartedAtMs = this.now();
    this.startedAtMs = this.intervalStartedAtMs;
    this.samples = [];

    // `unref()` so the monitor never holds the process open during shutdown —
    // an observability timer must not be the reason a container refuses to exit.
    const timer = setInterval(() => this.sampleNow(), this.sampleIntervalMs);
    timer.unref?.();
    this.timer = timer;
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.histogram) {
      this.histogram.disable();
      this.histogram = null;
    }
    this.samples = [];
    this.intervalStartedAtMs = 0;
    this.startedAtMs = 0;
  }

  /**
   * Snapshot the histogram into the retained window and reset it so the next
   * sample covers only the next interval. Returns the recorded sample, or null
   * when the monitor is not running.
   */
  sampleNow(): EventLoopLagSample | null {
    const histogram = this.histogram;
    if (!histogram) return null;

    const atMs = this.now();
    // `max` is Infinity and `mean` is NaN on a histogram that recorded nothing
    // (possible for the very first tick, or with a resolution coarser than the
    // interval). Normalise to 0 rather than letting a non-finite value leak into
    // a comparison — `NaN >= threshold` is false, which would read as "healthy"
    // by accident rather than by decision.
    const sample: EventLoopLagSample = {
      atMs,
      maxLagMs: finiteMs(histogram.max),
      meanLagMs: finiteMs(histogram.mean),
    };
    histogram.reset();
    this.intervalStartedAtMs = atMs;

    this.samples.push(sample);
    this.pruneTo(atMs);

    // An observability hook must never break the sampler that feeds it: if the
    // consumer throws (Sentry transport hiccup, logger misconfiguration) the
    // interval callback would otherwise die as an unhandled rejection and the
    // monitor would go quiet exactly when it matters.
    if (this.onSample) {
      try {
        this.onSample(sample);
      } catch {
        // Intentionally ignored — see above.
      }
    }

    return sample;
  }

  /** Worst lag over the last `windowMs`, including any stall still in flight. */
  read(windowMs: number): EventLoopLagReading {
    if (!this.histogram) return UNMONITORED_READING;

    const nowMs = this.now();
    const cutoff = nowMs - windowMs;
    let sampledMaxLagMs = 0;
    let sampleCount = 0;
    for (const sample of this.samples) {
      if (sample.atMs < cutoff) continue;
      sampleCount += 1;
      if (sample.maxLagMs > sampledMaxLagMs) sampledMaxLagMs = sample.maxLagMs;
    }

    const inFlightLagMs = this.inFlightLagMs(nowMs);
    return {
      monitored: true,
      coversWindow: this.coversWindow(nowMs, windowMs),
      sampledMaxLagMs,
      inFlightLagMs,
      worstLagMs: Math.max(sampledMaxLagMs, inFlightLagMs),
      sampleCount,
    };
  }

  /**
   * Whether this monitor can account for the whole of the last `windowMs`.
   *
   * Requires both that it has been running at least that long, and that it
   * samples at least as often as the window is wide — sampling coarser than the
   * window leaves an interval-wide hole that neither a recorded sample nor the
   * in-flight figure can fill. Callers must degrade to "unknown" when this is
   * false rather than reading the accompanying zeros as health.
   */
  private coversWindow(nowMs: number, windowMs: number): boolean {
    if (this.startedAtMs === 0) return false;
    if (this.sampleIntervalMs > this.blindSpotBudgetMs(windowMs)) return false;
    return nowMs - this.startedAtMs >= windowMs;
  }

  /**
   * Largest sampling interval whose blind spot is still tolerable for a query
   * about `windowMs`.
   *
   * The blind spot is the CURRENT, not-yet-recorded interval: a stall that
   * starts and ends inside it is captured by no sample, and `inFlightLagMs`
   * subtracts a full interval so it reads 0. That hole is `sampleIntervalMs`
   * wide — it is NOT bounded by `windowMs`. Comparing the interval against the
   * window alone (the first version of this guard) therefore only caught the
   * extreme case: at a 9s interval and a 10s window, an 8.5s stall sitting
   * inside one interval still produced `coversWindow: true` and a confident
   * "the event loop stayed healthy, check database reachability".
   *
   * The invariant that actually holds is `sampleIntervalMs <= starvation
   * threshold`: a stall big enough to matter then necessarily crosses an
   * interval boundary and becomes visible, either as a delayed sample or as
   * in-flight lag. The window is kept as a second bound so a query narrower
   * than the threshold is judged on its own terms.
   *
   * Note the shipped defaults satisfy this only by coincidence
   * (DEFAULT_SAMPLE_INTERVAL_MS === DEFAULT_STARVATION_MS === 1000), which is
   * exactly why it is enforced rather than assumed.
   */
  private blindSpotBudgetMs(windowMs: number): number {
    return Math.min(windowMs, getEventLoopStarvationThresholdMs());
  }

  /**
   * Lag attributable to the most recent completed sampling interval, folded with
   * any stall still in flight.
   *
   * This is the *instantaneous* figure, as distinct from `stats()`, which is a
   * high-water mark over the whole retained window. Prometheus wants this one:
   * a gauge fed from a 120s high-water mark keeps reporting a 1.2s blip for two
   * minutes after the loop recovered, so `starved == 1 for 1m` fires on a
   * momentary spike and `max_over_time` counts the same stall repeatedly.
   */
  latest(): EventLoopLagReading {
    if (!this.histogram) return UNMONITORED_READING;
    const nowMs = this.now();
    const last = this.samples[this.samples.length - 1];
    const sampledMaxLagMs = last?.maxLagMs ?? 0;
    const inFlightLagMs = this.inFlightLagMs(nowMs);
    return {
      monitored: true,
      // One interval is by definition covered once a sample exists; before the
      // first sample only the in-flight figure speaks, so say so.
      coversWindow: last !== undefined,
      sampledMaxLagMs,
      inFlightLagMs,
      worstLagMs: Math.max(sampledMaxLagMs, inFlightLagMs),
      sampleCount: last ? 1 : 0,
    };
  }

  /** Summary of the whole retained window, for the health endpoint. */
  stats(): EventLoopLagStats {
    const starvationThresholdMs = getEventLoopStarvationThresholdMs();
    if (!this.histogram) {
      return {
        monitored: false,
        windowMs: this.retentionMs,
        sampleCount: 0,
        maxLagMs: 0,
        meanLagMs: 0,
        inFlightLagMs: 0,
        worstLagMs: 0,
        starved: false,
        starvationThresholdMs,
      };
    }

    const nowMs = this.now();
    this.pruneTo(nowMs);
    let maxLagMs = 0;
    let meanTotal = 0;
    for (const sample of this.samples) {
      if (sample.maxLagMs > maxLagMs) maxLagMs = sample.maxLagMs;
      meanTotal += sample.meanLagMs;
    }
    const sampleCount = this.samples.length;
    const inFlightLagMs = this.inFlightLagMs(nowMs);
    const worstLagMs = Math.max(maxLagMs, inFlightLagMs);

    return {
      monitored: true,
      windowMs: this.retentionMs,
      sampleCount,
      maxLagMs: round2(maxLagMs),
      meanLagMs: sampleCount > 0 ? round2(meanTotal / sampleCount) : 0,
      inFlightLagMs: round2(inFlightLagMs),
      worstLagMs: round2(worstLagMs),
      starved: worstLagMs >= starvationThresholdMs,
      starvationThresholdMs,
    };
  }

  /**
   * How long the current sampling interval has overrun its scheduled length.
   * Zero while the sampler is keeping up; grows in real time while the loop is
   * blocked, which is what makes an in-progress stall observable at all.
   */
  private inFlightLagMs(nowMs: number): number {
    if (this.intervalStartedAtMs === 0) return 0;
    return Math.max(0, nowMs - this.intervalStartedAtMs - this.sampleIntervalMs);
  }

  private pruneTo(nowMs: number): void {
    const cutoff = nowMs - this.retentionMs;
    // Samples are appended in time order, so dropping the leading run is enough.
    let firstKept = 0;
    while (firstKept < this.samples.length && this.samples[firstKept]!.atMs < cutoff) {
      firstKept += 1;
    }
    if (firstKept > 0) {
      this.samples = this.samples.slice(firstKept);
    }
  }
}

function finiteMs(nanoseconds: number): number {
  if (!Number.isFinite(nanoseconds) || nanoseconds <= 0) return 0;
  return nanoseconds / NS_PER_MS;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

// ---------------------------------------------------------------------------
// Process-wide singleton
// ---------------------------------------------------------------------------

let monitor: EventLoopLagMonitor | null = null;

/**
 * Start the process-wide monitor. Idempotent — a second call is a no-op rather
 * than a second histogram. Set `EVENT_LOOP_MONITOR_DISABLED` to a truthy value
 * to opt out entirely (readings then report `monitored: false`, which every
 * consumer treats as "unknown", never as "healthy").
 */
export function startEventLoopMonitor(
  options: EventLoopLagMonitorOptions = {},
): EventLoopLagMonitor | null {
  if (isEventLoopMonitorDisabled()) return null;
  if (!monitor) {
    monitor = new EventLoopLagMonitor(options);
  }
  monitor.start();
  return monitor;
}

export function stopEventLoopMonitor(): void {
  monitor?.stop();
  monitor = null;
}

const DISABLED_VALUES = new Set(['1', 'true', 'yes', 'on']);
function isEventLoopMonitorDisabled(): boolean {
  return DISABLED_VALUES.has((process.env.EVENT_LOOP_MONITOR_DISABLED ?? '').trim().toLowerCase());
}

/** TEST ONLY. Install a monitor built with injected clock/histogram. */
export function __setEventLoopMonitorForTests(next: EventLoopLagMonitor | null): void {
  monitor = next;
}

/**
 * Worst event-loop lag over the last `windowMs`. Returns an unmonitored reading
 * when no monitor is running — callers must not read that as "healthy".
 */
export function readEventLoopLag(windowMs: number): EventLoopLagReading {
  return monitor?.read(windowMs) ?? UNMONITORED_READING;
}

/**
 * Instantaneous lag (last completed interval + any in-flight stall). Use for
 * Prometheus gauges; use getEventLoopLagStats for the retained-window summary.
 */
export function readLatestEventLoopLag(): EventLoopLagReading {
  return monitor?.latest() ?? UNMONITORED_READING;
}

/** Retained-window summary for health/diagnostic endpoints. */
export function getEventLoopLagStats(): EventLoopLagStats {
  if (monitor) return monitor.stats();
  return {
    monitored: false,
    // Same windowMs the running path reports, so consumers of /health/ready see
    // a stable field shape rather than a 0 that looks like a distinct state.
    windowMs: DEFAULT_RETENTION_MS,
    sampleCount: 0,
    maxLagMs: 0,
    meanLagMs: 0,
    inFlightLagMs: 0,
    worstLagMs: 0,
    starved: false,
    starvationThresholdMs: getEventLoopStarvationThresholdMs(),
  };
}
