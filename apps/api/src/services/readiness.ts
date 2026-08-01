/**
 * Readiness evaluation for the legacy `/ready` endpoint.
 *
 * Historically `/ready` served a module-level `readinessState` object that was
 * written exactly twice during boot (once by the startup DB/Redis checks, once
 * when worker initialisation finished) and never again. Because the HTTP server
 * starts listening *before* `initializeWorkers()` resolves, the value a probe
 * observed depended purely on boot timing — and whatever it observed was
 * latched for the lifetime of the process. In production EU that latched
 * `workers:false` on a perfectly healthy API, with a `checkedAt` timestamp that
 * never moved; US latched the opposite result from the same code (#2974).
 *
 * This module makes readiness a *live* evaluation, with two properties that
 * matter for an endpoint in this position:
 *
 * 1. **TTL cache.** `/ready` is unauthenticated *and* exempt from the global
 *    rate limiter (`SKIP_PATHS` in `middleware/globalRateLimit.ts`, so probes
 *    from load balancers aren't throttled). A naive per-request implementation
 *    would turn every unauthenticated GET into a Postgres round-trip plus a
 *    Redis `PING` — an amplification surface anyone can drive. Results are
 *    cached for `ttlMs`, which bounds the backend cost to one probe pair per
 *    window no matter the request rate, while still being far shorter than any
 *    realistic uptime-check interval.
 * 2. **Single-flight.** Concurrent probes that miss the cache share one
 *    in-flight evaluation instead of stampeding the backends when the cache
 *    expires.
 *
 * Everything is injected so the behaviour — specifically "an unhealthy
 * dependency recovers and readiness flips back to true within one process
 * lifetime" — is testable without booting the API.
 */

export interface ReadinessSnapshot {
  ready: boolean;
  db: boolean;
  redis: boolean;
  workers: boolean;
  checkedAt: string;
}

/**
 * How far boot-time worker initialisation got. Distinguishing "hasn't run yet"
 * from "ran but deliberately started nothing" matters: the first is a transient
 * not-ready, the second is only acceptable when Redis is optional for this
 * deployment.
 */
export type WorkerInitPhase = 'pending' | 'started' | 'skipped-no-redis';

export interface WorkersHealthyInput {
  phase: WorkerInitPhase;
  /** Per-worker initialisation outcome, keyed by worker name. */
  workerStatus: Record<string, boolean>;
  /** Result of the *current* Redis probe, not a boot-time snapshot. */
  redisOk: boolean;
  requireRedis: boolean;
  shuttingDown: boolean;
}

/**
 * Live view of background-worker health.
 *
 * Deliberately derived on every evaluation rather than frozen at boot, so a
 * worker that finishes registering after the first probe flips `/ready` to true
 * without a restart.
 */
export function computeWorkersHealthy({
  phase,
  workerStatus,
  redisOk,
  requireRedis,
  shuttingDown
}: WorkersHealthyInput): boolean {
  // Draining: report not-ready so load balancers stop routing to us.
  if (shuttingDown) return false;

  // Boot hasn't reached worker initialisation yet. The HTTP server is already
  // listening at this point, so this window is exactly the race that #2974 used
  // to latch permanently.
  if (phase === 'pending') return false;

  // Every tracked worker is BullMQ-backed, so no Redis means no workers —
  // whether Redis was already gone at boot or died afterwards. Only tolerated
  // when this deployment explicitly declared Redis optional.
  if (!redisOk) return !requireRedis;

  // Redis is reachable *now*, but boot skipped worker startup because it wasn't
  // reachable then. Nothing is consuming the queues and only a restart fixes
  // it, so this must not silently report healthy once Redis returns.
  if (phase === 'skipped-no-redis') return false;

  return Object.values(workerStatus).every(Boolean);
}

export interface ReadinessEvaluatorOptions {
  /** Live database probe. Must resolve false rather than reject on failure. */
  checkDb: () => Promise<boolean>;
  /** Live Redis probe. Must resolve false rather than reject on failure. */
  checkRedis: () => Promise<boolean>;
  /** Live worker view, given the freshly probed Redis result. */
  workersHealthy: (redisOk: boolean) => boolean;
  /** True once the process has begun draining. */
  isShuttingDown: () => boolean;
  /** Whether Redis is a hard readiness dependency for this deployment. */
  requireRedis: boolean;
  /** Cache lifetime in ms. `0` disables caching (each call re-probes). */
  ttlMs: number;
  /** Injectable clock, for tests. */
  now?: () => number;
}

export interface ReadinessEvaluator {
  get(): Promise<ReadinessSnapshot>;
  /** Drop any cached snapshot so the next `get()` re-probes. */
  invalidate(): void;
}

export function createReadinessEvaluator(
  options: ReadinessEvaluatorOptions
): ReadinessEvaluator {
  const now = options.now ?? Date.now;

  let cached: { snapshot: ReadinessSnapshot; expiresAt: number } | null = null;
  let inFlight: Promise<ReadinessSnapshot> | null = null;

  const evaluate = async (): Promise<ReadinessSnapshot> => {
    const [db, redis] = await Promise.all([options.checkDb(), options.checkRedis()]);
    const workers = options.workersHealthy(redis);
    const redisReady = options.requireRedis ? redis : true;

    return {
      ready: !options.isShuttingDown() && db && redisReady && workers,
      db,
      redis,
      workers,
      checkedAt: new Date(now()).toISOString()
    };
  };

  return {
    async get(): Promise<ReadinessSnapshot> {
      // Shutdown short-circuits *before* the cache. A snapshot captured
      // moments earlier would still say ready, and serving it during a drain
      // is the one case where a stale answer actively causes harm.
      if (options.isShuttingDown()) {
        cached = null;
        return {
          ready: false,
          db: false,
          redis: false,
          workers: false,
          checkedAt: new Date(now()).toISOString()
        };
      }

      const current = now();
      if (cached && cached.expiresAt > current) {
        return cached.snapshot;
      }

      if (inFlight) return inFlight;

      const pending = evaluate()
        .then((snapshot) => {
          cached = { snapshot, expiresAt: now() + options.ttlMs };
          return snapshot;
        })
        .finally(() => {
          inFlight = null;
        });

      inFlight = pending;
      return pending;
    },

    invalidate(): void {
      cached = null;
    }
  };
}
