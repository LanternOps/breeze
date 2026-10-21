/**
 * W08 admission signals, sampled once per controller tick.
 *
 * - lagMs: lower median of the `maxLagMs` of the newest LAG_WINDOW_SAMPLES
 *   distinct event-loop monitor samples. A single GC-sized spike in the `all`
 *   role does not move it; a sustained stall does.
 * - lagFresh: whether this tick consumed a new monitor sample (see the field).
 * - peakLagMs: the worst of the in-flight stall and the samples consumed this
 *   tick — drives the controller's emergency path.
 * - dbWaitMs: max(grant-wait p95 over W04's gate window, 1.5 ticks wide; oldest waiter). The
 *   second term makes a stuck queue visible before any permit is granted.
 * - msSinceLastDbTimeout: time since the pool-acquire-timeout + prologue-expiry
 *   counter last increased; null until it has moved during this process's
 *   sampling (timeouts during boot/migrations do not count).
 * - eluRatio: event-loop utilization since the previous tick. Exported only:
 *   in the `all` role BullMQ workers legitimately push it up without hurting
 *   request latency, so it is not a trigger.
 *
 * The first sample() call skips the monitor's retained history (boot/migration
 * stalls) and only seeds the cursor; it reports lag 0 (the same "no samples
 * yet" reading as an empty window) and the in-flight stall as the peak.
 *
 * `null` lag means "the monitor is not running" — unknown, never healthy; the
 * controller then decides on the DB signal alone.
 */
import { performance, type EventLoopUtilization } from 'node:perf_hooks';
import {
  readEventLoopLagSamplesSince,
  readLatestEventLoopLag,
  type EventLoopLagReading,
  type EventLoopLagSample,
} from '../eventLoopMonitor';
import { readPoolSignals, type PoolSignals } from './poolSignals';

export const LAG_WINDOW_SAMPLES = 3;

export interface AdmissionSignals {
  lagMs: number | null;
  /**
   * True when this tick consumed at least one new monitor sample. The monitor
   * and the controller both run on unaligned 1 s timers, so some ticks read no
   * new sample and repeat the previous median. The controller does not count
   * those repeats as fresh evidence toward a rise (#9353).
   */
  lagFresh: boolean;
  peakLagMs: number | null;
  dbWaitMs: number;
  oldestDbWaitMs: number;
  msSinceLastDbTimeout: number | null;
  eluRatio: number;
  pool: PoolSignals;
}

export interface SignalSampler {
  sample(): AdmissionSignals;
}

export interface SignalSamplerDeps {
  readSamplesSince?: (afterMs: number) => readonly EventLoopLagSample[];
  readLatest?: () => EventLoopLagReading;
  readPool?: () => PoolSignals;
  /** Monotonic clock for the DB-timeout age. Defaults to performance.now(). */
  now?: () => number;
  /** `performance.eventLoopUtilization` shape: no arg = absolute, one arg = delta since it. */
  elu?: (prev?: EventLoopUtilization) => EventLoopUtilization;
}

export function createSignalSampler(deps: SignalSamplerDeps = {}): SignalSampler {
  const readSamplesSince = deps.readSamplesSince ?? readEventLoopLagSamplesSince;
  const readLatest = deps.readLatest ?? readLatestEventLoopLag;
  const readPool = deps.readPool ?? readPoolSignals;
  const now = deps.now ?? (() => performance.now());
  const elu = deps.elu ?? ((prev?: EventLoopUtilization) => performance.eventLoopUtilization(prev));

  const recent: number[] = [];
  let cursorMs = 0;
  // The monitor starts before migrations/boot; admission starts right before serve().
  // The first call only seeds the cursor so boot stalls are never replayed as live lag.
  let seeded = false;
  let previousElu = elu();
  let lastDbTimeoutsTotal: number | null = null;
  let lastDbTimeoutAtMs: number | null = null;

  return {
    sample(): AdmissionSignals {
      const latest = readLatest();
      let newestThisTick = 0;
      let consumed = 0;
      if (!latest.monitored) {
        recent.length = 0;
        cursorMs = 0;
        seeded = false;
      } else if (!seeded) {
        seeded = true;
        for (const sample of readSamplesSince(0)) cursorMs = Math.max(cursorMs, sample.atMs);
      } else {
        for (const sample of readSamplesSince(cursorMs)) {
          recent.push(sample.maxLagMs);
          if (recent.length > LAG_WINDOW_SAMPLES) recent.shift();
          cursorMs = sample.atMs;
          if (sample.maxLagMs > newestThisTick) newestThisTick = sample.maxLagMs;
          consumed += 1;
        }
      }
      const sorted = [...recent].sort((a, b) => a - b);
      const lagMs = !latest.monitored ? null : sorted.length === 0 ? 0 : sorted[Math.floor((sorted.length - 1) / 2)]!;
      const peakLagMs = !latest.monitored ? null : Math.max(latest.inFlightLagMs, newestThisTick);

      const delta = elu(previousElu);
      previousElu = elu();

      const pool = readPool();
      const nowMs = now();
      if (lastDbTimeoutsTotal !== null && pool.dbTimeoutsTotal > lastDbTimeoutsTotal) lastDbTimeoutAtMs = nowMs;
      lastDbTimeoutsTotal = pool.dbTimeoutsTotal;
      return {
        lagMs,
        lagFresh: consumed > 0,
        peakLagMs,
        dbWaitMs: Math.max(pool.grantWaitP95Ms, pool.oldestWaitMs),
        oldestDbWaitMs: pool.oldestWaitMs,
        msSinceLastDbTimeout: lastDbTimeoutAtMs === null ? null : nowMs - lastDbTimeoutAtMs,
        eluRatio: delta.utilization,
        pool,
      };
    },
  };
}
