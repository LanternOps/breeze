/**
 * Boot-order / readiness / role-guard tests for `worker.ts` (wave 3.5d-b,
 * #4086, Task 6). Every heavy dependency worker.ts loads via a dynamic
 * `await import(...)` (see that file's header comment) is mocked here via
 * `vi.mock` on the exact same relative specifier — this test file sits next
 * to `worker.ts`, so the specifiers resolve identically for both. `vi.hoisted`
 * gives the mock factories STABLE `vi.fn()` handles that survive
 * `vi.resetModules()` (needed between tests so worker.ts's own top-level
 * state — and its auto-invoked `bootWorker()` call — re-runs fresh each time
 * with that test's mock configuration already in place).
 *
 * `process.exit` is mocked as a no-op that records the code instead of
 * terminating the test process; every `process.exit(...)` call site in
 * worker.ts has an explicit `return` right after it for exactly this reason
 * (see worker.ts's comments).
 *
 * The Task 7 LIVE boot smoke (`docker` + a real Postgres/Redis) is separate
 * and out of scope here — this suite never touches a real database or Redis.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import type { Worker } from 'bullmq';
import { Gauge } from 'prom-client';

const SCRAPE_TOKEN = 'worker-scrape-token';

/** The subset of `declareExpectedConsumers`'s input these tests drive. */
type DeclareExpectedConsumersInput = {
  role: string;
  redisAvailable: boolean;
  abuseSignalsEnabled: boolean;
  eventDispatchEnabled: boolean;
  aiAgentsEnabled: boolean;
  registry: { expect(name: string, required: boolean): void };
};

const mocks = vi.hoisted(() => {
  return {
    breezeRole: vi.fn<() => string>(),
    validateConfig: vi.fn<() => { NODE_ENV: string }>(),
    initSentry: vi.fn(),
    captureException: vi.fn(),
    captureMessage: vi.fn(),
    flushSentry: vi.fn(async () => {}),
    setConnectTimeoutClassifier: vi.fn(),
    safeDiagnoseConnectTimeout: vi.fn(() => null),
    startEventLoopMonitor: vi.fn<() => { intervalMs: number } | null>(() => ({ intervalMs: 500 })),
    stopEventLoopMonitor: vi.fn(),
    startDbPoolHealthMonitor: vi.fn<() => number | null>(() => 30_000),
    stopDbPoolHealthMonitor: vi.fn(),
    updateRuntimeMetrics: vi.fn(),
    dbExecute: vi.fn(async () => [] as unknown[]),
    withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
    closeDb: vi.fn(async () => {}),
    redisPing: vi.fn(async () => 'PONG'),
    getRedis: vi.fn<() => { ping: () => Promise<string> } | null>(),
    closeRedis: vi.fn(async () => {}),
    waitForMigrationParity: vi.fn(async () => {}),
    initializeDatabaseForStartup: vi.fn(async () => {}),
    loadBuiltinExtensions: vi.fn(async () => {}),
    createExtensionStateStore: vi.fn(() => ({})),
    registerAiAgentEnqueuer: vi.fn(),
    registerAllEventSubscribers: vi.fn(),
    buildWebhookFanoutDeps: vi.fn(() => ({})),
    abuseSignalsEnabled: vi.fn(() => false),
    eventDispatchMode: vi.fn(() => 'off' as const),
    declareExpectedConsumers: vi.fn<(input: DeclareExpectedConsumersInput) => void>(),
    consumersForInitializer: vi.fn((_name: string): readonly string[] => []),
    startRegisteredWorkers: vi.fn(
      async (_role: string, hooks: { onResult: (n: string, ok: boolean, e?: unknown) => void }) => {
        hooks.onResult('fakeGlobalWorker', true);
      },
    ),
    buildWorkerShutdownTasks: vi.fn(async () => [] as Array<() => Promise<void>>),
    initializeEventDispatchWorker: vi.fn(async () => {}),
    shutdownEventDispatchWorker: vi.fn(async () => {}),
    shutdownEventDispatcher: vi.fn(async () => {}),
    shutdownEventDispatchQueue: vi.fn(async () => {}),
    getEventBus: vi.fn(() => ({ close: vi.fn(async () => {}) })),
    drainAuditRetryQueue: vi.fn(async () => {}),
    shutdownPhaseCalls: [] as string[][],
    runShutdownPhases: vi.fn(
      async (phases: Array<{ name: string }>): Promise<{ failures: unknown[]; timedOutPhases: string[] }> => {
        mocks.shutdownPhaseCalls.push(phases.map((p) => p.name));
        return { failures: [], timedOutPhases: [] };
      },
    ),
  };
});

vi.mock('./config/env', () => ({
  breezeRole: mocks.breezeRole,
  abuseSignalsEnabled: mocks.abuseSignalsEnabled,
  eventDispatchMode: mocks.eventDispatchMode,
  AI_AGENTS_ENABLED: false,
}));
vi.mock('./config/validate', () => ({ validateConfig: mocks.validateConfig }));
vi.mock('./services/sentry', () => ({
  initSentry: mocks.initSentry,
  captureException: mocks.captureException,
  captureMessage: mocks.captureMessage,
  flushSentry: mocks.flushSentry,
  setConnectTimeoutClassifier: mocks.setConnectTimeoutClassifier,
}));
// #4143 observability wiring. The monitors themselves are covered by their own
// suites (eventLoopMonitor.test.ts / dbPoolHealthMonitor.test.ts); what this
// file owns is that worker.ts STARTS and STOPS them at the right points, which
// is exactly the wiring that was missing and is silent when absent — an
// unstarted monitor reports `monitored: false`, which every consumer correctly
// reads as "unknown". Nothing breaks; the container just goes blind.
vi.mock('./services/eventLoopMonitor', () => ({
  startEventLoopMonitor: mocks.startEventLoopMonitor,
  stopEventLoopMonitor: mocks.stopEventLoopMonitor,
  getEventLoopStarvationThresholdMs: () => 1_000,
}));
vi.mock('./services/eventLoopStarvationReporter', () => ({
  createStarvationReporter: () => () => {},
}));
vi.mock('./services/postgresConnectTimeout', () => ({
  safeDiagnoseConnectTimeout: mocks.safeDiagnoseConnectTimeout,
  getConnectTimeoutStarvationThresholdMs: () => 1_000,
}));
vi.mock('./db/dbPoolHealthMonitor', () => ({
  startDbPoolHealthMonitor: mocks.startDbPoolHealthMonitor,
  stopDbPoolHealthMonitor: mocks.stopDbPoolHealthMonitor,
  getDbPoolHealthWindowMs: () => 60_000,
  getDbPoolHealthMinTimeouts: () => 3,
}));
vi.mock('./services/metricsRuntime', () => ({
  updateRuntimeMetrics: mocks.updateRuntimeMetrics,
}));
vi.mock('./db', () => ({
  db: { execute: mocks.dbExecute },
  withSystemDbAccessContext: mocks.withSystemDbAccessContext,
  closeDb: mocks.closeDb,
}));
vi.mock('./services/redis', () => ({
  getRedis: mocks.getRedis,
  closeRedis: mocks.closeRedis,
}));
vi.mock('./db/migrationParity', () => ({ waitForMigrationParity: mocks.waitForMigrationParity }));
vi.mock('./db/databaseStartup', () => ({ initializeDatabaseForStartup: mocks.initializeDatabaseForStartup }));
vi.mock('./extensions/builtinExtensions', () => ({ loadBuiltinExtensions: mocks.loadBuiltinExtensions }));
vi.mock('./extensions/contributionRegistry', () => ({ extensionContributionRegistry: {} }));
vi.mock('./extensions/stateStore', () => ({ createExtensionStateStore: mocks.createExtensionStateStore }));
vi.mock('./jobs/aiAgentEnqueuer', () => ({ registerAiAgentEnqueuer: mocks.registerAiAgentEnqueuer }));
vi.mock('./services/eventSubscribers', () => ({ registerAllEventSubscribers: mocks.registerAllEventSubscribers }));
vi.mock('./services/webhookFanoutDeps', () => ({ buildWebhookFanoutDeps: mocks.buildWebhookFanoutDeps }));
vi.mock('./services/workerRegistry', () => ({
  startRegisteredWorkers: mocks.startRegisteredWorkers,
  buildWorkerShutdownTasks: mocks.buildWorkerShutdownTasks,
}));
// Track C: the manifest is mocked WHOLESALE so each test controls the declared
// consumer set directly (the real one declares the whole worker-role registry).
// `./services/workerReadinessRegistry` is deliberately NOT mocked — it is a
// leaf with no side effects, and the real registry is what makes the
// fail-closed ("declared but never attached") assertions real rather than a
// test of our own mock.
vi.mock('./jobs/workerReadinessManifest', () => ({
  declareExpectedConsumers: mocks.declareExpectedConsumers,
  consumersForInitializer: mocks.consumersForInitializer,
}));
vi.mock('./jobs/eventDispatchWorker', () => ({
  initializeEventDispatchWorker: mocks.initializeEventDispatchWorker,
  shutdownEventDispatchWorker: mocks.shutdownEventDispatchWorker,
}));
vi.mock('./services/eventDispatcher', () => ({ shutdownEventDispatcher: mocks.shutdownEventDispatcher }));
vi.mock('./services/eventDispatchQueue', () => ({ shutdownEventDispatchQueue: mocks.shutdownEventDispatchQueue }));
vi.mock('./services/eventBus', () => ({ getEventBus: mocks.getEventBus }));
vi.mock('./services/auditService', () => ({ drainAuditRetryQueue: mocks.drainAuditRetryQueue }));
// Stubbed rather than left real: real `runShutdownPhases` is already covered
// by Part A's own tests, and stubbing it lets this suite assert exactly
// which phase NAMES (and in what order) worker.ts hands it, with no need to
// drive real per-task timing.
vi.mock('./services/shutdownPhases', () => ({ runShutdownPhases: mocks.runShutdownPhases }));

type WorkerModule = typeof import('./worker');

let exitCalls: number[] = [];

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor: condition never became true within the timeout');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function importFreshWorker(): Promise<WorkerModule> {
  vi.resetModules();
  return import('./worker');
}

async function waitForListening(worker: WorkerModule): Promise<number> {
  await waitFor(() => {
    const server = worker._getHealthServerForTest();
    return !!server && server.listening;
  });
  const addr = worker._getHealthServerForTest()!.address();
  if (addr && typeof addr === 'object') return addr.port;
  throw new Error('health server has no assigned port');
}

function getJson(port: number, path: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) });
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('error', reject);
  });
}

/** Minimal Worker-shaped double the registry accepts: events + isRunning() + a ready client. */
function fakeBullmqWorker() {
  return Object.assign(new EventEmitter(), {
    isRunning: () => true,
    client: Promise.resolve({ status: 'ready' }),
  });
}

/** The registry instance worker.ts is using in THIS test's module generation (after vi.resetModules). */
async function liveRegistry() {
  return (await import('./services/workerReadinessRegistry')).workerReadinessRegistry;
}

/** Raw GET returning the body as TEXT — for asserting on what is (not) serialized. */
function getText(port: number, path: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: data }));
    }).on('error', reject);
  });
}

/**
 * Raw GET returning the body as TEXT plus headers — `/metrics` renders
 * Prometheus exposition format, not JSON, so `getJson` cannot read it.
 */
function rawGet(
  port: number,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string; contentType: string | undefined }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path, headers }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          body: data,
          contentType: res.headers['content-type'],
        }),
      );
    });
    req.on('error', reject);
  });
}

beforeEach(() => {
  exitCalls = [];
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCalls.push(code ?? 0);
    return undefined as never;
  }) as never);

  process.env.API_PORT = '0';
  process.env.METRICS_SCRAPE_TOKEN = SCRAPE_TOKEN;
  delete process.env.METRICS_SCRAPE_IP_ALLOWLIST;

  vi.clearAllMocks();
  mocks.shutdownPhaseCalls.length = 0;

  // Baseline "everything healthy" defaults; individual tests override.
  mocks.breezeRole.mockReturnValue('worker');
  mocks.validateConfig.mockReturnValue({ NODE_ENV: 'test' });
  mocks.dbExecute.mockResolvedValue([]);
  mocks.withSystemDbAccessContext.mockImplementation(async (fn: () => Promise<unknown>) => fn());
  mocks.closeDb.mockResolvedValue(undefined);
  mocks.redisPing.mockResolvedValue('PONG');
  mocks.getRedis.mockReturnValue({ ping: mocks.redisPing });
  mocks.closeRedis.mockResolvedValue(undefined);
  mocks.waitForMigrationParity.mockResolvedValue(undefined);
  mocks.initializeDatabaseForStartup.mockResolvedValue(undefined);
  mocks.loadBuiltinExtensions.mockResolvedValue(undefined);
  mocks.createExtensionStateStore.mockReturnValue({});
  mocks.buildWebhookFanoutDeps.mockReturnValue({});
  mocks.abuseSignalsEnabled.mockReturnValue(false);
  mocks.eventDispatchMode.mockReturnValue('off');
  mocks.declareExpectedConsumers.mockImplementation(({ registry }) => {
    registry.expect('fakeGlobalWorker', true);
  });
  mocks.consumersForInitializer.mockImplementation((name: string) => (name === 'fakeGlobalWorker' ? ['fakeGlobalWorker'] : []));
  mocks.startRegisteredWorkers.mockImplementation(
    async (_role: string, hooks: { onResult: (n: string, ok: boolean, e?: unknown) => void }) => {
      (await liveRegistry()).attach('fakeGlobalWorker', fakeBullmqWorker() as unknown as Worker);
      hooks.onResult('fakeGlobalWorker', true);
    },
  );
  mocks.buildWorkerShutdownTasks.mockResolvedValue([]);
  mocks.initializeEventDispatchWorker.mockResolvedValue(undefined);
  mocks.shutdownEventDispatchWorker.mockResolvedValue(undefined);
  mocks.shutdownEventDispatcher.mockResolvedValue(undefined);
  mocks.shutdownEventDispatchQueue.mockResolvedValue(undefined);
  mocks.getEventBus.mockReturnValue({ close: vi.fn(async () => {}) });
  mocks.drainAuditRetryQueue.mockResolvedValue(undefined);
});

afterEach(async () => {
  // Every successful boot in this suite installs SIGINT/SIGTERM/
  // unhandledRejection/uncaughtException listeners on the real `process`
  // object (worker.ts has no test-mode branch for this — it's the real
  // production wiring). Left attached, a later test's `process.emit(...)`
  // would also refire an earlier test's now-stale closures. Strip them
  // between tests; this file owns none of these listeners in steady state.
  process.removeAllListeners('SIGINT');
  process.removeAllListeners('SIGTERM');
  process.removeAllListeners('unhandledRejection');
  process.removeAllListeners('uncaughtException');
  vi.restoreAllMocks();
});

describe('worker.ts boot (#4086 Task 6)', () => {
  it('exits 78 before any side effect when BREEZE_ROLE is not worker', async () => {
    mocks.breezeRole.mockReturnValue('api');

    await importFreshWorker();

    expect(exitCalls).toEqual([78]);
    expect(mocks.validateConfig).not.toHaveBeenCalled();
    expect(mocks.initSentry).not.toHaveBeenCalled();
    expect(mocks.waitForMigrationParity).not.toHaveBeenCalled();
    expect(mocks.loadBuiltinExtensions).not.toHaveBeenCalled();
    expect(mocks.startRegisteredWorkers).not.toHaveBeenCalled();
  });

  it('boots in order: migration parity -> role verification -> enqueuer/subscribers -> workers', async () => {
    const order: string[] = [];
    mocks.waitForMigrationParity.mockImplementation(async () => { order.push('parity'); });
    mocks.initializeDatabaseForStartup.mockImplementation(async () => { order.push('roleVerification'); });
    mocks.registerAiAgentEnqueuer.mockImplementation(() => { order.push('registerAiAgentEnqueuer'); });
    mocks.registerAllEventSubscribers.mockImplementation(() => { order.push('registerAllEventSubscribers'); });
    mocks.declareExpectedConsumers.mockImplementation(({ registry }) => {
      order.push('declareExpectedConsumers');
      registry.expect('fakeGlobalWorker', true);
    });
    mocks.startRegisteredWorkers.mockImplementation(
      async (_role: string, hooks: { onResult: (n: string, ok: boolean, e?: unknown) => void }) => {
        order.push('startRegisteredWorkers');
        (await liveRegistry()).attach('fakeGlobalWorker', fakeBullmqWorker() as unknown as Worker);
        hooks.onResult('fakeGlobalWorker', true);
      },
    );
    mocks.initializeEventDispatchWorker.mockImplementation(async () => { order.push('initializeEventDispatchWorker'); });

    const worker = await importFreshWorker();
    await waitFor(() => worker._getWorkerInitPhaseForTest() === 'started');

    expect(order).toEqual([
      'parity',
      'roleVerification',
      'registerAiAgentEnqueuer',
      'registerAllEventSubscribers',
      'declareExpectedConsumers',
      'startRegisteredWorkers',
      'initializeEventDispatchWorker',
    ]);
  });

  it('exits non-zero when production DB-role verification fails, before Redis is probed or workers start', async () => {
    mocks.initializeDatabaseForStartup.mockRejectedValue(new Error('request pool is SUPERUSER'));

    const worker = await importFreshWorker();
    await waitFor(() => exitCalls.length > 0);

    expect(exitCalls).toEqual([1]);
    expect(worker._getWorkerInitPhaseForTest()).toBe('pending');
    expect(mocks.redisPing).not.toHaveBeenCalled();
    expect(mocks.loadBuiltinExtensions).not.toHaveBeenCalled();
    expect(mocks.startRegisteredWorkers).not.toHaveBeenCalled();
  });

  it('readiness flips to ready only after every worker init result is recorded', async () => {
    let resolveStart!: () => void;
    const startGate = new Promise<void>((resolve) => { resolveStart = resolve; });
    mocks.startRegisteredWorkers.mockImplementation(
      async (_role: string, hooks: { onResult: (n: string, ok: boolean, e?: unknown) => void }) => {
        await startGate;
        (await liveRegistry()).attach('fakeGlobalWorker', fakeBullmqWorker() as unknown as Worker);
        hooks.onResult('fakeGlobalWorker', true);
      },
    );

    const worker = await importFreshWorker();
    await waitFor(() => mocks.startRegisteredWorkers.mock.calls.length > 0);

    // Migration parity + Redis are already satisfied at this point (both run
    // before startRegisteredWorkers), but no worker outcome has been
    // recorded yet — readiness must still report not-ready.
    const midSnapshot = await worker._getReadinessForTest().get();
    expect(midSnapshot.ready).toBe(false);
    expect(worker._getWorkerInitPhaseForTest()).not.toBe('started');

    resolveStart();
    await waitFor(() => worker._getWorkerInitPhaseForTest() === 'started');

    const finalSnapshot = await worker._getReadinessForTest().get();
    expect(finalSnapshot.ready).toBe(true);
    expect(finalSnapshot.workers).toBe(true);
    // Redis is mandatory in this entrypoint, so the worker-role consumer set is
    // declared with redisAvailable: true and the flag inputs resolved at
    // declare time (spec D3a).
    expect(mocks.declareExpectedConsumers).toHaveBeenCalledWith(expect.objectContaining({
      role: 'worker',
      redisAvailable: true,
      abuseSignalsEnabled: false,
      eventDispatchEnabled: false,
      aiAgentsEnabled: false,
    }));
  });

  it('stays not-ready in the pre-declaration window — an empty registry is never vacuously ready', async () => {
    // Between migration parity and declareExpectedConsumers the registry is
    // EMPTY, so requiredConsumersRunnable() is vacuously true; only the
    // workersInitialized gate (workerInitPhase === 'started') keeps that
    // window not-ready. Sample readiness inside it.
    let releaseDeclare!: () => void;
    const declareGate = new Promise<void>((resolve) => { releaseDeclare = resolve; });
    let declareReached!: () => void;
    const reachedDeclare = new Promise<void>((resolve) => { declareReached = resolve; });
    mocks.declareExpectedConsumers.mockImplementation(({ registry }) => {
      declareReached();
      void declareGate.then(() => registry.expect('fakeGlobalWorker', true));
    });
    // startRegisteredWorkers must not attach before the (deferred) declaration.
    mocks.startRegisteredWorkers.mockImplementation(async (_role, hooks) => {
      await declareGate;
      (await liveRegistry()).attach('fakeGlobalWorker', fakeBullmqWorker() as unknown as Worker);
      hooks.onResult('fakeGlobalWorker', true);
    });

    const worker = await importFreshWorker();
    await reachedDeclare;

    const preDeclare = await worker._getReadinessForTest().get();
    expect(preDeclare).toMatchObject({ ready: false, db: true, redis: true, workers: false });
    expect(Object.keys(preDeclare.consumers)).toEqual([]);

    releaseDeclare();
    await waitFor(() => worker._getWorkerInitPhaseForTest() === 'started');
    expect((await worker._getReadinessForTest().get()).ready).toBe(true);
  });

  it('stays not-ready when a declared consumer never attaches (fail-closed half of D4)', async () => {
    mocks.declareExpectedConsumers.mockImplementation(({ registry }) => {
      registry.expect('fakeGlobalWorker', true);
      registry.expect('neverAttached', true);
    });
    const worker = await importFreshWorker();
    const port = await waitForListening(worker);
    await waitFor(() => worker._getWorkerInitPhaseForTest() === 'started');

    const snapshot = await worker._getReadinessForTest().get();
    expect(snapshot).toMatchObject({ ready: false, db: true, redis: true, workers: false });
    const response = await getJson(port, '/health/ready');
    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ ready: false, reason: 'workers-pending', role: 'worker' });
  });

  it('records initialization failure for every consumer of a failed registry entry AND of a failed eventDispatch', async () => {
    mocks.declareExpectedConsumers.mockImplementation(({ registry }) => {
      for (const n of ['fakeGlobalWorker', 'brokenA', 'brokenB', 'eventDispatch', 'eventDispatchMaintenance']) {
        registry.expect(n, n !== 'eventDispatchMaintenance');
      }
    });
    mocks.consumersForInitializer.mockImplementation((name: string) =>
      name === 'brokenEntry' ? ['brokenA', 'brokenB']
        : name === 'eventDispatch' ? ['eventDispatch', 'eventDispatchMaintenance']
          : name === 'fakeGlobalWorker' ? ['fakeGlobalWorker'] : []);
    mocks.startRegisteredWorkers.mockImplementation(async (_role, hooks) => {
      (await liveRegistry()).attach('fakeGlobalWorker', fakeBullmqWorker() as unknown as Worker);
      hooks.onResult('fakeGlobalWorker', true);
      hooks.onResult('brokenEntry', false, new TypeError('boom'));
    });
    mocks.initializeEventDispatchWorker.mockRejectedValue(new RangeError('dispatch boom'));
    const worker = await importFreshWorker();
    await waitFor(() => worker._getWorkerInitPhaseForTest() === 'started');

    const consumers = (await liveRegistry()).snapshot();
    expect(consumers.brokenA).toMatchObject({ state: 'failed', lastErrorCode: 'TypeError' });
    expect(consumers.brokenB).toMatchObject({ state: 'failed', lastErrorCode: 'TypeError' });
    expect(consumers.eventDispatch).toMatchObject({ state: 'failed', lastErrorCode: 'RangeError' });
    expect((await worker._getReadinessForTest().get()).ready).toBe(false);
    expect(mocks.captureException).toHaveBeenCalledTimes(2);
  });

  it('never serializes consumer names, timestamps, or error codes on /health/ready (mirror of routes/readiness.test.ts)', async () => {
    const leaky = fakeBullmqWorker();
    mocks.declareExpectedConsumers.mockImplementation(({ registry }) => {
      registry.expect('leaky-postgres-primary.internal', true);
    });
    mocks.startRegisteredWorkers.mockImplementation(async (_role, hooks) => {
      (await liveRegistry()).attach('leaky-postgres-primary.internal', leaky as unknown as Worker);
      hooks.onResult('leaky-postgres-primary.internal', true);
    });
    const worker = await importFreshWorker();
    const port = await waitForListening(worker);
    await waitFor(() => worker._getWorkerInitPhaseForTest() === 'started');

    const ok = await getJson(port, '/health/ready');
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({
      role: 'worker', ready: true, db: true, redis: true, workers: true, checkedAt: expect.any(String),
      consumerSummary: { required: 1, runnable: 1, unavailable: 0, optionalRunning: 0, optionalDisabled: 0 },
    });

    leaky.emit('error', Object.assign(new Error('redis://secret.internal:6379'), { name: 'RedisSecretError' }));
    const degraded = await getText(port, '/health/ready');
    expect(degraded.status).toBe(503);
    expect(JSON.parse(degraded.text)).toEqual({
      reason: 'workers-pending', role: 'worker', ready: false, db: true, redis: true, workers: false, checkedAt: expect.any(String),
      consumerSummary: { required: 1, runnable: 0, unavailable: 1, optionalRunning: 0, optionalDisabled: 0 },
    });
    // The three redaction assertions the API-side test carries: name, timestamp, error code.
    expect(degraded.text).not.toContain('leaky-postgres-primary');   // registry name
    expect(degraded.text).not.toContain('"transitionedAt"');         // per-consumer timestamp field
    expect(degraded.text).not.toContain('RedisSecretError');         // error code
    expect(degraded.text).not.toContain('secret.internal');          // error message / endpoint
    expect(degraded.text).not.toContain('"consumers"');              // the snapshot map itself
  });

  it('reports migrations-pending over HTTP while parity is pending, then exits non-zero on failure', async () => {
    let rejectParity!: (error: unknown) => void;
    mocks.waitForMigrationParity.mockImplementation(
      () => new Promise<void>((_resolve, reject) => { rejectParity = reject; }),
    );

    const worker = await importFreshWorker();
    const port = await waitForListening(worker);

    const midResponse = await getJson(port, '/health/ready');
    expect(midResponse.status).toBe(503);
    expect(midResponse.body).toEqual({ ready: false, reason: 'migrations-pending' });

    // `/health` (basic liveness) stays 200 the whole time, unlike `/health/ready`.
    const liveness = await getJson(port, '/health');
    expect(liveness.status).toBe(200);
    expect(liveness.body).toMatchObject({ status: 'ok', role: 'worker' });

    rejectParity(new Error('checksum mismatch'));
    await waitFor(() => exitCalls.length > 0);
    expect(exitCalls).toEqual([1]);
    expect(worker._getWorkerInitPhaseForTest()).toBe('pending');
  });

  it('exits non-zero when the database is unreachable at boot', async () => {
    mocks.dbExecute.mockRejectedValue(new Error('connection refused'));

    await importFreshWorker();
    await waitFor(() => exitCalls.length > 0);

    expect(exitCalls).toEqual([1]);
    expect(mocks.waitForMigrationParity).not.toHaveBeenCalled();
    expect(mocks.loadBuiltinExtensions).not.toHaveBeenCalled();
  });

  it('exits non-zero when Redis is unreachable at boot — no skipped-no-redis limp mode', async () => {
    mocks.getRedis.mockReturnValue(null);

    const worker = await importFreshWorker();
    await waitFor(() => exitCalls.length > 0);

    expect(exitCalls).toEqual([1]);
    expect(worker._getWorkerInitPhaseForTest()).toBe('pending');
    expect(mocks.loadBuiltinExtensions).not.toHaveBeenCalled();
    expect(mocks.startRegisteredWorkers).not.toHaveBeenCalled();
  });

  it('loads built-in extensions in worker mode', async () => {
    await importFreshWorker();
    await waitFor(() => mocks.loadBuiltinExtensions.mock.calls.length > 0);

    expect(mocks.loadBuiltinExtensions).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'worker' }),
    );
  });

  it('SIGTERM runs shutdown phases in order and exits 0 on success', async () => {
    const worker = await importFreshWorker();
    await waitFor(() => worker._getWorkerInitPhaseForTest() === 'started');

    process.emit('SIGTERM');
    await waitFor(() => mocks.shutdownPhaseCalls.length > 0);

    expect(mocks.shutdownPhaseCalls[0]).toEqual([
      'drain',
      'workers',
      'queues',
      'eventbus',
      'redis',
      'db',
      'sentry',
    ]);
    await waitFor(() => exitCalls.length > 0);
    expect(exitCalls).toEqual([0]);
  });

  it('a second SIGTERM during shutdown force-exits with 130', async () => {
    let resolveShutdown!: (report: { failures: unknown[]; timedOutPhases: string[] }) => void;
    mocks.runShutdownPhases.mockImplementation((phases: Array<{ name: string }>) => {
      mocks.shutdownPhaseCalls.push(phases.map((p) => p.name));
      return new Promise((resolve) => { resolveShutdown = resolve; });
    });

    const worker = await importFreshWorker();
    await waitFor(() => worker._getWorkerInitPhaseForTest() === 'started');

    process.emit('SIGTERM');
    await waitFor(() => mocks.shutdownPhaseCalls.length > 0);
    // First signal is still draining (runShutdownPhases never resolved) — no
    // exit call yet.
    expect(exitCalls).toEqual([]);

    process.emit('SIGTERM');
    await waitFor(() => exitCalls.length > 0);
    expect(exitCalls).toEqual([130]);

    // Let the gated shutdown settle so it doesn't leak into the next test.
    resolveShutdown({ failures: [], timedOutPhases: [] });
  });
});

/**
 * #4143 — the worker container's own observability surface.
 *
 * Before this, a droplet in split mode published NOTHING from the container
 * running the relocated BullMQ workers: the Prometheus registry was private to
 * `routes/metrics.ts`, which a worker-role process must never import (see
 * services/workerEntrypointClosure.contract.test.ts), so every series that
 * process could have produced was ABSENT — not stale, not zero. No `up`, no
 * event-loop lag, no pool-health verdict, on the exact process where #3022 and
 * #3214 were loudest.
 */
describe('worker.ts /metrics (#4143)', () => {
  /**
   * Registers a uniquely-named gauge on the registry singleton **that the
   * freshly-imported worker sees**.
   *
   * It MUST run after `importFreshWorker()`: that calls `vi.resetModules()`,
   * so a registry imported before the reset is a different instance from the
   * one worker.ts binds to, and a canary on it would never appear no matter
   * how correct the endpoint is. Dynamically importing here resolves within
   * the same post-reset module registry the worker got.
   *
   * Finding this canary in the response is what distinguishes "serves the
   * SHARED registry" — the entire point of extracting it out of
   * routes/metrics.ts — from "serves some empty registry of its own", which
   * would satisfy every auth-gate assertion below while publishing nothing.
   */
  async function registerCanary(): Promise<string> {
    const { metricsRegistry } = await import('./services/metricsRegistry');
    const name = `worker_metrics_canary_${Math.random().toString(36).slice(2)}`;
    const gauge = new Gauge({
      name,
      help: 'canary proving /metrics renders the shared registry',
      registers: [metricsRegistry],
    });
    gauge.set(42);
    return name;
  }

  it('serves the SHARED registry with the correct token', async () => {
    const worker = await importFreshWorker();
    const canary = await registerCanary();
    const port = await waitForListening(worker);

    const res = await rawGet(port, '/metrics', { Authorization: `Bearer ${SCRAPE_TOKEN}` });

    expect(res.status).toBe(200);
    expect(res.contentType).toContain('text/plain');
    expect(res.body).toContain(`${canary} 42`);
  });

  it('refreshes the read-on-scrape runtime series before rendering', async () => {
    // Without this the event-loop lag and pool-health verdict would render
    // whatever they held at boot: a flat, entirely plausible healthy line that
    // cannot be told apart from a genuinely quiet process.
    const worker = await importFreshWorker();
    await waitFor(() => worker._getWorkerInitPhaseForTest() === 'started');
    const port = await waitForListening(worker);
    mocks.updateRuntimeMetrics.mockClear();

    await rawGet(port, '/metrics', { Authorization: `Bearer ${SCRAPE_TOKEN}` });

    expect(mocks.updateRuntimeMetrics).toHaveBeenCalled();
  });

  it('401s a missing, malformed or wrong bearer token', async () => {
    const worker = await importFreshWorker();
    const canary = await registerCanary();
    const port = await waitForListening(worker);

    for (const headers of [
      {},
      { Authorization: SCRAPE_TOKEN },
      { Authorization: `Bearer ${SCRAPE_TOKEN}x` },
    ]) {
      const res = await rawGet(port, '/metrics', headers as Record<string, string>);
      expect(res.status, JSON.stringify(headers)).toBe(401);
      expect(JSON.parse(res.body)).toEqual({ error: 'Unauthorized' });
      // A refusal must never leak the series it is refusing to serve.
      expect(res.body).not.toContain(canary);
    }
  });

  it('503s when METRICS_SCRAPE_TOKEN is not configured', async () => {
    delete process.env.METRICS_SCRAPE_TOKEN;
    const worker = await importFreshWorker();
    const canary = await registerCanary();
    const port = await waitForListening(worker);

    const res = await rawGet(port, '/metrics', { Authorization: 'Bearer anything' });

    expect(res.status).toBe(503);
    expect(JSON.parse(res.body)).toEqual({ error: 'Metrics scrape token is not configured' });
    expect(res.body).not.toContain(canary);
  });

  it('403s an off-allowlist peer even with the correct token', async () => {
    process.env.METRICS_SCRAPE_IP_ALLOWLIST = '203.0.113.7';
    const worker = await importFreshWorker();
    const canary = await registerCanary();
    const port = await waitForListening(worker);

    // The test client connects from loopback, which is not on the allowlist.
    const res = await rawGet(port, '/metrics', { Authorization: `Bearer ${SCRAPE_TOKEN}` });

    expect(res.status).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: 'Forbidden' });
    expect(res.body).not.toContain(canary);
  });

  it('allows a loopback peer when loopback is on the allowlist', async () => {
    // Pins the direct-peer resolution end to end, including the IPv4-mapped
    // IPv6 normalisation a dual-stack listener produces.
    process.env.METRICS_SCRAPE_IP_ALLOWLIST = '127.0.0.1,::1';
    const worker = await importFreshWorker();
    const canary = await registerCanary();
    const port = await waitForListening(worker);

    const res = await rawGet(port, '/metrics', { Authorization: `Bearer ${SCRAPE_TOKEN}` });

    expect(res.status).toBe(200);
    expect(res.body).toContain(`${canary} 42`);
  });

  it('ignores X-Forwarded-For — the allowlist matches the DIRECT peer only', async () => {
    // This port has no trusted-proxy configuration, so honouring a forwarded
    // header would let any caller name its own source IP and walk straight
    // through the allowlist.
    process.env.METRICS_SCRAPE_IP_ALLOWLIST = '203.0.113.7';
    const worker = await importFreshWorker();
    const port = await waitForListening(worker);

    const res = await rawGet(port, '/metrics', {
      Authorization: `Bearer ${SCRAPE_TOKEN}`,
      'X-Forwarded-For': '203.0.113.7',
    });

    expect(res.status).toBe(403);
  });

  it('answers before boot completes rather than 404ing', async () => {
    // The health server starts at step 3, long before the dynamic imports and
    // the worker registry. A scrape landing in that window must get the
    // endpoint (rendering whatever is registered so far), not a 404 that reads
    // as "this build has no /metrics".
    let releaseParity!: () => void;
    mocks.waitForMigrationParity.mockImplementation(
      () => new Promise<void>((resolve) => { releaseParity = () => resolve(); }),
    );

    const worker = await importFreshWorker();
    const port = await waitForListening(worker);

    const res = await rawGet(port, '/metrics', { Authorization: `Bearer ${SCRAPE_TOKEN}` });
    expect(res.status).toBe(200);

    releaseParity();
    await waitFor(() => worker._getWorkerInitPhaseForTest() === 'started');
  });

  it('still 404s an unknown path', async () => {
    const worker = await importFreshWorker();
    const port = await waitForListening(worker);

    const res = await rawGet(port, '/metrics/scrape', { Authorization: `Bearer ${SCRAPE_TOKEN}` });
    expect(res.status).toBe(404);
  });
});

/**
 * #3022/#3214 monitors on the worker role (#4143). These are the two
 * instrumentations that "matter MOST where the heavy jobs run" — and an
 * unstarted monitor is completely silent: it reports `monitored: false`, which
 * every consumer correctly reads as "unknown". Nothing breaks and no other
 * test fails; the container simply goes blind. That is exactly why the wiring
 * needs its own assertions.
 */
describe('worker.ts observability monitors (#4143)', () => {
  it('starts the event-loop monitor and injects the SAFE CONNECT_TIMEOUT classifier', async () => {
    const worker = await importFreshWorker();
    await waitFor(() => worker._getWorkerInitPhaseForTest() === 'started');

    expect(mocks.startEventLoopMonitor).toHaveBeenCalledTimes(1);
    // The never-throwing variant specifically: this runs on error paths, where
    // a throw would cost the original report.
    expect(mocks.setConnectTimeoutClassifier).toHaveBeenCalledWith(mocks.safeDiagnoseConnectTimeout);
  });

  it('starts the DB pool-health watchdog', async () => {
    const worker = await importFreshWorker();
    await waitFor(() => worker._getWorkerInitPhaseForTest() === 'started');

    expect(mocks.startDbPoolHealthMonitor).toHaveBeenCalledTimes(1);
  });

  it('stops both monitors in the shutdown preamble, before the phases run', async () => {
    // Ordering is the assertion, not merely that they are stopped: the
    // watchdog must not open a fresh probe connection while the `db` phase
    // drains the pool, which would report `database-unreachable` about a
    // process that is simply shutting down.
    const order: string[] = [];
    mocks.stopEventLoopMonitor.mockImplementation(() => { order.push('stopEventLoop'); });
    mocks.stopDbPoolHealthMonitor.mockImplementation(() => { order.push('stopDbPoolHealth'); });
    mocks.runShutdownPhases.mockImplementation(
      async (phases: Array<{ name: string }>) => {
        order.push('phases');
        mocks.shutdownPhaseCalls.push(phases.map((p) => p.name));
        return { failures: [], timedOutPhases: [] };
      },
    );

    const worker = await importFreshWorker();
    await waitFor(() => worker._getWorkerInitPhaseForTest() === 'started');

    process.emit('SIGTERM');
    await waitFor(() => exitCalls.length > 0);

    expect(order).toEqual(['stopEventLoop', 'stopDbPoolHealth', 'phases']);
  });
});
