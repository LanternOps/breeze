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
 * This module makes readiness a *live* evaluation, with three properties that
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
 * 3. **Bounded probes.** Every probe is raced against `probeTimeoutMs`. This is
 *    load-bearing, not defensive garnish: postgres.js has a connect timeout but
 *    no pool-acquire timeout, so a saturated pool leaves a query queued
 *    indefinitely. Without the race, one such evaluation would never settle,
 *    the single-flight slot would never clear, and *every* subsequent probe
 *    would await the same dead promise — `/ready` would go permanently silent,
 *    which is a worse latch than the one this module exists to remove.
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

export type ReadinessProbeName = 'db' | 'redis';

/**
 * How far boot-time worker initialisation got. Distinguishing "hasn't run yet"
 * from "ran but deliberately started nothing" matters: the first is a transient
 * not-ready, the second is permanent until the process restarts.
 */
export type WorkerInitPhase = 'pending' | 'started' | 'skipped-no-redis';

export interface WorkersHealthyInput {
  phase: WorkerInitPhase;
  /** Per-worker initialisation outcome, keyed by worker name. */
  workerStatus: Record<string, boolean>;
  /** Result of the *current* Redis probe, not a boot-time snapshot. */
  redisOk: boolean;
  shuttingDown: boolean;
}

/**
 * Live view of background-worker health — the *fact*, not the verdict.
 *
 * Deliberately derived on every evaluation rather than frozen at boot, so a
 * worker that finishes registering after the first probe flips `/ready` to true
 * without a restart.
 *
 * This reports what is actually true even when the deployment has declared
 * Redis optional. Tolerating a missing Redis is a decision about the overall
 * `ready` verdict (see `createReadinessEvaluator`), and folding it in here
 * would make the `workers` field claim workers exist when none do — the same
 * class of untruth as #2974, just in the other direction.
 */
export function computeWorkersHealthy({
  phase,
  workerStatus,
  redisOk,
  shuttingDown
}: WorkersHealthyInput): boolean {
  // Draining: report not-ready so load balancers stop routing to us.
  if (shuttingDown) return false;

  // Boot hasn't reached worker initialisation yet. The HTTP server is already
  // listening at this point, so this window is exactly the race that #2974 used
  // to latch permanently. Checked before Redis so that "nothing has started
  // yet" is never reported as healthy on a Redis-optional deployment.
  if (phase === 'pending') return false;

  // Every tracked worker is BullMQ-backed, so no Redis means no workers —
  // whether Redis was already gone at boot or died afterwards.
  if (!redisOk) return false;

  // Redis is reachable *now*, but boot skipped worker startup because it wasn't
  // reachable then. Nothing is consuming the queues and only a restart fixes
  // it, so this must not silently report healthy once Redis returns.
  if (phase === 'skipped-no-redis') return false;

  // `every` is vacuously true on an empty map. `phase` only becomes 'started'
  // after all workers have recorded an outcome, so an empty map means the
  // bookkeeping is wrong — report not-ready rather than healthy-with-no-workers.
  const outcomes = Object.values(workerStatus);
  return outcomes.length > 0 && outcomes.every(Boolean);
}

export interface ReadinessEvaluatorOptions {
  /** Live database probe. */
  checkDb: () => Promise<boolean>;
  /** Live Redis probe. */
  checkRedis: () => Promise<boolean>;
  /** Live worker view, given the freshly probed Redis result. */
  workersHealthy: (redisOk: boolean) => boolean;
  /** True once the process has begun draining. */
  isShuttingDown: () => boolean;
  /** Whether Redis is a hard readiness dependency for this deployment. */
  requireRedis: boolean;
  /** Cache lifetime in ms. `0` disables caching (each call re-probes). */
  ttlMs: number;
  /** Per-probe deadline in ms. A probe that exceeds it counts as unhealthy. */
  probeTimeoutMs: number;
  /**
   * Called when a probe throws or times out. A probe failing is *expected*
   * (that's what readiness reports), but it must never be invisible — the
   * caller wires this to logging plus Sentry.
   */
  onProbeFailure?: (probe: ReadinessProbeName, error: unknown) => void;
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
  /**
   * Bumped by `invalidate()`. An evaluation that was already running when the
   * cache was invalidated must not write its now-stale result back, or a probe
   * taken during the boot race could re-cache `workers:false` for a full TTL
   * immediately after worker initialisation completed.
   */
  let generation = 0;

  /** Runs a probe under a deadline; any failure resolves false, never rejects. */
  const probe = async (
    name: ReadinessProbeName,
    run: () => Promise<boolean>
  ): Promise<boolean> => {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        run(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`readiness ${name} probe exceeded ${options.probeTimeoutMs}ms`)),
            options.probeTimeoutMs
          );
          // Never hold the event loop open just for a readiness deadline.
          timer.unref?.();
        })
      ]);
    } catch (error) {
      options.onProbeFailure?.(name, error);
      // An unknown dependency is a not-ready dependency.
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  const evaluate = async (): Promise<ReadinessSnapshot> => {
    const [db, redis] = await Promise.all([
      probe('db', options.checkDb),
      probe('redis', options.checkRedis)
    ]);

    const workers = options.workersHealthy(redis);
    const redisReady = options.requireRedis ? redis : true;
    // Workers can only be absent *because* Redis is. When this deployment
    // declared Redis optional, that must not fail the verdict — but the
    // `workers` field above still reports the honest fact.
    const workersReady = workers || (!options.requireRedis && !redis);

    return {
      // Belt-and-braces for a drain that begins mid-evaluation: `get()` already
      // short-circuits, but this response is still in flight.
      ready: !options.isShuttingDown() && db && redisReady && workersReady,
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

      const startedGeneration = generation;
      const pending = evaluate()
        .then((snapshot) => {
          if (generation === startedGeneration) {
            cached = { snapshot, expiresAt: now() + options.ttlMs };
          }
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
      generation += 1;
    }
  };
}
