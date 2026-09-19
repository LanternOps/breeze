import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Track C's lifecycle mapping in processNextJob()'s outer catch, plus the
 * attach relocation the port made (spec section 2, C2), pinned:
 *  (a) a job-level failure on a healthy blocking connection is `failed` — the
 *      loop keeps running;
 *  (b) anything else is `error` — the registry treats it as a Redis disconnect
 *      until the next successful BRPOP re-emits `ready`;
 *  (c) emit('error') never throws on a bare instance: the constructor installs
 *      its own listener, so attach state is irrelevant;
 *  (d) the registry attach happens in initializeWebhookDelivery() — the only
 *      start path, reached only through the global registry entry — and an
 *      api-role fan-out that reaches getWebhookWorker() declares/attaches
 *      nothing.
 */
const brpopMock = vi.hoisted(() => vi.fn());
// Mutable so a test can flip the blocking connection's status. Never 'end':
// getBlockingRedis() would then create a fresh connection and the branch
// under test would see status 'ready' again.
const blockingConnection = vi.hoisted(() => ({
  brpop: (...args: unknown[]) => brpopMock(...args),
  status: 'ready' as string,
}));
const lpushMock = vi.hoisted(() => vi.fn(async () => 1));

vi.mock('../services/eventBus', () => ({ getEventBus: () => ({ subscribe: vi.fn() }), EVENT_TYPES: {} }));
vi.mock('../db', () => ({
  db: {},
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
  runOutsideDbContext: (fn: () => unknown) => fn(),
}));
vi.mock('../services/redis', () => ({
  createBlockingRedisConnection: () => blockingConnection,
  getRedisConnection: () => ({ lpush: lpushMock, lindex: vi.fn(), lrem: vi.fn(async () => 1) }),
}));
vi.mock('../services/urlSafety', () => ({ safeFetch: vi.fn(), SsrfBlockedError: class SsrfBlockedError extends Error {} }));
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));

const NAME = 'webhookDeliveryWorker';

/**
 * Each test gets a fresh module graph: the singleton and the registry are
 * module-level, and attach() throws on a second attach of the same name.
 */
async function load() {
  vi.resetModules();
  const mod = await import('./webhookDelivery');
  const { workerReadinessRegistry } = await import('../services/workerReadinessRegistry');
  return { ...mod, registry: workerReadinessRegistry };
}

/** One pump iteration; the outer catch sleeps 1 s, so fake timers drive it. */
async function processOnce(worker: unknown): Promise<void> {
  const pending = (worker as { processNextJob: () => Promise<void> }).processNextJob();
  await vi.advanceTimersByTimeAsync(1_000);
  await pending;
}

const EVENT = {
  id: 'event-1', type: 'device.created', orgId: 'org-1', source: 'test', priority: 'normal',
  payload: {}, metadata: { timestamp: '2026-09-01T12:00:00.000Z' },
};
const WEBHOOK = { id: 'webhook-1', orgId: 'org-1', name: 'hook', url: 'https://example.test/hook', events: ['*'] };

describe('webhook delivery worker lifecycle -> readiness registry', () => {
  let current: Awaited<ReturnType<typeof load>> | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    brpopMock.mockReset();
    // Default: a BRPOP that never returns, so a started loop parks instead of
    // spinning the microtask queue. Tests that pump directly override it.
    brpopMock.mockImplementation(() => new Promise(() => {}));
    blockingConnection.status = 'ready';
    lpushMock.mockClear();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    current?.getWebhookWorker().stop();
    current = null;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('(c) a bare instance has its own error listener, so emit(error) never throws and nothing is declared', async () => {
    current = await load();
    const worker = current.getWebhookWorker();
    expect(worker.listenerCount('error')).toBeGreaterThanOrEqual(1);
    expect(() => worker.emit('error', new Error('unattached'))).not.toThrow();
    expect(current.registry.snapshot()[NAME]).toBeUndefined();
  });

  it('(d) an api-role fan-out reaches getWebhookWorker() but declares and attaches nothing', async () => {
    current = await load();
    current.configureWebhookFanout({
      getWebhooksForEvent: async () => [WEBHOOK] as never,
      createDeliveryRecord: (async () => ({ created: true, deliveryId: 'delivery-1' })) as never,
    });
    await current.handleWebhookFanoutEvent(EVENT as never);
    expect(lpushMock).toHaveBeenCalledTimes(1);                  // the delivery was queued …
    expect(current.registry.snapshot()[NAME]).toBeUndefined();  // … without touching readiness
    expect(brpopMock).not.toHaveBeenCalled();                    // and without starting a drain loop
  });

  it('(d) initializeWebhookDelivery() is where the attach happens, and start() marks it running', async () => {
    current = await load();
    // Reaching the getter first (as every api-role caller does) must not be
    // the attach site: nothing is declared until the start path runs.
    current.getWebhookWorker();
    expect(current.registry.snapshot()[NAME]).toBeUndefined();
    await current.initializeWebhookDelivery();
    expect(current.registry.snapshot()[NAME]).toMatchObject({ required: true, state: 'running', running: true, redisConnected: true });
    expect(brpopMock).toHaveBeenCalled();                        // the loop is parked on the never-resolving BRPOP
  });

  it('(a) a job-level failure on a ready connection emits failed and leaves the consumer running', async () => {
    current = await load();
    await current.initializeWebhookDelivery();
    const worker = current.getWebhookWorker();
    brpopMock.mockResolvedValueOnce(null);               // timeout -> emit('ready') -> running
    await processOnce(worker);
    const failed = vi.fn();
    worker.once('failed', failed);
    brpopMock.mockResolvedValueOnce(['queue', '{not json']);   // JSON.parse throws inside the try
    await processOnce(worker);
    expect(failed).toHaveBeenCalledTimes(1);
    expect(current.registry.snapshot()[NAME]).toMatchObject({ state: 'running', running: true, lastErrorCode: 'SyntaxError' });
  });

  it('(b) a connection failure emits error, moves the consumer to redis_disconnected without throwing, and recovers on the next BRPOP', async () => {
    current = await load();
    await current.initializeWebhookDelivery();
    const worker = current.getWebhookWorker();
    brpopMock.mockResolvedValueOnce(null);
    await processOnce(worker);                            // running
    const errored = vi.fn();
    worker.once('error', errored);
    blockingConnection.status = 'reconnecting';
    brpopMock.mockRejectedValueOnce(Object.assign(new Error('read ECONNRESET'), { name: 'RedisConnectionError' }));
    await expect(processOnce(worker)).resolves.toBeUndefined();
    expect(errored).toHaveBeenCalledTimes(1);
    expect(current.registry.snapshot()[NAME]).toMatchObject({ state: 'redis_disconnected', running: false, redisConnected: false, lastErrorCode: 'RedisConnectionError' });
    blockingConnection.status = 'ready';
    brpopMock.mockResolvedValueOnce(null);
    await processOnce(worker);
    expect(current.registry.snapshot()[NAME]).toMatchObject({ state: 'running', running: true });
  });
});
