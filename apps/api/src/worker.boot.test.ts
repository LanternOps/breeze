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

const mocks = vi.hoisted(() => {
  return {
    breezeRole: vi.fn<() => string>(),
    validateConfig: vi.fn<() => { NODE_ENV: string }>(),
    initSentry: vi.fn(),
    captureException: vi.fn(),
    flushSentry: vi.fn(async () => {}),
    dbExecute: vi.fn(async () => [] as unknown[]),
    withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
    closeDb: vi.fn(async () => {}),
    redisPing: vi.fn(async () => 'PONG'),
    getRedis: vi.fn<() => { ping: () => Promise<string> } | null>(),
    closeRedis: vi.fn(async () => {}),
    waitForMigrationParity: vi.fn(async () => {}),
    loadBuiltinExtensions: vi.fn(async () => {}),
    createExtensionStateStore: vi.fn(() => ({})),
    registerAiAgentEnqueuer: vi.fn(),
    registerAllEventSubscribers: vi.fn(),
    buildWebhookFanoutDeps: vi.fn(() => ({})),
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

vi.mock('./config/env', () => ({ breezeRole: mocks.breezeRole }));
vi.mock('./config/validate', () => ({ validateConfig: mocks.validateConfig }));
vi.mock('./services/sentry', () => ({
  initSentry: mocks.initSentry,
  captureException: mocks.captureException,
  flushSentry: mocks.flushSentry,
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

beforeEach(() => {
  exitCalls = [];
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCalls.push(code ?? 0);
    return undefined as never;
  }) as never);

  process.env.API_PORT = '0';

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
  mocks.loadBuiltinExtensions.mockResolvedValue(undefined);
  mocks.createExtensionStateStore.mockReturnValue({});
  mocks.buildWebhookFanoutDeps.mockReturnValue({});
  mocks.startRegisteredWorkers.mockImplementation(
    async (_role: string, hooks: { onResult: (n: string, ok: boolean, e?: unknown) => void }) => {
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

  it('boots in order: migration parity before workers; enqueuer/subscribers before workers', async () => {
    const order: string[] = [];
    mocks.waitForMigrationParity.mockImplementation(async () => { order.push('parity'); });
    mocks.registerAiAgentEnqueuer.mockImplementation(() => { order.push('registerAiAgentEnqueuer'); });
    mocks.registerAllEventSubscribers.mockImplementation(() => { order.push('registerAllEventSubscribers'); });
    mocks.startRegisteredWorkers.mockImplementation(
      async (_role: string, hooks: { onResult: (n: string, ok: boolean, e?: unknown) => void }) => {
        order.push('startRegisteredWorkers');
        hooks.onResult('fakeGlobalWorker', true);
      },
    );
    mocks.initializeEventDispatchWorker.mockImplementation(async () => { order.push('initializeEventDispatchWorker'); });

    const worker = await importFreshWorker();
    await waitFor(() => worker._getWorkerInitPhaseForTest() === 'started');

    expect(order).toEqual([
      'parity',
      'registerAiAgentEnqueuer',
      'registerAllEventSubscribers',
      'startRegisteredWorkers',
      'initializeEventDispatchWorker',
    ]);
  });

  it('readiness flips to ready only after every worker init result is recorded', async () => {
    let resolveStart!: () => void;
    const startGate = new Promise<void>((resolve) => { resolveStart = resolve; });
    mocks.startRegisteredWorkers.mockImplementation(
      async (_role: string, hooks: { onResult: (n: string, ok: boolean, e?: unknown) => void }) => {
        await startGate;
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
