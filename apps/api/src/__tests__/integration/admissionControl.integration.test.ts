/**
 * W08 — admission control against a REAL event loop and a REAL Postgres pool.
 *
 * Unit suites drive the controller with synthetic signals. This proves the
 * signals themselves: a genuinely blocked main thread raises the lag signal,
 * genuinely queued requests raise the DB pool-wait signal (W04's gate), refusals
 * are answered without waiting for the pool, a real pool-acquire timeout becomes
 * 503 + Retry-After, and the level recovers on its own.
 */
import './setup';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { startEventLoopMonitor, stopEventLoopMonitor } from '../../services/eventLoopMonitor';
import { ADMISSION_DEFAULTS } from '../../services/admission/admissionConfig';
import { AdmissionRuntime } from '../../services/admission/admissionRuntime';
import { agentAdmission } from '../../middleware/agentAdmission';
import { dbSaturationResponse } from '../../middleware/dbSaturationResponse';

const AGENT = 'a'.repeat(64);
const POOL_MAX = Number.parseInt(process.env.DB_POOL_MAX ?? '', 10) > 0
  ? Number.parseInt(process.env.DB_POOL_MAX!, 10)
  : 30; // db/index.ts getDbPoolMax() default

let runtime: AdmissionRuntime | null = null;

function buildApp(gate: AdmissionRuntime | null) {
  const app = new Hono();
  app.use('*', agentAdmission(() => gate));
  // Stand-in for every agent route: real DB work through the real pool.
  app.all('/api/v1/agents/:id/*', async (c) => {
    await withSystemDbAccessContext(async () => {
      await db.execute(sql`select 1`);
    }, 'admissionIntegration');
    return c.json({ ok: true });
  });
  return app;
}

async function until(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

beforeAll(() => {
  startEventLoopMonitor({ sampleIntervalMs: 250 });
});
afterAll(() => {
  stopEventLoopMonitor();
});
afterEach(() => {
  runtime?.stop();
  runtime = null;
});

describe('admission control (real loop, real pool)', () => {
  it('sheds bulk while the event loop is genuinely stalled, keeps heartbeats, and recovers', async () => {
    runtime = new AdmissionRuntime({ ...ADMISSION_DEFAULTS, mode: 'enforce' }, { log: () => {} });
    runtime.start(250);
    const app = buildApp(runtime);
    const control = buildApp(null);

    // ~150 ms of synchronous work every 300 ms: a loop that is half busy in long slices.
    const stall = setInterval(() => {
      const end = Date.now() + 150;
      while (Date.now() < end) { /* block the loop */ }
    }, 300);
    try {
      await until(() => runtime!.level >= 1, 10_000, 'level >= 1 under real lag');

      const refused = await app.request(`/api/v1/agents/${AGENT}/software`, { method: 'PUT' });
      expect(refused.status).toBe(503);
      const retryAfter = Number(refused.headers.get('retry-after'));
      expect(retryAfter).toBeGreaterThanOrEqual(120);
      expect(retryAfter).toBeLessThanOrEqual(180);

      expect((await app.request(`/api/v1/agents/${AGENT}/heartbeat`, { method: 'POST' })).status).toBe(200);
      // Control: the same request without admission succeeds, so the 503 is admission's.
      expect((await control.request(`/api/v1/agents/${AGENT}/software`, { method: 'PUT' })).status).toBe(200);
    } finally {
      clearInterval(stall);
    }

    await until(() => runtime!.level === 0, 45_000, 'recovery to level 0');
    expect((await app.request(`/api/v1/agents/${AGENT}/software`, { method: 'PUT' })).status).toBe(200);
  }, 90_000);

  it('raises the level from real pool queueing and refuses without waiting for a connection', async () => {
    runtime = new AdmissionRuntime({ ...ADMISSION_DEFAULTS, mode: 'enforce' }, { log: () => {} });
    runtime.start(250);
    const app = buildApp(runtime);

    // More holders than the pool has slots: the excess queue inside postgres.js.
    const holders = Array.from({ length: POOL_MAX + 10 }, () =>
      withSystemDbAccessContext(async () => {
        await db.execute(sql`select pg_sleep(1.5)`);
      }, 'admissionIntegrationHolder'),
    );
    try {
      await until(() => runtime!.level >= 2, 10_000, 'level >= 2 under real pool queueing');

      const startedAt = Date.now();
      const refused = await app.request(`/api/v1/agents/${AGENT}/security/status`, { method: 'PUT' });
      const refusalMs = Date.now() - startedAt;
      expect(refused.status).toBe(503);
      const retryAfter = Number(refused.headers.get('retry-after'));
      expect(retryAfter).toBeGreaterThanOrEqual(60);
      expect(retryAfter).toBeLessThanOrEqual(90);
      // The pool is saturated for ~1.5 s per wave; a refusal that queued for a slot would take that long.
      expect(refusalMs).toBeLessThan(250);

      // Heartbeats are never refused: this one queues for the pool like any request and still succeeds.
      expect((await app.request(`/api/v1/agents/${AGENT}/heartbeat`, { method: 'POST' })).status).toBe(200);
    } finally {
      await Promise.allSettled(holders);
    }

    await until(() => runtime!.level === 0, 60_000, 'recovery to level 0');
  }, 120_000);

  it('a real pool-acquire timeout (#8243) is answered 503 + Retry-After, not 500', async () => {
    const previous = process.env.DB_POOL_ACQUIRE_TIMEOUT_MS;
    process.env.DB_POOL_ACQUIRE_TIMEOUT_MS = '1000'; // read per call; 1000 is the clamp floor
    const app = buildApp(null);
    app.onError((err, c) => dbSaturationResponse(err, c) ?? c.json({ error: 'Internal Server Error' }, 500));
    const holders = Array.from({ length: POOL_MAX + 5 }, () =>
      withSystemDbAccessContext(async () => {
        await db.execute(sql`select pg_sleep(3)`);
      }, 'admissionIntegrationHolder').catch(() => undefined),
    );
    try {
      const res = await app.request(`/api/v1/agents/${AGENT}/heartbeat`, { method: 'POST' });
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ code: 'DB_POOL_SATURATED' });
      const retryAfter = Number(res.headers.get('retry-after'));
      expect(retryAfter).toBeGreaterThanOrEqual(30);
      expect(retryAfter).toBeLessThanOrEqual(45);
    } finally {
      await Promise.allSettled(holders);
      if (previous === undefined) delete process.env.DB_POOL_ACQUIRE_TIMEOUT_MS;
      else process.env.DB_POOL_ACQUIRE_TIMEOUT_MS = previous;
    }
  }, 60_000);
});
