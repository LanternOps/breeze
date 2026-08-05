import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { createReadinessHandler } from './readiness';
import type { ReadinessEvaluator, ReadinessSnapshot } from '../services/readiness';

const snapshot = (overrides: Partial<ReadinessSnapshot> = {}): ReadinessSnapshot => ({
  ready: true,
  db: true,
  redis: true,
  workers: true,
  checkedAt: '2026-07-31T18:23:48.511Z',
  ...overrides
});

function mount(evaluator: ReadinessEvaluator, onEvaluationError = vi.fn()) {
  const app = new Hono();
  app.get('/ready', createReadinessHandler({ evaluator, onEvaluationError }));
  return { app, onEvaluationError };
}

describe('GET /ready', () => {
  it('returns 200 with the snapshot when ready', async () => {
    // Probes and load balancers act on the status code, not the body.
    const { app } = mount({ get: async () => snapshot(), invalidate: vi.fn() });

    const res = await app.request('/ready');

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(snapshot());
  });

  it('returns 503 with the snapshot when not ready', async () => {
    const notReady = snapshot({ ready: false, workers: false });
    const { app } = mount({ get: async () => notReady, invalidate: vi.fn() });

    const res = await app.request('/ready');

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual(notReady);
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
});
