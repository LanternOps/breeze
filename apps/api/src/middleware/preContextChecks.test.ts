import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { preContextCheck, runPreContextChecks } from './preContextChecks';

describe('preContextCheck', () => {
  it('runs inline exactly once when no context-opening middleware pre-ran it', async () => {
    const check = vi.fn(async () => null);
    const app = new Hono();
    app.post('/x', preContextCheck(check), (c) => c.json({ ok: true }));
    const res = await app.request('/x', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(check).toHaveBeenCalledTimes(1);
  });

  it('inline fallback still denies', async () => {
    const app = new Hono();
    app.post('/x', preContextCheck(async (c) => c.json({ e: 1 }, 429)), (c) => c.json({ ok: true }));
    expect((await app.request('/x', { method: 'POST' })).status).toBe(429);
  });

  it('pre-runs a check on a mounted sub-app once, before the opener continues', async () => {
    const check = vi.fn(async () => null);
    const sub = new Hono();
    sub.post('/x', preContextCheck(check), (c) => c.json({ ok: true }));
    const order: string[] = [];
    const app = new Hono();
    app.use('*', async (c, next) => {
      const denied = await runPreContextChecks(c);
      order.push(`pre:${check.mock.calls.length}`);
      if (denied) { c.res = denied; return; }
      order.push('open');
      await next();
    });
    app.route('/api', sub);
    const res = await app.request('/api/x', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(check).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['pre:1', 'open']);
  });

  it('a pre-run denial short-circuits before the opener', async () => {
    const app = new Hono();
    app.use('*', async (c, next) => {
      const denied = await runPreContextChecks(c);
      if (denied) { c.res = denied; return; }
      await next();
    });
    let handled = false;
    app.post('/x', preContextCheck(async (c) => c.json({ e: 1 }, 429)), (c) => { handled = true; return c.json({}); });
    expect((await app.request('/x', { method: 'POST' })).status).toBe(429);
    expect(handled).toBe(false);
  });
});
