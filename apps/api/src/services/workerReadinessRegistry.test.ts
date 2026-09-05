import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { createReadinessEvaluator } from './readiness';
import type { Worker } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import {
  createWorkerReadinessRegistry,
  summarizeConsumerReadiness,
} from './workerReadinessRegistry';

interface FakeWorkerOptions {
  running?: boolean;
  clientStatus?: string;
}

function makeFakeWorker(options: FakeWorkerOptions = {}): {
  emitter: EventEmitter;
  worker: Worker;
  client: EventEmitter & { status: string };
  blockingClient: EventEmitter & { status: string };
  setRunning(running: boolean): void;
} {
  const emitter = new EventEmitter();
  let running = options.running ?? false;
  let paused = false;
  const client = Object.assign(new EventEmitter(), { status: options.clientStatus ?? 'connecting' });
  const blockingClient = Object.assign(new EventEmitter(), { status: options.clientStatus ?? 'connecting' });
  emitter.on('ready', () => {
    running = true;
    client.status = 'ready';
    blockingClient.status = 'ready';
    client.emit('ready');
    blockingClient.emit('ready');
  });
  emitter.on('paused', () => { paused = true; });
  emitter.on('resumed', () => { paused = false; running = true; });
  Object.assign(emitter, {
    isRunning: () => running,
    isPaused: () => paused,
    client: Promise.resolve(client),
    waitUntilReady: () => Promise.resolve(blockingClient),
  });
  return {
    emitter,
    client,
    blockingClient,
    worker: emitter as unknown as Worker,
    setRunning(value: boolean) {
      running = value;
    },
  };
}

describe('createWorkerReadinessRegistry', () => {
  it('keeps a newly expected required consumer fail-closed', async () => {
    const registry = createWorkerReadinessRegistry();

    registry.expect('requiredWorker', true);

    expect(registry.requiredConsumersRunnable()).toBe(false);
    expect(registry.snapshot().requiredWorker).toMatchObject({
      required: true,
      state: 'expected',
      running: false,
      redisConnected: false,
    });
  });

  it('marks a consumer runnable on ready and recovers it after an error', async () => {
    const registry = createWorkerReadinessRegistry();
    const { emitter, worker, client } = makeFakeWorker();
    registry.expect('requiredWorker', true);
    registry.attach('requiredWorker', worker);
    await Promise.resolve();
    await Promise.resolve();

    emitter.emit('ready');
    expect(registry.requiredConsumersRunnable()).toBe(true);
    expect(registry.snapshot().requiredWorker).toMatchObject({
      state: 'running',
      running: true,
      redisConnected: true,
    });

    client.status = 'reconnecting';
    client.emit('close');
    emitter.emit('error', new TypeError('connection details must not be stored'));
    expect(registry.requiredConsumersRunnable()).toBe(false);
    expect(registry.snapshot().requiredWorker).toMatchObject({
      state: 'redis_disconnected',
      running: false,
      redisConnected: false,
      lastErrorCode: 'TypeError',
    });

    emitter.emit('ready');
    expect(registry.requiredConsumersRunnable()).toBe(true);
  });

  it('recognizes a running worker with an already-ready Redis client', async () => {
    const registry = createWorkerReadinessRegistry();
    const { worker } = makeFakeWorker({ running: true, clientStatus: 'ready' });
    registry.expect('requiredWorker', true);

    registry.attach('requiredWorker', worker);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(registry.requiredConsumersRunnable()).toBe(true);
  });

  it('updates last-success time when a job completes', async () => {
    let now = Date.parse('2026-08-24T12:00:00.000Z');
    const registry = createWorkerReadinessRegistry({ now: () => now });
    const { emitter, worker } = makeFakeWorker();
    registry.expect('requiredWorker', true);
    registry.attach('requiredWorker', worker);
    await Promise.resolve();
    await Promise.resolve();
    emitter.emit('ready');

    now += 1_000;
    emitter.emit('completed', { id: 'job-1' });

    expect(registry.snapshot().requiredWorker?.lastSuccessfulJobAt)
      .toBe('2026-08-24T12:00:01.000Z');
    expect(registry.requiredConsumersRunnable()).toBe(true);
  });

  it('records a job failure without stopping a runnable consumer', async () => {
    const registry = createWorkerReadinessRegistry();
    const { emitter, worker } = makeFakeWorker();
    registry.expect('requiredWorker', true);
    registry.attach('requiredWorker', worker);
    await Promise.resolve();
    await Promise.resolve();
    emitter.emit('ready');

    emitter.emit('failed', { id: 'job-1' }, new RangeError('tenant secret'));

    expect(registry.snapshot().requiredWorker).toMatchObject({
      state: 'running',
      running: true,
      redisConnected: true,
      lastErrorCode: 'RangeError',
    });
    expect(registry.requiredConsumersRunnable()).toBe(true);
    expect(JSON.stringify(registry.snapshot())).not.toContain('tenant secret');
  });

  it.each([
    ['closing', 'stopping'],
    ['closed', 'stopped'],
  ] as const)('makes a consumer unavailable on %s', async (event, state) => {
    const registry = createWorkerReadinessRegistry();
    const { emitter, worker } = makeFakeWorker();
    registry.expect('requiredWorker', true);
    registry.attach('requiredWorker', worker);
    await Promise.resolve();
    await Promise.resolve();
    emitter.emit('ready');

    emitter.emit(event);

    expect(registry.snapshot().requiredWorker).toMatchObject({
      state,
      running: false,
      redisConnected: false,
    });
    expect(registry.requiredConsumersRunnable()).toBe(false);
  });

  it('records a sanitized initialization failure', async () => {
    const registry = createWorkerReadinessRegistry();
    registry.expect('requiredWorker', true);
    const error = Object.assign(new Error('redis://user:secret@example.test'), {
      name: 'invalid error name',
    });

    registry.recordInitializationFailure('requiredWorker', error);

    expect(registry.snapshot().requiredWorker).toMatchObject({
      state: 'failed',
      running: false,
      redisConnected: false,
      lastErrorCode: 'worker_error',
    });
    expect(JSON.stringify(registry.snapshot())).not.toContain('secret');
  });

  it('keeps an initialization failure terminal when BullMQ re-emits ready', async () => {
    const registry = createWorkerReadinessRegistry();
    const { emitter, worker } = makeFakeWorker();
    registry.expect('requiredWorker', true);
    // Dominant initializer shape: attach first, then do throwable work. A
    // Redis flap during init throws AFTER the attach, and BullMQ re-emits
    // `ready` on every reconnect (and forwards the initial one deferred by a
    // macrotask) -- that must not resurrect a failed consumer.
    registry.attach('requiredWorker', worker);
    await Promise.resolve();
    await Promise.resolve();

    registry.recordInitializationFailure('requiredWorker', new TypeError('init blew up'));
    emitter.emit('ready');

    expect(registry.requiredConsumersRunnable()).toBe(false);
    expect(registry.snapshot().requiredWorker).toMatchObject({
      state: 'failed',
      running: false,
      redisConnected: false,
    });
  });

  it('keeps an initialization failure terminal across a disconnect and reconnect', async () => {
    const registry = createWorkerReadinessRegistry();
    const { emitter, worker } = makeFakeWorker();
    registry.expect('requiredWorker', true);
    registry.attach('requiredWorker', worker);
    await Promise.resolve();
    await Promise.resolve();

    registry.recordInitializationFailure('requiredWorker', new TypeError('init blew up'));
    emitter.emit('error', new RangeError('connection lost'));
    emitter.emit('ready');

    expect(registry.requiredConsumersRunnable()).toBe(false);
    expect(registry.snapshot().requiredWorker).toMatchObject({
      state: 'failed',
      running: false,
      redisConnected: false,
    });
  });

  it('does not refresh last-success time for a failed consumer', async () => {
    let now = Date.parse('2026-08-24T12:00:00.000Z');
    const registry = createWorkerReadinessRegistry({ now: () => now });
    const { emitter, worker } = makeFakeWorker();
    registry.expect('requiredWorker', true);
    registry.attach('requiredWorker', worker);
    await Promise.resolve();
    await Promise.resolve();

    registry.recordInitializationFailure('requiredWorker', new TypeError('init blew up'));
    now += 1_000;
    emitter.emit('completed', { id: 'job-1' });

    expect(registry.snapshot().requiredWorker?.lastSuccessfulJobAt).toBeNull();
    expect(registry.requiredConsumersRunnable()).toBe(false);
  });

  it('allows optional disabled consumers but fails closed for required disabled consumers', () => {
    const optionalRegistry = createWorkerReadinessRegistry();
    optionalRegistry.expect('optionalWorker', false);
    optionalRegistry.disable('optionalWorker', 'feature_disabled');
    expect(optionalRegistry.requiredConsumersRunnable()).toBe(true);

    const requiredRegistry = createWorkerReadinessRegistry();
    requiredRegistry.expect('requiredWorker', true);
    requiredRegistry.disable('requiredWorker', 'feature_disabled');
    expect(requiredRegistry.requiredConsumersRunnable()).toBe(false);
  });

  it('throws on duplicate expected consumer names', async () => {
    const registry = createWorkerReadinessRegistry();
    registry.expect('duplicateWorker', true);

    expect(() => registry.expect('duplicateWorker', true))
      .toThrow(/duplicateWorker/);
  });

  it('fails closed without throwing when a Worker-shaped test double lacks runtime probes', async () => {
    const registry = createWorkerReadinessRegistry();
    const worker = new EventEmitter() as unknown as Worker;
    registry.expect('incompleteWorker', true);

    expect(() => registry.attach('incompleteWorker', worker)).not.toThrow();
    expect(registry.snapshot().incompleteWorker).toMatchObject({
      state: 'failed',
      running: false,
      redisConnected: false,
      lastErrorCode: 'TypeError',
    });
    expect(registry.requiredConsumersRunnable()).toBe(false);
  });

  it('sanitizes invalid worker and job error names', async () => {
    const registry = createWorkerReadinessRegistry();
    const { emitter, worker } = makeFakeWorker();
    registry.expect('requiredWorker', true);
    registry.attach('requiredWorker', worker);
    await Promise.resolve();
    await Promise.resolve();
    emitter.emit('ready');
    const invalidError = Object.assign(new Error('raw message'), { name: 'not-valid!' });

    emitter.emit('failed', { id: 'job-1' }, invalidError);

    expect(registry.snapshot().requiredWorker?.lastErrorCode).toBe('worker_error');
  });

  it('invalidates for lifecycle transitions, not job metadata', async () => {
    let now = Date.parse('2026-08-24T12:00:00.000Z');
    const onTransition = vi.fn();
    const registry = createWorkerReadinessRegistry({ now: () => now, onTransition });
    const { emitter, worker } = makeFakeWorker();

    registry.expect('requiredWorker', true);
    expect(onTransition).toHaveBeenCalledTimes(1);
    registry.attach('requiredWorker', worker);
    await Promise.resolve();
    await Promise.resolve();
    expect(onTransition).toHaveBeenCalledTimes(2);

    now += 1_000;
    emitter.emit('ready');
    expect(onTransition).toHaveBeenCalledTimes(3);
    emitter.emit('ready');
    expect(onTransition).toHaveBeenCalledTimes(3);

    now += 1_000;
    emitter.emit('completed', { id: 'job-1' });
    expect(onTransition).toHaveBeenCalledTimes(3);

    now += 1_000;
    emitter.emit('failed', { id: 'job-2' }, new Error('failed'));
    expect(onTransition).toHaveBeenCalledTimes(3);

    now += 1_000;
    emitter.emit('closing');
    expect(onTransition).toHaveBeenCalledTimes(4);
  });

  it('keeps a healthy consumer runnable after installed BullMQ reports an expired job lock', async () => {
    const registry = createWorkerReadinessRegistry();
    const fake = makeFakeWorker({ running: true, clientStatus: 'ready' });
    registry.attach('lockWorker', fake.worker);
    await Promise.resolve();
    await Promise.resolve();
    const require = createRequire(import.meta.url);
    const { LockManager } = require('bullmq/dist/cjs/classes/lock-manager.js');
    Object.assign(fake.emitter, {
      name: 'lockWorker',
      trace: async (_kind: unknown, _operation: unknown, _name: unknown, callback: () => Promise<void>) => callback(),
      extendJobLocks: async () => ['expired-job'],
    });
    const manager = new LockManager(fake.emitter, { lockDuration: 1000, lockRenewTime: 0 });
    await manager.extendLocks(['expired-job']);
    expect(registry.snapshot().lockWorker).toMatchObject({ state: 'running', lastErrorCode: 'Error' });
    expect(registry.requiredConsumersRunnable()).toBe(true);
    fake.emitter.emit('completed', { id: 'next-job' });
    expect(registry.requiredConsumersRunnable()).toBe(true);
  });

  it.each(['client', 'blockingClient'] as const)('tracks %s outages and recovery independently', async (which) => {
    const registry = createWorkerReadinessRegistry();
    const fake = makeFakeWorker({ running: true, clientStatus: 'ready' });
    registry.attach('worker', fake.worker);
    await Promise.resolve();
    await Promise.resolve();
    fake[which].status = 'reconnecting';
    fake[which].emit('close');
    fake[which === 'client' ? 'blockingClient' : 'client'].emit('ready');
    expect(registry.requiredConsumersRunnable()).toBe(false);
    fake.emitter.emit('completed');
    expect(registry.requiredConsumersRunnable()).toBe(false);
    fake[which].status = 'ready';
    fake[which].emit('ready');
    expect(registry.requiredConsumersRunnable()).toBe(true);
  });

  it('checks the live run loop even without a lifecycle event', async () => {
    const registry = createWorkerReadinessRegistry();
    const fake = makeFakeWorker({ running: true, clientStatus: 'ready' });
    registry.attach('worker', fake.worker);
    await Promise.resolve();
    await Promise.resolve();
    expect(registry.requiredConsumersRunnable()).toBe(true);
    fake.setRunning(false);
    expect(registry.requiredConsumersRunnable()).toBe(false);
    expect(registry.snapshot().worker.state).toBe('stopped');
  });

  it('follows a webhook adapter that replaces its ended blocking client', async () => {
    const registry = createWorkerReadinessRegistry();
    let client = Object.assign(new EventEmitter(), { status: 'ready' });
    const adapter = Object.assign(new EventEmitter(), { isRunning: () => true });
    Object.defineProperty(adapter, 'client', { get: () => Promise.resolve(client) });
    registry.attach('webhook', adapter as unknown as Worker);
    await Promise.resolve();
    expect(registry.requiredConsumersRunnable()).toBe(true);
    const previous = client;
    previous.status = 'end';
    previous.emit('end');
    expect(registry.requiredConsumersRunnable()).toBe(false);
    client = Object.assign(new EventEmitter(), { status: 'ready' });
    adapter.emit('ready');
    await Promise.resolve();
    expect(registry.requiredConsumersRunnable()).toBe(true);
    previous.emit('close');
    expect(registry.requiredConsumersRunnable()).toBe(true);
    adapter.emit('ready');
    await Promise.resolve();
    expect(client.listenerCount('close')).toBe(1);
  });

  it('does not revive a paused, closing or closed worker on a late ready event', async () => {
    const registry = createWorkerReadinessRegistry();
    const fake = makeFakeWorker({ running: true, clientStatus: 'ready' });
    registry.attach('worker', fake.worker);
    await Promise.resolve();
    await Promise.resolve();
    fake.emitter.emit('paused');
    fake.emitter.emit('ready');
    expect(registry.requiredConsumersRunnable()).toBe(false);
    fake.emitter.emit('resumed');
    expect(registry.requiredConsumersRunnable()).toBe(true);
    fake.emitter.emit('closing');
    fake.emitter.emit('ready');
    expect(registry.snapshot().worker.state).toBe('stopping');
    fake.emitter.emit('closed');
    fake.emitter.emit('ready');
    expect(registry.snapshot().worker.state).toBe('stopped');
  });

  it('keeps dependency probes cached during job traffic but invalidates on disconnect', async () => {
    let now = 1000;
    let invalidate = () => {};
    const registry = createWorkerReadinessRegistry({ now: () => now, onTransition: () => invalidate() });
    const fake = makeFakeWorker({ running: true, clientStatus: 'ready' });
    registry.attach('worker', fake.worker);
    await Promise.resolve();
    await Promise.resolve();
    const checkDb = vi.fn(async () => true);
    const checkRedis = vi.fn(async () => true);
    const evaluator = createReadinessEvaluator({
      checkDb, checkRedis, workerRegistry: registry, workersInitialized: () => true,
      isShuttingDown: () => false, requireRedis: true, ttlMs: 5000, probeTimeoutMs: 1000, now: () => now,
    });
    invalidate = () => evaluator.invalidate();
    expect((await evaluator.get()).ready).toBe(true);
    for (let index = 0; index < 30; index++) {
      now++;
      fake.emitter.emit('completed');
      fake.emitter.emit('failed', undefined, new Error('job failed'));
      fake.emitter.emit('error', new Error('job lock expired'));
      expect((await evaluator.get()).ready).toBe(true);
    }
    expect(checkDb).toHaveBeenCalledTimes(1);
    expect(checkRedis).toHaveBeenCalledTimes(1);
    expect(registry.snapshot().worker.lastSuccessfulJobAt).toBe(new Date(now).toISOString());
    fake.blockingClient.status = 'reconnecting';
    fake.blockingClient.emit('close');
    expect((await evaluator.get()).ready).toBe(false);
    expect(checkDb).toHaveBeenCalledTimes(2);
    fake.blockingClient.status = 'ready';
    fake.blockingClient.emit('ready');
    expect((await evaluator.get()).ready).toBe(true);
  });

  it('returns detached snapshot state that cannot mutate the registry', async () => {
    const registry = createWorkerReadinessRegistry();
    registry.expect('requiredWorker', true);
    const snapshot = registry.snapshot();

    (snapshot.requiredWorker as { running: boolean }).running = true;

    expect(registry.requiredConsumersRunnable()).toBe(false);
  });
});

describe('summarizeConsumerReadiness', () => {
  it('returns only the five aggregate integer fields', async () => {
    const registry = createWorkerReadinessRegistry();
    const required = makeFakeWorker();
    const optional = makeFakeWorker();
    registry.expect('requiredRunning', true);
    registry.attach('requiredRunning', required.worker);
    await Promise.resolve();
    await Promise.resolve();
    required.emitter.emit('ready');
    registry.expect('requiredUnavailable', true);
    registry.expect('optionalRunning', false);
    registry.attach('optionalRunning', optional.worker);
    await Promise.resolve();
    await Promise.resolve();
    optional.emitter.emit('ready');
    registry.expect('optionalDisabled', false);
    registry.disable('optionalDisabled', 'feature_disabled');

    const summary = summarizeConsumerReadiness(registry.snapshot());

    expect(summary).toEqual({
      required: 2,
      runnable: 1,
      unavailable: 1,
      optionalRunning: 1,
      optionalDisabled: 1,
    });
    expect(Object.keys(summary)).toEqual([
      'required',
      'runnable',
      'unavailable',
      'optionalRunning',
      'optionalDisabled',
    ]);
    expect(JSON.stringify(summary)).not.toContain('requiredRunning');
  });
});
