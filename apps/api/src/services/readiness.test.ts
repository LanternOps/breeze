import { describe, it, expect, vi } from 'vitest';
import {
  computeWorkersHealthy,
  createReadinessEvaluator,
  type ReadinessEvaluatorOptions
} from './readiness';

/**
 * Harness with a controllable clock and mutable dependency state, so a single
 * evaluator instance (one "process lifetime") can be walked through
 * healthy → unhealthy → healthy transitions.
 */
function harness(overrides: Partial<ReadinessEvaluatorOptions> = {}) {
  const state = {
    db: true,
    redis: true,
    workers: true,
    shuttingDown: false,
    clock: 1_000_000
  };

  const checkDb = vi.fn(async () => state.db);
  const checkRedis = vi.fn(async () => state.redis);
  const workersHealthy = vi.fn((redisOk: boolean) => redisOk && state.workers);

  const evaluator = createReadinessEvaluator({
    checkDb,
    checkRedis,
    workersHealthy,
    isShuttingDown: () => state.shuttingDown,
    requireRedis: true,
    ttlMs: 5_000,
    now: () => state.clock,
    ...overrides
  });

  return { state, evaluator, checkDb, checkRedis, workersHealthy };
}

describe('createReadinessEvaluator', () => {
  it('does not latch a boot-time workers:false — a late-registering worker flips /ready true', async () => {
    // This is the #2974 regression. The old implementation snapshotted
    // readiness once at boot; whichever way the race landed was permanent.
    const { state, evaluator } = harness();
    state.workers = false;

    const first = await evaluator.get();
    expect(first.ready).toBe(false);
    expect(first.workers).toBe(false);

    // Workers finish registering shortly after the first probe.
    state.workers = true;
    state.clock += 6_000; // past the TTL

    const second = await evaluator.get();
    expect(second.workers).toBe(true);
    expect(second.ready).toBe(true);
    // Same evaluator instance: no restart involved.
    expect(second.checkedAt).not.toBe(first.checkedAt);
  });

  it('reports a dependency that dies after boot (workers cannot go stale-true)', async () => {
    const { state, evaluator } = harness();

    expect((await evaluator.get()).ready).toBe(true);

    state.workers = false;
    state.clock += 6_000;

    const after = await evaluator.get();
    expect(after.ready).toBe(false);
    expect(after.workers).toBe(false);
  });

  it('advances checkedAt on every fresh evaluation', async () => {
    const { state, evaluator } = harness();

    const first = await evaluator.get();
    state.clock += 6_000;
    const second = await evaluator.get();

    expect(first.checkedAt).toBe(new Date(1_000_000).toISOString());
    expect(second.checkedAt).toBe(new Date(1_006_000).toISOString());
  });

  it('recovers from a database outage within one process lifetime', async () => {
    const { state, evaluator } = harness();

    state.db = false;
    expect(await evaluator.get()).toMatchObject({ ready: false, db: false });

    state.db = true;
    state.clock += 6_000;
    expect(await evaluator.get()).toMatchObject({ ready: true, db: true });
  });

  it('serves the cached snapshot within the TTL without re-probing', async () => {
    const { state, evaluator, checkDb, checkRedis } = harness();

    await evaluator.get();
    state.clock += 4_999;
    await evaluator.get();
    await evaluator.get();

    expect(checkDb).toHaveBeenCalledTimes(1);
    expect(checkRedis).toHaveBeenCalledTimes(1);
  });

  it('re-probes once the TTL expires', async () => {
    const { state, evaluator, checkDb } = harness();

    await evaluator.get();
    state.clock += 5_001;
    await evaluator.get();

    expect(checkDb).toHaveBeenCalledTimes(2);
  });

  it('collapses concurrent cache misses into a single probe pair (single-flight)', async () => {
    let releaseDb: (value: boolean) => void = () => {};
    const gate = new Promise<boolean>((resolve) => {
      releaseDb = resolve;
    });
    const checkDb = vi.fn(() => gate);

    const { evaluator, checkRedis } = harness({ checkDb });

    const inFlight = [evaluator.get(), evaluator.get(), evaluator.get()];
    releaseDb(true);
    const results = await Promise.all(inFlight);

    expect(checkDb).toHaveBeenCalledTimes(1);
    expect(checkRedis).toHaveBeenCalledTimes(1);
    expect(results.every((r) => r.ready)).toBe(true);
  });

  it('re-probes after an in-flight evaluation settles (no stuck single-flight slot)', async () => {
    const { state, evaluator, checkDb } = harness();

    await Promise.all([evaluator.get(), evaluator.get()]);
    state.clock += 6_000;
    await evaluator.get();

    expect(checkDb).toHaveBeenCalledTimes(2);
  });

  it('reports not-ready during shutdown without probing, even with a warm ready cache', async () => {
    const { state, evaluator, checkDb, checkRedis } = harness();

    expect((await evaluator.get()).ready).toBe(true);
    checkDb.mockClear();
    checkRedis.mockClear();

    state.shuttingDown = true;

    const draining = await evaluator.get();
    expect(draining).toMatchObject({ ready: false, db: false, redis: false, workers: false });
    expect(checkDb).not.toHaveBeenCalled();
    expect(checkRedis).not.toHaveBeenCalled();
  });

  it('does not resurrect a pre-shutdown cached snapshot after the drain begins', async () => {
    const { state, evaluator } = harness();

    await evaluator.get();
    state.shuttingDown = true;
    await evaluator.get();
    // Even if the flag were somehow cleared, the stale cache must be gone.
    state.shuttingDown = false;
    state.db = false;

    expect((await evaluator.get()).ready).toBe(false);
  });

  it('ignores Redis for the ready verdict when Redis is optional', async () => {
    const { state, evaluator } = harness({
      requireRedis: false,
      workersHealthy: () => true
    });

    state.redis = false;
    const snapshot = await evaluator.get();

    expect(snapshot.redis).toBe(false);
    expect(snapshot.ready).toBe(true);
  });

  it('re-probes on every call when the TTL is zero', async () => {
    const { evaluator, checkDb } = harness({ ttlMs: 0 });

    await evaluator.get();
    await evaluator.get();

    expect(checkDb).toHaveBeenCalledTimes(2);
  });

  it('invalidate() forces the next call to re-probe', async () => {
    const { evaluator, checkDb } = harness();

    await evaluator.get();
    evaluator.invalidate();
    await evaluator.get();

    expect(checkDb).toHaveBeenCalledTimes(2);
  });

  it('passes the freshly probed Redis result to the worker view', async () => {
    const { state, evaluator, workersHealthy } = harness();

    state.redis = false;
    await evaluator.get();

    expect(workersHealthy).toHaveBeenCalledWith(false);
  });
});

describe('computeWorkersHealthy', () => {
  const base = {
    phase: 'started' as const,
    workerStatus: { alertWorkers: true, cisJobs: true },
    redisOk: true,
    requireRedis: true,
    shuttingDown: false
  };

  it('is healthy when every tracked worker initialised', () => {
    expect(computeWorkersHealthy(base)).toBe(true);
  });

  it('is unhealthy when any tracked worker failed to initialise', () => {
    expect(
      computeWorkersHealthy({ ...base, workerStatus: { alertWorkers: true, cisJobs: false } })
    ).toBe(false);
  });

  it('is unhealthy before worker initialisation runs', () => {
    // The HTTP server starts listening before initializeWorkers() resolves, so
    // probes really do hit this window.
    expect(computeWorkersHealthy({ ...base, phase: 'pending', workerStatus: {} })).toBe(false);
  });

  it('flips true once initialisation completes, with no other state change', () => {
    const pending = computeWorkersHealthy({ ...base, phase: 'pending', workerStatus: {} });
    const started = computeWorkersHealthy(base);
    expect([pending, started]).toEqual([false, true]);
  });

  it('is unhealthy when Redis is required and unreachable', () => {
    expect(computeWorkersHealthy({ ...base, redisOk: false })).toBe(false);
  });

  it('tolerates unreachable Redis when Redis is optional', () => {
    expect(computeWorkersHealthy({ ...base, redisOk: false, requireRedis: false })).toBe(true);
  });

  it('stays unhealthy when Redis recovers but boot never started the workers', () => {
    // Nothing is consuming the queues; only a restart fixes this, so returning
    // healthy here would be a lie in the same direction as the original bug.
    expect(
      computeWorkersHealthy({ ...base, phase: 'skipped-no-redis', workerStatus: {} })
    ).toBe(false);
  });

  it('is unhealthy while shutting down', () => {
    expect(computeWorkersHealthy({ ...base, shuttingDown: true })).toBe(false);
  });
});
