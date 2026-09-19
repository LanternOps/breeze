import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { createReadinessHandler } from './readiness';
import type { ReadinessEvaluator, ReadinessSnapshot } from '../services/readiness';
import type { ConsumerReadinessState } from '../services/workerReadinessRegistry';

const internalConsumer: ConsumerReadinessState = {
  name: 'secret-worker-name',
  required: true,
  state: 'running',
  running: true,
  redisConnected: true,
  transitionedAt: '2026-07-31T18:20:00.000Z',
  lastSuccessfulJobAt: null,
  lastErrorAt: null,
  lastErrorCode: null,
};

const snapshot = (overrides: Partial<ReadinessSnapshot> = {}): ReadinessSnapshot => ({
  ready: true,
  db: true,
  redis: true,
  workers: true,
  checkedAt: '2026-07-31T18:23:48.511Z',
  consumers: { secretWorker: internalConsumer },
  ...overrides
});

function mount(evaluator: ReadinessEvaluator, onEvaluationError = vi.fn()) {
  const app = new Hono();
  const handler = createReadinessHandler({ evaluator, onEvaluationError });
  app.get('/ready', handler);
  app.get('/health/ready', handler);
  return { app, onEvaluationError };
}

describe('GET /ready', () => {
  it('returns 200 with the snapshot when ready', async () => {
    // Probes and load balancers act on the status code, not the body.
    const { app } = mount({ get: async () => snapshot(), invalidate: vi.fn() });

    const res = await app.request('/ready');

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ready: true,
      db: true,
      redis: true,
      workers: true,
      checkedAt: '2026-07-31T18:23:48.511Z',
      consumerSummary: {
        required: 1,
        runnable: 1,
        unavailable: 0,
        optionalRunning: 0,
        optionalDisabled: 0,
      },
    });
  });

  it('returns 503 with the snapshot when not ready', async () => {
    const notReady = snapshot({ ready: false, workers: false });
    const { app } = mount({ get: async () => notReady, invalidate: vi.fn() });

    const res = await app.request('/ready');

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({
      ready: false,
      workers: false,
      consumerSummary: { required: 1, runnable: 1, unavailable: 0 },
    });
  });

  it('passes the checkedAt through unchanged so a frozen timestamp stays visible', async () => {
    const { app } = mount({ get: async () => snapshot(), invalidate: vi.fn() });

    const body = (await (await app.request('/ready')).json()) as ReadinessSnapshot;

    expect(body.checkedAt).toBe('2026-07-31T18:23:48.511Z');
  });

  it('returns 503 — not 500 — when the evaluator itself throws', async () => {
    // A 500 reads to a probe as an ambiguous transport failure; 503 is an
    // unambiguous "not ready".
    const boom = new Error('evaluator exploded');
    const { app, onEvaluationError } = mount({
      get: async () => {
        throw boom;
      },
      invalidate: vi.fn()
    });

    const res = await app.request('/ready');

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({
      ready: false,
      error: 'readiness evaluation failed'
    });
    expect(onEvaluationError).toHaveBeenCalledWith(boom, expect.anything());
  });

  it('reports unknown dependencies as null rather than claiming they are down', async () => {
    // When the evaluator broke, the backends may be perfectly healthy —
    // `db: false` would send whoever reads the alert off chasing Postgres.
    const { app } = mount({
      get: async () => {
        throw new Error('evaluator exploded');
      },
      invalidate: vi.fn()
    });

    const body = (await (await app.request('/ready')).json()) as Record<string, unknown>;

    expect(body.db).toBeNull();
    expect(body.redis).toBeNull();
    expect(body.workers).toBeNull();
  });

  it('never swallows an evaluator failure', async () => {
    const { app, onEvaluationError } = mount({
      get: async () => {
        throw new Error('evaluator exploded');
      },
      invalidate: vi.fn()
    });

    await app.request('/ready');

    expect(onEvaluationError).toHaveBeenCalledTimes(1);
  });

  it.each([
    snapshot(),
    snapshot({ ready: false, db: false }),
    snapshot({ ready: false, redis: false }),
    snapshot({ ready: false, workers: false }),
  ])('serves identical readiness aliases for %#', async (value) => {
    const { app } = mount({ get: async () => value, invalidate: vi.fn() });

    const [legacy, canonical] = await Promise.all([
      app.request('/ready'),
      app.request('/health/ready'),
    ]);

    expect(canonical.status).toBe(legacy.status);
    expect(await canonical.json()).toEqual(await legacy.json());
  });

  it('never serializes registry names, timestamps, codes, messages, or endpoints', async () => {
    const leaking = snapshot({
      consumers: {
        secret: {
          ...internalConsumer,
          name: 'postgres-primary.internal.example',
          transitionedAt: '2026-07-31T18:20:00.000Z',
          lastErrorAt: '2026-07-31T18:21:00.000Z',
          lastErrorCode: 'RedisSecretError',
        },
      },
    });
    const { app } = mount({ get: async () => leaking, invalidate: vi.fn() });

    const body = await (await app.request('/ready')).text();

    expect(JSON.parse(body)).toEqual({
      ready: true,
      db: true,
      redis: true,
      workers: true,
      checkedAt: '2026-07-31T18:23:48.511Z',
      consumerSummary: {
        required: 1,
        runnable: 1,
        unavailable: 0,
        optionalRunning: 0,
        optionalDisabled: 0,
      },
    });
    expect(body).not.toContain('postgres-primary');
    expect(body).not.toContain('RedisSecretError');
    expect(body).not.toContain('2026-07-31T18:20:00.000Z');
  });

  it('returns the explicit null summary on evaluator errors for both aliases', async () => {
    const { app } = mount({
      get: async () => { throw new Error('redis://secret.internal'); },
      invalidate: vi.fn(),
    });

    for (const path of ['/ready', '/health/ready']) {
      const body = await (await app.request(path)).json() as Record<string, unknown>;
      expect(body.consumerSummary).toBeNull();
      expect(JSON.stringify(body)).not.toContain('secret.internal');
    }
  });
});
