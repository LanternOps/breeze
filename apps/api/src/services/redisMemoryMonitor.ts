/**
 * Redis memory watchdog (#6452).
 *
 * THE GAP THIS CLOSES. Redis runs `noeviction` by contract — the remote-WS
 * admission gate (`services/remoteWsRedisTopology.ts`) and
 * `scripts/prod/deploy.sh` both require it, so a full instance fails writes
 * loudly rather than silently evicting data. But nothing observed memory
 * before this: `/health` returned only status/version/uptime, `/ready` only
 * PINGed, and OOM was handled ad hoc at each call site. The first signal an
 * operator got was a failed login or a stuck queue (#6249, #6177).
 *
 * WHAT THIS MODULE DOES. Polls `INFO memory` on an interval, publishes
 * `used_memory` / `maxmemory` (and their ratio) as Prometheus gauges on the
 * shared `metricsRegistry`, and emits a throttled warning (console + Sentry)
 * once the ratio crosses `REDIS_MEMORY_WARN_RATIO` (default 0.80) — so
 * `REDIS_MAXMEMORY` can be raised, or the instance force-recreated, before an
 * incident rather than during one. It does NOT touch Redis's eviction policy;
 * `noeviction` stays a deploy-time contract, not something this watchdog can
 * override.
 *
 * PATTERN. Deliberately mirrors `db/dbPoolHealthMonitor.ts` (#3214): a pure,
 * injectable-deps assessment function (`assessRedisMemory`) wrapped by a
 * side-effecting runner (`runRedisMemoryCheck`) that owns the last-good-value
 * cache, a failure counter, and a per-key capture throttle so a Sentry storm
 * cannot fire once per tick. A failed check CLEARS the last assessment rather
 * than leaving a stale "healthy" reading standing — see `runRedisMemoryCheck`.
 *
 * `maxmemory=0` (unbounded — Redis grows until the OS OOM-kills it) is
 * reported as ratio `null`, never `0`. Zero would read as "plenty of
 * headroom"; null says "not configured to be observed", which is the actual
 * state and itself worth alerting on separately (see the `maxmemory=0`
 * warning below).
 *
 * IMPORT GRAPH. `./redis` (ioredis + bullmq types + node:fs), `./sentry`,
 * `./metricsRegistry` (prom-client only) and `../utils/envInt` — none reach
 * `routes/` or `db/`, so this module stays importable from `worker.ts`'s
 * dynamic-import block without violating
 * `services/workerEntrypointClosure.contract.test.ts`.
 */
import { Gauge } from 'prom-client';

import { captureMessage } from './sentry';
import { metricsRegistry } from './metricsRegistry';
import { getRedis } from './redis';
import { envInt } from '../utils/envInt';

export interface RedisMemoryAssessment {
  usedMemoryBytes: number;
  maxMemoryBytes: number;
  /** null when maxmemory is 0 (unbounded) — see module header. */
  ratio: number | null;
  warn: boolean;
  message: string;
  at: number;
}

export interface AssessRedisMemoryDeps {
  readInfo: () => Promise<string>;
  thresholdRatio: number;
}

const register = metricsRegistry;

const usedMemoryGauge = new Gauge({
  name: 'breeze_redis_used_memory_bytes',
  help: 'Redis INFO memory used_memory, in bytes (#6452)',
  registers: [register],
});

const maxMemoryGauge = new Gauge({
  name: 'breeze_redis_maxmemory_bytes',
  help: 'Redis INFO memory maxmemory, in bytes; 0 means unbounded (#6452)',
  registers: [register],
});

// -1, not 0 — matching the `breeze_db_wedged_client_read_backends` sentinel
// convention (#6048): 0 would mean "confirmed at 0% used", which is a
// different (and false) claim from "unbounded, so no ratio exists" or "never
// successfully measured". Alert on `>= <threshold>`, never on the negation.
const memoryRatioGauge = new Gauge({
  name: 'breeze_redis_memory_used_ratio',
  help: 'used_memory / maxmemory from the last successful Redis INFO check; -1 when maxmemory=0 (unbounded) or not observed (#6452)',
  registers: [register],
});

const lastCheckGauge = new Gauge({
  name: 'breeze_redis_memory_last_check_timestamp_seconds',
  help: 'Unix time of the last successful Redis memory check; 0 = never (#6452)',
  registers: [register],
});

const checkFailuresGauge = new Gauge({
  name: 'breeze_redis_memory_check_failures',
  help: 'Redis memory checks that threw before producing a reading, since process start (#6452)',
  registers: [register],
});

// A hung `redis.info()` call (e.g. a wedged connection) leaves every tick
// after it skipped — with no failure recorded, `checkFailuresGauge` stays
// flat, and `lastCheckGauge` staying stale is the ONLY other signal. Without
// this counter, "the watchdog itself is stalled" is indistinguishable on
// /metrics from "nothing has changed for a while".
const checkSkippedGauge = new Gauge({
  name: 'breeze_redis_memory_check_skipped_total',
  help: 'Ticks skipped because the previous Redis memory check was still in flight, since process start (#6452)',
  registers: [register],
});

usedMemoryGauge.set(0);
maxMemoryGauge.set(0);
memoryRatioGauge.set(-1);
lastCheckGauge.set(0);
checkFailuresGauge.set(0);
checkSkippedGauge.set(0);

/**
 * Parses the subset of an `INFO memory` reply this module needs. Returns null
 * on a malformed/truncated reply — missing `used_memory` OR missing
 * `maxmemory` — rather than defaulting the missing field to 0.
 *
 * Both fields are always present in a real `INFO memory` reply (maxmemory=0
 * is how Redis reports "unbounded", it never omits the field). Treating a
 * MISSING maxmemory line the same as a present-and-explicit `maxmemory:0`
 * would silently reinterpret a truncated/malformed reply as "unbounded, no
 * ratio to compute" — which reports as a quiet console line instead of the
 * parse-failure path (thrown, counted, Sentry-throttled). A real
 * over-threshold instance whose reply happened to drop this one field would
 * then go unreported.
 */
export function parseRedisMemoryInfo(
  info: string,
): { usedMemoryBytes: number; maxMemoryBytes: number } | null {
  const usedMatch = /^used_memory:(\d+)\s*$/m.exec(info);
  const maxMatch = /^maxmemory:(\d+)\s*$/m.exec(info);
  if (!usedMatch || !maxMatch) return null;

  return {
    usedMemoryBytes: Number.parseInt(usedMatch[1]!, 10),
    maxMemoryBytes: Number.parseInt(maxMatch[1]!, 10),
  };
}

function formatBytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)}MiB`;
}

/**
 * Pure evaluation — no gauges, no logging, no Sentry. Injectable `readInfo`
 * so tests never touch a real Redis connection, mirroring
 * `assessDbPoolHealth`.
 */
export async function assessRedisMemory(
  deps: AssessRedisMemoryDeps,
): Promise<RedisMemoryAssessment> {
  const info = await deps.readInfo();
  const parsed = parseRedisMemoryInfo(info);
  if (!parsed) {
    throw new Error('[redis-memory] INFO memory reply missing used_memory or maxmemory');
  }

  const { usedMemoryBytes, maxMemoryBytes } = parsed;
  const ratio = maxMemoryBytes > 0 ? usedMemoryBytes / maxMemoryBytes : null;
  const warn = ratio !== null && ratio >= deps.thresholdRatio;
  const pct = ratio !== null ? Math.round(ratio * 1000) / 10 : null;

  const message =
    ratio !== null
      ? `[redis-memory] used_memory is ${pct}% of maxmemory `
        + `(${formatBytes(usedMemoryBytes)} / ${formatBytes(maxMemoryBytes)}) — `
        + `Redis runs noeviction, so writes fail loudly once this reaches 100%. `
        + `Raise REDIS_MAXMEMORY or force-recreate the instance (#6452, #6249).`
      : `[redis-memory] maxmemory is unset (0 = unbounded) — used_memory is `
        + `${formatBytes(usedMemoryBytes)} with no configured ceiling to alert against. `
        + `Set REDIS_MAXMEMORY so this watchdog (and noeviction) has something to enforce.`;

  return { usedMemoryBytes, maxMemoryBytes, ratio, warn, message, at: Date.now() };
}

let lastAssessment: RedisMemoryAssessment | null = null;
let checkFailures = 0;
let checksSkipped = 0;
let timer: NodeJS.Timeout | null = null;
let activeIntervalMs: number | null = null;
let checkInFlight = false;
const lastCaptureAtByKey = new Map<string, number>();

/** Latest reading, or null when never checked, disabled, or the last check failed. */
export function getLastRedisMemoryAssessment(): RedisMemoryAssessment | null {
  return lastAssessment;
}

/** Checks that threw before producing a reading. Monotonic. */
export function getRedisMemoryCheckFailures(): number {
  return checkFailures;
}

/** Ticks skipped because the previous check was still in flight. Monotonic. */
export function getRedisMemoryChecksSkipped(): number {
  return checksSkipped;
}

/**
 * Throttle gate, mirroring `claimDbPoolHealthCaptureSlot`: returns true —and
 * records the claim — at most once per `throttleMs` per key. Named `claim…`
 * because it mutates; evaluate it exactly once per intended capture.
 */
export function claimRedisMemoryCaptureSlot(key: string, now: number, throttleMs: number): boolean {
  if (throttleMs === 0) return true;
  const lastAt = lastCaptureAtByKey.get(key);
  if (lastAt === undefined || now - lastAt >= throttleMs) {
    lastCaptureAtByKey.set(key, now);
    return true;
  }
  return false;
}

function isRedisMemoryMonitorDisabled(): boolean {
  return (process.env.REDIS_MEMORY_MONITOR_DISABLED ?? '').toLowerCase() === 'true';
}

function getRedisMemoryIntervalMs(): number {
  return envInt('REDIS_MEMORY_MONITOR_INTERVAL_MS', 60_000);
}

function getRedisMemoryWarnRatio(): number {
  const raw = process.env.REDIS_MEMORY_WARN_RATIO?.trim();
  const parsed = raw ? Number.parseFloat(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 1 ? parsed : 0.8;
}

function getRedisMemoryCaptureThrottleMs(): number {
  return envInt('REDIS_MEMORY_CAPTURE_THROTTLE_MS', 15 * 60_000);
}

async function readRedisInfoMemory(): Promise<string> {
  const redis = getRedis();
  if (!redis) {
    throw new Error('[redis-memory] Redis client unavailable');
  }
  return redis.info('memory');
}

/**
 * Run one evaluation, publish it to the gauges, and report it. Never throws —
 * this is a watchdog, and a watchdog that can crash the tick it runs on is
 * worse than none.
 */
export async function runRedisMemoryCheck(
  deps: AssessRedisMemoryDeps = { readInfo: readRedisInfoMemory, thresholdRatio: getRedisMemoryWarnRatio() },
): Promise<RedisMemoryAssessment | null> {
  try {
    const assessment = await assessRedisMemory(deps);
    lastAssessment = assessment;

    usedMemoryGauge.set(assessment.usedMemoryBytes);
    maxMemoryGauge.set(assessment.maxMemoryBytes);
    memoryRatioGauge.set(assessment.ratio ?? -1);
    lastCheckGauge.set(Math.floor(assessment.at / 1000));
    checkFailuresGauge.set(checkFailures);

    if (assessment.warn) {
      console.warn(assessment.message);
      if (claimRedisMemoryCaptureSlot('warn', assessment.at, getRedisMemoryCaptureThrottleMs())) {
        try {
          captureMessage(assessment.message, {
            eventCode: 'redis_memory_high',
            tags: { redis_memory_ratio: String(Math.round((assessment.ratio ?? 0) * 100)) },
          });
        } catch (captureErr) {
          console.error('[redis-memory] failed to report to Sentry:', captureErr);
        }
      }
    } else if (assessment.ratio === null) {
      // maxmemory=0: worth a log line every check (cheap, and operators should
      // fix this once) but never a Sentry event — it is a config gap, not an
      // incident in progress.
      console.warn(assessment.message);
    }

    return assessment;
  } catch (err) {
    checkFailures += 1;
    checkFailuresGauge.set(checkFailures);
    // Do NOT leave the previous reading standing — see module header. A stale
    // "healthy" ratio would otherwise republish on every scrape for as long as
    // the watchdog itself has been broken.
    lastAssessment = null;
    memoryRatioGauge.set(-1);
    console.error('[redis-memory] check failed:', err);
    if (claimRedisMemoryCaptureSlot('check-failed', Date.now(), getRedisMemoryCaptureThrottleMs())) {
      try {
        captureMessage('[redis-memory] watchdog evaluation failed', {
          eventCode: 'redis_memory_check_failed',
        });
      } catch (captureErr) {
        // The console line above already recorded the ORIGINAL Redis failure;
        // this logs the SEPARATE fact that reporting it to Sentry also failed
        // — dropping that silently would mean a Sentry outage overlapping a
        // Redis outage is invisible in both places an operator looks.
        console.error('[redis-memory] failed to report check-failure to Sentry:', captureErr);
      }
    }
    return null;
  }
}

/**
 * Start the watchdog. Idempotent. Returns the effective interval, or null
 * when disabled — mirroring `startDbPoolHealthMonitor`.
 */
export function startRedisMemoryMonitor(): number | null {
  if (isRedisMemoryMonitorDisabled()) return null;
  if (timer) return activeIntervalMs;

  activeIntervalMs = getRedisMemoryIntervalMs();
  timer = setInterval(() => {
    if (checkInFlight) {
      checksSkipped += 1;
      checkSkippedGauge.set(checksSkipped);
      console.warn('[redis-memory] skipping tick — the previous check is still in flight.');
      return;
    }
    checkInFlight = true;
    void runRedisMemoryCheck().finally(() => {
      checkInFlight = false;
    });
  }, activeIntervalMs);
  // Unref'd: the watchdog must never be the reason the process stays alive.
  timer.unref?.();
  return activeIntervalMs;
}

export function stopRedisMemoryMonitor(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
    activeIntervalMs = null;
  }
}

export function __resetRedisMemoryMonitorForTests(): void {
  stopRedisMemoryMonitor();
  checkInFlight = false;
  lastAssessment = null;
  checkFailures = 0;
  checksSkipped = 0;
  lastCaptureAtByKey.clear();
  usedMemoryGauge.set(0);
  maxMemoryGauge.set(0);
  memoryRatioGauge.set(-1);
  lastCheckGauge.set(0);
  checkFailuresGauge.set(0);
  checkSkippedGauge.set(0);
}
