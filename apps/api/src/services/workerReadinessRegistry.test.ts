import { EventEmitter } from 'node:events';
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
  setRunning(running: boolean): void;
} {
  const emitter = new EventEmitter();
  let running = options.running ?? false;
  Object.assign(emitter, {
    isRunning: () => running,
    client: Promise.resolve({ status: options.clientStatus ?? 'connecting' }),
  });
  return {
    emitter,
    worker: emitter as unknown as Worker,
    setRunning(value: boolean) {
      running = value;
    },
  };
}

describe('createWorkerReadinessRegistry', () => {
  it('keeps a newly expected required consumer fail-closed', () => {
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

  it('marks a consumer runnable on ready and recovers it after an error', () => {
    const registry = createWorkerReadinessRegistry();
    const { emitter, worker } = makeFakeWorker();
    registry.expect('requiredWorker', true);
    registry.attach('requiredWorker', worker);

    emitter.emit('ready');
    expect(registry.requiredConsumersRunnable()).toBe(true);
    expect(registry.snapshot().requiredWorker).toMatchObject({
      state: 'running',
      running: true,
      redisConnected: true,
    });

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

    expect(registry.requiredConsumersRunnable()).toBe(true);
  });

  it('updates last-success time when a job completes', () => {
    let now = Date.parse('2026-08-24T12:00:00.000Z');
    const registry = createWorkerReadinessRegistry({ now: () => now });
    const { emitter, worker } = makeFakeWorker();
    registry.expect('requiredWorker', true);
    registry.attach('requiredWorker', worker);
    emitter.emit('ready');

    now += 1_000;
    emitter.emit('completed', { id: 'job-1' });

    expect(registry.snapshot().requiredWorker?.lastSuccessfulJobAt)
      .toBe('2026-08-24T12:00:01.000Z');
    expect(registry.requiredConsumersRunnable()).toBe(true);
  });

  it('records a job failure without stopping a runnable consumer', () => {
    const registry = createWorkerReadinessRegistry();
    const { emitter, worker } = makeFakeWorker();
    registry.expect('requiredWorker', true);
    registry.attach('requiredWorker', worker);
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
  ] as const)('makes a consumer unavailable on %s', (event, state) => {
    const registry = createWorkerReadinessRegistry();
    const { emitter, worker } = makeFakeWorker();
    registry.expect('requiredWorker', true);
    registry.attach('requiredWorker', worker);
    emitter.emit('ready');

    emitter.emit(event);

    expect(registry.snapshot().requiredWorker).toMatchObject({
      state,
      running: false,
      redisConnected: false,
    });
    expect(registry.requiredConsumersRunnable()).toBe(false);
  });

  it('records a sanitized initialization failure', () => {
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

  it('keeps an initialization failure terminal when BullMQ re-emits ready', () => {
    const registry = createWorkerReadinessRegistry();
    const { emitter, worker } = makeFakeWorker();
    registry.expect('requiredWorker', true);
    // Dominant initializer shape: attach first, then do throwable work. A
    // Redis flap during init throws AFTER the attach, and BullMQ re-emits
    // `ready` on every reconnect (and forwards the initial one deferred by a
    // macrotask) -- that must not resurrect a failed consumer.
    registry.attach('requiredWorker', worker);

    registry.recordInitializationFailure('requiredWorker', new TypeError('init blew up'));
    emitter.emit('ready');

    expect(registry.requiredConsumersRunnable()).toBe(false);
    expect(registry.snapshot().requiredWorker).toMatchObject({
      state: 'failed',
      running: false,
      redisConnected: false,
    });
  });

  it('keeps an initialization failure terminal across a disconnect and reconnect', () => {
    const registry = createWorkerReadinessRegistry();
    const { emitter, worker } = makeFakeWorker();
    registry.expect('requiredWorker', true);
    registry.attach('requiredWorker', worker);

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

  it('does not refresh last-success time for a failed consumer', () => {
    let now = Date.parse('2026-08-24T12:00:00.000Z');
    const registry = createWorkerReadinessRegistry({ now: () => now });
    const { emitter, worker } = makeFakeWorker();
    registry.expect('requiredWorker', true);
    registry.attach('requiredWorker', worker);

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

  it('throws on duplicate expected consumer names', () => {
    const registry = createWorkerReadinessRegistry();
    registry.expect('duplicateWorker', true);

    expect(() => registry.expect('duplicateWorker', true))
      .toThrow(/duplicateWorker/);
  });

  it('fails closed without throwing when a Worker-shaped test double lacks runtime probes', () => {
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

  it('sanitizes invalid worker and job error names', () => {
    const registry = createWorkerReadinessRegistry();
    const { emitter, worker } = makeFakeWorker();
    registry.expect('requiredWorker', true);
    registry.attach('requiredWorker', worker);
    emitter.emit('ready');
    const invalidError = Object.assign(new Error('raw message'), { name: 'not-valid!' });

    emitter.emit('failed', { id: 'job-1' }, invalidError);

    expect(registry.snapshot().requiredWorker?.lastErrorCode).toBe('worker_error');
  });

  it('invalidates exactly once for each material lifecycle or timestamp transition', () => {
    let now = Date.parse('2026-08-24T12:00:00.000Z');
    const onTransition = vi.fn();
    const registry = createWorkerReadinessRegistry({ now: () => now, onTransition });
    const { emitter, worker } = makeFakeWorker();

    registry.expect('requiredWorker', true);
    expect(onTransition).toHaveBeenCalledTimes(1);
    registry.attach('requiredWorker', worker);
    expect(onTransition).toHaveBeenCalledTimes(1);

    now += 1_000;
    emitter.emit('ready');
    expect(onTransition).toHaveBeenCalledTimes(2);
    emitter.emit('ready');
    expect(onTransition).toHaveBeenCalledTimes(2);

    now += 1_000;
    emitter.emit('completed', { id: 'job-1' });
    expect(onTransition).toHaveBeenCalledTimes(3);

    now += 1_000;
    emitter.emit('failed', { id: 'job-2' }, new Error('failed'));
    expect(onTransition).toHaveBeenCalledTimes(4);

    now += 1_000;
    emitter.emit('closing');
    expect(onTransition).toHaveBeenCalledTimes(5);
  });

  it('returns detached snapshot state that cannot mutate the registry', () => {
    const registry = createWorkerReadinessRegistry();
    registry.expect('requiredWorker', true);
    const snapshot = registry.snapshot();

    (snapshot.requiredWorker as { running: boolean }).running = true;

    expect(registry.requiredConsumersRunnable()).toBe(false);
  });
});

describe('summarizeConsumerReadiness', () => {
  it('returns only the five aggregate integer fields', () => {
    const registry = createWorkerReadinessRegistry();
    const required = makeFakeWorker();
    const optional = makeFakeWorker();
    registry.expect('requiredRunning', true);
    registry.attach('requiredRunning', required.worker);
    required.emitter.emit('ready');
    registry.expect('requiredUnavailable', true);
    registry.expect('optionalRunning', false);
    registry.attach('optionalRunning', optional.worker);
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
