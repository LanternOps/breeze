import { describe, it, expect, vi } from 'vitest';
import {
  createReadinessEvaluator,
  type ReadinessEvaluatorOptions
} from './readiness';
import type {
  ConsumerLifecycleState,
  ConsumerReadinessState,
} from './workerReadinessRegistry';

/**
 * Harness with a controllable clock and mutable dependency state, so a single
 * evaluator instance (one "process lifetime") can be walked through
 * healthy → unhealthy → healthy transitions.
 *
 * The registry state is deliberately mutable so lifecycle transitions can be
 * exercised against one evaluator instance.
 */
function harness(overrides: Partial<ReadinessEvaluatorOptions> = {}) {
  const state = {
    db: true,
    redis: true,
    workers: true,
    consumerState: 'running' as ConsumerLifecycleState,
    shuttingDown: false,
    clock: 1_000_000
  };

  const checkDb = vi.fn(async () => state.db);
  const checkRedis = vi.fn(async () => state.redis);
  const consumer = (): ConsumerReadinessState => ({
    name: 'required-consumer-internal-name',
    required: true,
    state: state.workers ? state.consumerState : 'expected',
    running: state.workers && state.consumerState === 'running',
    redisConnected: state.workers && state.consumerState === 'running',
    transitionedAt: new Date(state.clock).toISOString(),
    lastSuccessfulJobAt: null,
    lastErrorAt: state.consumerState === 'failed' ? new Date(state.clock).toISOString() : null,
    lastErrorCode: state.consumerState === 'failed' ? 'InternalFailure' : null,
  });
  const workerRegistry = {
    snapshot: vi.fn(() => ({ requiredConsumer: consumer() })),
    requiredConsumersRunnable: vi.fn(
      () => state.workers && state.consumerState === 'running',
    ),
  };
  const onProbeFailure = vi.fn();

  const evaluator = createReadinessEvaluator({
    checkDb,
    checkRedis,
    workerRegistry,
    workersInitialized: () => true,
    onProbeFailure,
    isShuttingDown: () => state.shuttingDown,
    requireRedis: true,
    ttlMs: 5_000,
    probeTimeoutMs: 1_000,
    now: () => state.clock,
    ...overrides
  });

  return {
    state,
    evaluator,
    checkDb,
    checkRedis,
    workerRegistry,
    onProbeFailure,
  };
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

  describe('verdict composition', () => {
    it.each(['expected', 'stopped', 'redis_disconnected', 'failed'] as const)(
      'fails admission when a required consumer is %s',
      async (consumerState) => {
        const { state, evaluator } = harness();
        state.consumerState = consumerState;

        expect(await evaluator.get()).toMatchObject({
          ready: false,
          workers: false,
          consumers: {
            requiredConsumer: { state: consumerState },
          },
        });
      },
    );

    it('allows an optional disabled consumer when every required consumer is runnable', async () => {
      const optionalDisabled: ConsumerReadinessState = {
        name: 'optional-internal-name',
        required: false,
        state: 'disabled',
        running: false,
        redisConnected: false,
        transitionedAt: '2026-08-24T00:00:00.000Z',
        lastSuccessfulJobAt: null,
        lastErrorAt: null,
        lastErrorCode: 'feature_disabled',
      };
      const { evaluator } = harness({
        workerRegistry: {
          snapshot: () => ({ optionalDisabled }),
          requiredConsumersRunnable: () => true,
        },
      } as Partial<ReadinessEvaluatorOptions>);

      expect(await evaluator.get()).toMatchObject({ ready: true, workers: true });
    });

    it('reflects a recovered consumer on the next invalidated evaluation', async () => {
      const { state, evaluator, checkDb } = harness();
      state.consumerState = 'stopped';
      expect(await evaluator.get()).toMatchObject({ ready: false, workers: false });

      state.consumerState = 'running';
      evaluator.invalidate();

      expect(await evaluator.get()).toMatchObject({ ready: true, workers: true });
      expect(checkDb).toHaveBeenCalledTimes(2);
    });

    it('fails readiness on unreachable Redis when Redis is required', async () => {
      // Isolates the requireRedis term: workers report healthy, db is fine, so
      // Redis is the only thing that can decide the verdict.
      const { state, evaluator } = harness({
        requireRedis: true,
      });

      state.redis = false;
      expect(await evaluator.get()).toMatchObject({
        ready: false,
        db: true,
        redis: false,
        workers: false
      });
    });

    it('keeps admission closed without Redis even when direct Redis use is optional', async () => {
      const { state, evaluator } = harness({ requireRedis: false });

      state.redis = false;
      expect(await evaluator.get()).toMatchObject({
        ready: false,
        redis: false,
        workers: false,
      });
    });

    it('still fails readiness when workers are down for a reason other than Redis', async () => {
      const { state, evaluator } = harness({ requireRedis: false });
      state.workers = false;

      expect(await evaluator.get()).toMatchObject({ ready: false, redis: true, workers: false });
    });

    it('fails readiness on a database outage regardless of Redis being optional', async () => {
      const { state, evaluator } = harness({ requireRedis: false });

      state.db = false;
      expect(await evaluator.get()).toMatchObject({ ready: false, db: false });
    });

    it('stays closed before consumer declarations complete', async () => {
      const { evaluator } = harness({ workersInitialized: () => false });
      expect(await evaluator.get()).toMatchObject({ ready: false, workers: false });
    });
  });

  describe('caching', () => {
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

    it('does not let an evaluation invalidated mid-flight write its stale result back', async () => {
      // Boot ordering: a probe starts while workers are still registering,
      // initializeWorkers() finishes and invalidates, then the older
      // evaluation resolves. It must not re-cache the pre-invalidate answer.
      let release: (value: boolean) => void = () => {};
      const gate = new Promise<boolean>((resolve) => {
        release = resolve;
      });
      const checkDb = vi.fn(() => gate);
      const { state, evaluator } = harness({ checkDb });

      const stale = evaluator.get();
      state.workers = false; // the in-flight snapshot will carry workers:false
      evaluator.invalidate();
      release(true);
      await stale;

      // Workers came good; the next probe must re-evaluate rather than serve
      // the invalidated snapshot from cache.
      state.workers = true;
      const fresh = await evaluator.get();

      expect(fresh.workers).toBe(true);
      expect(checkDb).toHaveBeenCalledTimes(2);
    });
  });

  describe('single-flight', () => {
    it('collapses concurrent cache misses into a single probe pair', async () => {
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

    it('releases the slot after an evaluation settles', async () => {
      const { state, evaluator, checkDb } = harness();

      await Promise.all([evaluator.get(), evaluator.get()]);
      state.clock += 6_000;
      await evaluator.get();

      expect(checkDb).toHaveBeenCalledTimes(2);
    });

    it('is not wedged by a probe that throws — the next call still answers', async () => {
      // A wedged single-flight slot would silence /ready for the rest of the
      // process, which is a worse latch than the one this module removes.
      let shouldThrow = true;
      const checkDb = vi.fn(async () => {
        if (shouldThrow) throw new Error('pool exhausted');
        return true;
      });
      const { state, evaluator, onProbeFailure } = harness({ checkDb });

      expect(await evaluator.get()).toMatchObject({ ready: false, db: false });
      expect(onProbeFailure).toHaveBeenCalledWith('db', expect.any(Error));

      shouldThrow = false;
      state.clock += 6_000;
      expect(await evaluator.get()).toMatchObject({ ready: true, db: true });
    });
  });

  describe('probe deadlines', () => {
    it('counts a probe that never settles as unhealthy instead of hanging forever', async () => {
      // postgres.js has no pool-acquire timeout, so a saturated pool leaves the
      // query queued indefinitely. Without the deadline this call never
      // resolves and every later probe awaits the same dead promise.
      const { evaluator, onProbeFailure } = harness({
        checkDb: vi.fn(() => new Promise<boolean>(() => {})),
        probeTimeoutMs: 20
      });

      expect(await evaluator.get()).toMatchObject({ ready: false, db: false, redis: true });
      expect(onProbeFailure).toHaveBeenCalledWith('db', expect.any(Error));
    });

    it('keeps answering after a timed-out probe, and recovers when the probe does', async () => {
      let hang = true;
      const checkDb = vi.fn(() => (hang ? new Promise<boolean>(() => {}) : Promise.resolve(true)));
      const { state, evaluator } = harness({ checkDb, probeTimeoutMs: 20 });

      expect(await evaluator.get()).toMatchObject({ ready: false, db: false });

      hang = false;
      state.clock += 6_000;
      expect(await evaluator.get()).toMatchObject({ ready: true, db: true });
    });

    it('does not report a failure for a probe that finishes inside its deadline', async () => {
      const { evaluator, onProbeFailure } = harness({ probeTimeoutMs: 1_000 });

      await evaluator.get();

      expect(onProbeFailure).not.toHaveBeenCalled();
    });
  });

  describe('shutdown', () => {
    it('reports not-ready without probing, even with a warm ready cache', async () => {
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

    it('still advances checkedAt while draining', async () => {
      // A frozen checkedAt is the exact symptom operators used to diagnose
      // #2974, so the drain response must not reintroduce one.
      const { state, evaluator } = harness();
      state.shuttingDown = true;

      const first = await evaluator.get();
      state.clock += 1_000;
      const second = await evaluator.get();

      expect(second.checkedAt).not.toBe(first.checkedAt);
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
  });
});
