import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../services/redis', () => ({
  getRedis: () => null,
}));

vi.mock('../services/clientIp', () => ({
  getTrustedClientIp: vi.fn(() => 'global-rate-limit-test'),
}));

import {
  __resetSkipPrefixesForTests,
  globalRateLimit,
  registerGlobalRateLimitSkipPrefix,
} from './globalRateLimit';

beforeEach(() => {
  __resetSkipPrefixesForTests();
});

describe('globalRateLimit', () => {
  it('skips registered extension agent prefixes', async () => {
    registerGlobalRateLimitSkipPrefix('/api/v1/demo/agent/');
    const app = new Hono();
    app.use('*', globalRateLimit({ limit: 1, windowSeconds: 60 }));
    app.post('/api/v1/demo/agent/batch', (c) => c.json({ ok: true }));

    await app.request('/api/v1/demo/agent/batch', { method: 'POST' });
    const res = await app.request('/api/v1/demo/agent/batch', { method: 'POST' });

    expect(res.status).toBe(200);
  });

  it('resets registered prefixes while preserving built-in prefixes', async () => {
    registerGlobalRateLimitSkipPrefix('/api/v1/demo/agent/');
    __resetSkipPrefixesForTests();

    const app = new Hono();
    app.use('*', globalRateLimit({ limit: 1, windowSeconds: 60 }));
    app.post('/api/v1/demo/agent/batch', (c) => c.json({ ok: true }));
    app.post('/api/v1/agents/batch', (c) => c.json({ ok: true }));

    await app.request('/api/v1/demo/agent/batch', { method: 'POST' });
    const limited = await app.request('/api/v1/demo/agent/batch', { method: 'POST' });
    const builtIn = await app.request('/api/v1/agents/batch', { method: 'POST' });

    expect(limited.status).toBe(429);
    expect(builtIn.status).toBe(200);
  });
});
